import Link from "next/link";
import { getService } from "@meridian/core";

/**
 * The compliance presentation primitives: `ComplianceBlock` and `ExpiryChip`.
 *
 * Local to `/workforce` for now. They belong in `components/` the moment a
 * second module needs them — `ComplianceBlock` already has a near-twin in the
 * job assign panel — but promoting them is a shared-file change and this route
 * is the only caller today.
 *
 * ── COLOUR IS NEVER THE MESSAGE ─────────────────────────────────────────────
 *
 * Every tone below carries a word. A red chip that says "23 Jan 2027" and
 * nothing else is invisible to a colourblind reader, to a screen reader, and to
 * anybody printing the board in mono for a site meeting — which is exactly when
 * an expiry list gets printed.
 */

/**
 * Four tones, and the distinction that matters is the first two.
 *
 * `blocked` is *impossible*; `critical` is *urgent*. They are separate hues on
 * purpose (`D-7`, and the contrast gate enforces at least 60 degrees between
 * them) because a dispatcher who reads "impossible" as "urgent" starts looking
 * for someone to authorise an override that does not exist.
 */
export type ComplianceTone = "blocked" | "critical" | "warning" | "success";

const TONE: Readonly<Record<ComplianceTone, { border: string; wash: string; text: string }>> = {
  blocked: {
    border: "var(--status-blocked)",
    wash: "var(--status-blocked-wash)",
    text: "var(--status-blocked-text)",
  },
  critical: {
    border: "var(--status-critical)",
    wash: "var(--status-critical-wash)",
    text: "var(--status-critical-text)",
  },
  warning: {
    border: "var(--status-warning)",
    wash: "var(--status-warning-wash)",
    text: "var(--status-warning-text)",
  },
  success: {
    border: "var(--status-success)",
    wash: "var(--status-success-wash)",
    text: "var(--status-success-text)",
  },
};

export function toneColours(tone: ComplianceTone): { border: string; wash: string; text: string } {
  return TONE[tone];
}

/**
 * How far ahead a company accreditation needs warning about.
 *
 * Twice the window used for a person's documents, because the renewal is twice
 * the job: a trade licence goes through a government department over weeks, and
 * an expired one stops the business rather than inconveniencing it. Shared
 * between the board and the register so the same licence cannot read as amber
 * on one screen and green on the other.
 */
export const ACCREDITATION_WARN_DAYS = 180;

/** Dubai-local rendering of a calendar day, from either a `Date` or `YYYY-MM-DD`. */
export function formatDay(value: Date | string): string {
  const date = typeof value === "string" ? new Date(`${value}T00:00:00Z`) : value;
  return date.toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium" });
}

/**
 * Days as a phrase, not a bare integer.
 *
 * "8" beside a date is ambiguous in the one direction that costs money — days
 * left, or days since. The words remove the guess.
 */
export function daysPhrase(daysRemaining: number): string {
  if (daysRemaining < 0) {
    const past = Math.abs(daysRemaining);
    return past === 1 ? "1 day ago" : `${past} days ago`;
  }
  if (daysRemaining === 0) return "today";
  return daysRemaining === 1 ? "in 1 day" : `in ${daysRemaining} days`;
}

/**
 * `ExpiryChip` — date, days remaining, severity, and always a word.
 *
 * One component, five contexts (§4.3). The `blocking` flag is what turns an
 * amber "expires soon" into "somebody stops being deployable on this date",
 * and that difference is the whole reason the section exists: one of these is
 * renew-at-some-point and the other is renew-or-lose-a-technician.
 */
