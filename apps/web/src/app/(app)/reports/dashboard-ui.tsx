import Link from "next/link";
import { formatMoney, type GoalVerdict } from "@meridian/core";

/**
 * The owner dashboard's presentation primitives.
 *
 * ── WHY THERE IS NO CHART LIBRARY HERE ──────────────────────────────────────
 *
 * The wireframe's only graphic is a ten-segment progress bar against the AED 3m
 * relief line, and `Meter` below is that bar in nine lines of CSS. Adding a
 * charting dependency to draw it would buy an axis nobody asked for, a client
 * bundle on a page specified to be read on a phone, and a second colour system
 * to keep inside the contrast gate. Every other figure on this screen is a
 * number or a short list, and a number renders better as a number.
 *
 * ── THE FOUR RULES THE COMPONENTS ENFORCE ───────────────────────────────────
 *
 *  1. **A missing measurement is never a zero.** `Metric` takes `null` and
 *     renders "not measured" with the reason. A dashboard that shows 0% for an
 *     unmeasured conversion rate is lying in the reassuring direction.
 *  2. **Colour is never the message.** Every verdict carries a word. The screen
 *     gets printed, screenshotted into WhatsApp, and read by people who cannot
 *     separate the hues.
 *  3. **Every figure says what it is measured against.** "DSO 95 days" means
 *     nothing on its own; "95 days, target under 45" is a fact somebody can
 *     act on.
 *  4. **Mobile first.** One column, stacked cards, tabular figures. `KPI-3`
 *     says designed for a phone and read weekly, and that is not a layout note
 *     — it is why the whole thing is a card stack rather than a grid of tiles.
 */

