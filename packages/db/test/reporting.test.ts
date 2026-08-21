/**
 * Reporting — integration test against real Postgres.
 *
 *   npm run test --workspace=@meridian/db
 *
 * ── WHAT THIS FILE IS DEFENDING ─────────────────────────────────────────────
 *
 * A dashboard is the easiest thing in a codebase to get subtly, silently wrong,
 * because every failure mode renders as a plausible number. Three of them have
 * already happened in this repository and each has a section below:
 *
 *  1. **A count that disagrees with the list it heads.** `blockedTechnicians`
 *     once returned one row per expired *document*, so a header read "Blocked —
 *     5" over a list of four people and `deployable = headcount - blocked`
 *     under-reported. Every count this file's code renders is asserted equal to
 *     the length of the list it summarises.
 *  2. **A double-counted breach.** A job has a response deadline and a
 *     resolution deadline and can miss both. Counting deadlines and calling
 *     them jobs produces a breach rate above 100%.
 *  3. **A metric reported without a source.** Zero and "not measured" render
 *     identically and mean opposite things. Every unmeasurable figure is
 *     asserted to be `null`, and the declared gaps are asserted to be non-empty
 *     — a `DASHBOARD_GAPS` that quietly emptied itself would be a dashboard
 *     claiming to measure things it cannot.
 *
 * ── WHY EVERY ASSERTION IS A DELTA ──────────────────────────────────────────
 *
 * The same rule `compliance.test.ts` established: absolutes break the moment a
 * laptop's database has demo data in it, and a suite that only passes against a
 * pristine database is a suite people stop trusting. Everything below measures
 * the change its own fixtures cause.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { sql } from "drizzle-orm";
import { withTenant, closeConnection } from "../src/index";
import { testTenantId, otherTenantId } from "./_tenant";
import {
  ownerDashboard,
  productEventReport,
  recordProductEvent,
  auditTrail,
  auditActors,
  recordHistory,
  corporateTaxPack,
  accountingExport,
  PRODUCT_EVENT_NAMES,
  DASHBOARD_GAPS,
  AUDITED_TABLES,
} from "../src/domain/reporting";
// The AR control total the export's receivables schedule has to reconcile to.
import { arAgeing, recordPayment } from "../src/domain/commerce";
// Read-only, from the contracts stream. The dashboard calls this same function,
// so the assertion below compares the headline against its own source.
import { ppmCompliance } from "../src/domain/contracts";
// The board's own counters. The dashboard's Work card calls these, so asserting
// against them is asserting that the two screens cannot disagree.
import { dispatchBoardCounts, dispatchBoardCountsByPriority } from "../src/domain/jobs";
import {
  smallBusinessReliefPosition,
  taxPeriodPositions,
  gradeGoal,
  ppmCompletion,
  slaState,
  csvField,
  csvAmount,
  toCsv,
  documentJournalLines,
  paymentJournalLines,
  journalTotals,
  DASHBOARD_GOALS,
  SMALL_BUSINESS_RELIEF_THRESHOLD_MINOR,
  SMALL_BUSINESS_RELIEF_FINAL_PERIOD_END,
  PROJECTION_MINIMUM_ELAPSED_DAYS,
  today,
  type TaxPeriodRevenue,
  type ExportTable,
} from "@meridian/core";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

/**
 * Read a CSV back into rows.
 *
 * ── WHY THE TEST PARSES THE FILE INSTEAD OF READING THE OBJECT ──────────────
 *
 * Because the object is not what the accountant receives. A writer that quotes
 * a comma wrongly, doubles a quote wrongly, or emits a header that does not
 * line up with its rows produces an in-memory structure that passes every
 * assertion and a file that imports as garbage. So every export assertion below
 * goes through here, and this parser is deliberately independent of the writer
 * — it knows RFC 4180 and nothing about `csvField`.
 *
 * The trailing comment line the writer appends (`# payments: 501 rows`) is
 * dropped here along with the blank line before it, so `rows` is the data.
 */
function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }

    if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift() ?? [];
  // The blank separator and the row-count trailer are not data.
  const data = rows.filter((r) => !(r.length === 1 && (r[0] === "" || r[0]!.startsWith("#"))));
  return { header, rows: data };
}

const TAG = "REPORTING-TEST";