export function ExpiryChip({
  expiresAt,
  daysRemaining,
  blocking = false,
  warnWithinDays = 90,
  soonLabel,
}: {
  expiresAt: Date | string | null;
  daysRemaining: number | null;
  blocking?: boolean;
  /**
   * How far ahead this kind of thing needs warning about.
   *
   * 90 days suits a person's documents, where a renewal is a clinic visit and a
   * MOHRE appointment. It does not suit a trade licence: that renewal runs
   * through a government department over weeks, so the caller widens the window
   * rather than the chip pretending a licence 155 days out is nothing to plan.
   */
  warnWithinDays?: number;
  /**
   * What "expiring soon" means here, where the default is wrong.
   *
   * The default labels describe an employee document: it will either block a
   * dispatch or warn at assignment. A company accreditation does neither —
   * nobody is assigned to a trade licence — so that caller says what its own
   * deadline is instead of borrowing language from a different consequence.
   */
  soonLabel?: string;
}) {
  if (expiresAt === null || daysRemaining === null) {
    return (
      <Chip tone="critical" label="No expiry recorded">
        An expiry nobody typed in is an expiry nobody is watching.
      </Chip>
    );
  }

  const expired = daysRemaining < 0;
  // T-90 is the outermost alert window in `HR-5`, so beyond the caller's window
  // it is simply valid — an amber chip on a permit with four months left is
  // noise, and noise is what makes the amber chips that matter get skipped.
  const soon = daysRemaining <= warnWithinDays;

  const tone: ComplianceTone = expired
    ? blocking
      ? "blocked"
      : "critical"
    : soon
      ? "warning"
      : "success";

  const label = expired
    ? blocking
      ? "Expired · blocks dispatch"
      : "Expired"
    : soon
      ? (soonLabel ?? (blocking ? "Will block on expiry" : "Warns at assignment"))
      : "Valid";

  return (
    <Chip tone={tone} label={label}>
      {formatDay(expiresAt)} &middot; {daysPhrase(daysRemaining)}
    </Chip>
  );
}

function Chip({
  tone,
  label,
  children,
}: {
  tone: ComplianceTone;
  label: string;
  children: React.ReactNode;
}) {
  const colours = TONE[tone];
  return (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span
        className="rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
        style={{ backgroundColor: colours.wash, color: colours.text }}
      >
        {label}
      </span>
      <span className="tnum text-[12px]" style={{ color: "var(--text-secondary)" }}>
        {children}
      </span>
    </span>
  );
}

/**
 * `ComplianceBlock` — the hard block, per §4.4.
 *
 * The details are the component, and each of them undoes the point if dropped:
 *
 *  - **No control at all.** Not a disabled button, not a greyed checkbox. A
 *    disabled control reads as "try again later"; the absence of one reads as
 *    "this is not possible", which is the true statement.
 *  - **The penalty as a number.** "AED 100,000–1,000,000" changes behaviour;
 *    "a compliance risk" does not.
 *  - **A route to fixing it.** A wall with no door gets climbed — the operator
 *    phones the technician directly and nothing is recorded at all.
 *  - **`role="note"` with an accessible name, not `role="alert"`.** This is a
 *    standing condition, not an event that just happened; announcing it as an
 *    alert on every render would make the page unusable with a screen reader.
 */
