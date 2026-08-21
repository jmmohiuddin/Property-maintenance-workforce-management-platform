import Link from "next/link";
import {
  CANDIDATE_GRADE_LABEL,
  CONTRACT_TYPE_LABEL,
  formatMoney,
  getService,
  telLink,
  tenant,
  whatsappLink,
  type CandidateGrade,
  type ContractType,
  type PublicRequisition,
} from "@meridian/core";
import { Section } from "@/components/ui";
import { ArrowRight, WhatsappLogo } from "@phosphor-icons/react/dist/ssr";

/**
 * The open-roles list (`ATS-2`, wireframe §2.3).
 *
 * ── THE EMPTY STATE IS THE IMPORTANT HALF ───────────────────────────────────
 *
 * Most of the time a small contractor has one or two vacancies, and often none.
 * A careers page that says "no open roles" and stops is a page that converts a
 * good plumber who found you on a Tuesday into nothing at all — and in a
 * referral-driven trades market that person does not come back a second time.
 *
 * So the empty state points at the channels that are answered today. `ATS-13`'s
 * talent pool is fed by exactly these conversations, and the difference between
 * "no roles, goodbye" and "no roles, message us" is the difference between a
 * careers page and a notice board.
 */
export function OpenRoles({ roles }: { roles: readonly PublicRequisition[] }) {
  const applyOnWhatsapp = whatsappLink(
    "Hello, I would like to be considered for technician work. My trade is:",
  );

  if (roles.length === 0) {
    return (
      <Section className="!py-14">
        <div className="container-page">
          <h2 className="text-2xl font-semibold md:text-3xl">Open roles</h2>
          <div
            className="mt-7 rounded border p-8"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            <p className="text-[17px] font-semibold">No open roles right now.</p>
            <p className="prose-body mt-2.5 text-[15px]">
              That changes often — contracts start and technicians move on. Send us your trade and
              your years of experience and we will come back to you when something in your line
              opens up.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              {applyOnWhatsapp ? (
                <a href={applyOnWhatsapp} className="btn btn-primary">
                  <WhatsappLogo size={17} weight="fill" aria-hidden />
                  Message us on WhatsApp
                </a>
              ) : null}
              {tenant.phone ? (
                <a href={telLink(tenant.phone)} className="btn btn-secondary">
                  Call {tenant.phone}
                </a>
              ) : null}
            </div>
          </div>
        </div>
      </Section>
    );
  }

  return (
    <Section className="!py-14">
      <div className="container-page">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-2xl font-semibold md:text-3xl">
            Open roles
            <span className="ml-3 text-[15px] font-normal" style={{ color: "var(--text-muted)" }}>
              {roles.length} {roles.length === 1 ? "vacancy" : "vacancies"}
            </span>
          </h2>
          <p className="text-[14px]" style={{ color: "var(--text-muted)" }}>
            Under three minutes to apply. A CV is optional.
          </p>
        </div>

        <ul className="mt-8 space-y-4">
          {roles.map((role) => (
            <li key={role.slug}>
              <RoleCard role={role} />
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

function RoleCard({ role }: { role: PublicRequisition }) {
  const trade = getService(role.trade)?.shortName ?? role.trade;

  return (
    <article
      className="rounded border p-6 transition-colors hover:border-[var(--accent)]"
      style={{ backgroundColor: "var(--surface-raised)" }}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-[19px] font-semibold tracking-tight">
            <Link href={`/careers/${role.slug}`} className="hover:text-[var(--accent-text)]">
              {role.title}
            </Link>
          </h3>

          {/*
            The facts a tradesperson decides on, in the order they decide in:
            what it is, where it is, how much experience, and only then the
            money. Grade is included because "technician" and "charge hand" are
            different jobs to the person reading, not different labels.
          */}
          <p className="mt-2 text-[14px]" style={{ color: "var(--text-secondary)" }}>
            {CONTRACT_TYPE_LABEL[role.contractType as ContractType] ?? role.contractType}
            {" · "}
            {trade}
            {" · "}
            {CANDIDATE_GRADE_LABEL[role.grade as CandidateGrade] ?? role.grade}
            {" · "}
            {role.area ? `${role.area}, ${role.city}` : role.city}
            {role.minExperienceYears !== null ? ` · ${role.minExperienceYears}+ years` : ""}
            {role.headcount > 1 ? ` · ${role.headcount} positions` : ""}
          </p>

          {role.summary ? (
            <p className="prose-body mt-3 max-w-2xl text-[15px]">{role.summary}</p>
          ) : null}

          {/*
            Only when a real band exists. A missing salary is honest; an invented
            one is a commitment nobody made, and this is a public page.
          */}
          {role.salaryMinMinor !== null && role.salaryMaxMinor !== null ? (
            <p className="tnum mt-3 text-[15px] font-medium">
              {formatMoney(role.salaryMinMinor, role.currency)} –{" "}
              {formatMoney(role.salaryMaxMinor, role.currency)} per month
            </p>
          ) : null}

          {role.closesAt ? (
            <p className="mt-3 text-[13px]" style={{ color: "var(--text-muted)" }}>
              Closes{" "}
              {role.closesAt.toLocaleDateString("en-GB", {
                timeZone: "Asia/Dubai",
                day: "numeric",
                month: "long",
              })}
            </p>
          ) : null}
        </div>

        <Link href={`/careers/${role.slug}`} className="btn btn-primary shrink-0">
          View &amp; apply
          <ArrowRight size={16} weight="bold" aria-hidden />
        </Link>
      </div>
    </article>
  );
}