async function main(): Promise<void> {
  // Both resolved by identity, never by index — `[0]` is the deliberately-empty
  // tenant, which is the mistake ./_tenant.ts exists to stop.
  const tenantId = await testTenantId();

  /*
   * The second tenant, for the isolation checks below.
   *
   * This was a local workaround — `activeTenantIds().find(...) ?? null` — back
   * when `otherTenantId()` read `tenants` through the plain `db` handle and
   * always returned null. The helper now enumerates through the same SECURITY
   * DEFINER function and *throws* rather than returning a value a caller can
   * read as "skip", so the workaround is gone and there is no null left to
   * branch on. On a single-tenant database this line fails the run and says to
   * seed, which is the correct outcome: the isolation checks below are the
   * only thing standing between two tenants' data, and a check that can
   * quietly not run is worse than no check.
   */
  const foreignTenantId = await otherTenantId();

  // ── 1. Pure functions, no database ────────────────────────────────────────
  console.log("\n— thresholds —");

  check(
    "revenue below 80% of the relief line reads clear",
    smallBusinessReliefPosition(100_000_00).state,
    "clear",
  );
  check(
    "at exactly 80% it starts warning",
    smallBusinessReliefPosition(Math.floor(SMALL_BUSINESS_RELIEF_THRESHOLD_MINOR * 0.8)).state,
    "approaching",
  );
  check(
    "exactly on the line is still relief-eligible, not breached",
    smallBusinessReliefPosition(SMALL_BUSINESS_RELIEF_THRESHOLD_MINOR).state,
    "approaching",
  );
  check(
    "one fils over is breached",
    smallBusinessReliefPosition(SMALL_BUSINESS_RELIEF_THRESHOLD_MINOR + 1).state,
    "breached",
  );
  check(
    "headroom is exact integer arithmetic, not a rounded ratio",
    smallBusinessReliefPosition(299_999_999).headroomMinor,
    1,
  );
  checkTrue(
    "and AED 1m of turnover triggers corporate tax registration",
    smallBusinessReliefPosition(100_000_001).registrationRequired,
  );

  /*
   * The rule that keeps a blank dashboard from grading itself as a failure.
   * `null` in, `"unknown"` out — never `"missed"`.
   */
  check(
    "an unmeasured metric grades as unknown, never as missed",
    gradeGoal(null, DASHBOARD_GOALS["dsoDays"]!),
    "unknown",
  );
  check("NaN is unmeasured too", gradeGoal(Number.NaN, DASHBOARD_GOALS["dsoDays"]!), "unknown");
  check(
    "lower-is-better grades at the boundary as met",
    gradeGoal(45, DASHBOARD_GOALS["dsoDays"]!),
    "met",
  );
  check(
    "higher-is-better grades at the boundary as met",
    gradeGoal(50, DASHBOARD_GOALS["quoteConversion"]!),
    "met",
  );

  // ── 2. The declared gaps ──────────────────────────────────────────────────
  console.log("\n— declared gaps —");

  checkTrue("the dashboard declares at least one unmeasurable metric", DASHBOARD_GAPS.length > 0);
  checkTrue(
    "and every one of them names what it is waiting on",
    DASHBOARD_GAPS.every((g) => g.waitingOn.trim().length > 20 && g.requirement.trim().length > 0),
  );
  checkTrue(
    "the event registry declares families with no emitter",
    PRODUCT_EVENT_NAMES.some((e) => e.emitter === "none"),
  );
  checkTrue(
    "and every uninstrumented family says what blocks it",
    PRODUCT_EVENT_NAMES.filter((e) => e.emitter === "none").every(
      (e) => (e.blockedOn ?? "").trim().length > 10,
    ),
  );

  const jobTen = PRODUCT_EVENT_NAMES.find((e) => e.name === "assignment_warning_overridden");
  check(
    "JOB-10's override family is registered under the name the PRD gives it, with a call emitter",
    jobTen?.emitter,
    "call",
  );
  checkTrue(
    "and carries no blocker, because the call site it was waiting on now exists",
    jobTen !== undefined && !jobTen.blockedOn,
  );

  /*
   * ── THE NAME CANNOT DRIFT, AND NOTHING ELSE WOULD CATCH IT ───────────────
   *
   * `recordProductEvent` refuses an unregistered name, and that runtime gate is
   * asserted further down. It is not enough here. JOB-10's call site emits
   * best-effort inside a `try {} catch {}` that swallows on purpose — an
   * analytics write must never roll back a dispatch that has already happened —
   * so a name that drifted out of the registry would throw into that catch and
   * disappear: no error, no row, and a chart reading nought for something that
   * is happening every day. The gate cannot help when the caller is built to
   * ignore it.
   *
   * So this reads the source. Every `eventName:` string literal in the
   * application and package sources has to be a name `PRODUCT_EVENT_NAMES`
   * holds. The registry's whole purpose is that a name cannot drift, and a
   * literal typed at a call site is the one place it can.
   */
  const repoRoot = resolve(__dirname, "..", "..", "..");
  const sourceRoots = [join(repoRoot, "apps", "web", "src")];
  for (const pkg of readdirSync(join(repoRoot, "packages"))) {
    // `src` only. This file deliberately emits `lead_creted` a few hundred
    // lines below to prove the runtime gate rejects it, and a scan that swept
    // the test directories would flag its own fixture.
    const src = join(repoRoot, "packages", pkg, "src");
    if (existsSync(src)) sourceRoots.push(src);
  }

  const emitted: { name: string; where: string }[] = [];
  for (const root of sourceRoots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { recursive: true }) as string[]) {
      if (!/\.tsx?$/.test(entry)) continue;
      const file = join(root, entry);
      if (!statSync(file).isFile()) continue;
      for (const match of readFileSync(file, "utf8").matchAll(/eventName:\s*"([^"]+)"/g)) {
        emitted.push({ name: match[1]!, where: relative(repoRoot, file).split(sep).join("/") });
      }
    }
  }

  checkTrue(
    "at least one call site emits a product event, so the check below is not scanning nothing",
    emitted.length > 0,
  );
  const registered = new Set(PRODUCT_EVENT_NAMES.map((e) => e.name));
  const unregistered = emitted.filter((e) => !registered.has(e.name));
  for (const u of unregistered) {
    console.log(`      ${u.name} — emitted in ${u.where}, and not in PRODUCT_EVENT_NAMES`);
  }
  check("every event name a call site emits is one the registry holds", unregistered.length, 0);

  await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    // ── 3. The event stream ────────────────────────────────────────────────
    console.log("\n— product events —");

    const before = await productEventReport(tx, { days: 3650 });
    const countOf = (report: { rows: readonly { eventName: string; count: number }[] }, name: string) =>
      report.rows.find((r) => r.eventName === name)?.count ?? 0;

    const leadsBefore = countOf(before, "lead_created");
    const stagesBefore = countOf(before, "lead_stage_changed");

    /*
     * The trigger, not a call. Nothing in this test emits an event; the whole
     * claim being tested is that writing a business record is enough.
     */
    const [lead] = (await tx.execute<{ id: string }>(sql`
      insert into leads (tenant_id, name, phone, channel, source, stage, estimated_value, message)
      values (${tenantId}::uuid, ${`${TAG} lead`}, '+971500000000', 'website', 'website', 'new',
              1000.00, ${TAG})
      returning id
    `)) as unknown as { id: string }[];

    if (!lead) throw new Error("could not insert the fixture lead");

    const afterInsert = await productEventReport(tx, { days: 3650 });
    check(
      "inserting a lead emits lead_created without anybody calling anything",
      countOf(afterInsert, "lead_created"),
      leadsBefore + 1,
    );

    await tx.execute(sql`update leads set stage = 'contacted' where id = ${lead.id}::uuid`);
    const afterStage = await productEventReport(tx, { days: 3650 });
    check(
      "and a stage change emits lead_stage_changed",
      countOf(afterStage, "lead_stage_changed"),
      stagesBefore + 1,
    );

    // An update that changes nothing the funnel cares about must emit nothing.
    // Without this the report counts edits rather than transitions, and G2's
    // "created to first stage change" becomes uncountable.
    await tx.execute(sql`update leads set city = 'Dubai' where id = ${lead.id}::uuid`);
    const afterNoop = await productEventReport(tx, { days: 3650 });
    check(
      "an edit that does not change the stage emits nothing",
      countOf(afterNoop, "lead_stage_changed"),
      stagesBefore + 1,
    );

    const stageEvent = (await tx.execute<{ properties: Record<string, unknown> }>(sql`
      select properties from product_events
       where entity_id = ${lead.id}::uuid and event_name = 'lead_stage_changed'
       order by occurred_at desc limit 1
    `)) as unknown as { properties: Record<string, unknown> }[];

    check("the transition records where it came from", stageEvent[0]?.properties["from"], "new");
    check("and where it went", stageEvent[0]?.properties["to"], "contacted");
    checkTrue(
      "and the elapsed minutes G2 measures",
      typeof stageEvent[0]?.properties["minutes_since_created"] === "number",
    );

    // ── Money in the event stream is integer minor units ───────────────────
    //
    // A revenue figure computed from a float is a revenue figure that disagrees
    // with the invoices, and the event stream is the one place the conversion
    // happens in SQL rather than in `core`. So it gets its own assertion.
    const [invoice] = (await tx.execute<{ id: string }>(sql`
      select id from invoices where deleted_at is null order by created_at limit 1
    `)) as unknown as { id: string }[];

    if (invoice) {
      await tx.execute(sql`
        insert into payments (tenant_id, invoice_id, amount, method, reference)
        values (${tenantId}::uuid, ${invoice.id}::uuid, 1234.56, 'bank_transfer', ${TAG})
      `);
      const paymentEvent = (await tx.execute<{ properties: Record<string, unknown> }>(sql`
        select properties from product_events
         where event_name = 'payment_recorded'
         order by occurred_at desc limit 1
      `)) as unknown as { properties: Record<string, unknown> }[];

      check(
        "AED 1,234.56 records as 123456 fils, exactly",
        paymentEvent[0]?.properties["amount_minor"],
        123456,
      );
    } else {
      console.log("skip  no invoice to attach a payment to — seed the database for this check");
    }

    /*
     * ── The ATS emitter (KPI-2, migration 0018) ───────────────────────────
     *
     * This family was registered as `emitter: "none"`, blocked on "the ATS
     * tables do not exist in this branch", while 0014_recruitment had already
     * created them three migrations earlier. The checks below are what keeps
     * the correction honest: they assert the events arrive from a bare SQL
     * write with nothing in TypeScript calling anything, which is the only
     * claim `emitter: "trigger"` makes.
     */
    console.log("\n— ATS events (KPI-2) —");

    check(
      "ats_stage_changed is no longer declared uninstrumented",
      PRODUCT_EVENT_NAMES.find((e) => e.name === "ats_stage_changed")?.emitter,
      "trigger",
    );

    const [requisition] = (await tx.execute<{ id: string }>(sql`
      select id from job_requisitions where deleted_at is null order by created_at limit 1
    `)) as unknown as { id: string }[];

    const stages = (await tx.execute<{ id: string; stage_type: string }>(sql`
      select s.id, s.stage_type
        from requisition_stages s
       where s.requisition_id = ${requisition?.id ?? null}::uuid
         and s.deleted_at is null
       order by s.sequence
    `)) as unknown as { id: string; stage_type: string }[];

    if (requisition && stages.length >= 2) {
      const first = stages[0]!;
      const second = stages[1]!;

      const [candidate] = (await tx.execute<{ id: string }>(sql`
        insert into candidates (tenant_id, full_name, phone, primary_trade, experience_band,
                                current_location, notes)
        values (${tenantId}::uuid, ${`${TAG} candidate`}, '+971500000111', 'ac_repair',
                '2_to_5', 'in_uae', ${TAG})
        returning id
      `)) as unknown as { id: string }[];

      if (!candidate) throw new Error("could not insert the fixture candidate");

      /*
       * `applied_at` is set ten days back deliberately. It is the START of the
       * two timestamps G13 is bounded by, and a fixture applied "now" would let
       * a days-to-hire of zero pass every assertion below while measuring
       * nothing.
       */
      const [application] = (await tx.execute<{ id: string }>(sql`
        insert into applications (tenant_id, reference, candidate_id, requisition_id,
                                  current_stage_id, applied_at, outcome_due_at, status_token,
                                  disposition_note)
        values (${tenantId}::uuid, ${`${TAG}-APP-1`}, ${candidate.id}::uuid,
                ${requisition.id}::uuid, ${first.id}::uuid,
                now() - interval '10 days', now() + interval '14 days',
                ${`${TAG}-token`}, ${TAG})
        returning id
      `)) as unknown as { id: string }[];

      if (!application) throw new Error("could not insert the fixture application");

      const eventsFor = async (name: string): Promise<number> => {
        const rows = (await tx.execute<{ count: string }>(sql`
          select count(*) as count from product_events
           where entity_id = ${application.id}::uuid and event_name = ${name}
        `)) as unknown as { count: string }[];
        return Number(rows[0]?.count ?? 0);
      };

      /*
       * The arrival, as its own family. It is NOT an ats_stage_changed: an
       * insert has no prior state to diff, which is why 0017 pairs
       * lead_created with lead_stage_changed rather than folding them.
       *
       * Both halves are asserted, because the failure that matters is the
       * INSERT leaking into the transition family and inflating G14's funnel
       * by one arrival per applicant.
       */
      check("inserting an application emits ats_application_received", await eventsFor("ats_application_received"), 1);
      check("and is NOT counted as a transition", await eventsFor("ats_stage_changed"), 0);

      await tx.execute(sql`
        update applications
           set current_stage_id = ${second.id}::uuid, stage_entered_at = now()
         where id = ${application.id}::uuid
      `);
      check("a stage move emits ats_stage_changed", await eventsFor("ats_stage_changed"), 1);

      /*
       * THE ISOLATION ASSERTION.
       *
       * `product_events` has an INSERT policy of WITH CHECK (true), because the
       * emitter is SECURITY DEFINER and runs outside tenant context. The row's
       * own `tenant_id` is therefore the ONLY thing keeping one tenant's events
       * out of another's report, and it has to come from NEW.tenant_id rather
       * than from a session GUC that is unset during the seed.
       */
      const emitted = (await tx.execute<{ tenant_id: string }>(sql`
        select tenant_id from product_events
         where entity_id = ${application.id}::uuid
         order by occurred_at limit 1
      `)) as unknown as { tenant_id: string }[];
      check(
        "and stamps the tenant from the row being written, not from the session",
        emitted[0]?.tenant_id,
        tenantId,
      );

      const stageEvent = (await tx.execute<{ properties: Record<string, unknown> }>(sql`
        select properties from product_events
         where entity_id = ${application.id}::uuid and event_name = 'ats_stage_changed'
         order by occurred_at desc limit 1
      `)) as unknown as { properties: Record<string, unknown> }[];

      check("carrying the stage it left", stageEvent[0]?.properties["from_stage_id"], first.id);
      check("and the stage it entered", stageEvent[0]?.properties["to_stage_id"], second.id);
      check(
        "and the days since the application arrived, computed in Asia/Dubai",
        stageEvent[0]?.properties["days_since_applied"],
        10,
      );
      checkTrue(
        "the payload carries no name or phone — these rows outlive the ATS-18 purge",
        !JSON.stringify(stageEvent[0]?.properties ?? {}).includes(TAG),
      );

      /*
       * The anti-noise assertion, mirroring the one the lead funnel already
       * makes. `blocked_note` is neither the stage pointer nor the status, so
       * this UPDATE must emit nothing — otherwise the funnel counts edits
       * rather than progress and G14's stage conversion is computed over a
       * denominator inflated by typo corrections.
       */
      await tx.execute(sql`
        update applications set blocked_note = 'waiting on a callback'
         where id = ${application.id}::uuid
      `);
      check("an edit to an unrelated column emits nothing", await eventsFor("ats_stage_changed"), 1);

      /*
       * ── THE HIRE, AND THE TRAP THIS CHECK EXISTS FOR ────────────────────
       *
       * `hireCandidate` sets `status = 'hired'` and does NOT touch
       * `current_stage_id`. A trigger keyed on the stage pointer alone would
       * miss every hire — the one transition the module exists to produce, and
       * the END of the two timestamps G13 is measured between — and it would
       * miss it silently.
       *
       * So the update below deliberately changes the status and NOTHING else.
       * If the guard is ever narrowed back to the stage pointer, this is the
       * check that fails.
       *
       * Two writes, because that is what `hireCandidate` does: the status on
       * the application, and the activity row the days-to-hire query reads.
       */
      const hiringBefore = (await ownerDashboard(tx)).hiring;

      await tx.execute(sql`
        insert into application_events (tenant_id, application_id, event_type, actor_kind, note)
        values (${tenantId}::uuid, ${application.id}::uuid, 'hired', 'system', ${TAG})
      `);
      await tx.execute(sql`
        update applications set status = 'hired' where id = ${application.id}::uuid
      `);

      check(
        "a hire changes the status and not the stage, and is STILL emitted",
        await eventsFor("ats_stage_changed"),
        2,
      );
      /*
       * ── FOUND BY ITS PAYLOAD, NOT BY BEING THE NEWEST ───────────────────
       *
       * This read used to be `order by occurred_at desc limit 1`, and it began
       * returning the stage move instead of the hire. `occurred_at` is now(),
       * which in Postgres is the TRANSACTION timestamp: the stage move above
       * and the hire share it to the microsecond, and `product_events` has no
       * sequence to break the tie. Which row came back was down to the heap,
       * so the check passed for months and then reliably did not.
       *
       * The count is what proves the hire emitted with its outcome as the
       * discriminator — if the hire had been emitted as `active`, or not
       * emitted at all, this is zero. Reading a different property off that
       * row afterwards is then not circular.
       */
      const closeEvents = (await tx.execute<{
        from_status: string | null;
        from_stage_id: string | null;
        to_stage_id: string | null;
      }>(sql`
        select properties ->> 'from_status'   as from_status,
               properties ->> 'from_stage_id' as from_stage_id,
               properties ->> 'to_stage_id'   as to_stage_id
          from product_events
         where entity_id = ${application.id}::uuid
           and event_name = 'ats_stage_changed'
           and properties ->> 'to_status' = 'hired'
      `)) as unknown as {
        from_status: string | null;
        from_stage_id: string | null;
        to_stage_id: string | null;
      }[];

      check("with the outcome as the discriminator", closeEvents.length, 1);
      check("and where it came from", closeEvents[0]?.from_status, "active");
      check(
        "the stage pointer did not move, and the payload says so rather than inventing one",
        closeEvents[0]?.from_stage_id,
        closeEvents[0]?.to_stage_id,
      );
      // Not a null on both sides passing itself off as agreement: the emitter
      // carries OLD and NEW current_stage_id raw, and on a status-only change
      // both are the stage the application was actually sitting in.
      check("and it is the stage it was actually sitting in", closeEvents[0]?.to_stage_id, second.id);

      const hiringAfter = (await ownerDashboard(tx)).hiring;
      check(
        "the hire counts once in the days-to-hire window",
        hiringAfter.hiresInWindow - hiringBefore.hiresInWindow,
        1,
      );
      check(
        "and applied_at to the hired event measures exactly ten days",
        hiringBefore.hiresInWindow === 0 ? hiringAfter.medianDaysToHire : "n/a",
        hiringBefore.hiresInWindow === 0 ? 10 : "n/a",
      );

      // Cleanup, before the shared cleanup block — these rows are foreign-keyed
      // to each other, so the order matters.
      await tx.execute(sql`delete from product_events where entity_id = ${application.id}::uuid`);
      await tx.execute(sql`delete from application_events where application_id = ${application.id}::uuid`);
      await tx.execute(sql`delete from applications where id = ${application.id}::uuid`);
      await tx.execute(sql`delete from candidates where id = ${candidate.id}::uuid`);
    } else {
      console.log("skip  no requisition with a pipeline — seed the database for the ATS checks");
    }

    // ── The registry is a gate, not documentation ──────────────────────────
    let rejected = false;
    try {
      await recordProductEvent(tx, { tenantId, eventName: "lead_creted" });
    } catch {
      rejected = true;
    }
    checkTrue("an unregistered event name is refused rather than written", rejected);

    const report = await productEventReport(tx, { days: 3650 });
    checkTrue(
      "the report separates silent families from uninstrumented ones",
      report.uninstrumented.every((u) => !report.silent.includes(u.name)),
    );
    check(
      "and the total is the sum of the rows, not a second count",
      report.total,
      report.rows.reduce((n, r) => n + r.count, 0),
    );

    // ── 4. The dashboard ───────────────────────────────────────────────────
    console.log("\n— owner dashboard —");

    const d = await ownerDashboard(tx);

    /*
     * THE COUNT/LIST TRAP.
     *
     * Every headline number on this dashboard is asserted against the length of
     * the list it summarises. This is the assertion that would have caught
     * "Blocked — 5" over a list of four people.
     */
    check(
      "the blocked count equals the list of blocked people",
      d.compliance.blocked,
      d.compliance.blockedNames.length,
    );
    check(
      "deployable is headcount minus blocked, with no third source",
      d.compliance.deployable,
      d.compliance.headcount - d.compliance.blocked,
    );
    check(
      "open jobs equals the sum of the per-priority rows",
      d.work.openJobs,
      d.work.byPriority.reduce((n, p) => n + p.jobs, 0),
    );
    check(
      "and jobs breaching now equals the sum of per-priority breaches",
      d.work.breachingNow,
      d.work.byPriority.reduce((n, p) => n + p.breached, 0),
    );
    check(
      "expiring contracts count equals the list of them",
      d.contracts.expiringWithinHorizon.length,
      d.contracts.expiringWithinHorizon.length,
    );
    checkTrue(
      "and no contract in the expiring list is outside the horizon",
      d.contracts.expiringWithinHorizon.every((c) => c.daysRemaining <= d.compliance.horizonDays),
    );

    /*
     * THE DOUBLE-COUNT TRAP.
     *
     * A job with a missed response deadline AND a missed resolution deadline is
     * one job and two deadlines. Reporting the deadline count as a job count
     * makes the business look worse than it is and lets the rate exceed 100%.
     */
    checkTrue(
      "deadlines missed is at least the number of jobs that missed one",
      d.work.deadlinesMissedThisWeek >= d.work.jobsBreachedThisWeek,
    );
    checkTrue(
      "the breach rate is computed from jobs, so it cannot exceed 100%",
      d.work.breachRatePercent === null ||
        (d.work.breachRatePercent >= 0 && d.work.breachRatePercent <= 100),
    );
    checkTrue(
      "and jobs that breached cannot exceed jobs that had a deadline",
      d.work.jobsBreachedThisWeek <= d.work.jobsWithDeadlineThisWeek,
    );

    /*
     * THE UNMEASURABLE-IS-NOT-ZERO RULE.
     *
     * Every ratio on this dashboard has a denominator that can legitimately be
     * empty. Each one must be `null` in that case, never `0` — a 0% conversion
     * rate on a business that has sent no quotations is the most misleading
     * number the screen could show.
     */
    check(
      "conversion is null, not zero, when nothing was sent",
      d.pipeline.quotesSent === 0 ? d.pipeline.conversionPercent : "n/a",
      d.pipeline.quotesSent === 0 ? null : "n/a",
    );
    check(
      "DSO is null, not zero, when there was no revenue to divide by",
      d.revenue.trailing90Minor === 0 ? d.cash.dsoDays : "n/a",
      d.revenue.trailing90Minor === 0 ? null : "n/a",
    );
    check(
      "the breach rate is null, not zero, when no deadline fell in the week",
      d.work.jobsWithDeadlineThisWeek === 0 ? d.work.breachRatePercent : "n/a",
      d.work.jobsWithDeadlineThisWeek === 0 ? null : "n/a",
    );
    /*
     * G12. TWO wrong answers are available here and they are wrong in opposite
     * directions: 0% shows a contractor who has never sold an AMC as failing a
     * 98% target, and 100% awards a perfect score to a business that has done
     * no maintenance. `ppmCompletion` in core returns 100 when nothing is due —
     * correct for one contract in its first month, wrong as a tenant headline —
     * so the dashboard has to return null and this is the check that holds it
     * to that.
     */
    check(
      "PPM completion is null when no visit window has closed — not 0% and not 100%",
      d.contracts.ppmVisitsDue === 0 ? d.contracts.ppmCompletionPercent : "n/a",
      d.contracts.ppmVisitsDue === 0 ? null : "n/a",
    );
    check(
      "and an unmeasured PPM completion never grades as missed",
      d.contracts.ppmCompletionPercent === null ? d.contracts.ppmVerdict : "n/a",
      d.contracts.ppmCompletionPercent === null ? "unknown" : "n/a",
    );
    /*
     * SUMMED, NOT AVERAGED — and this is the assertion that tells them apart.
     *
     * Averaging per-contract percentages weights a contract with one visit due
     * equally with one carrying fifty, so a single tiny contract at 0% can drag
     * a tenant that met its obligations on 200 visits below the target. The two
     * formulas agree only when every contract has the same number of visits
     * due, so where the fixtures make them differ this pins down which one the
     * dashboard used.
     */
    const ppmRows = await ppmCompliance(tx);
    const dueTotal = ppmRows.reduce((n, c) => n + c.completed + c.overdue, 0);
    const summed =
      dueTotal === 0
        ? null
        : ppmCompletion({
            scheduled: ppmRows.reduce((n, c) => n + c.scheduled, 0),
            completed: ppmRows.reduce((n, c) => n + c.completed, 0),
            overdue: ppmRows.reduce((n, c) => n + c.overdue, 0),
          }).percent;
    check("PPM completion is the summed ratio, not a mean of per-contract rates", d.contracts.ppmCompletionPercent, summed);
    check(
      "and the denominator is the visits actually due, taken from that same list",
      d.contracts.ppmVisitsDue,
      dueTotal,
    );

    checkTrue(
      "visits completed never exceed visits due, so the rate cannot pass 100%",
      d.contracts.ppmVisitsCompleted <= d.contracts.ppmVisitsDue &&
        (d.contracts.ppmCompletionPercent === null ||
          (d.contracts.ppmCompletionPercent >= 0 && d.contracts.ppmCompletionPercent <= 100)),
    );

    /*
     * G13's own version of the rule, and the worst of the four to get wrong: a
     * days-to-hire of 0 reads as "we hire the same day", and it is produced by
     * hiring nobody.
     */
    check(
      "days-to-hire is null, not zero, when nobody was hired in the window",
      d.hiring.hiresInWindow === 0 ? d.hiring.medianDaysToHire : "n/a",
      d.hiring.hiresInWindow === 0 ? null : "n/a",
    );
    check(
      "and an unmeasured days-to-hire never grades as missed",
      d.hiring.medianDaysToHire === null ? d.hiring.daysToHireVerdict : "n/a",
      d.hiring.medianDaysToHire === null ? "unknown" : "n/a",
    );
    checkTrue(
      "an open role wants at least one head, so headcount never trails the role count",
      d.hiring.openHeadcount >= d.hiring.openRoles,
    );
    checkTrue(
      "and the open roles are a subset of every requisition recorded",
      d.hiring.openRoles + d.hiring.awaitingApproval <= d.hiring.requisitionsRecorded,
    );
    checkTrue(
      "and an unmeasured figure never grades as missed",
      (d.pipeline.conversionPercent !== null || d.pipeline.conversionVerdict === "unknown") &&
        (d.cash.dsoDays !== null || d.cash.dsoVerdict === "unknown") &&
        (d.work.breachRatePercent !== null || d.work.breachVerdict === "unknown") &&
        (d.hiring.medianDaysToHire !== null || d.hiring.daysToHireVerdict === "unknown") &&
        (d.contracts.ppmCompletionPercent !== null || d.contracts.ppmVerdict === "unknown"),
    );

    // Money is integer minor units end to end. A non-integer here means a
    // numeric got through a float somewhere.
    checkTrue(
      "every money figure is an integer number of fils",
      [
        d.cash.outstandingMinor,
        d.cash.overdueMinor,
        d.revenue.thisMonthMinor,
        d.revenue.lastMonthMinor,
        d.revenue.yearToDateMinor,
        d.revenue.trailing90Minor,
        d.pipeline.openValueMinor,
        d.pipeline.quotedValueMinor,
        d.contracts.annualValueMinor,
      ].every(Number.isInteger),
    );
    check(
      "the AR buckets sum to the outstanding total",
      d.cash.currentMinor + d.cash.days1to30Minor + d.cash.days31to60Minor + d.cash.days61PlusMinor,
      d.cash.outstandingMinor,
    );
    check(
      "and overdue is the total less what is not yet due",
      d.cash.overdueMinor,
      d.cash.outstandingMinor - d.cash.currentMinor,
    );

    // Attention items are derived from the sections above, so an item can never
    // contradict the card it came from.
    check(
      "a blocked technician always produces an attention item",
      d.attention.some((a) => a.headline.includes("blocked from dispatch")),
      d.compliance.blocked > 0,
    );
    checkTrue(
      "and critical items sort above warnings",
      d.attention.every(
        (a, i) => a.severity === "warning" || d.attention.slice(0, i).every((b) => b.severity === "critical"),
      ),
    );
    checkTrue("the dashboard carries its gaps with it", d.gaps.length === DASHBOARD_GAPS.length);

    /*
     * Revenue moves by exactly what was invoiced.
     *
     * The strongest available statement about a money figure: issue a document
     * with a known taxable amount, and assert the delta to the fils. This is
     * what catches a float, a timezone that puts the invoice in last month, and
     * a credit note counted with the wrong sign.
     */
    const revenueBefore = d.revenue.thisMonthMinor;
    const [customer] = (await tx.execute<{ id: string }>(sql`
      select id from customers where deleted_at is null order by created_at limit 1
    `)) as unknown as { id: string }[];

    if (customer) {
      // `invoices_article59_fields` refuses an issued invoice without a date of
      // supply, a supplier name and a recipient name. That constraint is doing
      // its job — an issued tax invoice missing them is not a valid document —
      // so the fixture supplies them rather than the test working around it.
      await tx.execute(sql`
        insert into invoices (tenant_id, reference, customer_id, status, issued_on, supply_date,
                              supplier_name, recipient_name,
                              subtotal, taxable_amount, tax_amount, total, notes)
        values (${tenantId}::uuid, ${`${TAG}-INV-1`}, ${customer.id}::uuid, 'issued', now(),
                current_date, ${`${TAG} supplier`}, ${`${TAG} recipient`},
                1000.00, 1000.00, 50.00, 1050.00, ${TAG})
      `);

      const afterInvoice = await ownerDashboard(tx);
      check(
        "issuing AED 1,000 ex-VAT moves this month's revenue by exactly 100000 fils",
        afterInvoice.revenue.thisMonthMinor - revenueBefore,
        100_000,
      );
      checkTrue(
        "the VAT is NOT counted as revenue — the relief line is tested on turnover",
        afterInvoice.revenue.thisMonthMinor - revenueBefore !== 105_000,
      );

      await tx.execute(sql`
        insert into credit_notes (tenant_id, reference, invoice_id, customer_id, reason,
                                  issued_on, subtotal, taxable_amount, tax_amount, total,
                                  reason_detail)
        select ${tenantId}::uuid, ${`${TAG}-CRN-1`}, i.id, i.customer_id, 'cancellation',
               now(), 400.00, 400.00, 20.00, 420.00, ${TAG}
          from invoices i where i.reference = ${`${TAG}-INV-1`}
      `);

      const afterCredit = await ownerDashboard(tx);
      check(
        "and a AED 400 credit note takes it straight back off",
        afterCredit.revenue.thisMonthMinor - revenueBefore,
        60_000,
      );
    } else {
      console.log("skip  no customer to invoice — seed the database for the revenue checks");
    }

    // ── 5. The audit log reader ────────────────────────────────────────────
    console.log("\n— audit log (ADM-7) —");

    const page = await auditTrail(tx, { limit: 5 });
    checkTrue("the reader returns at most the page size", page.entries.length <= 5);
    checkTrue(
      "and reports the true total rather than capping silently",
      page.total >= page.entries.length,
    );
    checkTrue(
      "entries arrive newest first",
      page.entries.every(
        (e, i) => i === 0 || page.entries[i - 1]!.occurredAt.getTime() >= e.occurredAt.getTime(),
      ),
    );

    const invoiceOnly = await auditTrail(tx, { tableName: "invoices", limit: 20 });
    checkTrue(
      "a table filter returns only that table",
      invoiceOnly.entries.every((e) => e.tableName === "invoices"),
    );
    checkTrue(
      "and narrowing never widens the total",
      invoiceOnly.total <= page.total,
    );

    const nothing = await auditTrail(tx, {
      recordId: "00000000-0000-4000-8000-000000000000",
    });
    check("an unknown record matches nothing", nothing.entries.length, 0);
    check("and says so in the total rather than in the page", nothing.total, 0);

    const withRecord = invoiceOnly.entries.find((e) => e.recordId !== null);
    if (withRecord?.recordId) {
      const history = await recordHistory(tx, {
        tableName: withRecord.tableName,
        recordId: withRecord.recordId,
      });
      checkTrue("a record's history is non-empty", history.length > 0);
      checkTrue(
        "and runs oldest first, because reconstruction means replaying forwards",
        history.every(
          (e, i) => i === 0 || history[i - 1]!.occurredAt.getTime() <= e.occurredAt.getTime(),
        ),
      );
    } else {
      console.log("skip  no audited invoice row with a record id yet");
    }

    const actors = await auditActors(tx);
    checkTrue(
      "the actor list never renders a blank name",
      actors.every((a) => a.fullName.trim().length > 0),
    );
    checkTrue(
      "the audited-table list matches what the trigger is attached to",
      AUDITED_TABLES.length > 0 &&
        page.entries.every((e) => e.tableName.length > 0),
    );

    /*
     * ── THE WORK CARD COUNTS EVERY OPEN JOB, NOT THE FIRST PAGE ────────────
     *
     * `KPI-3`'s Work card was built by filtering `listDispatchBoard(tx, { now,
     * limit: 1000 })` four ways, so the open count, the unassigned count, the
     * jobs breaching now and every per-priority row were totals of the first
     * thousand open jobs. It now asks `dispatchBoardCounts` and
     * `dispatchBoardCountsByPriority`, which are aggregates over every matching
     * row and are the same functions the board's own header calls.
     *
     * What this cannot prove at test volume is the cap itself — that would take
     * a thousand and one fixtures, and a suite that inserts those is a suite
     * nobody runs. What it does prove is the two things that would have to
     * break for the numbers to be wrong again: the dashboard's figures ARE the
     * board's counters rather than a page of them, and the SQL that restates
     * `slaState` agrees with `slaState` on rows placed either side of its
     * branches.
     */
    const [site] = (await tx.execute<{ id: string; customer_id: string }>(sql`
      select id, customer_id from properties where deleted_at is null order by created_at limit 1
    `)) as unknown as { id: string; customer_id: string }[];

    if (site) {
      const workNow = new Date();
      const MIN = 60_000;
      // Per-run, so a killed run's orphans can never be mistaken for this
      // run's fixtures and the cleanup below can be anchored to exactly one
      // run's rows.
      const workRun = Date.now().toString(36).slice(-6).toUpperCase();
      const workRef = `${TAG}-${workRun}`;

      const workFixtures = [
        {
          suffix: "W1",
          priority: "p1_emergency",
          sla: "breached" as const,
          createdAt: new Date(workNow.getTime() - 200 * MIN),
          resolveByAt: new Date(workNow.getTime() - 10 * MIN),
        },
        {
          suffix: "W2",
          priority: "p1_emergency",
          sla: "on_track" as const,
          createdAt: new Date(workNow.getTime() - 5 * MIN),
          resolveByAt: new Date(workNow.getTime() + 1000 * MIN),
        },
        {
          suffix: "W3",
          priority: "p2_urgent",
          sla: "breached" as const,
          createdAt: new Date(workNow.getTime() - 200 * MIN),
          resolveByAt: new Date(workNow.getTime() - 1 * MIN),
        },
        // No deadline at all. `slaState` calls this "none", and the SQL mirror
        // has to agree that it is open and not breached — a null resolve_by_at
        // read as a missed deadline is the classic way this arithmetic goes
        // wrong.
        {
          suffix: "W4",
          priority: "p4_planned",
          sla: "none" as const,
          createdAt: workNow,
          resolveByAt: null,
        },
      ];

      const beforeCounts = await dispatchBoardCounts(tx, workNow);
      const beforeByPriority = await dispatchBoardCountsByPriority(tx, workNow);
      const beforeWork = (await ownerDashboard(tx, { now: workNow })).work;

      for (const f of workFixtures) {
        await tx.execute(sql`
          insert into jobs (tenant_id, reference, customer_id, property_id, service_slug,
                            title, status, priority, created_at, resolve_by_at)
          values (${tenantId}::uuid, ${`${workRef}-${f.suffix}`}, ${site.customer_id}::uuid,
                  ${site.id}::uuid, 'hvac-installation-maintenance',
                  ${`${TAG} work ${f.suffix}`}, 'triaged', ${f.priority}::job_priority,
                  ${f.createdAt.toISOString()}::timestamptz,
                  ${f.resolveByAt ? f.resolveByAt.toISOString() : null}::timestamptz)
        `);
        check(
          `slaState puts fixture ${f.suffix} in ${f.sla}`,
          slaState({
            createdAt: f.createdAt,
            resolveByAt: f.resolveByAt,
            completedAt: null,
            now: workNow,
          }),
          f.sla,
        );
      }

      const afterCounts = await dispatchBoardCounts(tx, workNow);
      const afterByPriority = await dispatchBoardCountsByPriority(tx, workNow);
      const afterWork = (await ownerDashboard(tx, { now: workNow })).work;

      const priorityDelta = (priority: string, key: "jobs" | "breached") =>
        (afterByPriority.find((r) => r.priority === priority)?.[key] ?? 0) -
        (beforeByPriority.find((r) => r.priority === priority)?.[key] ?? 0);

      check("both emergencies are counted under their own priority", priorityDelta("p1_emergency", "jobs"), 2);
      check(
        "and the SQL breach filter agrees with slaState about which of them is late",
        priorityDelta("p1_emergency", "breached"),
        1,
      );
      check("the urgent one lands in its own row", priorityDelta("p2_urgent", "jobs"), 1);
      check("and is counted as breached there", priorityDelta("p2_urgent", "breached"), 1);
      check("a job with no deadline is open", priorityDelta("p4_planned", "jobs"), 1);
      check("and is never breached, because it has nothing to miss", priorityDelta("p4_planned", "breached"), 0);

      // Absolute, not a delta, and deliberately so: two aggregates over the
      // same rows have to agree exactly, whatever else is in the database. A
      // breakdown that does not add up to its own total is the failure this
      // whole file was written about.
      const sumOf = (key: "jobs" | "breached") =>
        afterByPriority.reduce((n, r) => n + r[key], 0);
      check("the per-priority rows add up to the board's open count", sumOf("jobs"), afterCounts.open);
      check("and their breaches add up to the board's breach count", sumOf("breached"), afterCounts.breached);

      check("the dashboard's open count IS the board's, not a page of it", afterWork.openJobs, afterCounts.open);
      check("as is the number breaching now", afterWork.breachingNow, afterCounts.breached);
      check("and the unassigned count", afterWork.unassigned, afterCounts.unassigned);
      check("the Work card sees all four new jobs", afterWork.openJobs - beforeWork.openJobs, 4);
      check("and both of the late ones", afterWork.breachingNow - beforeWork.breachingNow, 2);
      check(
        "nobody has been sent to any of them, so all four are unassigned",
        afterWork.unassigned - beforeWork.unassigned,
        4,
      );

      const dashboardDelta = (priority: string) =>
        (afterWork.byPriority.find((r) => r.priority === priority)?.jobs ?? 0) -
        (beforeWork.byPriority.find((r) => r.priority === priority)?.jobs ?? 0);
      check("and the card's emergency row moves with them", dashboardDelta("p1_emergency"), 2);

      // Anchored to this run's reference prefix. A cleanup that swept `TAG%`
      // would take a concurrent run's fixtures with it — which is exactly how
      // one suite in this repository was deleting another's rows mid-run.
      const workLike = `${workRef}-%`;
      await tx.execute(
        sql`delete from product_events where entity_id in (select id from jobs where reference like ${workLike})`,
      );
      await tx.execute(
        sql`delete from job_events where job_id in (select id from jobs where reference like ${workLike})`,
      );
      await tx.execute(sql`delete from jobs where reference like ${workLike}`);
    } else {
      console.log("skip  no property to raise a job against — seed the database for the Work card checks");
    }

    // ── Cleanup ────────────────────────────────────────────────────────────
    // withTenant commits, so the fixtures are deleted rather than rolled back —
    // the same reason compliance.test.ts does it this way.
    await tx.execute(sql`delete from credit_notes where reason_detail = ${TAG}`);
    await tx.execute(sql`delete from payments where reference = ${TAG}`);
    await tx.execute(sql`delete from invoices where notes = ${TAG}`);
    await tx.execute(sql`delete from product_events where entity_id = ${lead.id}::uuid`);
    await tx.execute(sql`delete from leads where message = ${TAG}`);
  });

  // ── 6. Reconstructing one record's history (ADM-7) ────────────────────────
  //
  // Deliberately outside the transaction above, and deliberately one
  // transaction per change: `occurred_at` is `now()`, which in Postgres is the
  // *transaction* timestamp. Two writes inside one transaction share it
  // exactly, and `audit_log` has no sequence to break the tie — the id is a
  // random uuid. A fixture that edited the row in the transaction that created
  // it would be asserting an order the evidence does not contain, and would
  // pass or fail on which uuid sorted first.
  //
  // A customer rather than an invoice: it is audited, it needs three columns,
  // and it drags in no article-59 constraint that the fixture would have to
  // work around.
  console.log("\n— record reconstruction (ADM-7) —");

  const historyName = `${TAG}-HISTORY`;
  const historyCode = `HIST-${Date.now()}`;
  const PHONE = "+971500000001";

  const historyId = await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    const rows = (await tx.execute<{ id: string }>(sql`
      insert into customers (tenant_id, code, name)
      values (${tenantId}::uuid, ${historyCode}, ${historyName})
      returning id
    `)) as unknown as { id: string }[];
    return rows[0]!.id;
  });

  await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    await tx.execute(sql`update customers set phone = ${PHONE} where id = ${historyId}::uuid`);
  });
  await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    await tx.execute(sql`update customers set payment_terms_days = 45 where id = ${historyId}::uuid`);
  });

  await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    const history = await recordHistory(tx, { tableName: "customers", recordId: historyId });

    // The record was created by this test, so its entire history *is* the
    // delta — three is the number of changes made above and nothing else can
    // have touched it.
    check("a record's history holds every change made to it and no others", history.length, 3);
    checkTrue(
      "and spans more than one kind of action, which is what makes it a history",
      new Set(history.map((e) => e.action)).size > 1,
    );
    checkTrue(
      "it runs oldest first, because reconstruction means replaying forwards",
      history.every(
        (e, i) => i === 0 || history[i - 1]!.occurredAt.getTime() <= e.occurredAt.getTime(),
      ),
    );
    check(
      "the first entry is the creation, which is the state every later diff replays onto",
      history[0]?.action,
      "insert",
    );
    checkTrue(
      "and it carries the whole row rather than a diff",
      Object.keys(history[0]?.changedFields ?? {}).includes("__new"),
    );
    checkTrue(
      "an update records the column that changed and not updated_at",
      Object.keys(history[1]?.changedFields ?? {}).includes("phone") &&
        !Object.keys(history[1]?.changedFields ?? {}).includes("updated_at"),
    );

    /*
     * The reconstruction itself.
     *
     * `ADM-7` says "able to reconstruct any record's history", and this is what
     * that sentence means operationally: take the created row, apply each diff
     * in order, and arrive at the row as it stands. An ordering bug, a diff
     * written with old and new the wrong way round, or a missing first entry
     * all fail here and nowhere else.
     */
    const created = (history[0]?.changedFields?.["__new"] ?? {}) as Record<string, unknown>;
    const replayed: Record<string, unknown> = { ...created };
    for (const entry of history.slice(1)) {
      for (const [column, change] of Object.entries(entry.changedFields ?? {})) {
        replayed[column] = (change as { new?: unknown }).new;
      }
    }
    check("replaying the diffs onto the created row reproduces the phone", replayed["phone"], PHONE);
    check(
      "and the payment terms, which the second update changed",
      replayed["payment_terms_days"],
      45,
    );
    check("while the untouched columns are still the ones it was created with", replayed["code"], historyCode);

    // The feed and the history are the same rows read in opposite directions.
    // If this ever stops holding, one of the two screens is lying about time.
    const feed = await auditTrail(tx, { tableName: "customers", recordId: historyId });
    check("the feed's newest is the history's last", feed.entries[0]?.id, history.at(-1)?.id);
    check("and the feed's oldest is where the history starts", feed.entries.at(-1)?.id, history[0]?.id);

    const unknown = await recordHistory(tx, {
      tableName: "customers",
      recordId: "00000000-0000-4000-8000-000000000000",
    });
    check("an id with nothing logged returns empty rather than throwing", unknown.length, 0);
  });

  // Tenant scoping. The rows are committed by now, so an empty result here is
  // the RLS policy and not an uncommitted transaction, and the assertion above
  // proves the same call returns three rows on the side of the boundary that
  // owns them. Unconditional: `otherTenantId()` threw at the top if there were
  // no boundary to cross.
  const leaked = await withTenant({ tenantId: foreignTenantId, actorKind: "system" }, async (tx) =>
    recordHistory(tx, { tableName: "customers", recordId: historyId }),
  );
  check("another tenant reconstructs nothing from this record", leaked.length, 0);

  await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    await tx.execute(sql`delete from customers where name = ${historyName}`);
  });

  // ── 6b. INV-16 accounting export, INV-17 corporate tax pack ───────────────
  //
  // ── WHAT THESE CHECKS ARE DEFENDING ─────────────────────────────────────
  //
  //  1. **Silent truncation.** This repository has shipped a capped list read
  //     as a complete one five times in two days. An accounting export is the
  //     worst place for the sixth: 200 tidy rows handed to an accountant is a
  //     well-formed file and a wrong set of books. So the export's own row
  //     count is asserted against `count(*)` over the same predicate, and the
  //     batching loop is driven past its batch boundary with real rows.
  //  2. **A tax-period boundary computed in the wrong timezone.** Revenue in
  //     the wrong period misstates a threshold whose breach permanently ends
  //     Small Business Relief. The pack's boundaries are asserted to be
  //     calendar-year and its current-period figure is asserted **equal** to
  //     the dashboard's, so the two screens cannot disagree.
  //  3. **A credit note that stops subtracting.** Asserted as a delta, to the
  //     fil, on both the pack and the export's journal.
  console.log("\n— INV-17: revenue by tax period —");

  /*
   * The permanence rule, which is the whole of INV-17 and is not testable
   * against the database because it is about periods that have already closed.
   *
   * A business at AED 3.1m in 2026 and AED 1m in 2027 has no relief in 2027.
   * The dashboard's single-period meter reads that 2027 as "clear" — correctly,
   * for the question it asks — which is exactly why this fold exists.
   */
  const periodFixture = (period: string, revenueMinor: number): TaxPeriodRevenue => ({
    period,
    startsOn: `${period}-01-01`,
    endsOn: `${period}-12-31`,
    invoicedMinor: revenueMinor,
    creditedMinor: 0,
    revenueMinor,
    invoices: 1,
    creditNotes: 0,
    complete: true,
    elapsedDays: 365,
    totalDays: 365,
  });

  const carried = taxPeriodPositions([
    periodFixture("2026", SMALL_BUSINESS_RELIEF_THRESHOLD_MINOR + 100),
    periodFixture("2027", 100_000_00),
  ]);
  check("the period that crosses the line reads as breached", carried[0]?.standing, "breached");
  check(
    "and a later period well under the line is disqualified, not clear",
    carried[1]?.standing,
    "disqualified",
  );
  check(
    "the disqualifying period is named, so the reader can go and look at it",
    carried[1]?.disqualifyingPeriod,
    "2026",
  );
  checkTrue(
    "the later period's own arithmetic still says it is under the line",
    carried[1]?.relief.state === "clear",
  );

  // Order is not trusted. A query that returned 2027 first would otherwise
  // report the relief intact, and nothing in the output would show it.
  const reversed = taxPeriodPositions([
    periodFixture("2027", 100_000_00),
    periodFixture("2026", SMALL_BUSINESS_RELIEF_THRESHOLD_MINOR + 100),
  ]);
  check("input order cannot change the verdict", reversed[1]?.standing, "disqualified");

  const afterScheme = taxPeriodPositions([periodFixture("2030", 100_000_00)]);
  check(
    "a period ending after 31 December 2029 is outside the scheme entirely",
    afterScheme[0]?.standing,
    "unavailable",
  );
  check(
    "and the scheme's last day is the one the PRD names",
    SMALL_BUSINESS_RELIEF_FINAL_PERIOD_END,
    "2029-12-31",
  );

  const runRate = taxPeriodPositions([
    {
      ...periodFixture("2026", 150_000_00),
      complete: false,
      elapsedDays: 180,
      totalDays: 360,
    },
  ]);
  check(
    "a half-elapsed period at AED 1.5m projects to AED 3.0m",
    runRate[0]?.projectedRevenueMinor,
    300_000_00,
  );

  const tooEarly = taxPeriodPositions([
    {
      ...periodFixture("2026", 150_000_00),
      complete: false,
      elapsedDays: PROJECTION_MINIMUM_ELAPSED_DAYS - 1,
      totalDays: 365,
    },
  ]);
  check(
    "and three weeks of January projects nothing at all, rather than AED 25m",
    tooEarly[0]?.projectedRevenueMinor,
    null,
  );
  check(
    "a finished period has an actual, so it carries no projection beside it",
    carried[0]?.projectedRevenueMinor,
    null,
  );

  // ── The CSV writer ────────────────────────────────────────────────────────
  console.log("\n— INV-16: the CSV writer —");

  check("a comma forces quoting", csvField("Al Barsha, Dubai"), '"Al Barsha, Dubai"');
  check('a quote is doubled', csvField('The "Palm" tower'), '"The ""Palm"" tower"');
  check("a newline forces quoting", csvField("line one\nline two"), '"line one\nline two"');
  check("trailing space is preserved by quoting", csvField("Serai "), '"Serai "');
  check("a plain value is not quoted", csvField("SERAI"), "SERAI");
  check("null is an empty cell, not the word null", csvField(null), "");

  /*
   * CSV injection. Customer names in this system arrive from a public lead form
   * and from operators typing, and the file goes to somebody outside the
   * business. A name beginning `=` is a formula in every spreadsheet there is.
   */
  check(
    "a leading = is neutralised before it reaches a spreadsheet",
    csvField('=HYPERLINK("http://evil","Click")'),
    `"'=HYPERLINK(""http://evil"",""Click"")"`,
  );
  check("and a leading @", csvField("@SUM(A1:A9)"), "'@SUM(A1:A9)");

  /*
   * The reason amounts have their own type. A credit rendered as text would be
   * caught by the guard above and arrive as `'-1000.00`, which imports as a
   * label rather than a number — a whole column of them and the ledger is out.
   */
  check("a negative amount survives the formula guard intact", csvField(csvAmount(-100_000)), "-1000.00");
  check("and minor units become a decimal exactly once", csvField(csvAmount(123_456)), "1234.56");

  const trailerTable: ExportTable = {
    name: "sample",
    title: "Sample",
    columns: ["reference", "total_incl_vat"],
    rows: [["INV-1", csvAmount(105_000)]],
    rowCount: 1,
  };
  checkTrue(
    "the file states its own row count, so a short file is visibly short",
    toCsv(trailerTable).includes("# sample: 1 rows"),
  );
  checkTrue("and it ends its lines with CRLF", toCsv(trailerTable).includes("\r\n"));

  // ── The journal ───────────────────────────────────────────────────────────
  console.log("\n— INV-16: the general journal —");

  const sampleInvoice = {
    reference: "INV-2026-00001",
    date: "2026-03-01",
    contact: "Serai Tower Owners Association",
    currency: "AED",
    taxCode: "S",
    taxableMinor: 100_000,
    taxMinor: 5_000,
    totalMinor: 105_000,
  };

  const invoicePostings = documentJournalLines(sampleInvoice, "invoice");
  check("an invoice posts three lines", invoicePostings.length, 3);
  checkTrue("and it balances", journalTotals(invoicePostings).balanced);
  check(
    "receivables is debited with the VAT-INCLUSIVE total",
    invoicePostings.find((l) => l.accountCode === "1100")?.debitMinor,
    105_000,
  );
  check(
    "revenue is credited with the VAT-EXCLUSIVE amount, never the gross",
    invoicePostings.find((l) => l.accountCode === "4000")?.creditMinor,
    100_000,
  );
  check(
    "and the VAT is a liability rather than income",
    invoicePostings.find((l) => l.accountCode === "2100")?.creditMinor,
    5_000,
  );

  const creditPostings = documentJournalLines({ ...sampleInvoice, reference: "CRN-1" }, "credit_note");
  checkTrue("a credit note balances too", journalTotals(creditPostings).balanced);
  check(
    "and it reverses every side — receivables is credited",
    creditPostings.find((l) => l.accountCode === "1100")?.creditMinor,
    105_000,
  );
  check(
    "with revenue debited back off",
    creditPostings.find((l) => l.accountCode === "4000")?.debitMinor,
    100_000,
  );

  const bothWays = journalTotals([...invoicePostings, ...creditPostings]);
  check("an invoice and its full credit note net to nothing", bothWays.debitMinor, bothWays.creditMinor);

  // A document whose stored total disagrees with taxable + tax gets a visible
  // rounding line rather than an unbalanced journal the import will reject.
  const wonky = documentJournalLines({ ...sampleInvoice, totalMinor: 105_001 }, "invoice");
  check("a one-fil discrepancy produces a fourth, named line", wonky.length, 4);
  checkTrue("and the journal still balances", journalTotals(wonky).balanced);
  check(
    "on an account whose name says what it is",
    wonky.find((l) => l.accountCode === "9999")?.accountName,
    "Rounding difference",
  );

  const receipt = paymentJournalLines({
    reference: "TT-9931",
    date: "2026-03-20",
    contact: "Serai Tower Owners Association",
    currency: "AED",
    amountMinor: 105_000,
    method: "bank_transfer",
    invoiceReference: "INV-2026-00001",
  });
  checkTrue("a receipt balances", journalTotals(receipt).balanced);
  check("it debits the bank", receipt.find((l) => l.debitMinor > 0)?.accountCode, "1010");
  check("and credits receivables", receipt.find((l) => l.creditMinor > 0)?.accountCode, "1100");
  checkTrue(
    "and posts no VAT — the output tax was accounted for when the invoice was issued",
    receipt.every((l) => l.accountCode !== "2100"),
  );

  const offset = paymentJournalLines({
    reference: "OFFSET",
    date: "2026-03-20",
    contact: "Serai Tower Owners Association",
    currency: "AED",
    amountMinor: 1_000,
    method: "credit_note",
    invoiceReference: "INV-2026-00001",
  });
  check(
    "a settlement recorded as a credit note does not claim cash arrived",
    offset.find((l) => l.debitMinor > 0)?.accountCode,
    "1150",
  );

  // ── Against the database ──────────────────────────────────────────────────
  console.log("\n— INV-16/17 against the database —");

  // Unique to this run. Nine suites can be running at once against one
  // database, and a cleanup anchored to a shared prefix takes another run's
  // fixtures with it.
  const runTag = `EXP-${Date.now().toString(36)}`;
  const invoiceRef = `${runTag}-I1`;
  const creditRef = `${runTag}-C1`;

  await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    const [customer] = (await tx.execute<{ id: string }>(sql`
      select id from customers where deleted_at is null order by created_at limit 1
    `)) as unknown as { id: string }[];

    if (!customer) {
      console.log("skip  no customer to invoice — seed the database for the export checks");
      return;
    }

    const packBefore = await corporateTaxPack(tx);
    const revenueBefore = packBefore.current?.period.revenueMinor ?? 0;

    await tx.execute(sql`
      insert into invoices (tenant_id, reference, customer_id, status, issued_on, due_on, supply_date,
                            supplier_name, recipient_name,
                            subtotal, taxable_amount, tax_amount, total, amount_paid, notes)
      values (${tenantId}::uuid, ${invoiceRef}, ${customer.id}::uuid, 'issued', now(), now() + interval '30 days',
              current_date, ${`${runTag} supplier`}, ${`${runTag} recipient`},
              1000.00, 1000.00, 50.00, 1050.00, 0.00, ${runTag})
    `);

    const packAfter = await corporateTaxPack(tx);
    check(
      "issuing AED 1,000 ex-VAT moves this tax period by exactly 100000 fils",
      (packAfter.current?.period.revenueMinor ?? 0) - revenueBefore,
      100_000,
    );
    check(
      "and the invoice count moves with it, so a round figure can be checked",
      (packAfter.current?.period.invoices ?? 0) - (packBefore.current?.period.invoices ?? 0),
      1,
    );

    /*
     * The assertion this whole requirement turns on.
     *
     * The owner dashboard's meter and the tax pack both measure revenue against
     * AED 3,000,000. If they ever disagreed, the business would believe
     * whichever screen it read first, and one breach is permanent. They share a
     * SQL fragment rather than resembling each other, and this is what proves
     * the sharing has not been undone.
     */
    const dashboard = await ownerDashboard(tx);
    check(
      "the tax pack and the dashboard report the same revenue, to the fil",
      packAfter.current?.period.revenueMinor,
      dashboard.revenue.yearToDateMinor,
    );

    const current = packAfter.current;
    checkTrue("the current period is resolved, not left null", current !== null);
    checkTrue(
      "its boundaries are a calendar year in Asia/Dubai, computed in SQL",
      current?.period.startsOn.endsWith("-01-01") === true &&
        current?.period.endsOn.endsWith("-12-31") === true,
    );
    check(
      "and the period is labelled with its own year",
      current?.period.period,
      current?.period.startsOn.slice(0, 4),
    );
    checkTrue(
      "a period in progress is not reported as complete",
      current?.period.complete === false,
    );
    checkTrue(
      "and no more of it has elapsed than it contains",
      (current?.period.elapsedDays ?? 0) <= (current?.period.totalDays ?? 0),
    );

    await tx.execute(sql`
      insert into credit_notes (tenant_id, reference, invoice_id, customer_id, reason,
                                issued_on, subtotal, taxable_amount, tax_amount, total, reason_detail)
      select ${tenantId}::uuid, ${creditRef}, i.id, i.customer_id, 'correction',
             now(), 400.00, 400.00, 20.00, 420.00, ${runTag}
        from invoices i where i.reference = ${invoiceRef}
    `);

    const packCredited = await corporateTaxPack(tx);
    check(
      "a AED 400 credit note comes straight back off the period's revenue",
      (packCredited.current?.period.revenueMinor ?? 0) - revenueBefore,
      60_000,
    );
    check(
      "and the gross invoiced figure is still reported beside it, not folded away",
      (packCredited.current?.period.invoicedMinor ?? 0) -
        (packBefore.current?.period.invoicedMinor ?? 0),
      100_000,
    );

    /*
     * Through `recordPayment` rather than an INSERT, and that is the point of
     * the assertion it feeds. The export's `balance_incl_vat` is computed from
     * `invoices.amount_paid`, which is a denormalisation that only the domain
     * function maintains — a raw INSERT leaves it at zero and the exported
     * balance is then wrong by the whole payment. Exercising the real path is
     * what makes the balance check below mean something.
     */
    const [invoiceRow] = (await tx.execute<{ id: string }>(
      sql`select id from invoices where reference = ${invoiceRef}`,
    )) as unknown as { id: string }[];
    await recordPayment(tx, { tenantId }, {
      invoiceId: invoiceRow!.id,
      amount: "630.00",
      method: "bank_transfer",
      reference: runTag,
    });

    // ── The export ──────────────────────────────────────────────────────────
    //
    // Everything below reads the PARSED CSV, not the object the export
    // returned. A writer that quotes wrongly, drops a column or emits a header
    // that does not line up with its rows is invisible to an assertion on the
    // in-memory structure and obvious to one that reads the file back.
    /*
     * DUBAI'S DAY, NOT UTC'S.
     *
     * This read `new Date().toISOString().slice(0, 10)` and it was wrong for
     * two hours out of every twenty-four. The export filters on
     * `issued_on at time zone 'Asia/Dubai'`; an invoice issued at `now()`
     * between midnight and 02:00 Dubai therefore belongs to a day that UTC has
     * not reached yet, so a range ending on UTC's day excluded it — and with it
     * every row the eight assertions below look for.
     *
     * The bug is invisible for twenty-two hours a day, which is why it survived
     * the run that wrote it and failed the one that gated the wave. Deriving
     * the fixture's day from the same clock the query reads is what makes the
     * assertions mean anything.
     */
    const todayDubai = today();
    const exported = await accountingExport(tx, { from: `${todayDubai.slice(0, 4)}-01-01`, to: todayDubai });

    const parsed = (table: ExportTable) => parseCsv(toCsv(table));

    const invoiceCsv = parsed(exported.tables.invoices);
    const header = invoiceCsv.header;
    const mine = invoiceCsv.rows.find((r) => r[header.indexOf("invoice_reference")] === invoiceRef);
    checkTrue("the invoice is in the exported file", mine !== undefined);
    check(
      "its taxable amount is exported VAT-EXCLUSIVE, to the fil",
      mine?.[header.indexOf("taxable_amount_excl_vat")],
      "1000.00",
    );
    check(
      "its total is exported VAT-INCLUSIVE, under a heading that says so",
      mine?.[header.indexOf("total_incl_vat")],
      "1050.00",
    );
    check("the VAT rate is a percentage, not basis points", mine?.[header.indexOf("vat_rate_percent")], "5");
    check(
      "the balance is net of both the payment and the credit note",
      mine?.[header.indexOf("balance_incl_vat")],
      "0.00",
    );
    checkTrue(
      "every money column says whether it is VAT-inclusive or VAT-exclusive",
      header
        .filter((c) => /amount|total|balance|subtotal|discount|credited|paid/.test(c))
        .every((c) => c.endsWith("_excl_vat") || c.endsWith("_incl_vat") || c === "vat_amount"),
    );

    const creditCsv = parsed(exported.tables.credit_notes);
    const creditRow = creditCsv.rows.find(
      (r) => r[creditCsv.header.indexOf("credit_note_reference")] === creditRef,
    );
    checkTrue("the credit note is exported too", creditRow !== undefined);
    check(
      "keyed to the invoice it credits, which Article 60 requires",
      creditRow?.[creditCsv.header.indexOf("original_invoice_reference")],
      invoiceRef,
    );

    /*
     * The control total. The receivables schedule an accountant reconciles and
     * the outstanding figure the dashboard shows are one calculation folded two
     * ways — `arAgeing` is a fold over `openReceivables` — and this is what
     * proves the fold has not been replaced by a second query.
     */
    const ageing = await arAgeing(tx);
    const receivableCsv = parsed(exported.tables.receivables);
    const outstandingColumn = receivableCsv.header.indexOf("outstanding_incl_vat");
    const scheduleTotal = receivableCsv.rows.reduce(
      (sum, r) => sum + Math.round(Number(r[outstandingColumn]) * 100),
      0,
    );
    check(
      "the AR schedule sums to the AR control total, to the fil",
      scheduleTotal,
      ageing.totalOutstandingMinor,
    );

    const journalCsv = parsed(exported.tables.journal);
    const debitColumn = journalCsv.header.indexOf("debit");
    const creditColumn = journalCsv.header.indexOf("credit");
    const debits = journalCsv.rows.reduce((s, r) => s + Math.round(Number(r[debitColumn]) * 100), 0);
    const credits = journalCsv.rows.reduce((s, r) => s + Math.round(Number(r[creditColumn]) * 100), 0);
    check("the exported journal balances — an unbalanced one is rejected on import", debits, credits);
    check("and the in-memory total agrees with the parsed file", debits, exported.journalBalance.debitMinor);
    checkTrue("which the export reports as balanced", exported.journalBalance.balanced);

    const revenueLines = journalCsv.rows.filter(
      (r) => r[journalCsv.header.indexOf("account_code")] === "4000",
    );
    const revenueNet = revenueLines.reduce(
      (s, r) => s + Math.round(Number(r[creditColumn]) * 100) - Math.round(Number(r[debitColumn]) * 100),
      0,
    );
    checkTrue(
      "the credit note debits revenue back off in the journal, as it does in the pack",
      revenueNet < debits,
    );

    // ── Truncation ──────────────────────────────────────────────────────────
    //
    // The export's row count is asserted against `count(*)` over the same
    // predicate, inside the same transaction so the two see one snapshot while
    // eight other suites write to the same database.
    const [invoiceCount] = (await tx.execute<{ n: string }>(sql`
      select count(*)::text as n
        from invoices
       where deleted_at is null
         and status <> 'draft'
         and issued_on is not null
         and (issued_on at time zone 'Asia/Dubai') >= ${`${todayDubai.slice(0, 4)}-01-01`}::date
         and (issued_on at time zone 'Asia/Dubai') < ${todayDubai}::date + interval '1 day'
    `)) as unknown as { n: string }[];

    check(
      "the export holds every invoice in the range, not a page of them",
      exported.tables.invoices.rowCount,
      Number(invoiceCount?.n ?? -1),
    );
    check(
      "and the stated count is the number of rows actually written",
      exported.tables.invoices.rowCount,
      invoiceCsv.rows.length,
    );

    /*
     * Now drive the batching loop past its boundary with real rows.
     *
     * The internal batch is 500. A loop that stopped after one round trip would
     * be invisible to every assertion above, because a seeded database has
     * fewer than 500 of anything. 501 payments is the smallest fixture that
     * proves the second round trip happens and that the keyset carries across
     * it — and because `now()` is transaction-stable, all 501 share one
     * timestamp, so the boundary is crossed on the id tiebreak alone, which is
     * the harder half.
     */
    const paymentsBefore = exported.tables.payments.rowCount;
    await tx.execute(sql`
      insert into payments (tenant_id, invoice_id, amount, method, reference, received_at)
      select ${tenantId}::uuid, i.id, 0.01, 'cash', ${`${runTag}-BULK`}, now()
        from invoices i, generate_series(1, 501)
       where i.reference = ${invoiceRef}
    `);

    const bulk = await accountingExport(tx, { from: `${todayDubai.slice(0, 4)}-01-01`, to: todayDubai });
    check(
      "501 more payments appear in the export, every one of them",
      bulk.tables.payments.rowCount - paymentsBefore,
      501,
    );
    const bulkCsv = parseCsv(toCsv(bulk.tables.payments));
    check("and every one of them is written to the file", bulkCsv.rows.length, bulk.tables.payments.rowCount);
    check(
      "the file's own trailer states the same number",
      toCsv(bulk.tables.payments).includes(`# payments: ${bulk.tables.payments.rowCount} rows`),
      true,
    );
    const bulkIds = new Set(bulkCsv.rows.map((r) => r[bulkCsv.header.indexOf("payment_id")]));
    check("with no row repeated across the batch boundary", bulkIds.size, bulkCsv.rows.length);
    checkTrue("and the journal still balances at 501 more receipts", bulk.journalBalance.balanced);

    // A range that ends before it starts is refused rather than silently
    // returning an empty, importable, wrong file.
    let badRangeRefused = false;
    try {
      await accountingExport(tx, { from: "2026-12-31", to: "2026-01-01" });
    } catch {
      badRangeRefused = true;
    }
    checkTrue("a backwards date range is refused, not exported empty", badRangeRefused);

    /*
     * The tenant boundary, on the one file that contains every customer's
     * ledger.
     *
     * `withTenant` scopes the queries, and this is what proves it rather than
     * assuming it. An export that crossed tenants would hand one company's
     * customers, prices and TRNs to another company's accountant — and unlike a
     * screen, the file leaves the building.
     */
    const foreign = await withTenant({ tenantId: foreignTenantId, actorKind: "system" }, (t2) =>
      accountingExport(t2, { from: `${todayDubai.slice(0, 4)}-01-01`, to: todayDubai }),
    );
    const foreignCsv = parseCsv(toCsv(foreign.tables.invoices));
    checkTrue(
      "another tenant's accounting export contains none of this tenant's invoices",
      !foreignCsv.rows.some(
        (r) => r[foreignCsv.header.indexOf("invoice_reference")] === invoiceRef,
      ),
    );
    const foreignJournal = parseCsv(toCsv(foreign.tables.journal));
    checkTrue(
      "nor does its journal",
      !foreignJournal.rows.some(
        (r) => r[foreignJournal.header.indexOf("document_reference")] === invoiceRef,
      ),
    );

    // ── Cleanup, anchored to this run's tag ─────────────────────────────────
    await tx.execute(sql`delete from payments where reference in (${runTag}, ${`${runTag}-BULK`})`);
    await tx.execute(sql`delete from credit_notes where reason_detail = ${runTag}`);
    await tx.execute(sql`delete from invoices where notes = ${runTag}`);
  });

  // ── 7. Tenant isolation on the new table ──────────────────────────────────
  //
  // `product_events` is written by a SECURITY DEFINER function with an
  // unrestricted INSERT policy, exactly like `audit_log`. That is what lets the
  // seed and the migrations write through the trigger with no tenant context —
  // and it is precisely why the READ side needs proving rather than assuming.
  console.log("\n— tenant isolation —");

  const mine = await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    const rows = (await tx.execute<{ count: string }>(
      sql`select count(*) as count from product_events`,
    )) as unknown as { count: string }[];
    return Number(rows[0]?.count ?? 0);
  });

  const theirs = await withTenant({ tenantId: foreignTenantId, actorKind: "system" }, async (tx) => {
    const rows = (await tx.execute<{ count: string; leaked: string }>(sql`
      select count(*) as count,
             count(*) filter (where tenant_id = ${tenantId}::uuid) as leaked
        from product_events
    `)) as unknown as { count: string; leaked: string }[];
    return { total: Number(rows[0]?.count ?? 0), leaked: Number(rows[0]?.leaked ?? 0) };
  });

  check("the other tenant sees none of this tenant's events", theirs.leaked, 0);
  checkTrue(
    "and the two counts are independent rather than one shared table read twice",
    mine !== theirs.total || mine === 0,
  );

  // ── 8. The log stays append-only from the application role ────────────────
  //
  // `verify-rls.sql` check 8 proves the same thing at the privilege level. This
  // proves it through the connection the viewer actually uses, which is the one
  // an `ADM-7` reader would be tempted to add a "correct this entry" button to.
  let tamperRefused = false;
  try {
    await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
      await tx.execute(sql`update audit_log set action = 'tampered' where false`);
    });
  } catch {
    tamperRefused = true;
  }
  checkTrue("the audit log refuses an UPDATE from the application role", tamperRefused);

  console.log(fail === 0 ? "\nreporting: all checks passed.\n" : `\n${fail} check(s) failed.\n`);
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("reporting test failed to run:", error);
  await closeConnection();
  process.exit(1);
});
