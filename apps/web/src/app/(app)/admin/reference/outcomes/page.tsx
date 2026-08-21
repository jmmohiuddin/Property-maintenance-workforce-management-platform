import type { Metadata } from "next";
import { withTenant } from "@meridian/db";
import { listJobOutcomeCodes, STANDARD_JOB_OUTCOMES } from "@meridian/db/domain";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { ReferenceTabs } from "../tabs";
import { AddOutcomeForm, InstallOutcomesButton, RetireButton } from "../taxonomy-forms";

export const metadata: Metadata = {
  title: "Job outcomes",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * `/admin/reference/outcomes` — `JOB-13`, `ADM-10`.
 *
 * `jobs.outcome_code` has been a bare varchar since the workforce migration,
 * which meant the seven outcomes the requirement names existed in prose and the
 * column would have accepted anything. This is the list it points at.
 *
 * The seven are installed rather than invented: they are prescribed by the
 * requirement, and a deployment that starts with an empty list is a deployment
 * where the first technician to finish a job has nothing valid to record —
 * which is precisely how a free-text field gets added back.
 */
export default async function OutcomesPage() {
  const session = await requireSessionWith("settings:write");

  const outcomes = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    (tx) => listJobOutcomeCodes(tx),
  );

  const present = new Set(outcomes.map((o) => o.code));
  const missingStandard = STANDARD_JOB_OUTCOMES.filter((o) => !present.has(o.code));
  const returnVisitCovered = outcomes.some((o) => o.isActive && o.requiresReturnVisit);

  return (
    <AppShell session={session} active="admin/reference">
      <main id="main" className="container-page py-10">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Job outcomes</h1>
          <p className="prose-body mt-2 max-w-3xl text-[15px]">
            What a technician is allowed to record when a visit ends. The ones worth counting are
            the awkward ones — no access, customer not home, aborted on safety grounds — because
            they are a large share of real visits and they are invisible if the only recorded
            outcome is “done”.
          </p>
        </header>

        <ReferenceTabs active="/admin/reference/outcomes" />

        {outcomes.length === 0 ? (
          <div
            className="mt-8 rounded-sm p-4 text-[14px]"
            style={{ backgroundColor: "var(--status-critical-wash)" }}
          >
            <p className="font-medium">No outcomes have been entered.</p>
            <p className="mt-1">
              A completed visit has nothing valid to record against it, so the outcome will end up
              in the notes field, where no report can reach it. The seven standard outcomes are one
              click away.
            </p>
            <div className="mt-4">
              <InstallOutcomesButton label="Add the seven standard outcomes" />
            </div>
          </div>
        ) : null}

        {outcomes.length > 0 && missingStandard.length > 0 ? (
          <div
            className="mt-8 rounded-sm p-4 text-[14px]"
            style={{ backgroundColor: "var(--status-warning-wash)" }}
          >
            <p className="font-medium">
              {missingStandard.length} of the seven standard outcomes {missingStandard.length === 1 ? "is" : "are"} missing:{" "}
              {missingStandard.map((o) => o.label).join(", ")}.
            </p>
            <p className="mt-1">
              Adding them back leaves your own wording alone — nothing already here is overwritten.
            </p>
            <div className="mt-4">
              <InstallOutcomesButton label="Add the missing ones" />
            </div>
          </div>
        ) : null}

        {outcomes.length > 0 && !returnVisitCovered ? (
          <div
            className="mt-8 rounded-sm p-4 text-[14px]"
            style={{ backgroundColor: "var(--status-warning-wash)" }}
          >
            <p className="font-medium">Every outcome on this list ends the job.</p>
            <p className="mt-1">
              Nothing here says work is still owed, so a locked door and a finished repair look the
              same to the schedule and to every report drawn from it.
            </p>
          </div>
        ) : null}

        {outcomes.length > 0 ? (
          <ul className="mt-8 divide-y border-y">
            {outcomes.map((outcome) => (
              <li
                key={outcome.id}
                className="flex flex-wrap items-baseline justify-between gap-3 py-3"
                style={outcome.isActive ? undefined : { color: "var(--text-secondary)" }}
              >
                <div>
                  <p className="text-[14px] font-medium">
                    {/* The space is load-bearing: without it a screen reader
                        reads the label and the badge as one word. */}
                    {outcome.label}{" "}
                    {outcome.requiresReturnVisit ? (
                      <span
                        className="rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                        style={{
                          backgroundColor: "var(--accent-wash)",
                          color: "var(--accent-text)",
                        }}
                      >
                        work still owed
                      </span>
                    ) : null}
                    {outcome.isActive ? null : (
                      <span className="text-[12px] font-normal" style={{ color: "var(--text-muted)" }}>
                        retired
                      </span>
                    )}
                  </p>
                  {outcome.description ? (
                    <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                      {outcome.description}
                    </p>
                  ) : null}
                  <p className="tnum mt-0.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
                    {outcome.code}
                  </p>
                </div>
                <RetireButton
                  kind="outcome"
                  id={outcome.id}
                  label={outcome.label}
                  isActive={outcome.isActive}
                />
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-8 rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
          <h2 className="text-[14px] font-semibold">Add an outcome</h2>
          <p className="prose-body mt-1 max-w-3xl text-[14px]">
            Only add one if it genuinely happens and none of the existing ones describe it. Every
            extra outcome splits the numbers a little further, and outcomes that mean nearly the
            same thing get chosen at random.
          </p>
          <div className="mt-4">
            <AddOutcomeForm />
          </div>
        </div>

        <p className="mt-10 max-w-3xl text-[13px]" style={{ color: "var(--text-muted)" }}>
          These are what the job screen offers when the work is completed: a job on site cannot be
          moved to work complete without one, which is what makes the first-time-fix rate countable.
          The field app will sync against the same list. Deactivating an outcome removes it from the
          picker and leaves every job that already carries it alone.
        </p>
      </main>
    </AppShell>
  );
}
