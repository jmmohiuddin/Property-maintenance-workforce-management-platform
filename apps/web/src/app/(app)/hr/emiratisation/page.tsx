import type { Metadata } from "next";
import Link from "next/link";
import { withTenant, skilledWorkforce, emiratisationPosition } from "@meridian/db";
import { can } from "@meridian/auth";
import {
  formatMoney,
  ISCO_MAJOR_GROUPS,
  ISCO_SKILLED_MAX_MAJOR_GROUP,
  EMIRATISATION_SKILLED_WAGE_FLOOR_MINOR,
  EMIRATISATION_SMALL_ESTABLISHMENT_FLOOR,
  EMIRATISATION_SKILLED_THRESHOLD,
  type IscoMajorGroup,
} from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { SectionHeading } from "../../workforce/compliance-ui";
import { ClassifyOccupation, type IscoOption } from "../gratuity-forms";

export const metadata: Metadata = { title: "Emiratisation" };
export const dynamic = "force-dynamic";

/**
 * The skilled headcount, against the 50-employee threshold (`HR-18`).
 *
 * ── WHY THE HEADLINE NUMBER IS SOMETIMES A RANGE ────────────────────────────
 *
 * "Skilled" is a conjunction of three facts, and an employee missing any of
 * them is not unskilled — nobody has said. Rendering a single confident number
 * would mean choosing a side for every unrecorded fact, and the reassuring side
 * is the one that produces `HR-18`'s named failure: discovering the threshold
 * was crossed a quarter ago. So where unknowns exist the screen shows the range
 * they create, and says who is in it.
 *
 * ── AND WHY THE OWNER DASHBOARD DOES NOT SHOW THIS YET ──────────────────────
 *
 * It shows raw headcount with an explicit gap entry saying a contractor with 60
 * tradesmen and 6 office staff is measured against the 6. That entry was right
 * and can now be closed — the denominator is computable — but closing it is the
 * dashboard owner's change, not this page's.
 */
