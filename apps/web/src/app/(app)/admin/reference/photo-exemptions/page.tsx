import type { Metadata } from "next";
import { withTenant } from "@meridian/db";
import { listPhotoExemptionReasons, STANDARD_PHOTO_EXEMPTION_REASONS } from "@meridian/db/domain";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { ReferenceTabs } from "../tabs";
import { AddPhotoExemptionForm, InstallPhotoExemptionsButton, RetireButton } from "../taxonomy-forms";

export const metadata: Metadata = {
  title: "Photo exemption reasons",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * `/admin/reference/photo-exemptions` — `JOB-15`, `ADM-10`.
 *
 * `JOB-15` will not let a job be completed without an "after" photograph *or an
 * explicit reason-coded exemption*. This is the list that second clause points
 * at, and it is the only legitimate way past the requirement.
 *
 * ── WHY THIS LIST BEING EMPTY IS WORSE THAN THE OTHERS BEING EMPTY ──────────
 *
 * An empty fault-code list means faults go uncoded. An empty list here means
 * the completion gate has no legitimate exit: a technician who genuinely
 * cannot photograph the work — a sealed unit, a data centre that forbids
 * cameras, a job they never got inside — cannot close it at all. Gates with no
 * legitimate exit do not survive contact with a Thursday afternoon. Somebody
 * widens the gate, and a gate widened once stays widened.
 *
 * So the five standard reasons are seeded for every tenant, this screen exists
 * for the sixth that a particular business actually needs, and the empty state
 * below installs the five in one click.
 */
export default async function PhotoExemptionsPage() {
  const session = await requireSessionWith("settings:write");

  // Explicitly the whole list, retired entries included. `listPhotoExemptionReasons`
  // defaults to active-only because its first caller is a picker; an
  // administration screen that hid retired rows would offer no way to restore
  // one.
  const reasons = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    (tx) => listPhotoExemptionReasons(tx, { activeOnly: false }),
  );

  const present = new Set(reasons.map((r) => r.code));
  const missingStandard = STANDARD_PHOTO_EXEMPTION_REASONS.filter((r) => !present.has(r.code));
  const anyActive = reasons.some((r) => r.isActive);

  return (
    <AppShell session={session} active="admin/reference">
      <main id="main" className="container-page py-10">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Photo exemption reasons</h1>
          <p className="prose-body mt-2 max-w-3xl text-[15px]">
            A job cannot be completed without an “after” photograph unless one of these says why
            there is none. The list is short on purpose: every reason on it should be a situation
            that genuinely produces no photograph, never one that excuses forgetting.
          </p>
        </header>

        <ReferenceTabs active="/admin/reference/photo-exemptions" />

        {reasons.length === 0 ? (
          <div
            className="mt-8 rounded-sm p-4 text-[14px]"
            style={{ backgroundColor: "var(--status-critical-wash)" }}
          >
            <p className="font-medium">No reasons have been entered.</p>
            <p className="mt-1">
              Until one exists, a job whose work cannot be photographed cannot be completed at all —
              there is no “after” photo and no way to say why. The five standard reasons are one
              click away.
            </p>
            <div className="mt-4">
              <InstallPhotoExemptionsButton label="Add the five standard reasons" />
            </div>
          </div>
        ) : null}

        {/*
          Rows exist but every one is retired. Not the same problem as an empty
          list and not visible from the count, so it is said separately: the
          picker on the job card is empty either way.
        */}
        {reasons.length > 0 && !anyActive ? (
          <div
            className="mt-8 rounded-sm p-4 text-[14px]"
            style={{ backgroundColor: "var(--status-critical-wash)" }}
          >
            <p className="font-medium">Every reason on this list is retired.</p>
            <p className="mt-1">
              The picker on the job card is empty, so an “after” photograph is now mandatory on
              every job with no way to waive it. Restore one below if that was not intended.
            </p>
          </div>
        ) : null}

        {reasons.length > 0 && missingStandard.length > 0 ? (
          <div
            className="mt-8 rounded-sm p-4 text-[14px]"
            style={{ backgroundColor: "var(--status-warning-wash)" }}
          >
            <p className="font-medium">
              {missingStandard.length} of the five standard reasons{" "}
              {missingStandard.length === 1 ? "is" : "are"} missing:{" "}
              {missingStandard.map((r) => r.label).join(", ")}.
            </p>
            <p className="mt-1">
              Adding them back leaves your own wording alone — nothing already here is overwritten.
            </p>
            <div className="mt-4">
              <InstallPhotoExemptionsButton label="Add the missing ones" />
            </div>
          </div>
        ) : null}

        {reasons.length > 0 ? (
          <ul className="mt-8 divide-y border-y">
            {reasons.map((reason) => (
              <li
                key={reason.id}
                className="flex flex-wrap items-baseline justify-between gap-3 py-3"
                style={reason.isActive ? undefined : { color: "var(--text-secondary)" }}
              >
                <div>
                  <p className="text-[14px] font-medium">
                    {/* The space is load-bearing: without it a screen reader
                        reads the label and the badge as one word. */}
                    {reason.label}{" "}
                    {reason.isActive ? null : (
                      <span className="text-[12px] font-normal" style={{ color: "var(--text-muted)" }}>
                        retired
                      </span>
                    )}
                  </p>
                  {reason.description ? (
                    <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                      {reason.description}
                    </p>
                  ) : null}
                  <p className="tnum mt-0.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
                    {reason.code}
                  </p>
                </div>
                <RetireButton
                  kind="photoExemption"
                  id={reason.id}
                  label={reason.label}
                  isActive={reason.isActive}
                />
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-8 rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
          <h2 className="text-[14px] font-semibold">Add a reason</h2>
          <p className="prose-body mt-1 max-w-3xl text-[14px]">
            Only add one if it genuinely happens and none of the existing ones describe it. Every
            extra reason makes the exemption easier to reach, and the number worth watching is how
            often work is completed with no photograph at all — which stops meaning anything once
            there is a reason that fits every job.
          </p>
          <div className="mt-4">
            <AddPhotoExemptionForm />
          </div>
        </div>

        <p className="mt-10 max-w-3xl text-[13px]" style={{ color: "var(--text-muted)" }}>
          Retiring a reason takes it out of the picker and leaves every job already exempted for it
          showing it, unchanged. There is no delete and there is deliberately nowhere to add one: a
          completed job holds a foreign key to the reason it cites, so removing one would mean
          rewriting that job’s record of why it had no photograph. The field app will sync against
          this same list, so a reason retired here stops being offered on site too.
        </p>
      </main>
    </AppShell>
  );
}
