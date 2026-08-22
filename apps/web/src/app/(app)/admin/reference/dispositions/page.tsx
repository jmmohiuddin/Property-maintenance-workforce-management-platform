import type { Metadata } from "next";
import { withTenant } from "@meridian/db";
import { listDispositionReasons } from "@meridian/db/domain";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { ReferenceTabs } from "../tabs";
import { AddDispositionForm, InstallDispositionsButton, RetireButton } from "../taxonomy-forms";

export const metadata: Metadata = {
  title: "Lost and dormant reasons",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const SCOPE_LABEL: Record<string, string> = {
  both: "Lost or dormant",
  lost: "Lost only",
  dormant: "Dormant only",
};

/**
 * `/admin/reference/dispositions` — `LEAD-6`, `ADM-10`.
 *
 * The list a lead has to be closed against. `setLeadStage` refuses `lost` and
 * `dormant` without one of these, so an empty list is not a cosmetic gap: it
 * means nobody can close a lead at all, and it is the one state on this screen
 * that has to be shouted about rather than mentioned.
 */
export default async function DispositionsPage() {
  const session = await requireSessionWith("settings:write");

  const reasons = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    (tx) => listDispositionReasons(tx),
  );

  const active = reasons.filter((r) => r.isActive);
  const retired = reasons.filter((r) => !r.isActive);
  const lostCovered = active.some((r) => r.appliesTo === "lost" || r.appliesTo === "both");
  const dormantCovered = active.some((r) => r.appliesTo === "dormant" || r.appliesTo === "both");

  return (
    <AppShell session={session} active="admin/reference">
      <main id="main" className="container-page py-10">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Lost and dormant reasons</h1>
          <p className="prose-body mt-2 max-w-3xl text-[15px]">
            The list a lead has to be closed against. Free text is refused — not to make life
            harder, but because “too expensive”, “Price” and “cost” are one reason typed three ways,
            and no report can put them back together afterwards.
          </p>
        </header>

        <ReferenceTabs active="/admin/reference/dispositions" />

        {active.length === 0 ? (
          <div
            className="mt-8 rounded-sm p-4 text-[14px]"
            style={{ backgroundColor: "var(--status-critical-wash)" }}
          >
            <p className="font-medium">No reasons have been entered, so no lead can be closed.</p>
            <p className="mt-1">
              Marking a lead lost or dormant requires one of these, and the list is empty — the
              stage change is refused until something is here. Six reasons that come up in nearly
              every business are one click away: price, chose a competitor, stopped responding,
              outside the service area, work no longer needed, budget deferred. Add, retire or
              reword any of them afterwards.
            </p>
            <div className="mt-4">
              <InstallDispositionsButton label="Add the standard reasons" />
            </div>
          </div>
        ) : !lostCovered || !dormantCovered ? (
          <div
            className="mt-8 rounded-sm p-4 text-[14px]"
            style={{ backgroundColor: "var(--status-warning-wash)" }}
          >
            <p className="font-medium">
              {lostCovered
                ? "Nothing on this list applies to dormant leads."
                : "Nothing on this list applies to lost leads."}
            </p>
            <p className="mt-1">
              That stage cannot be used until a reason covers it, so leads that belong there will
              sit in the pipeline looking live.
            </p>
          </div>
        ) : null}

        {active.length > 0 ? (
          <ul className="mt-8 divide-y border-y">
            {active.map((reason) => (
              <li key={reason.id} className="flex flex-wrap items-baseline justify-between gap-3 py-3">
                <div>
                  <p className="text-[14px] font-medium">
                    {reason.label}{" "}
                    <span className="font-normal" style={{ color: "var(--text-secondary)" }}>
                      · {SCOPE_LABEL[reason.appliesTo] ?? reason.appliesTo}
                    </span>
                  </p>
                  {reason.guidance ? (
                    <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                      {reason.guidance}
                    </p>
                  ) : null}
                  <p className="tnum mt-0.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
                    {reason.code}
                    {reason.leadCount > 0
                      ? ` · ${reason.leadCount} ${reason.leadCount === 1 ? "lead" : "leads"} closed with it`
                      : " · not used yet"}
                  </p>
                </div>
                <RetireButton kind="disposition" id={reason.id} label={reason.label} isActive />
              </li>
            ))}
          </ul>
        ) : null}

        {retired.length > 0 ? (
          <section className="mt-8">
            <h2 className="text-[15px] font-semibold">Retired</h2>
            <p className="prose-body mt-1 text-[14px]">
              Out of the picker, still in the data. Leads closed with one of these keep it — that is
              what makes last quarter&rsquo;s numbers still add up.
            </p>
            <ul className="mt-3 divide-y border-y">
              {retired.map((reason) => (
                <li
                  key={reason.id}
                  className="flex flex-wrap items-baseline justify-between gap-3 py-3"
                  style={{ color: "var(--text-secondary)" }}
                >
                  <p className="text-[14px]">
                    {reason.label}{" "}
                    <span className="tnum text-[12px]" style={{ color: "var(--text-muted)" }}>
                      · {reason.leadCount} {reason.leadCount === 1 ? "lead" : "leads"}
                    </span>
                  </p>
                  <RetireButton
                    kind="disposition"
                    id={reason.id}
                    label={reason.label}
                    isActive={false}
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="mt-8 rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
          <h2 className="text-[14px] font-semibold">Add a reason</h2>
          <p className="prose-body mt-1 text-[14px]">
            Keep the list short. Fifteen reasons produce fifteen categories with two leads in each,
            which is the same as having none.
          </p>
          <div className="mt-4">
            <AddDispositionForm />
          </div>
        </div>
      </main>
    </AppShell>
  );
}
