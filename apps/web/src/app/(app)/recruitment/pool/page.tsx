import type { Metadata } from "next";
import Link from "next/link";
import { withTenant } from "@meridian/db";
import { listTalentPool, talentPoolExpiringCertifications } from "@meridian/db/domain";
import {
  CERTIFICATION_EXPIRY_WINDOW_DAYS,
  TALENT_POOL_CERT_FILTERS,
  TALENT_POOL_CERT_FILTER_LABEL,
  getService,
  isTalentPoolCertFilter,
  services,
  type TalentPoolCertFilter,
} from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { PoolMemberControls } from "./pool-controls";
import { ArrowLeft } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Talent pool" };
export const dynamic = "force-dynamic";

/**
 * The talent pool, as something you can actually use (`ATS-13`).
 *
 * ── WHY THIS SCREEN IS SMALL ────────────────────────────────────────────────
 *
 * Two filters and a list. The pool's value is not in how richly it can be
 * queried; it is in whether anybody opens it on the Sunday somebody drops out
 * of a job. So it answers the two questions that get asked out loud — who is in
 * this trade, and is their ticket still good — and it puts a phone number next
 * to every name.
 *
 * The lapsed-certificate list is at the top, above the browser, for the same
 * consequence-order reason the owed-an-outcome panel leads /recruitment. Those
 * people are not a filter result, they are today's phone calls: an expired
 * certificate blocks a dispatch under `HR-9`, so finding out now costs a call
 * and finding out after an offer costs the job.
 *
 * The same expiry query runs in the recruitment cron every fifteen minutes and
 * warns there too. This screen names them; the cron makes sure somebody hears
 * about them without opening it.
 *
 * Absent, deliberately: any score, ranking or match percentage (`ATS-19`).
 */
