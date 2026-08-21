import Link from "next/link";
import { formatMoney } from "@meridian/core";

/**
 * The WPS countdown, as one block (`HR-17`).
 *
 * ── WHY THIS IS THE FIRST THING ON TWO SCREENS ──────────────────────────────
 *
 * Wages are due on the 1st, and the escalation past that date is the fastest
 * moving consequence in the whole compliance surface: five days to losing the
 * ability to hire, eleven to a fine and a category downgrade, sixteen to labour
 * disputes registered automatically on behalf of every unpaid worker, twenty-one
 * to executive orders. Nothing else in this system moves that quickly, so
 * nothing else goes above it.
 *
 * ── WHY IT SHOWS A STAGE AND NOT A FLAG ─────────────────────────────────────
 *
 * "Payroll is late" is one bit and the recipient acts on none of it. The
 * distance between day 4 and day 5 is the distance between an awkward
 * conversation and being unable to onboard anybody, and the person reading this
 * banner is the person who can still change which side of it they are on.
 *
 * ── WHY IT IS NOT A BLOCK ───────────────────────────────────────────────────
 *
 * There are exactly three hard blocks in this system, each stopping a dispatch,
 * and each stopping an act that is itself unlawful at the moment it happens.
 * Late wages make no worker unlawful to deploy — what day 5 suspends is new
 * permit issuance, at MOHRE. Blocking dispatch here would stop the lawful work
 * that earns the money the wages are paid from. The argument is written out in
 * full in `assessWpsCycle`.
 */

export type WpsSeverity = "info" | "warning" | "critical" | "alarm";

const TONE: Readonly<Record<WpsSeverity, { border: string; wash: string; text: string }>> = {
  // `info` deliberately reads as calm rather than as success: a settled cycle is
  // normal, and painting normal green trains people to look for green.
  info: { border: "var(--border-strong)", wash: "var(--surface-raised)", text: "var(--text-primary)" },
  warning: { border: "var(--status-warning)", wash: "var(--status-warning-wash)", text: "var(--status-warning-text)" },
  critical: { border: "var(--status-critical)", wash: "var(--status-critical-wash)", text: "var(--status-critical-text)" },
  // Alarm borrows the *blocked* hue, not the critical one. It is the strongest
  // thing this palette can say, and §12.1 asks for an "alarm tone" here.
  alarm: { border: "var(--status-blocked)", wash: "var(--status-blocked-wash)", text: "var(--status-blocked-text)" },
};

export interface WpsBannerProps {
  readonly label: string;
  readonly headline: string;
  readonly consequence: string;
  readonly severity: WpsSeverity;
  readonly stage: string;
  readonly daysUntilDue: number;
  readonly daysLate: number;
  readonly dueOn: string;
  readonly transferredBasisPoints: number;
  readonly thresholdPercent: number;
  readonly totalDueMinor: number;
  readonly totalTransferredMinor: number;
  readonly employeeCount: number;
  readonly fileDue: boolean;
  readonly filePreparedOn: string | null;
  readonly href?: string;
}

export function WpsBanner(p: WpsBannerProps) {
  const colours = TONE[p.severity];
  // `nothing_due` reads like a settled month for layout purposes — no transfer
  // form, no ladder highlight — but it is a different fact and the stage label
  // below says so. Reporting "settled" for a month nobody was owed anything
  // would put a false clean run into the history an inspection reads.
  const settled = p.stage === "settled" || p.stage === "nothing_due";

  return (
    <section
      aria-labelledby="wps-heading"
      className="rounded border p-6"
      style={{ borderColor: colours.border, backgroundColor: colours.wash }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 id="wps-heading" className="text-[15px] font-semibold uppercase tracking-wide" style={{ color: colours.text }}>
          Wage protection &mdash; {p.label}
        </h2>
        {/* The stage in words, always. A coloured border alone is invisible to a
            colourblind reader, to a screen reader, and in the print-out that
            gets taken into the meeting where this is discussed. */}
        <p className="text-[13px] font-medium" style={{ color: colours.text }}>
          {stageLabel(p.stage, p.daysLate)}
        </p>
      </div>

      <p className="mt-3 text-[17px] font-semibold tracking-tight">{p.headline}</p>

      {p.consequence ? <p className="prose-body mt-2 text-[14px]">{p.consequence}</p> : null}

      <dl className="tnum mt-5 grid gap-x-8 gap-y-3 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Due" value={p.dueOn} />
        <Stat
          label={p.daysLate > 0 ? "Days late" : "Days remaining"}
          value={p.daysLate > 0 ? String(p.daysLate) : String(Math.max(0, p.daysUntilDue))}
          tone={p.daysLate > 0 ? colours.text : undefined}
        />
        <Stat
          label="Wages due"
          value={`${formatMoney(p.totalDueMinor)} · ${p.employeeCount} ${p.employeeCount === 1 ? "person" : "people"}`}
        />
        <Stat
          label={`Transferred (floor ${p.thresholdPercent}%)`}
          value={`${formatMoney(p.totalTransferredMinor)} · ${(p.transferredBasisPoints / 100).toFixed(2)}%`}
          tone={
            p.transferredBasisPoints >= p.thresholdPercent * 100 ? undefined : colours.text
          }
        />
      </dl>

      {p.fileDue ? (
        <p className="mt-4 text-[13px]" style={{ color: colours.text }}>
          <strong>The wage file inputs have not been produced.</strong> Hours, overtime, absences and
          deductions are due three days before the deadline, so there is time to instruct the
          transfer rather than discover a problem on the 1st.
        </p>
      ) : p.filePreparedOn && !settled ? (
        <p className="mt-4 text-[13px]" style={{ color: "var(--text-muted)" }}>
          Wage file inputs produced {p.filePreparedOn}.
        </p>
      ) : null}

      {p.href ? (
        <p className="mt-5 text-[13px]">
          <Link href={p.href} className="btn btn-primary">
            {settled ? "Open the payroll register" : "Open the wage file and record the transfer"}
          </Link>
        </p>
      ) : null}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="text-[12px]" style={{ color: "var(--text-muted)" }}>
        {label}
      </dt>
      <dd className="mt-0.5 font-medium" style={{ color: tone ?? "var(--text-primary)" }}>
        {value}
      </dd>
    </div>
  );
}

/**
 * The escalation rung, in the words the consequence is written in.
 *
 * Not `stage.replace(/_/g, " ")`: "permits suspended" is what the enum says and
 * "Day 5 — new work permits suspended" is what somebody acts on.
 */
function stageLabel(stage: string, daysLate: number): string {
  switch (stage) {
    case "not_due":
      return "Not yet due";
    case "countdown":
      return "Countdown";
    case "due_today":
      return "DUE TODAY";
    case "unconfirmed":
      return `Day ${daysLate + 1} — transfer unconfirmed`;
    case "permits_suspended":
      return `Day ${daysLate + 1} — new work permits suspended`;
    case "fines_and_downgrade":
      return `Day ${daysLate + 1} — fines and category downgrade`;
    case "labour_disputes":
      return `Day ${daysLate + 1} — automatic labour disputes`;
    case "executive_orders":
      return `Day ${daysLate + 1} — executive orders, travel bans possible`;
    case "short_paid":
      return "Transferred below the 85% floor";
    case "settled":
      return "Settled";
    case "nothing_due":
      return "Nothing due";
    default:
      return stage.replace(/_/g, " ");
  }
}
