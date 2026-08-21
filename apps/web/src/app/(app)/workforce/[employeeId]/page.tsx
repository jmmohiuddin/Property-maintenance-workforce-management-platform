import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  withTenant,
  getEmployeeRecord,
  blockForTechnician,
  EMPLOYEE_DOCUMENT_KINDS,
  EMPLOYEE_DOCUMENT_LABEL,
  BLOCKING_DOCUMENT_KINDS,
} from "@meridian/db";
import { can } from "@meridian/auth";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import {
  ComplianceBlock,
  EmptyState,
  ExpiryChip,
  formatDay,
  humanise,
  tradeLabel,
} from "../compliance-ui";
import { DocumentPanel, WithdrawDocument } from "./document-panel";

export const metadata: Metadata = { title: "Employment record" };
export const dynamic = "force-dynamic";

/**
 * One employment record and its documents (`HR-5`).
 *
 * This page exists because the board cannot: without somewhere to type an
 * expiry date, `employee_documents` stays empty and the compliance board is a
 * screen that always reports that everything is fine. `HR-5` is the register,
 * not the report over it.
 */
export default async function EmployeeRecordPage({
  params,
}: {
  params: Promise<{ employeeId: string }>;
}) {
  const session = await requireSessionWith("workforce:read");
  const canWrite = can(session.principal, "workforce:write");
  const { employeeId } = await params;

  const { record, block } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => {
      const found = await getEmployeeRecord(tx, employeeId);
      return {
        record: found,
        block: found?.technicianId ? await blockForTechnician(tx, found.technicianId) : null,
      };
    },
  );

  // A record belonging to another tenant is filtered out by RLS and arrives
  // here as null, so this is a 404 rather than a 403 — deliberately. Telling an
  // attacker "that id exists but is not yours" confirms the id.
  if (!record) notFound();

  const trade = tradeLabel(record.primaryTrade);

  // Built here rather than inside the form: the constants live in the database
  // package, and importing that from a client component pulls the postgres
  // driver into the browser bundle.
  const onFile = new Set(record.documents.map((d) => d.kind));
  const documentKinds = EMPLOYEE_DOCUMENT_KINDS.map((kind) => ({
    value: kind,
    label: EMPLOYEE_DOCUMENT_LABEL[kind],
    blocking: BLOCKING_DOCUMENT_KINDS.includes(kind),
    onFile: onFile.has(kind),
  }));

  return (
    <AppShell session={session} active="workforce">
      <div className="container-page py-8">
        <p className="text-[13px]">
          <Link href="/workforce" style={{ color: "var(--accent-text)" }}>
            &larr; Workforce compliance
          </Link>
        </p>

        <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{record.fullName}</h1>
          <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
            {record.employeeNo ? (
              <>
                <span className="tnum">{record.employeeNo}</span> &middot;{" "}
              </>
            ) : null}
            {humanise(record.contractType)} &middot; {humanise(record.status)}
            {trade ? ` · ${trade}` : ""}
          </p>
        </div>

        {record.technicianId ? (
          <p className="mt-2 text-[13px]">
            <Link href={`/technicians/${record.technicianId}`} style={{ color: "var(--accent-text)" }}>
              Technician record: skills, certifications and workload &rarr;
            </Link>
          </p>
        ) : (
          <p className="prose-body mt-2 text-[13px]">
            Not linked to a technician. Documents recorded here are kept for the file, but nothing
            they say can stop a dispatch &mdash; the block is enforced through the technician link.
          </p>
        )}

        {/* The block first, before anything else on the page, for the same
            reason it is first on the board: it is the only thing here with a
            statutory penalty attached to it. */}
        {block ? (
          <ul className="mt-6">
            <ComplianceBlock
              name={record.fullName}
              subtitle={trade}
              detail={block.detail}
              penalty={block.penalty}
              fixHref="#record-document"
              fixLabel="Record the renewal below"
            />
          </ul>
        ) : null}

        {record.missingBlockingKinds.length > 0 ? (
          <div className="mt-6">
            <EmptyState
              tone="critical"
              title={`${record.missingBlockingKinds.length} of the 5 required documents ${
                record.missingBlockingKinds.length === 1 ? "is" : "are"
              } not in date`}
            >
              <p>
                {record.missingBlockingKinds
                  .map((k) => EMPLOYEE_DOCUMENT_LABEL[k])
                  .join(", ")}
                . A document that is missing entirely is invisible to the dispatch check &mdash; it
                joins through <code>employee_documents</code>, so no row means no block, which is
                the opposite of what a missing work permit should do.
              </p>
            </EmptyState>
          </div>
        ) : null}

        <section aria-labelledby="documents-heading" className="mt-8">
          <h2 id="documents-heading" className="text-lg font-semibold tracking-tight">
            Documents on file &mdash; {record.documents.length}
          </h2>

          {record.documents.length === 0 ? (
            <div className="mt-4">
              <EmptyState tone="warning" title="Nothing on file for this person.">
                <p>
                  Record the work permit, residence visa, Emirates ID, medical fitness certificate
                  and health insurance. Those five are the ones that stop a dispatch when they
                  lapse; everything else is recorded for the file and warns at assignment.
                </p>
              </EmptyState>
            </div>
          ) : (
            <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              {record.documents.map((d) => (
                <li key={d.id} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 p-4">
                  <div>
                    <p className="text-[14px] font-medium">
                      {d.label}
                      {d.referenceNo ? (
                        <span className="tnum font-normal" style={{ color: "var(--text-muted)" }}>
                          {" "}
                          &middot; {d.referenceNo}
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                      {d.blocking
                        ? "Expiry blocks dispatch outright"
                        : "Expiry warns at assignment; an override needs a recorded reason"}
                      {d.issuedAt ? ` · issued ${formatDay(d.issuedAt)}` : ""}
                    </p>
                    {d.note ? (
                      <p className="mt-1 text-[12px]" style={{ color: "var(--text-secondary)" }}>
                        {d.note}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <ExpiryChip
                      expiresAt={d.expiresAt}
                      daysRemaining={d.daysRemaining}
                      blocking={d.blocking}
                    />
                    {canWrite ? (
                      <WithdrawDocument
                        documentId={d.id}
                        employeeId={record.id}
                        label={d.label}
                      />
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div id="record-document" className="mt-8 scroll-mt-8">
          {canWrite ? (
            <DocumentPanel employeeId={record.id} kinds={documentKinds} />
          ) : (
            <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
              Your role can read this record but not change it. An operations manager, HR or an
              administrator can record documents and renewals.
            </p>
          )}
        </div>
      </div>
    </AppShell>
  );
}