export default async function EmiratisationPage() {
  const session = await requireSessionWith("workforce:read");
  const canWrite = can(session.principal, "workforce:write");

  const { workforce, position } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      workforce: await skilledWorkforce(tx),
      position: await emiratisationPosition(tx),
    }),
  );

  const unknown = workforce.filter((w) => w.test.classification === "unknown");
  const skilled = workforce.filter((w) => w.test.classification === "skilled");
  const excluded = workforce.filter((w) => w.test.classification === "excluded");

  const groups: IscoOption[] = (Object.keys(ISCO_MAJOR_GROUPS) as unknown as string[]).map((key) => {
    const value = Number(key) as IscoMajorGroup;
    return { value, label: ISCO_MAJOR_GROUPS[value], skilled: value <= ISCO_SKILLED_MAX_MAJOR_GROUP };
  });

  const tone =
    position.undecidedByMissingFacts || position.inScope
      ? "var(--status-warning-text)"
      : "var(--accent-text)";

  return (
    <AppShell session={session} active="hr">
      <div className="container-page py-8">
        <p className="text-[13px]">
          <Link href="/hr" style={{ color: "var(--accent-text)" }}>
            &larr; Employment lifecycle
          </Link>
        </p>

        <h1 className="mt-4 text-2xl font-semibold tracking-tight md:text-3xl">Emiratisation</h1>
        <p className="prose-body mt-2 text-[14px]">
          Targets apply to establishments with {EMIRATISATION_SKILLED_THRESHOLD} or more{" "}
          <strong>skilled</strong> employees, and skilled means three things at once: ISCO
          occupational major group 1&ndash;{ISCO_SKILLED_MAX_MAJOR_GROUP}, <em>and</em> a
          post-secondary certificate, <em>and</em> a salary of at least{" "}
          {formatMoney(EMIRATISATION_SKILLED_WAGE_FLOOR_MINOR)} a month. Manual and craft workers,
          drivers, security and cleaners fall outside it. Total headcount is not the number this is
          measured against &mdash; a contractor with 60 tradesmen and 6 office staff is measured
          against the 6.
        </p>

        {/* ── The position ─────────────────────────────────────────────────── */}
        <div
          className="mt-8 rounded-sm border-l-2 px-5 py-4"
          style={{ borderColor: tone, backgroundColor: "var(--surface-raised)" }}
        >
          <p className="text-[13px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            Skilled headcount
          </p>
          <p className="tnum mt-1 text-3xl font-semibold">
            {position.unknown > 0
              ? `${position.lowerBound}–${position.upperBound}`
              : position.lowerBound}
            <span className="text-[16px] font-normal" style={{ color: "var(--text-muted)" }}>
              {" "}
              of {position.headcount} employed
            </span>
          </p>
          <p className="prose-body mt-2 text-[13px]">{position.headline}</p>
          {position.caveat ? (
            <p className="mt-2 text-[13px]" style={{ color: "var(--status-warning-text)" }}>
              {position.caveat}
            </p>
          ) : null}
          {/* Adjacent to the figure, not only in the panel below it. Somebody
              reading the number and acting on it must not have to scroll to
              learn that the threshold's applicability to this sector is
              unresolved. */}
          {position.band === "small_establishment_band" ? (
            <p className="mt-2 text-[13px] font-medium" style={{ color: "var(--status-warning-text)" }}>
              This figure is measured against a rule whose application to technical services is
              unconfirmed &mdash; see OPEN-4 below.
            </p>
          ) : null}
        </div>

        {/* ── OPEN-4, stated rather than answered ──────────────────────────── */}
        <div className="mt-4 rounded-sm border px-5 py-4 text-[13px]" style={{ borderColor: "var(--border)" }}>
          <p className="font-medium">Unresolved: the {EMIRATISATION_SMALL_ESTABLISHMENT_FLOOR}&ndash;
            {EMIRATISATION_SKILLED_THRESHOLD - 1} employee rule (OPEN-4)</p>
          <p className="prose-body mt-1">
            A separate Emiratisation rule applies to establishments of{" "}
            {EMIRATISATION_SMALL_ESTABLISHMENT_FLOOR}&ndash;{EMIRATISATION_SKILLED_THRESHOLD - 1}{" "}
            employees in certain designated sectors. Whether technical services is one of those
            sectors is genuinely unknown &mdash; published sources conflict, and it has not been
            confirmed with MOHRE. This system assumes <strong>in scope</strong> until told
            otherwise, which is the conservative direction. It is written here rather than encoded
            as a certainty, because the alternative is a screen that quietly asserts an answer
            nobody has.
          </p>
        </div>

        {/* ── Unknowns first: they are the actionable ones ─────────────────── */}
        <section className="mt-10">
          <SectionHeading
            tone={unknown.length > 0 ? "warning" : "success"}
            title="Unclassified"
            count={unknown.length}
          >
            {unknown.length > 0
              ? "Counted as neither skilled nor excluded. Each one widens the range above."
              : "Every employee has been put through all three legs of the test."}
          </SectionHeading>

          {unknown.length > 0 ? (
            <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              {unknown.map((w) => (
                <li key={w.employeeId} className="p-4">
                  <p className="text-[14px] font-medium">{w.fullName}</p>
                  <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                    {w.test.reasons.join(" ")}
                  </p>
                  {canWrite ? (
                    <ClassifyOccupation
                      employeeId={w.employeeId}
                      employeeName={w.fullName}
                      groups={groups}
                      currentGroup={w.iscoMajorGroup}
                      currentCertificate={w.postSecondaryCertificate}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="mt-10">
          <SectionHeading tone="success" title="Inside the denominator" count={skilled.length}>
            All three legs pass.
          </SectionHeading>
          {skilled.length === 0 ? (
            <p className="mt-4 text-[13px]" style={{ color: "var(--text-muted)" }}>
              Nobody currently passes all three legs. For a technical-services contractor this is a
              normal state rather than a gap &mdash; the trades are outside the test by design.
            </p>
          ) : (
            <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              {skilled.map((w) => (
                <li key={w.employeeId} className="p-4">
                  <p className="text-[14px] font-medium">{w.fullName}</p>
                  <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                    ISCO {w.iscoMajorGroup} &mdash; {w.iscoLabel} &middot; post-secondary certificate
                    &middot; {formatMoney(w.monthlyWageMinor ?? 0)}/month
                  </p>
                  {canWrite ? (
                    <ClassifyOccupation
                      employeeId={w.employeeId}
                      employeeName={w.fullName}
                      groups={groups}
                      currentGroup={w.iscoMajorGroup}
                      currentCertificate={w.postSecondaryCertificate}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-10">
          <SectionHeading tone="success" title="Outside the denominator" count={excluded.length}>
            At least one leg definitely fails. Excluded from both the numerator and the denominator.
          </SectionHeading>
          {excluded.length > 0 ? (
            <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              {excluded.map((w) => (
                <li key={w.employeeId} className="p-4">
                  <p className="text-[14px] font-medium">{w.fullName}</p>
                  <ul className="mt-1 space-y-0.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
                    {w.test.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                  {canWrite ? (
                    <ClassifyOccupation
                      employeeId={w.employeeId}
                      employeeName={w.fullName}
                      groups={groups}
                      currentGroup={w.iscoMajorGroup}
                      currentCertificate={w.postSecondaryCertificate}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {/* ── The numerator, and why it is not here ────────────────────────── */}
        <div className="mt-10 rounded-sm border px-5 py-4 text-[13px]" style={{ borderColor: "var(--border)" }}>
          <p className="font-medium">What this screen does not compute</p>
          <p className="prose-body mt-1">
            The Emiratisation <em>ratio</em> needs a count of UAE nationals, and there is no
            nationality field on the employment record &mdash; deliberately. This system does not
            capture nationality anywhere, and adding a protected characteristic to compute a figure
            MOHRE reports from its own register would be the wrong trade. What is computed here is
            the denominator, which is the part everybody gets wrong.
          </p>
        </div>
      </div>
    </AppShell>
  );
}
