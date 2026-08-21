import type { Metadata } from "next";
import Link from "next/link";
import { withTenant } from "@meridian/db";
import {
  IDENTITY_KEYS,
  loadIdentityOverride,
  resolveCompanyIdentity,
  loadWorkingCalendar,
} from "@meridian/db/domain";
import {
  identityProblems,
  LICENSED_ACTIVITY_REGISTER,
  fromDubai,
  formatMinute,
  calendarWarnings,
} from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { CompanyForm, type IdentityValues } from "./company-form";

export const metadata: Metadata = {
  title: "Company",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const WEEKDAY_NAME = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/**
 * `/admin/company` — `ADM-9`, resolving `TD-9`.
 *
 * Identity stops being a source file. The screen's job is not really the form,
 * though: it is the panel above the form. The previous build published a
 * fabricated brand — a licence numbered `DED-000000`, 62,000 jobs completed,
 * three ISO certificates — and the reason none of it was caught is that nothing
 * anywhere asked whether it was true. `identityProblems()` asks, and this is
 * where it answers out loud.
 *
 * So an unset field is never blank here. It says what it blocks: no TRN means
 * no tax invoice can be issued at all, and that is a sentence somebody reads
 * and acts on, where an empty box is a sentence nobody reads.
 */
export default async function AdminCompanyPage() {
  const session = await requireSessionWith("settings:write");

  const { identity, override, calendar } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      identity: await resolveCompanyIdentity(tx),
      override: await loadIdentityOverride(tx),
      calendar: await loadWorkingCalendar(tx),
    }),
  );

  const now = new Date();
  const problems = identityProblems(identity);
  // Three tiers, and the middle one is the point. `certain` cannot be real and
  // blocks a production deploy; `missing` renders as nothing, which is honest;
  // `suspected` is a round number that is probably somebody's real phone line.
  // Flattening the last two into one banner is what made the old check
  // untrustworthy — a warning that is usually wrong gets ignored, including the
  // times it is right.
  const certain = problems.filter((p) => p.reason === "placeholder" && p.confidence === "certain");
  const suspected = problems.filter(
    (p) => p.reason === "placeholder" && p.confidence === "suspected",
  );
  const missing = problems.filter((p) => p.reason === "missing");
  const storedHere = IDENTITY_KEYS.filter((key) => key in override).length;

  const licence = licenceExpiryState(identity.licenceExpiry, now);
  const calendarGaps = calendarWarnings(calendar, now);

  const values: IdentityValues = {
    legalName: identity.legalName,
    tradingName: identity.tradingName ?? "",
    brandName: identity.brandName,
    licenceNumber: identity.licenceNumber ?? "",
    licenceExpiry: identity.licenceExpiry ?? "",
    crNumber: identity.crNumber ?? "",
    trn: identity.trn ?? "",
    addressStreet: identity.address.street ?? "",
    addressCity: identity.address.city,
    addressRegion: identity.address.region,
    lat: identity.address.lat === null ? "" : String(identity.address.lat),
    lng: identity.address.lng === null ? "" : String(identity.address.lng),
    phone: identity.phone ?? "",
    emergencyPhone: identity.emergencyPhone ?? "",
    whatsapp: identity.whatsapp ?? "",
    email: identity.email ?? "",
  };

  return (
    <AppShell session={session} active="admin/company">
      <main id="main" className="container-page py-10">
        <header className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Company</h1>
            <p className="prose-body mt-2 text-[15px]">
              These values appear on every quote, invoice and contract, and in the website footer.
            </p>
          </div>
          <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
            Changes are audited
          </p>
        </header>

        {/*
          Ordered by consequence, like every other list here: what cannot be
          true, then what is not set, then what merely looks odd.
        */}
        {certain.length > 0 ? (
          <section
            className="mt-6 rounded-sm p-4"
            style={{ backgroundColor: "var(--status-critical-wash)" }}
            aria-labelledby="certain-heading"
          >
            <h2 id="certain-heading" className="text-[14px] font-semibold">
              {certain.length} {certain.length === 1 ? "value" : "values"} cannot be real and would be
              published as fact
            </h2>
            <ul className="mt-2 space-y-1.5 text-[14px]">
              {certain.map((p) => (
                <li key={`${p.field}-certain`}>
                  <span className="font-medium">{p.field}</span> — {p.blocks}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>
              A deploy to production refuses while any of these stand. Clear the field or replace it
              with the real value.
            </p>
          </section>
        ) : null}

        {missing.length > 0 ? (
          <section
            className="mt-4 rounded-sm p-4"
            style={{ backgroundColor: "var(--status-warning-wash)" }}
            aria-labelledby="missing-heading"
          >
            <h2 id="missing-heading" className="text-[14px] font-semibold">
              {missing.length} {missing.length === 1 ? "value is" : "values are"} not set
            </h2>
            <p className="mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
              Nothing is invented in their place — the claim is simply omitted wherever it would have
              appeared. What that costs, field by field:
            </p>
            <ul className="mt-2 space-y-1.5 text-[14px]">
              {missing.map((p) => (
                <li key={`${p.field}-missing`}>
                  <span className="font-medium">{p.field}</span> — blocks {p.blocks}
                  <span className="ml-1 font-mono text-[12px]" style={{ color: "var(--text-muted)" }}>
                    {p.envVar}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/*
          Deliberately the quietest panel on the screen, and deliberately not
          the warning tone. A round phone number is what an established business
          buys; this is a "worth a glance", and dressing it as an alarm is how a
          check stops being believed.
        */}
        {suspected.length > 0 ? (
          <section
            className="mt-4 rounded-sm p-4"
            style={{ backgroundColor: "var(--surface-sunken)" }}
            aria-labelledby="suspected-heading"
          >
            <h2 id="suspected-heading" className="text-[14px] font-semibold">
              Worth a check — {suspected.length}{" "}
              {suspected.length === 1 ? "value looks" : "values look"} like a stand-in
            </h2>
            <ul className="mt-2 space-y-1.5 text-[14px]">
              {suspected.map((p) => (
                <li key={`${p.field}-suspected`}>
                  <span className="font-medium">{p.field}</span> — {p.blocks}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>
              These block nothing. If the value is right, leave it — it will keep saying this, and
              that is cheaper than a check that refuses true values.
            </p>
          </section>
        ) : null}

        {problems.length === 0 ? (
          <p
            className="mt-6 rounded-sm p-4 text-[14px]"
            style={{ backgroundColor: "var(--status-success-wash)" }}
          >
            Every required value is set and none of them looks like a placeholder.
          </p>
        ) : null}

        {licence ? (
          <p
            className="mt-4 rounded-sm p-4 text-[14px]"
            style={{
              backgroundColor:
                licence.tone === "critical"
                  ? "var(--status-critical-wash)"
                  : licence.tone === "warning"
                    ? "var(--status-warning-wash)"
                    : "var(--surface-sunken)",
            }}
          >
            {licence.message}
          </p>
        ) : null}

        <section className="mt-8 rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
          <CompanyForm values={values} />
          <p className="mt-6 border-t pt-4 text-[13px]" style={{ color: "var(--text-muted)" }}>
            {storedHere === 0
              ? "Every value currently comes from environment configuration. Saving this form stores it in the database instead, and the stored value wins from then on."
              : `${storedHere} of ${IDENTITY_KEYS.length} values are stored here and override the COMPANY_* environment configuration. The rest still come from configuration.`}
          </p>
        </section>

        {/*
          Read-only, and it is the licence that makes it so. §2.2 of the PRD: the
          service catalogue is derived from this list and may not exceed it.
          Editing the boundary of what may legally be quoted for is not an
          administrative action — it is a licence amendment.
        */}
        <section className="mt-10">
          <h2 className="text-[15px] font-semibold">Licensed activities</h2>
          <p className="prose-body mt-2 text-[14px]">
            The ten activities the trade licence permits. The service catalogue is derived from this
            list and may not exceed it — quoting outside it is a licensing exposure. Changing the
            list means amending the licence, so it cannot be edited here.
          </p>
          <ul className="mt-4 grid gap-x-8 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {LICENSED_ACTIVITY_REGISTER.map((activity) => (
              <li key={activity.key} className="flex items-baseline justify-between gap-3 border-b py-1.5">
                <span className="text-[14px]">{activity.licenceWording}</span>
                <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                  {activity.family}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-10">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-semibold">Working calendar</h2>
            <Link
              href="/admin/reference"
              className="text-[13px] font-medium underline underline-offset-2"
              style={{ color: "var(--accent-text)" }}
            >
              Manage holidays and hours →
            </Link>
          </div>

          <dl className="mt-4 grid gap-x-8 gap-y-3 text-[14px] sm:grid-cols-2">
            <div className="flex justify-between gap-3 border-b py-1.5">
              <dt style={{ color: "var(--text-secondary)" }}>Weekend</dt>
              <dd>{calendar.weekend.map((d) => WEEKDAY_NAME[d] ?? d).join(" and ") || "None"}</dd>
            </div>
            <div className="flex justify-between gap-3 border-b py-1.5">
              <dt style={{ color: "var(--text-secondary)" }}>Hours</dt>
              <dd>
                {formatMinute(calendar.openMinute)}–{formatMinute(calendar.closeMinute)}
              </dd>
            </div>
            <div className="flex justify-between gap-3 border-b py-1.5">
              <dt style={{ color: "var(--text-secondary)" }}>Public holidays</dt>
              <dd>{Object.keys(calendar.publicHolidays).length} entered</dd>
            </div>
            <div className="flex justify-between gap-3 border-b py-1.5">
              <dt style={{ color: "var(--text-secondary)" }}>Summer midday ban</dt>
              <dd>
                {formatMinute(calendar.middayBan.startMinute)}–{formatMinute(calendar.middayBan.endMinute)},
                statutory
              </dd>
            </div>
          </dl>

          {calendarGaps.length > 0 ? (
            <ul
              className="mt-4 space-y-1.5 rounded-sm p-4 text-[14px]"
              style={{ backgroundColor: "var(--status-warning-wash)" }}
            >
              {calendarGaps.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </section>
      </main>
    </AppShell>
  );
}

/**
 * How long the trade licence has left.
 *
 * Renewal is not a same-day errand, so the warning starts early: ninety days is
 * roughly the point at which a renewal that has not been started is a problem,
 * and an expired licence stops the company trading rather than merely
 * inconveniencing it.
 */
function licenceExpiryState(
  expiry: string | null,
  now: Date,
): { tone: "critical" | "warning" | "neutral"; message: string } | null {
  if (!expiry) return null;

  const [year, month, day] = expiry.split("-").map(Number);
  if (!year || !month || !day) return null;

  // Dubai midnight, so "days remaining" is counted in the calendar the licence
  // is read in rather than in UTC, where it would tick over four hours early.
  const expiresAt = fromDubai(year, month, day, 0);
  const days = Math.ceil((expiresAt.getTime() - now.getTime()) / 86_400_000);

  const printed = `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;

  if (days < 0) {
    return {
      tone: "critical",
      message: `The trade licence expired on ${printed}. Trading on an expired licence is a licensing offence — renew it before quoting further work.`,
    };
  }
  if (days <= 90) {
    return {
      tone: "warning",
      message: `The trade licence expires on ${printed} — ${days} ${days === 1 ? "day" : "days"} away. Start the renewal now.`,
    };
  }
  return {
    tone: "neutral",
    message: `Trade licence valid until ${printed} — ${days} days remaining.`,
  };
}
