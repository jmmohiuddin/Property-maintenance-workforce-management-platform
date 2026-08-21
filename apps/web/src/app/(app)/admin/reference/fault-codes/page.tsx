import type { Metadata } from "next";
import { withTenant } from "@meridian/db";
import { listFaultCodes, FAULT_CODE_KINDS, type FaultCodeKind } from "@meridian/db/domain";
import { getService } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { ReferenceTabs } from "../tabs";
import { AddFaultForm, RetireButton } from "../taxonomy-forms";

export const metadata: Metadata = {
  title: "Fault codes",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const KIND_HEADING: Record<FaultCodeKind, { title: string; blurb: string }> = {
  symptom: {
    title: "Symptom — what was reported",
    blurb:
      "What the customer described, in their words made repeatable. “AC not cooling”, “water on the floor”, “no power to sockets”.",
  },
  cause: {
    title: "Cause — what was found",
    blurb:
      "What was actually wrong. This is the column that answers “how many times has this failed the same way”, which is the whole reason for coding faults at all.",
  },
  remedy: {
    title: "Remedy — what was done",
    blurb:
      "The fix. Paired with the cause, it is what tells you whether the fix holds or whether the same unit comes back in six weeks.",
  },
};

/**
 * `/admin/reference/fault-codes` — `JOB-14`, `ADM-10`.
 *
 * Three lists, one screen. The capture side — a technician choosing a symptom,
 * a cause and a remedy on a job — is Phase 3 and is deliberately not built
 * here; what could not wait is the taxonomy itself, because the PRD is blunt
 * that shipping fault capture as free text is the mistake that cannot be
 * retrofitted. Every visit closed before these exist is a visit whose fault
 * history is unrecoverable prose, and no later migration can invent the codes
 * nobody chose at the time.
 */
export default async function FaultCodesPage() {
  const session = await requireSessionWith("settings:write");

  const codes = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    (tx) => listFaultCodes(tx),
  );

  const missing = FAULT_CODE_KINDS.filter(
    (kind) => !codes.some((code) => code.kind === kind && code.isActive),
  );

  return (
    <AppShell session={session} active="admin/reference">
      <main id="main" className="container-page py-10">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Fault codes</h1>
          <p className="prose-body mt-2 max-w-3xl text-[15px]">
            A three-part taxonomy: what was reported, what was found, what was done. Coded rather
            than written, because coded service history becomes reliability data, planned-maintenance
            justification and tender evidence, and written service history becomes a folder nobody
            can query.
          </p>
        </header>

        <ReferenceTabs active="/admin/reference/fault-codes" />

        {missing.length > 0 ? (
          <div
            className="mt-8 rounded-sm p-4 text-[14px]"
            style={{ backgroundColor: "var(--status-warning-wash)" }}
          >
            <p className="font-medium">
              {missing.length === 3
                ? "No fault codes have been entered."
                : `Nothing entered for: ${missing.join(", ")}.`}
            </p>
            <p className="mt-1">
              Faults recorded before this list exists are prose, and prose cannot be counted. Nobody
              can go back and code them later — the person who saw the fault will not remember it,
              and a guess entered a year on is worse than the gap. Ten or fifteen of each, taken
              from the jobs that actually recur, is enough to start.
            </p>
          </div>
        ) : null}

        {FAULT_CODE_KINDS.map((kind) => {
          const forKind = codes.filter((code) => code.kind === kind);
          const heading = KIND_HEADING[kind];

          return (
            <section key={kind} className="mt-10">
              <h2 className="text-[15px] font-semibold">{heading.title}</h2>
              <p className="prose-body mt-1 max-w-3xl text-[14px]">{heading.blurb}</p>

              {forKind.length === 0 ? (
                <p className="mt-3 text-[14px]" style={{ color: "var(--text-muted)" }}>
                  Nothing here yet.
                </p>
              ) : (
                <ul className="mt-4 divide-y border-y">
                  {forKind.map((code) => (
                    <li
                      key={code.id}
                      className="flex flex-wrap items-baseline justify-between gap-3 py-3"
                      style={code.isActive ? undefined : { color: "var(--text-secondary)" }}
                    >
                      <div>
                        <p className="text-[14px] font-medium">
                          {/* The space is load-bearing: without it a screen
                              reader reads the label and the badge as one word. */}
                          {code.label}{" "}
                          {code.isActive ? null : (
                            <span className="text-[12px] font-normal" style={{ color: "var(--text-muted)" }}>
                              retired
                            </span>
                          )}
                        </p>
                        {code.description ? (
                          <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                            {code.description}
                          </p>
                        ) : null}
                        <p className="tnum mt-0.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
                          {code.code} ·{" "}
                          {code.serviceSlug
                            ? (getService(code.serviceSlug)?.shortName ?? code.serviceSlug)
                            : "every service"}
                        </p>
                      </div>
                      <RetireButton
                        kind="fault"
                        id={code.id}
                        label={code.label}
                        isActive={code.isActive}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}

        <div className="mt-10 rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
          <h2 className="text-[14px] font-semibold">Add a code</h2>
          <p className="prose-body mt-1 max-w-3xl text-[14px]">
            Write them the way a technician speaks, not the way a category tree reads. A list nobody
            recognises their own job in is a list where everybody picks the first entry, and a
            taxonomy filled in that way is worse than none — it looks like data.
          </p>
          <div className="mt-4">
            <AddFaultForm defaultKind={missing[0] ?? "symptom"} />
          </div>
        </div>
      </main>
    </AppShell>
  );
}