export function ComplianceBlock({
  name,
  subtitle,
  detail,
  penalty,
  otherExpiredCount,
  fixHref,
  fixLabel,
}: {
  name: string;
  subtitle?: string | null;
  detail: string;
  penalty?: string | null;
  /**
   * Other blocking documents this person has also let lapse.
   *
   * Shown as a count rather than a list. The card leads with the
   * longest-overdue document because that is the most urgent one; saying there
   * are others stops the renewal being treated as a single errand, which is how
   * somebody gets renewed and stays blocked.
   */
  otherExpiredCount?: number;
  fixHref: string;
  fixLabel: string;
}) {
  const colours = TONE.blocked;
  return (
    <li
      role="note"
      aria-label={`${name} cannot be dispatched`}
      className="rounded-sm border-2 p-4"
      style={{ borderColor: colours.border, backgroundColor: colours.wash }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[15px] font-semibold">
          {name}
          {subtitle ? (
            <span className="font-normal" style={{ color: "var(--text-secondary)" }}>
              {" "}
              &middot; {subtitle}
            </span>
          ) : null}
        </p>
        <span
          className="text-[11px] font-semibold uppercase tracking-wide"
          style={{ color: colours.text }}
        >
          Blocked from dispatch
        </span>
      </div>

      <p className="mt-2 text-[13px] font-medium">
        <span aria-hidden>⛔ </span>
        {detail}
        {otherExpiredCount && otherExpiredCount > 0 ? (
          <span style={{ color: "var(--status-blocked-text)" }}>
            {" "}
            — and {otherExpiredCount} other blocking{" "}
            {otherExpiredCount === 1 ? "document" : "documents"} also expired
          </span>
        ) : null}
      </p>

      {penalty ? (
        <p className="mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
          {penalty}
        </p>
      ) : null}

      <Link
        href={fixHref}
        className="mt-3 inline-block text-[13px] font-medium"
        style={{ color: "var(--accent-text)" }}
      >
        {fixLabel} &rarr;
      </Link>
    </li>
  );
}

/**
 * A section heading with its count, in the consequence-list archetype (§7.1 A).
 *
 * The count is in the heading rather than in a badge beside it so a screen
 * reader navigating by heading hears "Blocked from dispatch, 2" and can stop
 * there, instead of hearing "Blocked from dispatch" and having to enter the
 * section to find out whether it matters.
 */
export function SectionHeading({
  tone,
  title,
  count,
  children,
}: {
  tone: ComplianceTone;
  title: string;
  count?: number;
  children?: React.ReactNode;
}) {
  const colours = TONE[tone];
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="text-[15px] font-semibold uppercase tracking-wide" style={{ color: colours.text }}>
        {title}
        {count === undefined ? null : <span className="tnum"> &mdash; {count}</span>}
      </h2>
      {children ? (
        <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          {children}
        </p>
      ) : null}
    </div>
  );
}

/**
 * `ADM-12`. An empty list is a statement, and which statement depends entirely
 * on the list.
 *
 * "Nobody is blocked" is a **good** state and must read as one. "No documents
 * on file" is a **gap** and must read as one. Both are zero rows; rendering
 * them the same way — or rendering either as a blank box — teaches people to
 * ignore the section.
 */
export function EmptyState({
  tone,
  title,
  children,
  action,
}: {
  tone: ComplianceTone;
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const colours = TONE[tone];
  return (
    <div
      className="rounded-sm border p-6"
      style={{ borderColor: colours.border, backgroundColor: colours.wash }}
    >
      <p className="text-[14px] font-semibold" style={{ color: colours.text }}>
        {title}
      </p>
      <div className="prose-body mt-2 text-[13px]">{children}</div>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/**
 * Initialisms that title-casing would otherwise ruin.
 *
 * `hvac-ac-maintenance` sentence-cased is "Hvac ac maintenance", which reads as
 * a slug somebody forgot to translate. Small list on purpose: it covers the
 * abbreviations that actually occur in this domain's stored values.
 */
const INITIALISMS = new Set(["hvac", "ac", "id", "uae", "iso", "dewa", "dm", "mohre", "wps"]);

/** Slugs are stored; people read words. `contract_supply` → `Contract supply`. */
export function humanise(value: string | null | undefined): string | null {
  if (!value) return null;
  const words = value.replace(/[_-]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  return words
    .map((word, i) => {
      if (INITIALISMS.has(word.toLowerCase())) return word.toUpperCase();
      return i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    })
    .join(" ");
}

/**
 * A technician's trade, from the service catalogue where the slug is one.
 *
 * `primary_trade` holds a catalogue slug, so title-casing it directly gives
 * "Hvac ac maintenance" — which is the catalogue's own service rendered as if
 * nobody had ever named it. The catalogue calls it "HVAC / AC".
 */
export function tradeLabel(slug: string | null | undefined): string | null {
  if (!slug) return null;
  return getService(slug)?.shortName ?? humanise(slug);
}
