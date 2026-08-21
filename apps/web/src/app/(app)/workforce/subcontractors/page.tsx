import type { Metadata } from "next";
import Link from "next/link";
import {
  withTenant,
  subcontractorRegister,
  listSubcontractorWorkers,
  findExpiringSubcontractorObligations,
} from "@meridian/db";
import { can } from "@meridian/auth";
import { today } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { SectionHeading, EmptyState, ExpiryChip, humanise, formatDay } from "../compliance-ui";
import {
  SubcontractorPanel,
  WithdrawSubcontractor,
  AddSupplierWorker,
  ReverifyWorker,
} from "./subcontractor-panel";

export const metadata: Metadata = { title: "Subcontractors and manpower suppliers" };
export const dynamic = "force-dynamic";

/** The same 90-day horizon the accreditation and certification sweeps use. */
const HORIZON_DAYS = 90;

/**
 * The subcontractor and manpower-supplier register (`HR-19`).
 *
 * ── WHY THIS IS ON THE WORKFORCE BOARD AND NOT ON `/hr` ─────────────────────
 *
 * The split between the two boards is by question. `/hr` asks what the
 * employment relationship owes and by when; `/workforce` asks whether a person
 * may lawfully be sent to work today. These people are not employed here at
 * all, and the question the register answers is the second one — asked about
 * somebody else's payroll. Responsibility for site compliance does not transfer
 * with the work, so a supplied worker on our site with a lapsed permit is our
 * exposure under Article 60: AED 100,000 to AED 1,000,000.
 *
 * ── AND WHY NOTHING HERE BLOCKS A DISPATCH ─────────────────────────────────
 *
 * There are three hard blocks in this system and all of them stop an
 * *assignment*. Nothing here is assignable — a supplied worker has no
 * technician record — so a fourth block would stop lawful work in this system
 * to punish a lapse in somebody else's, and it would be routed around inside a
 * day. What the register earns instead is the expiry nobody was watching.
 */