export function Card({
  title,
  subtitle,
  tone = "neutral",
  href,
  children,
}: {
  title: string;
  subtitle?: string;
  tone?: "neutral" | "critical" | "warning";
  /** Where the figures in this card come from, so a number can be checked. */
  href?: string;
  children: React.ReactNode;
}) {
  const border =
    tone === "critical"
      ? "var(--status-critical)"
      : tone === "warning"
        ? "var(--status-warning)"
        : "var(--border-strong)";

  return (
    <section
      aria-labelledby={`card-${title.replace(/\W+/g, "-").toLowerCase()}`}
      className="rounded-sm border p-5"
      style={{ borderColor: border, backgroundColor: "var(--surface-raised)" }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2
          id={`card-${title.replace(/\W+/g, "-").toLowerCase()}`}
          className="text-[13px] font-semibold uppercase tracking-wide"
          style={{ color: "var(--text-secondary)" }}
        >
          {title}
        </h2>
        {href ? (
          <Link href={href} className="text-[12px] font-medium" style={{ color: "var(--accent-text)" }}>
            Open &rarr;
          </Link>
        ) : null}
      </div>
      {subtitle ? (
        <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
          {subtitle}
        </p>
      ) : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * One labelled figure.
 *
 * `value === null` is a first-class case, not an edge case: it renders "not
 * measured" in muted type with `note` explaining why the denominator was
 * missing. The alternative — an em dash, or worse a 0 — is how a reader
 * concludes a business has no receivables when in fact nothing has been
 * invoiced.
 */
export function Metric({
  label,
  value,
  note,
  verdict,
  emphasis = false,
}: {
  label: string;
  value: string | null;
  note?: string;
  verdict?: GoalVerdict;
  emphasis?: boolean;
}) {
  const colour =
    verdict === "missed"
      ? "var(--status-critical-text)"
      : verdict === "met"
        ? "var(--status-success-text)"
        : "var(--text-primary)";

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5">
      <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
        {label}
      </span>
      <span className="flex flex-wrap items-baseline justify-end gap-x-2 text-right">
        <span
          className={`tnum ${emphasis ? "text-[18px] font-semibold" : "text-[14px] font-medium"}`}
          style={{ color: value === null ? "var(--text-muted)" : colour }}
        >
          {value ?? "not measured"}
        </span>
        {verdict && value !== null ? <VerdictWord verdict={verdict} /> : null}
        {note ? (
          <span className="w-full text-[11px]" style={{ color: "var(--text-muted)" }}>
            {note}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * The verdict, as a word.
 *
 * `unknown` renders nothing rather than a neutral badge. A grey "unknown" chip
 * beside every unmeasured figure turns into visual noise that trains the reader
 * to skip the row, and the row already says "not measured" in the value.
 */
function VerdictWord({ verdict }: { verdict: GoalVerdict }) {
  if (verdict === "unknown") return null;
  const met = verdict === "met";
  return (
    <span
      className="rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={{
        backgroundColor: met ? "var(--status-success-wash)" : "var(--status-critical-wash)",
        color: met ? "var(--status-success-text)" : "var(--status-critical-text)",
      }}
    >
      {met ? "on target" : "off target"}
    </span>
  );
}

/**
 * A proportion bar, with its numbers written out beside it.
 *
 * The bar is decorative and marked so. Everything it conveys is also in the
 * text — the requirement it serves is "revenue against the AED 3m line", and a
 * reader who cannot see the fill still has to be able to read the answer.
 *
 * Clamped at 100% fill. A business past the threshold gets a full bar and a
 * sentence saying it was crossed, rather than a bar overflowing its track,
 * which reads as a rendering fault rather than as a tax event.
 */
export function Meter({
  value,
  max,
  currency,
  tone,
}: {
  value: number;
  max: number;
  currency: string;
  tone: "clear" | "approaching" | "breached";
}) {
  const percent = max <= 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  const fill =
    tone === "breached"
      ? "var(--status-critical)"
      : tone === "approaching"
        ? "var(--status-warning)"
        : "var(--status-success)";

  return (
    <div>
      <div
        aria-hidden
        className="h-2 w-full overflow-hidden rounded-sm"
        style={{ backgroundColor: "var(--surface-sunken)" }}
      >
        <div className="h-full" style={{ width: `${percent}%`, backgroundColor: fill }} />
      </div>
      <p className="tnum mt-2 text-[13px]">
        <strong>{formatMoney(value, currency)}</strong>{" "}
        <span style={{ color: "var(--text-secondary)" }}>
          of {formatMoney(max, currency)} &middot; {percent}%
        </span>
      </p>
    </div>
  );
}

/**
 * The "needs you" item.
 *
 * `role="note"` with an accessible name, not `role="alert"` — the same choice
 * `ComplianceBlock` makes and for the same reason. These are standing
 * conditions rendered on every page load, and announcing each one as an alert
 * makes the screen unusable with a screen reader.
 */
export function AttentionItem({
  severity,
  headline,
  detail,
  href,
}: {
  severity: "critical" | "warning";
  headline: string;
  detail: string;
  href: string;
}) {
  const critical = severity === "critical";
  return (
    <li
      role="note"
      aria-label={headline}
      className="rounded-sm border-l-2 py-2 pl-3"
      style={{
        borderColor: critical ? "var(--status-critical)" : "var(--status-warning)",
      }}
    >
      <p
        className="text-[14px] font-semibold"
        style={{ color: critical ? "var(--status-critical-text)" : "var(--status-warning-text)" }}
      >
        {headline}
      </p>
      <p className="prose-body mt-0.5 text-[13px]">{detail}</p>
      <Link
        href={href}
        className="mt-1 inline-block text-[12px] font-medium"
        style={{ color: "var(--accent-text)" }}
      >
        Open the record &rarr;
      </Link>
    </li>
  );
}

/** "P1 emergency" from `p1_emergency`. */
export function priorityLabel(value: string): string {
  const [, digit = "", rest = ""] = /^p(\d)_(.*)$/.exec(value) ?? [];
  if (!digit) return value;
  return `P${digit} ${rest.replace(/_/g, " ")}`;
}

export function money(minor: number, currency: string): string {
  return formatMoney(minor, currency);
}
