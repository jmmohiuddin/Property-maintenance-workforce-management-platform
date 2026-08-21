import type { Metadata } from "next";
import Link from "next/link";
import { withTenant, listTechnicians, skillCoverage } from "@meridian/db";
import { services, getService } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { EmptyState } from "@/components/empty-state";
import { WarningCircle, ShieldWarning } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Technicians" };
export const dynamic = "force-dynamic";

const dubaiDate = (d: Date) =>
  d.toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium" });

export default async function TechniciansPage() {
  const session = await requireSessionWith("technicians:read");

  const { technicians, coverage } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      technicians: await listTechnicians(tx),
      coverage: await skillCoverage(tx),
    }),
  );

  const covered = new Map(coverage.map((c) => [c.serviceSlug, c.technicians]));
  // A service we advertise with nobody signed off for it is a promise dispatch
  // cannot keep. Nothing else in the system surfaces this.
  const uncovered = services.filter((s) => (covered.get(s.slug) ?? 0) === 0);
  const blocked = technicians.filter((t) => t.certAlerts.some((c) => c.state === "expired"));

  return (
    <AppShell session={session} active="technicians">
      <div className="container-page py-8">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Technicians</h1>
        <p className="prose-body mt-2 text-[14px]">
          Dispatch can only offer someone with a signed-off skill for the service and no lapsed
          certification. This is where both are kept true.
        </p>

        <dl
          className="mt-8 grid gap-px overflow-hidden rounded border sm:grid-cols-3"
          style={{ backgroundColor: "var(--border-hairline)" }}
        >
          {[
            { label: "Active technicians", value: String(technicians.length), tone: false },
            { label: "Blocked by a lapsed certificate", value: String(blocked.length), tone: blocked.length > 0 },
            { label: "Services with nobody signed off", value: String(uncovered.length), tone: uncovered.length > 0 },
          ].map((s) => (
            <div key={s.label} className="p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
              <dt className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                {s.label}
              </dt>
              <dd
                className="tnum mt-1 text-2xl font-semibold"
                style={s.tone ? { color: "var(--accent-text)" } : undefined}
              >
                {s.value}
              </dd>
            </div>
          ))}
        </dl>

        {uncovered.length > 0 ? (
          <section
            className="mt-6 rounded border-2 p-5"
            style={{ backgroundColor: "var(--surface-raised)", borderColor: "var(--accent)" }}
          >
            <h2 className="flex items-center gap-2 text-[15px] font-semibold">
              <ShieldWarning size={17} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
              No qualified technician for {uncovered.length}{" "}
              {uncovered.length === 1 ? "service" : "services"}
            </h2>
            <p className="prose-body mt-2 text-[14px]">
              A request for any of these will reach triage and then stall, because the assignment
              panel will have nobody to offer.
            </p>
            <p className="mt-3 text-[14px]" style={{ color: "var(--text-secondary)" }}>
              {uncovered.map((s) => s.shortName).join(" · ")}
            </p>
          </section>
        ) : null}

        {technicians.length === 0 ? (
          /*
           * ADM-12. "Run the seed script" was the old copy. It is an
           * instruction to a developer, on the screen an operations manager
           * reaches first when they want to know who can be sent to a job.
           *
           * Tone is `gap` rather than `start` on purpose: an empty roster is
           * not a neutral day-one state. Nothing can be dispatched, the
           * compliance board has nobody to check, and the skill-coverage
           * warning above this list is silently measuring an empty set.
           */
          <div className="mt-8">
            <EmptyState kind="gap" title="No technician is on the roster.">
              <p>
                Nothing can be assigned until somebody is. Every screen that depends on this one
                &mdash; the dispatch board&rsquo;s technician column, skill coverage above, and the
                workforce compliance board &mdash; is currently reporting on an empty set rather
                than on a clean one.
              </p>
              <p className="mt-2">
                Adding a technician here creates the roster entry. The employment record that holds
                their permit and visa is separate, and lives on the workforce board.
              </p>
            </EmptyState>
          </div>
        ) : (
          <ul className="mt-8 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
            {technicians.map((t) => (
              <li key={t.id}>
                <Link href={`/technicians/${t.id}`} className="block p-5 transition-colors">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <div className="flex flex-wrap items-baseline gap-3">
                      <h2 className="text-[16px] font-semibold">{t.fullName}</h2>
                      <span className="tnum text-[13px]" style={{ color: "var(--text-muted)" }}>
                        {t.employeeCode}
                      </span>
                      <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                        {t.grade.replace(/_/g, " ")} &middot; {t.employment.replace(/_/g, " ")}
                        {t.baseCity ? ` · ${t.baseCity}` : ""}
                      </span>
                    </div>
                    <span className="tnum text-[13px]" style={{ color: "var(--text-secondary)" }}>
                      {t.openVisits} open {t.openVisits === 1 ? "visit" : "visits"}
                    </span>
                  </div>

                  <p className="mt-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                    {t.skillSlugs.length === 0 ? (
                      <span style={{ color: "var(--accent-text)" }}>
                        No signed-off skills — invisible to dispatch
                      </span>
                    ) : (
                      t.skillSlugs
                        .map((slug) => getService(slug)?.shortName ?? slug)
                        .join(" · ")
                    )}
                  </p>

                  {t.certAlerts.length > 0 ? (
                    <ul className="mt-2 space-y-1">
                      {t.certAlerts.map((c) => (
                        <li
                          key={c.name}
                          className="flex items-center gap-2 text-[13px]"
                          style={{
                            color: c.state === "expired" ? "var(--accent-text)" : "var(--text-secondary)",
                          }}
                        >
                          <WarningCircle
                            size={15}
                            weight="fill"
                            aria-hidden
                            className="shrink-0"
                            style={{ color: c.state === "expired" ? "var(--accent)" : "var(--text-muted)" }}
                          />
                          {c.name} {c.state === "expired" ? "expired" : "expires"}
                          {c.expiresOn ? ` ${dubaiDate(c.expiresOn)}` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  );
}
