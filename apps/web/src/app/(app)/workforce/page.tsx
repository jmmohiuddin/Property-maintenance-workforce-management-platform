import type { Metadata } from "next";
import Link from "next/link";
import {
  withTenant,
  workforceSummary,
  blockedTechnicians,
  findExpiringEmployeeDocuments,
  findExpiringAccreditations,
  listEmployees,
  techniciansWithoutEmploymentRecord,
  ACCREDITATION_LABEL,
  type AccreditationKind,
  type ExpiringDocument,
} from "@meridian/db";
import { can } from "@meridian/auth";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import {
  ACCREDITATION_WARN_DAYS,
  ComplianceBlock,
  EmptyState,
  ExpiryChip,
  SectionHeading,
  daysPhrase,
  formatDay,
  humanise,
  tradeLabel,
} from "./compliance-ui";
import { OpenRecordForm } from "./open-record-form";

export const metadata: Metadata = { title: "Workforce compliance" };
export const dynamic = "force-dynamic";

/**
 * The workforce compliance board (`HR-5`, `HR-9`, `HR-14`).
 *
 * Consequence-ordered, which is the only ordering this screen is allowed to
 * have: hard blocks, then things about to become hard blocks, then the company
 * accreditations, then the register everything above is computed from. A board
 * sorted by name would put a lapsed work permit — AED 100,000 to AED 1,000,000
 * — underneath a passport expiring in eleven weeks.
 */

/**
 * The document alert horizon.
 *
 * `HR-5` escalates at T-90 / T-60 / T-30 / T-7, so 90 is the outer window and
 * the 30-day band inside it is what the wireframe headlines. Both are rendered:
 * the 31–90 group is where a renewal is still cheap and unhurried, and dropping
 * it would mean the first time anybody hears about a permit is a month before
 * it lapses.
 */
const DOCUMENT_HORIZON_DAYS = 90;

/**
 * Accreditations get a longer horizon than people's documents, deliberately.
 *
 * A trade licence renewal is a multi-week process with a municipality, not a
 * clinic appointment, and an expired trade licence stops the business rather
 * than inconveniencing it. Trade licence 930137 expires 23 January 2027 and had
 * nothing watching it before this screen; a 90-day window would have said
 * nothing about it until late October.
 */
const ACCREDITATION_HORIZON_DAYS = 365;

