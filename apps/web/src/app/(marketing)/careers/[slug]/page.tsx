import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CANDIDATE_GRADE_LABEL,
  CONTRACT_TYPE_LABEL,
  HR16_NOTICE,
  breadcrumbSchema,
  company,
  formatMoney,
  getService,
  graph,
  jobPostingSchema,
  webPageSchema,
  type CandidateGrade,
  type ContractType,
} from "@meridian/core";
import { JsonLd } from "@/components/json-ld";
import { Eyebrow } from "@/components/ui";
import { ArrowLeft, ShieldCheck } from "@phosphor-icons/react/dist/ssr";
import { openRole } from "../roles";
import { ApplicationForm } from "./application-form";

/**
 * Role detail and application (`ATS-2`, `ATS-3`).
 *
 * Detail and form on one page rather than a `/careers/[slug]` → `/apply/[slug]`
 * pair. A separate apply page is a page load, a scroll and a decision to
 * re-make; on a phone that is a meaningful slice of a three-minute budget, and
 * every step between reading the advert and answering the first question is a
 * place to lose somebody.
 *
 * Dynamic, never static. A role that closed this morning must not still be
 * collecting applications this afternoon from a page generated last week —
 * every one of those is an applicant nobody is reading.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const role = await openRole(slug);
  if (!role) return { title: "Role not found", robots: { index: false, follow: false } };

  return {
    title: `${role.title} — Careers`,
    description:
      role.summary ??
      `${role.title} at ${company.legalName}. Direct employment, UAE labour contract, salary paid through WPS.`,
    alternates: { canonical: `/careers/${role.slug}` },
  };
}

export default async function RolePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const role = await openRole(slug);

  // A closed role 404s rather than rendering a form that would be refused on
  // submit. Letting somebody spend three minutes filling in an application for
  // a vacancy that no longer exists is the exact experience this module is
  // supposed to be the opposite of.
  if (!role) notFound();

  const trade = getService(role.trade);

  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            path: `/careers/${role.slug}`,
            name: role.title,
            description: role.summary ?? role.title,
            primaryAnswer:
              role.summary ??
              `${company.legalName} is hiring a ${role.title} in ${role.city} on a direct UAE labour contract.`,
          }),
          jobPostingSchema(role),
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Careers", path: "/careers" },
            { name: role.title, path: `/careers/${role.slug}` },
          ]),
        )}
      />

      <section className="border-b">
        <div className="container-page pt-10 pb-12 md:pt-14">
          <Link
            href="/careers"
            className="inline-flex items-center gap-1.5 text-[14px]"
            style={{ color: "var(--text-secondary)" }}
          >
            <ArrowLeft size={15} aria-hidden />
            All roles
          </Link>

          <Eyebrow>
            {CONTRACT_TYPE_LABEL[role.contractType as ContractType] ?? role.contractType} ·{" "}
            {trade?.shortName ?? role.trade}
          </Eyebrow>

          <h1 className="mt-3 max-w-3xl text-3xl font-semibold md:text-4xl">{role.title}</h1>

          <p className="mt-4 text-[16px]" style={{ color: "var(--text-secondary)" }}>
            {CANDIDATE_GRADE_LABEL[role.grade as CandidateGrade] ?? role.grade}
            {" · "}
            {role.area ? `${role.area}, ${role.city}` : role.city}
            {role.minExperienceYears !== null ? ` · ${role.minExperienceYears}+ years` : ""}
            {role.headcount > 1 ? ` · ${role.headcount} positions` : ""}
          </p>

          {role.salaryMinMinor !== null && role.salaryMaxMinor !== null ? (
            <p className="tnum mt-3 text-[18px] font-semibold">
              {formatMoney(role.salaryMinMinor, role.currency)} –{" "}
              {formatMoney(role.salaryMaxMinor, role.currency)} per month
            </p>
          ) : null}

          {role.closesAt ? (
            <p className="mt-3 text-[14px]" style={{ color: "var(--text-muted)" }}>
              Applications close{" "}
              {role.closesAt.toLocaleDateString("en-GB", {
                timeZone: "Asia/Dubai",
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </p>
          ) : null}
        </div>
      </section>

      <div className="container-page grid gap-14 py-12 lg:grid-cols-12 lg:py-16">
        {/* ── The advert ─────────────────────────────────────────────────── */}
        <div className="space-y-9 lg:col-span-5">
          {role.summary ? (
            <div>
              <h2 className="text-[19px] font-semibold">About the role</h2>
              <p className="prose-body mt-3 whitespace-pre-line">{role.summary}</p>
            </div>
          ) : null}

          {role.responsibilities ? (
            <div>
              <h2 className="text-[19px] font-semibold">What you would be doing</h2>
              <p className="prose-body mt-3 whitespace-pre-line">{role.responsibilities}</p>
            </div>
          ) : null}

          {role.requiredCertifications.length > 0 ? (
            <div>
              <h2 className="text-[19px] font-semibold">Certificates we need</h2>
              <ul className="prose-body mt-3 space-y-1.5">
                {role.requiredCertifications.map((certification) => (
                  <li key={certification}>· {certification}</li>
                ))}
              </ul>
              <p className="mt-3 text-[14px]" style={{ color: "var(--text-muted)" }}>
                No papers but you can do the work? Apply anyway and say so. We trade test with our
                own supervisors rather than filtering on paperwork.
              </p>
            </div>
          ) : null}

          {/*
            `ATS-6`. Physical requirements belong in the advert. Stating them
            here is what makes the single yes/no question on the form legitimate
            — the applicant is answering about a job they have been told the
            demands of, not disclosing anything about themselves.
          */}
          {role.physicalRequirements ? (
            <div>
              <h2 className="text-[19px] font-semibold">Physical requirements</h2>
              <p className="prose-body mt-3 whitespace-pre-line">{role.physicalRequirements}</p>
            </div>
          ) : null}

          <div
            className="flex items-start gap-3 rounded-sm p-4"
            style={{ backgroundColor: "var(--surface-sunken)" }}
          >
            <ShieldCheck
              size={19}
              weight="fill"
              aria-hidden
              className="mt-0.5 shrink-0"
              style={{ color: "var(--accent)" }}
            />
            {/*
              `HR-16`, on the page the worker reads, not only in the schema. A
              prohibition somebody has never been told about is one they cannot
              report a breach of — and an applicant who knows the rule is the
              most effective enforcement this company has.
            */}
            <p className="text-[14px]">{HR16_NOTICE}</p>
          </div>
        </div>

        {/* ── The form ───────────────────────────────────────────────────── */}
        <div className="lg:col-span-7">
          <div className="mb-7">
            <h2 className="text-2xl font-semibold">Apply</h2>
            <p className="prose-body mt-2 text-[15px]">
              Under three minutes. Only your name and phone number need typing — everything else is
              a tap, and a CV is optional.
            </p>
          </div>

          <ApplicationForm
            roleSlug={role.slug}
            roleTrade={role.trade}
            roleTitle={role.title}
            physicalRequirements={role.physicalRequirements}
          />
        </div>
      </div>
    </>
  );
}