export default async function SubcontractorsPage() {
  const session = await requireSessionWith("workforce:read");
  const canWrite = can(session.principal, "workforce:write");
  const now = today();

  const { suppliers, expiring, workersBySupplier } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => {
      const suppliers = await subcontractorRegister(tx, now);
      const expiring = await findExpiringSubcontractorObligations(tx, HORIZON_DAYS, now);
      // Sequential, not `Promise.all`. Every query here runs on the one
      // connection this transaction reserved, so concurrency buys nothing and
      // only makes the ordering of a failure harder to read. The register is a
      // handful of organisations, not a table scan.
      const workersBySupplier = new Map<string, Awaited<ReturnType<typeof listSubcontractorWorkers>>>();
      for (const s of suppliers) {
        workersBySupplier.set(s.id, await listSubcontractorWorkers(tx, s.id, now));
      }
      return { suppliers, expiring, workersBySupplier };
    },
  );

  const lapsed = expiring.filter((e) => e.daysRemaining < 0);
  const soon = expiring.filter((e) => e.daysRemaining >= 0);

  return (
    <AppShell session={session} active="workforce">
      <div className="container-page py-8">
        <p className="text-[13px]">
          <Link href="/workforce" style={{ color: "var(--accent-text)" }}>
            &larr; Workforce compliance
          </Link>
        </p>

        <h1 className="mt-4 text-2xl font-semibold tracking-tight md:text-3xl">
          Subcontractors and manpower suppliers
        </h1>
        <p className="prose-body mt-2 text-[14px]">
          Organisations that supply labour or take a scope of work, with their trade licence,
          insurance and workmen&rsquo;s compensation expiries, and the work permit of every worker
          they put on our sites. Nothing on this page blocks a dispatch &mdash; these people are not
          assignable here &mdash; but responsibility for site compliance does not transfer with the
          work, so an expired permit on somebody else&rsquo;s payroll is still our exposure.
        </p>

        {/* ── 1. What has already lapsed ──────────────────────────────────── */}
        {lapsed.length > 0 ? (
          <section className="mt-8">
            <SectionHeading tone="blocked" title="Already expired" count={lapsed.length}>
              These are live now, not upcoming.
            </SectionHeading>
            <ul className="mt-4 space-y-2">
              {lapsed.map((e) => (
                <li
                  key={`${e.subcontractorId}-${e.kind}-${e.subject ?? ""}`}
                  className="rounded-sm border-l-2 px-4 py-3 text-[13px]"
                  style={{
                    borderColor: "var(--status-critical-border)",
                    backgroundColor: "var(--status-critical-wash)",
                  }}
                >
                  <span className="font-medium">{e.subcontractorName}</span> &mdash; {e.label}
                  {e.subject ? ` — ${e.subject}` : ""} expired {formatDay(e.expiresOn)},{" "}
                  {Math.abs(e.daysRemaining)} day{Math.abs(e.daysRemaining) === 1 ? "" : "s"} ago.
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* ── 2. What lapses next ─────────────────────────────────────────── */}
        {soon.length > 0 ? (
          <section className="mt-8">
            <SectionHeading tone="warning" title={`Expiring within ${HORIZON_DAYS} days`} count={soon.length}>
              Still cheap and unhurried to renew.
            </SectionHeading>
            <ul className="mt-4 space-y-2">
              {soon.map((e) => (
                <li
                  key={`${e.subcontractorId}-${e.kind}-${e.subject ?? ""}`}
                  className="rounded border p-3 text-[13px]"
                  style={{ backgroundColor: "var(--surface-raised)" }}
                >
                  <span className="font-medium">{e.subcontractorName}</span> &mdash; {e.label}
                  {e.subject ? ` — ${e.subject}` : ""}, {formatDay(e.expiresOn)} (
                  {e.daysRemaining} day{e.daysRemaining === 1 ? "" : "s"}).
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* ── 3. The register ─────────────────────────────────────────────── */}
        <section className="mt-10">
          <SectionHeading tone="success" title="The register" count={suppliers.length} />

          {suppliers.length === 0 ? (
            <div className="mt-4">
              <EmptyState tone="warning" title="No subcontractors recorded.">
                <p>
                  If any work on our sites is done by somebody else&rsquo;s people, they belong here.
                  Deploying a worker without a valid permit carries AED 100,000 to AED 1,000,000
                  under Article 60, and an inspector does not ask whose payroll they were on.
                </p>
              </EmptyState>
            </div>
          ) : (
            <ul className="mt-4 space-y-4">
              {suppliers.map((s) => {
                const workers = workersBySupplier.get(s.id) ?? [];
                const active = workers.filter((w) => w.isActive);
                return (
                  <li key={s.id} className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
                    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
                      <div>
                        <p className="text-[15px] font-medium">{s.name}</p>
                        <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                          {s.kindLabel}
                          {s.tradeSlug ? ` · ${humanise(s.tradeSlug)}` : ""} &middot;{" "}
                          {humanise(s.status)}
                          {s.approvalReference ? ` · approval ${s.approvalReference}` : ""}
                          {s.taxRegistrationNumber
                            ? ` · TRN ${s.taxRegistrationNumber}`
                            : " · no TRN recorded"}
                        </p>
                        {s.contactName || s.contactPhone ? (
                          <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                            {[s.contactName, s.contactPhone, s.contactEmail].filter(Boolean).join(" · ")}
                          </p>
                        ) : null}
                      </div>
                      {canWrite ? <WithdrawSubcontractor id={s.id} label={s.name} /> : null}
                    </div>

                    {s.problems.length > 0 ? (
                      <ul
                        className="mt-3 space-y-1 rounded-sm border-l-2 px-3 py-2 text-[12px]"
                        style={{
                          borderColor: "var(--status-critical-border)",
                          backgroundColor: "var(--status-critical-wash)",
                        }}
                      >
                        {s.problems.map((p) => (
                          <li key={p}>{p}</li>
                        ))}
                      </ul>
                    ) : null}

                    <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
                      <ExpiryChip
                        expiresAt={s.tradeLicenceExpiresOn}
                        daysRemaining={
                          s.tradeLicenceExpiresOn === null ? null : daysUntil(now, s.tradeLicenceExpiresOn)
                        }
                        warnWithinDays={HORIZON_DAYS}
                        soonLabel="Trade licence"
                      />
                      <ExpiryChip
                        expiresAt={s.liabilityExpiresOn}
                        daysRemaining={
                          s.liabilityExpiresOn === null ? null : daysUntil(now, s.liabilityExpiresOn)
                        }
                        warnWithinDays={HORIZON_DAYS}
                        soonLabel="Liability cover"
                      />
                      <ExpiryChip
                        expiresAt={s.workmenCompExpiresOn}
                        daysRemaining={
                          s.workmenCompExpiresOn === null ? null : daysUntil(now, s.workmenCompExpiresOn)
                        }
                        warnWithinDays={HORIZON_DAYS}
                        soonLabel="Workmen's comp"
                      />
                    </div>

                    {s.accreditations.length > 0 ? (
                      <p className="mt-3 text-[12px]" style={{ color: "var(--text-muted)" }}>
                        {s.accreditations
                          .map(
                            (a) =>
                              `${a.name}${a.issuer ? ` (${a.issuer})` : ""}${
                                a.expiresOn ? ` — ${formatDay(a.expiresOn)}` : " — no expiry recorded"
                              }`,
                          )
                          .join(" · ")}
                      </p>
                    ) : null}

                    <p className="mt-4 text-[13px] font-medium">
                      Supplied workers &mdash; {active.length}
                      {s.unverifiedWorkerCount > 0 ? (
                        <span style={{ color: "var(--status-warning-text)" }}>
                          {" "}
                          ({s.unverifiedWorkerCount} with no permit expiry recorded)
                        </span>
                      ) : null}
                    </p>

                    {workers.length === 0 ? (
                      <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                        None recorded. A supplier with no workers listed is a supplier whose permits
                        nobody has checked.
                      </p>
                    ) : (
                      <ul className="mt-2 divide-y rounded-sm border" style={{ borderColor: "var(--border)" }}>
                        {workers.map((w) => (
                          <li key={w.id} className="p-3">
                            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                              <p className="text-[13px]">
                                {w.fullName}
                                {w.isActive ? "" : " (stood down)"}
                                {w.tradeSlug ? (
                                  <span style={{ color: "var(--text-muted)" }}> · {humanise(w.tradeSlug)}</span>
                                ) : null}
                              </p>
                              <ExpiryChip
                                expiresAt={w.workPermitExpiresOn}
                                daysRemaining={w.daysRemaining}
                                warnWithinDays={HORIZON_DAYS}
                                soonLabel="Work permit"
                              />
                            </div>
                            <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                              {w.workPermitNo ? `${w.workPermitNo} · ` : ""}
                              {w.verifiedAt
                                ? `verified by ${w.verifiedByName ?? "a colleague"}`
                                : "never verified — the expiry date is the supplier's word for it"}
                            </p>
                            {canWrite && w.isActive ? <ReverifyWorker workerId={w.id} name={w.fullName} /> : null}
                          </li>
                        ))}
                      </ul>
                    )}

                    {canWrite ? <AddSupplierWorker subcontractorId={s.id} name={s.name} /> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="mt-10">
          {canWrite ? (
            <SubcontractorPanel />
          ) : (
            <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
              Your role can read this register but not change it.
            </p>
          )}
        </div>
      </div>
    </AppShell>
  );
}

/**
 * Whole days from `now` to `day`, both `YYYY-MM-DD`.
 *
 * Written here rather than reached for from `@meridian/core` only because
 * `ExpiryChip` wants the number beside the date it already has, and computing
 * it from two `Date`s would reintroduce the partial-day floor that reports 29
 * days for something expiring in 30.
 */
function daysUntil(now: string, day: string): number {
  const a = Date.parse(`${now}T00:00:00Z`);
  const b = Date.parse(`${day}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
