import type { Metadata } from "next";
import Link from "next/link";
import {
  withTenant,
  listAccreditations,
  ACCREDITATION_KINDS,
  ACCREDITATION_LABEL,
  type AccreditationKind,
} from "@meridian/db";
import { can } from "@meridian/auth";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import {
  ACCREDITATION_WARN_DAYS,
  EmptyState,
  ExpiryChip,
  humanise,
} from "../compliance-ui";
import { AccreditationPanel, WithdrawAccreditation } from "./accreditation-panel";

export const metadata: Metadata = { title: "Company accreditations" };
export const dynamic = "force-dynamic";

/**
 * The company accreditation register (`HR-14`).
 *
 * Separate from individual certifications because these belong to the
 * establishment, not to a person, and separate from the compliance board
 * because this is where they are entered rather than watched.
 *
 * It is also the source of truth for what the company may claim publicly. The
 * previous build advertised three ISO certificates and an insurance figure the
 * company did not hold; the rule now is that nothing is published or put in a
 * tender pack (`CON-12`) without a row here with an in-date expiry behind it.
 */
export default async function AccreditationsPage() {
  const session = await requireSessionWith("workforce:read");
  const canWrite = can(session.principal, "workforce:write");

  const accreditations = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    (tx) => listAccreditations(tx),
  );

  // Built on the server for the same reason as the document types: the
  // catalogue lives in the database package.
  const kinds = ACCREDITATION_KINDS.map((kind) => ({
    value: kind,
    label: ACCREDITATION_LABEL[kind],
  }));

  return (
    <AppShell session={session} active="workforce">
      <div className="container-page py-8">
        <p className="text-[13px]">
          <Link href="/workforce" style={{ color: "var(--accent-text)" }}>
            &larr; Workforce compliance
          </Link>
        </p>

        <h1 className="mt-4 text-2xl font-semibold tracking-tight md:text-3xl">
          Company accreditations
        </h1>
        <p className="prose-body mt-2 text-[14px]">
          Trade licence, DEWA contractor enrolment, Dubai Municipality classification, ISO
          certificates, insurance cover and the Workers Protection Programme. Anything the company
          claims in a tender is assembled from this list, so an entry that is not here cannot be
          claimed and an entry that lapses stops being claimed on its own.
        </p>

        {accreditations.length === 0 ? (
          <div className="mt-8">
            <EmptyState tone="warning" title="The register is empty.">
              <p>
                Start with the trade licence &mdash; number 930137, expiring 23 January 2027. An
                expired trade licence stops the business rather than inconveniencing it, and until
                it is recorded here nothing is counting down to that date.
              </p>
            </EmptyState>
          </div>
        ) : (
          <ul className="mt-8 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
            {accreditations.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 p-4">
                <div>
                  <p className="text-[14px] font-medium">
                    {a.name}
                    {a.referenceNo ? (
                      <span className="tnum font-normal" style={{ color: "var(--text-muted)" }}>
                        {" "}
                        &middot; {a.referenceNo}
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                    {ACCREDITATION_LABEL[a.kind as AccreditationKind] ?? humanise(a.kind)}
                    {a.issuingBody ? ` · ${a.issuingBody}` : ""}
                    {a.grade ? ` · ${humanise(a.grade)}` : ""}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  <ExpiryChip
                      expiresAt={a.expiresAt}
                      daysRemaining={a.daysRemaining}
                      warnWithinDays={ACCREDITATION_WARN_DAYS}
                      soonLabel="Renewal due"
                    />
                  {canWrite ? (
                    <WithdrawAccreditation accreditationId={a.id} label={a.name} />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-8">
          {canWrite ? (
            <AccreditationPanel kinds={kinds} />
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