export default async function WorkforcePage() {
  const session = await requireSessionWith("workforce:read");
  const canWrite = can(session.principal, "workforce:write");

  const { summary, blocks, documents, accreditations, employees, unregistered } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      summary: await workforceSummary(tx),
      blocks: await blockedTechnicians(tx),
      documents: await findExpiringEmployeeDocuments(tx, DOCUMENT_HORIZON_DAYS),
      accreditations: await findExpiringAccreditations(tx, ACCREDITATION_HORIZON_DAYS),
      employees: await listEmployees(tx),
      unregistered: await techniciansWithoutEmploymentRecord(tx),
    }),
  );

  // `blockedTechnicians` knows the technician; the fix lives on the employment
  // record. Nothing in the block itself carries the employee id, so the register
  // is the bridge — without it the only route out of a block is a technician
  // page with no document form on it.
  const employeeByTechnician = new Map(
    employees.filter((e) => e.technicianId).map((e) => [e.technicianId as string, e]),
  );

  const blockedTechnicianIds = new Set(blocks.map((b) => b.technicianId));

  // Expired blocking documents for someone already in section 1 would appear
  // twice on the same screen, and the second appearance is strictly weaker than
  // the first. What survives this filter is the set that section 1 cannot see:
  // expired documents that only warn, and expired blocking documents belonging
  // to somebody with no active technician record to block.
  const alreadyReported = (d: ExpiringDocument) =>
    d.blocking && d.technicianId !== null && blockedTechnicianIds.has(d.technicianId);

  const expired = documents.filter((d) => d.daysRemaining < 0 && !alreadyReported(d));
  const withinThirty = documents.filter((d) => d.daysRemaining >= 0 && d.daysRemaining <= 30);
  const beyondThirty = documents.filter((d) => d.daysRemaining > 30);

  const registered = employees.length;

  return (
    <AppShell session={session} active="workforce">
      <div className="container-page py-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Workforce compliance</h1>
          <p className="tnum text-[14px]" style={{ color: "var(--text-secondary)" }}>
            Headcount <strong style={{ color: "var(--text-primary)" }}>{summary.headcount}</strong>{" "}
            &middot; Deployable{" "}
            <strong style={{ color: "var(--text-primary)" }}>{summary.deployable}</strong> &middot;
            Blocked{" "}
            <strong
              style={{
                color: summary.blocked > 0 ? "var(--status-blocked-text)" : "var(--text-primary)",
              }}
            >
              {summary.blocked}
            </strong>
          </p>
        </div>

        <p className="prose-body mt-2 text-[14px]">
          Deploying a worker without a valid permit carries AED 100,000 to AED 1,000,000 under
          Article 60 of the Labour Law. Assignment refuses these people rather than warning about
          them; this page is where the refusal gets undone, by renewing the document.
        </p>

        {/* ── 1. Hard blocks ────────────────────────────────────────────── */}
        <section aria-labelledby="blocked-heading" className="mt-10">
          <div id="blocked-heading">
            <SectionHeading tone="blocked" title="Blocked from dispatch" count={blocks.length}>
              cannot be assigned to any job, by any route
            </SectionHeading>
          </div>

          {blocks.length === 0 ? (
            <div className="mt-4">
              {/* Zero blocks has two completely different meanings and the wrong
                  one is dangerous. With an empty register it means "nothing is
                  being checked"; with a populated one it means "everyone is
                  clear". Rendering both as a green tick is how a board becomes
                  reassuring and useless. */}
              <EmptyState
                tone={registered === 0 ? "warning" : "success"}
                title={
                  registered === 0
                    ? "Nobody is blocked, because nobody is being checked."
                    : "Nobody is blocked from dispatch."
                }
              >
                {registered === 0 ? (
                  <p>
                    There are no employment records, so there are no documents to check and no
                    dispatch can be blocked. All {unregistered.length} active{" "}
                    {unregistered.length === 1 ? "technician is" : "technicians are"} currently
                    deployable on that basis alone.
                  </p>
                ) : (
                  <p>
                    Every active technician with an employment record holds an in-date work permit,
                    residence visa, Emirates ID, medical fitness certificate and health insurance.
                    {unregistered.length > 0 ? (
                      <>
                        {" "}
                        That covers {registered} registered{" "}
                        {registered === 1 ? "person" : "people"}; {unregistered.length} active{" "}
                        {unregistered.length === 1 ? "technician has" : "technicians have"} no
                        employment record at all and nothing here is checking them.
                      </>
                    ) : null}
                  </p>
                )}
              </EmptyState>
            </div>
          ) : (
            <ul className="mt-4 space-y-3">
              {blocks.map((block) => {
                const employee = employeeByTechnician.get(block.technicianId);
                return (
                  <ComplianceBlock
                    key={`${block.technicianId}-${block.detail}`}
                    name={block.technicianName}
                    subtitle={tradeLabel(employee?.primaryTrade)}
                    detail={
                      block.daysExpired === null
                        ? block.detail
                        : `${block.detail} — ${daysPhrase(-block.daysExpired)}`
                    }
                    penalty={block.penalty}
                    otherExpiredCount={block.otherExpiredCount}
                    fixHref={
                      employee ? `/workforce/${employee.id}` : `/technicians/${block.technicianId}`
                    }
                    fixLabel="Open the compliance record and renew"
                  />
                );
              })}
            </ul>
          )}
        </section>

        {/* ── 2. Expiring documents ─────────────────────────────────────── */}
        <section aria-labelledby="expiring-heading" className="mt-10">
          <div id="expiring-heading">
            <SectionHeading tone="warning" title="Expiring within 30 days" count={withinThirty.length}>
              renew, or somebody stops being deployable
            </SectionHeading>
          </div>

          {expired.length > 0 ? (
            <div className="mt-4">
              <p className="text-[13px] font-semibold" style={{ color: "var(--status-critical-text)" }}>
                Already expired &mdash; {expired.length}
              </p>
              <DocumentTable rows={expired} />
            </div>
          ) : null}

          {withinThirty.length === 0 && expired.length === 0 ? (
            <div className="mt-4">
              <EmptyState
                tone={registered === 0 ? "warning" : "success"}
                title={
                  registered === 0
                    ? "Nothing is expiring, because nothing is on file."
                    : "Nothing expires in the next 30 days."
                }
              >
                {registered === 0 ? (
                  <p>
                    The document register is empty. Open an employment record below and add the work
                    permit, residence visa, Emirates ID, medical fitness certificate and health
                    insurance for each person &mdash; until then this board reports on nothing and
                    will keep saying everything is fine.
                  </p>
                ) : (
                  <p>
                    Documents are checked against a {DOCUMENT_HORIZON_DAYS}-day window, so anything
                    inside three months appears below well before it becomes urgent.
                  </p>
                )}
              </EmptyState>
            </div>
          ) : null}

          {withinThirty.length > 0 ? <DocumentTable rows={withinThirty} /> : null}

          {beyondThirty.length > 0 ? (
            <div className="mt-6">
              <p className="text-[13px] font-semibold" style={{ color: "var(--text-secondary)" }}>
                Between 31 and {DOCUMENT_HORIZON_DAYS} days &mdash; {beyondThirty.length}
              </p>
              <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                Still cheap to renew. This is the window where a MOHRE appointment can be booked
                without anybody standing down.
              </p>
              <DocumentTable rows={beyondThirty} />
            </div>
          ) : null}
        </section>

        {/* ── 3. Company accreditations ─────────────────────────────────── */}
        <section aria-labelledby="accreditations-heading" className="mt-10">
          <div id="accreditations-heading">
            <SectionHeading tone="warning" title="Company accreditations" count={accreditations.length}>
              the establishment&rsquo;s own paperwork, not an individual&rsquo;s
            </SectionHeading>
          </div>

          {accreditations.length === 0 ? (
            <div className="mt-4">
              <EmptyState
                tone="warning"
                title="No company accreditation is being watched."
                action={
                  canWrite ? (
                    <Link href="/workforce/accreditations" className="btn btn-primary">
                      Open the accreditation register
                    </Link>
                  ) : null
                }
              >
                <p>
                  Trade licence 930137 expires on 23 January 2027 and nothing in this system knows
                  about it. An expired trade licence stops the business rather than inconveniencing
                  it, and the same register feeds the tender pack &mdash; anything not recorded here
                  cannot be published or bid with.
                </p>
              </EmptyState>
            </div>
          ) : (
            <>
              <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
                {accreditations.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 p-4">
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
                      <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                        {ACCREDITATION_LABEL[a.kind as AccreditationKind] ?? humanise(a.kind)}
                      </p>
                    </div>
                    <ExpiryChip
                      expiresAt={a.expiresAt}
                      daysRemaining={a.daysRemaining}
                      warnWithinDays={ACCREDITATION_WARN_DAYS}
                      soonLabel="Renewal due"
                    />
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[13px]">
                <Link href="/workforce/accreditations" style={{ color: "var(--accent-text)" }}>
                  The full register, including anything expiring beyond {ACCREDITATION_HORIZON_DAYS}{" "}
                  days &rarr;
                </Link>
              </p>
            </>
          )}

          {/* `OPEN-3`, the highest-priority unknown in the requirements. Carried
              onto the screen rather than left in a document, because the people
              who can answer it are the people looking at this board. */}
          <p
            className="mt-4 rounded-sm border-l-2 px-4 py-3 text-[13px]"
            style={{ borderColor: "var(--status-warning)", color: "var(--text-secondary)" }}
          >
            <strong style={{ color: "var(--text-primary)" }}>Not registered:</strong> Dubai
            Municipality contractor classification. Dubai Law No. 7 of 2025 may require it, and may
            require professional competency certificates for technical personnel, from around
            January 2027. Whether it reaches a business this size is unverified &mdash; confirm with
            Dubai Municipality directly.
          </p>
        </section>

        {/* ── 3b. The people this company does not employ (HR-19) ────────
            Placed between the company's own accreditations and its employment
            records, because that is where it belongs conceptually: it is the
            same question — is the paperwork current — asked about an
            organisation rather than a person, and about workers on somebody
            else's payroll. Responsibility for site compliance does not transfer
            with the work, so their permits are this board's business too. */}
        <section aria-labelledby="subcontractors-heading" className="mt-10">
          <div id="subcontractors-heading">
            <SectionHeading tone="warning" title="Subcontractors and manpower suppliers">
              licence, insurance and per-worker permit verification (HR-19)
            </SectionHeading>
          </div>
          <p className="prose-body mt-2 text-[13px]">
            Nothing here blocks a dispatch &mdash; supplied workers are not assignable in this
            system. What the register earns is the expiry nobody was watching: deploying a worker
            without a valid permit carries AED 100,000 to AED 1,000,000 under Article 60, and an
            inspector does not ask whose payroll they were on.
          </p>
          <p className="mt-3 text-[13px]">
            <Link href="/workforce/subcontractors" style={{ color: "var(--accent-text)" }}>
              Open the subcontractor register &rarr;
            </Link>
          </p>
        </section>

        {/* ── 4. The register everything above is computed from ─────────── */}
        <section aria-labelledby="register-heading" className="mt-10">
          <div id="register-heading">
            <SectionHeading tone="success" title="Employment records" count={registered}>
              the document register itself (HR-5)
            </SectionHeading>
          </div>

          {registered === 0 ? (
            <div className="mt-4">
              <EmptyState tone="warning" title="No employment records yet.">
                <p>
                  Nothing above can be true until this list has people in it. An employment record
                  holds the documents; attaching it to a technician is what lets an expired document
                  stop a dispatch.
                </p>
              </EmptyState>
            </div>
          ) : (
            <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              {employees.map((e) => (
                <li key={e.id}>
                  <Link href={`/workforce/${e.id}`} className="block p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                      <p className="text-[14px] font-medium">
                        {e.fullName}
                        {e.employeeNo ? (
                          <span className="tnum font-normal" style={{ color: "var(--text-muted)" }}>
                            {" "}
                            &middot; {e.employeeNo}
                          </span>
                        ) : null}
                        {e.primaryTrade ? (
                          <span className="font-normal" style={{ color: "var(--text-secondary)" }}>
                            {" "}
                            &middot; {tradeLabel(e.primaryTrade)}
                          </span>
                        ) : null}
                      </p>
                      <span
                        className="text-[12px] font-medium"
                        style={{
                          color:
                            e.blockingGaps > 0
                              ? "var(--status-critical-text)"
                              : "var(--status-success-text)",
                        }}
                      >
                        {e.blockingGaps > 0
                          ? `${e.blockingGaps} of 5 required documents not in date`
                          : "All 5 required documents in date"}
                      </span>
                    </div>
                    <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                      {e.documentsOnFile} {e.documentsOnFile === 1 ? "document" : "documents"} on file
                      {e.technicianId ? "" : " · not linked to a technician, so nothing it holds can block a dispatch"}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {unregistered.length > 0 ? (
            <div className="mt-6">
              <p className="text-[13px] font-semibold" style={{ color: "var(--status-warning-text)" }}>
                Active technicians with no employment record &mdash; {unregistered.length}
              </p>
              <p className="prose-body mt-1 text-[12px]">
                Not a violation. Subcontracted and manpower-supplied labour legitimately has no
                employment file here, and HR-19 puts that verification on its own footing. But
                these people are invisible to every check on this page: the blocked count above is
                a count across the {registered} {registered === 1 ? "person" : "people"} we hold
                paperwork for, not across the {summary.headcount} on the roster.
              </p>
              <ul className="mt-3 flex flex-wrap gap-2">
                {unregistered.map((t) => (
                  <li
                    key={t.id}
                    className="rounded-sm border px-2.5 py-1 text-[12px]"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {t.fullName}{" "}
                    <span className="tnum" style={{ color: "var(--text-muted)" }}>
                      {t.employeeCode}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {canWrite ? (
            <div className="mt-6">
              <OpenRecordForm technicians={[...unregistered]} />
            </div>
          ) : (
            <p className="mt-6 text-[13px]" style={{ color: "var(--text-muted)" }}>
              Your role can read this board but not change it. An operations manager, HR or an
              administrator can add employment records and documents.
            </p>
          )}
        </section>

        <p className="mt-10 text-[12px]" style={{ color: "var(--text-muted)" }}>
          Certifications are held on the{" "}
          <Link href="/technicians" style={{ color: "var(--accent-text)" }}>
            technician record
          </Link>
          . Leave, working hours, injuries and payroll are specified but not built.
        </p>
      </div>
    </AppShell>
  );
}

/**
 * The expiry list.
 *
 * A table rather than cards: this is an operator surface read forty times a
 * day, scanned rather than read (§7.2), and the thing being compared across
 * rows is a number of days. Cards would put a paragraph between each one.
 */
function DocumentTable({ rows }: { rows: readonly ExpiringDocument[] }) {
  return (
    <ul className="mt-2 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
      {rows.map((d) => (
        <li key={`${d.employeeId}-${d.kind}`}>
          <Link
            href={`/workforce/${d.employeeId}`}
            className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 p-4"
          >
            <div>
              <p className="text-[14px] font-medium">{d.employeeName}</p>
              <p className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
                {d.label} &middot; expires {formatDay(d.expiresAt)}
              </p>
            </div>
            <ExpiryChip
              expiresAt={d.expiresAt}
              daysRemaining={d.daysRemaining}
              blocking={d.blocking}
            />
          </Link>
        </li>
      ))}
    </ul>
  );
}
