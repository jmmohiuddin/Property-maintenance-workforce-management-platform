import { withTenant } from "@meridian/db";
import {
  activeTenantIds,
  expireEndedContracts,
  materialisePpmJobs,
  ppmCompliance,
  reconcileContractVisits,
} from "@meridian/db/domain";
import { PPM_COMPLETION_TARGET_PERCENT } from "@meridian/core";
import { runCron } from "@/lib/cron";

/**
 * The PPM engine. Daily, 05:30 Asia/Dubai (`30 1 * * *` UTC).
 *
 * Half an hour ahead of the compliance sweep, and that is deliberate in both
 * directions. This route is what moves an ended contract to `expired`, and
 * `CON-9` in the compliance sweep reports expired contracts — running it second
 * means an AMC that lapsed overnight is reported on the same morning rather
 * than the next one. Staggering them also keeps two table-wide passes over
 * every tenant off the same connection pool at the same minute, which is the
 * reason the retention purge sits at 02:00 rather than 06:00.
 *
 * `CON-3`…`CON-7`. An AMC is not a record of an agreement, it is a machine that
 * produces work, and this route is the part of the machine that turns. Without
 * it the schedule generated at activation is a list of dates nobody ever acts
 * on, and the first time anyone notices is when an OA management company asks
 * for a PPM completion report at renewal.
 *
 * ── WHAT IT DOES, IN ORDER ──────────────────────────────────────────────────
 *
 * The order is not arbitrary — each step depends on the one before it.
 *
 *  1. **Expire ended contracts.** A contract past its end date stays `active`
 *     forever unless something moves it, and an active contract keeps
 *     materialising jobs under a term that finished in March. Same trap as
 *     `expireStaleQuotes`: the status existed and nothing set it.
 *  2. **Reconcile** (`CON-5`, `CON-7`). Visits whose job has completed become
 *     `completed` and decrement their entitlement; visits whose window has
 *     closed with nothing done become `missed`. Runs before materialisation so
 *     the entitlement counts a job it raised this morning reads are current.
 *  3. **Materialise** (`CON-4`). Every planned visit inside its lead time —
 *     21 days by default — becomes a real job, inheriting the property, the
 *     scope, the entitlement and the contract's own SLA targets.
 *  4. **Report** (`CON-7`, `G12`). Contracts below the 98% completion target
 *     are warned about every run while they stay below it.
 *
 * ── WHY THE COMPLETION WARNING REPEATS ──────────────────────────────────────
 *
 * Same rule as the blocked-technician warning in `/api/cron/compliance`: a
 * contract at 84% completion is a standing state, not an event. An alert that
 * fired once last Tuesday has stopped being visible, and this is the number the
 * customer asks for at renewal.
 *
 * ── WHAT THIS ROUTE DOES NOT DO ─────────────────────────────────────────────
 *
 * It does not send renewal reminders. `CON-9` lives in `/api/cron/compliance`
 * alongside the other expiry ladders — document, accreditation, certification —
 * because they are the same kind of check with the same T-90/T-60/T-30/T-7
 * shape and the same recipients, and splitting one of the four onto its own
 * schedule would mean two jobs to keep alive for one habit.
 *
 * It also blocks nothing. There are exactly three hard blocks in this system —
 * an expired blocking document, an expired work permit, and the summer midday
 * ban — each with a named statutory penalty. A contract that has expired or a
 * PPM schedule that has slipped is a commercial consequence, and commercial
 * consequences are warned about.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Below this, a contract's completion is reported as a warning. `G12`. */
const COMPLETION_WARN_BELOW = PPM_COMPLETION_TARGET_PERCENT;

/**
 * Cap per tenant per run.
 *
 * Generous relative to any real portfolio — a hundred buildings at monthly
 * frequency is 100 visits a month — but finite, so a misconfigured contract
 * with a one-day interval cannot make this route run until it times out and
 * leaves a stranded `cron_runs` row. Anything not taken today is taken
 * tomorrow; the lead time is 21 days, so nothing is missed by deferring.
 */
const MATERIALISE_LIMIT = 500;

export async function GET(request: Request) {
  return runCron("contracts", request, async () => {
    const tenants = await activeTenantIds();

    let expired = 0;
    let jobsCreated = 0;
    let visitsCompleted = 0;
    let visitsMissed = 0;
    let contractsBelowTarget = 0;

    const warnings: string[] = [];

    for (const tenantId of tenants) {
      await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
        const justExpired = await expireEndedContracts(tx);
        expired += justExpired;

        const reconciled = await reconcileContractVisits(tx);
        visitsCompleted += reconciled.completed;
        visitsMissed += reconciled.missed;

        const created = await materialisePpmJobs(
          tx,
          { tenantId, actorKind: "system" },
          { limit: MATERIALISE_LIMIT },
        );
        jobsCreated += created.length;

        if (reconciled.missed > 0) {
          warnings.push(
            `${reconciled.missed} contract visit(s) passed their window without being carried ` +
              `out. Each one is a miss against the PPM completion figure (G12, target ` +
              `${PPM_COMPLETION_TARGET_PERCENT}%).`,
          );
        }

        // Reported every run while the condition holds, not once when it starts.
        const compliance = await ppmCompliance(tx);
        const below = compliance.filter(
          // A contract with nothing due yet reports 100% and is not a finding.
          (c) => c.completed + c.overdue > 0 && c.percent < COMPLETION_WARN_BELOW,
        );

        contractsBelowTarget += below.length;

        if (below.length > 0) {
          warnings.push(
            `${below.length} contract(s) below the ${COMPLETION_WARN_BELOW}% PPM completion ` +
              `target: ` +
              below
                .map((c) => `${c.reference} — ${c.percent}% (${c.overdue} overdue)`)
                .join("; "),
          );
        }
      });
    }

    return {
      processed: jobsCreated + visitsCompleted + visitsMissed,
      detail: {
        tenants: tenants.length,
        contractsExpired: expired,
        jobsCreated,
        visitsCompleted,
        visitsMissed,
        contractsBelowTarget,
        completionTargetPercent: PPM_COMPLETION_TARGET_PERCENT,
      },
      warnings,
    };
  });
}