export default async function TalentPoolPage({
  searchParams,
}: {
  searchParams: Promise<{ trade?: string; certs?: string }>;
}) {
  const session = await requireSessionWith("recruitment:read");
  const query = await searchParams;

  const trade = query.trade && getService(query.trade) ? query.trade : "";
  const certs: TalentPoolCertFilter =
    query.certs && isTalentPoolCertFilter(query.certs) ? query.certs : "any";

  const { members, expiring } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      members: await listTalentPool(tx, {
        poolKey: trade || undefined,
        certifications: certs,
        limit: 100,
      }),
      expiring: await talentPoolExpiringCertifications(tx),
    }),
  );

  const canWrite = ["owner", "admin", "hr"].includes(session.principal.role);
  const lapsed = expiring.filter((certificate) => certificate.lapsed);

  return (
    <AppShell session={session} active="recruitment">
      <div className="container-page py-8">
        <Link
          href="/recruitment"
          className="inline-flex items-center gap-1.5 text-[13px] hover:underline"
          style={{ color: "var(--text-secondary)" }}
        >
          <ArrowLeft size={14} aria-hidden />
          Recruitment
        </Link>

        <h1 className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">Talent pool</h1>
        <p className="prose-body mt-2 max-w-2xl text-[14px]">
          People who agreed to be kept on file. Held under consent — its own lawful basis, separate
          from the application it came with — which is why every row shows when that consent was
          last confirmed and goes stale if nobody asks again.
        </p>

        {/* ── The phone calls, before the browser ──────────────────────── */}
        {expiring.length > 0 ? (
          <section className="mt-8">
            <div
              className="rounded border p-6"
              style={{
                backgroundColor: "var(--surface-raised)",
                borderColor: lapsed.length > 0 ? "var(--status-critical)" : undefined,
              }}
            >
              <h2 className="text-[17px] font-semibold">
                {lapsed.length} lapsed · {expiring.length - lapsed.length} lapsing within{" "}
                {CERTIFICATION_EXPIRY_WINDOW_DAYS} days
              </h2>
              <p className="prose-body mt-2 max-w-2xl text-[14px]">
                A pool member whose ticket has expired is not a prospect, they are a phone call. An
                expired certificate blocks a dispatch under HR-9 — so this costs a call today and a
                job if it is found the morning after an offer.
              </p>
              <ul className="mt-4 space-y-2">
                {expiring.slice(0, 15).map((certificate) => (
                  <li
                    key={`${certificate.candidateId}-${certificate.scheme}-${certificate.expiresOn}`}
                    className="flex flex-wrap items-center justify-between gap-3 text-[14px]"
                  >
                    <span>
                      {certificate.fullName} · {certificate.phone}
                    </span>
                    <span
                      className="tnum"
                      style={{
                        color: certificate.lapsed
                          ? "var(--status-critical-text)"
                          : "var(--text-muted)",
                      }}
                    >
                      {certificate.scheme} · {certificate.lapsed ? "LAPSED " : "expires "}
                      {formatDay(certificate.expiresOn)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ) : null}

        {/* ── The two filters ──────────────────────────────────────────── */}
        {/*
          A plain GET form. No client component, no state to keep in sync: the
          filter is in the URL, which means it can be sent to somebody, opened
          on a phone, and bookmarked by whoever runs the calls each week.
        */}
        <form method="get" className="mt-10 flex flex-wrap items-end gap-3">
          <label className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
            <span className="mb-1 block">Trade</span>
            <select
              name="trade"
              defaultValue={trade}
              className="rounded border px-3 py-2 text-[14px]"
              style={{ backgroundColor: "var(--surface-raised)" }}
            >
              <option value="">Every trade</option>
              {services.map((service) => (
                <option key={service.slug} value={service.slug}>
                  {service.shortName}
                </option>
              ))}
            </select>
          </label>

          <label className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
            <span className="mb-1 block">Certificates</span>
            <select
              name="certs"
              defaultValue={certs}
              className="rounded border px-3 py-2 text-[14px]"
              style={{ backgroundColor: "var(--surface-raised)" }}
            >
              {TALENT_POOL_CERT_FILTERS.map((value) => (
                <option key={value} value={value}>
                  {TALENT_POOL_CERT_FILTER_LABEL[value]}
                </option>
              ))}
            </select>
          </label>

          <button type="submit" className="btn btn-secondary">
            Filter
          </button>
        </form>

        {/* ── The pool ─────────────────────────────────────────────────── */}
        <section className="mt-6">
          {members.length === 0 ? (
            <div
              className="rounded border p-10 text-center"
              style={{ backgroundColor: "var(--surface-raised)" }}
            >
              <p className="text-[16px] font-semibold">Nobody matches.</p>
              <p className="prose-body mx-auto mt-2 max-w-md text-[14px]">
                {trade || certs !== "any"
                  ? "Widen the filter. An empty pool for one trade is a recruiting problem, not a bug."
                  : "The pool fills when an applicant ticks the box on the careers form, or when somebody is archived from a late stage with consent recorded."}
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {members.map((member) => (
                <li
                  key={`${member.candidateId}-${member.poolKey}`}
                  className="flex flex-wrap items-start justify-between gap-4 rounded border p-5"
                  style={{
                    backgroundColor: "var(--surface-raised)",
                    borderColor: member.lapsedCount > 0 ? "var(--status-critical)" : undefined,
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-medium">{member.fullName}</p>
                    <p className="mt-0.5 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                      {member.phone}
                      {member.email ? ` · ${member.email}` : " · no email address"} ·{" "}
                      {getService(member.poolKey)?.shortName ?? member.poolKey}
                      {member.addedReason ? ` · ${member.addedReason.replace(/_/g, " ")}` : ""}
                    </p>
                    <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                      {member.certificationCount === 0
                        ? "No certificate recorded"
                        : `${member.certificationCount} certificate${member.certificationCount === 1 ? "" : "s"}` +
                          (member.lapsedCount > 0 ? ` · ${member.lapsedCount} LAPSED` : "") +
                          (member.expiringCount > 0 ? ` · ${member.expiringCount} expiring` : "") +
                          (member.earliestExpiry ? ` · earliest ${formatDay(member.earliestExpiry)}` : "")}
                    </p>
                    <p
                      className="mt-1 text-[13px]"
                      style={{
                        color: member.reconfirmDue
                          ? "var(--status-critical-text)"
                          : "var(--text-muted)",
                      }}
                    >
                      {member.reconfirmDue ? "Consent needs re-confirming — due " : "Consent good until "}
                      {member.reconfirmDueAt.toLocaleDateString("en-GB", {
                        timeZone: "Asia/Dubai",
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                      {member.reconfirmedAt ? " · last confirmed by a person" : " · never re-confirmed"}
                    </p>
                  </div>

                  {canWrite ? (
                    <PoolMemberControls
                      candidateId={member.candidateId}
                      poolKey={member.poolKey}
                      fullName={member.fullName}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {members.length === 100 ? (
            <p className="mt-4 text-[13px]" style={{ color: "var(--text-muted)" }}>
              Showing the first 100. Narrow the trade filter — this screen does not paginate, and
              saying so is better than a page 2 button that quietly loses people.
            </p>
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}

/**
 * A `YYYY-MM-DD` day, rendered without ever becoming a `Date`.
 *
 * Passing it through `new Date()` and back would shift it by the local UTC
 * offset — in the direction that shows a certificate which lapsed yesterday as
 * lapsing today, which is the exact mistake this list exists to prevent.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDay(day: string): string {
  const [year, month, date] = day.split("-");
  const label = MONTHS[Number(month) - 1];
  if (!year || !label || !date) return day;
  return `${Number(date)} ${label} ${year}`;
}
