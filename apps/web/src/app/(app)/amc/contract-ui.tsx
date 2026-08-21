import { formatMoney, toMinor, RENEWAL_BANDS } from "@meridian/core";

/**
 * Presentation primitives for the contracts module.
 *
 * Local to this route, like `compliance-ui.tsx` is to `/workforce`. They move
 * to `components/` when a second module needs them; promoting them now would be
 * a shared-file change for one caller.
 *
 * ── COLOUR IS NEVER THE MESSAGE ─────────────────────────────────────────────
 *
 * Every tone below carries a word, for the same reason the compliance board's
 * do: a red chip reading "31 Dec 2026" and nothing else is invisible to a
 * colourblind reader, to a screen reader, and to anybody printing the renewal
 * pipeline in mono for a management meeting — which is precisely when a
 * renewal list gets printed.
 */

export type ContractTone = "critical" | "warning" | "success" | "neutral";

const TONE: Readonly<Record<ContractTone, { border: string; wash: string; text: string }>> = {
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
  neutral: {
    border: "var(--border-strong)",
    wash: "var(--surface-raised)",
    text: "var(--text-secondary)",
  },
};

export function formatDay(value: Date | string): string {
  const date = typeof value === "string" ? new Date(`${value}T00:00:00Z`) : value;
  return date.toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium" });
}

export function money(decimal: string, currency: string): string {
  return formatMoney(toMinor(decimal), currency);
}

/**
 * Days as a phrase, never a bare integer.
 *
 * "8" beside a contract end date is ambiguous in the one direction that costs
 * money — days left, or days since it lapsed.
 */
export function daysPhrase(days: number): string {
  if (days < 0) {
    const past = Math.abs(days);
    return past === 1 ? "expired 1 day ago" : `expired ${past} days ago`;
  }
  if (days === 0) return "expires today";
  return days === 1 ? "expires in 1 day" : `expires in ${days} days`;
}

/**
 * Which reminder rung a number of days sits in, as a label.
 *
 * Mirrors `renewalBand` in `packages/core` rather than restating the thresholds
 * — the screen and the email must agree about whether a contract is in the
 * 30-day band, and two copies of `[90, 60, 30, 7]` is how they stop agreeing.
 */
export function bandLabel(days: number): string | null {
  if (days < 0) return "expired";
  const band = [...RENEWAL_BANDS].reverse().find((b) => days <= b);
  return band ? `T-${band}` : null;
}

export function renewalTone(days: number): ContractTone {
  if (days < 0) return "critical";
  if (days <= 30) return "critical";
  if (days <= 90) return "warning";
  return "success";
}

export function Chip({
  tone,
  label,
  children,
}: {
  tone: ContractTone;
  label: string;
  children?: React.ReactNode;
}) {
  const colours = TONE[tone];
  return (
    <span
      className="inline-flex flex-col items-end gap-0.5 rounded-sm px-2.5 py-1 text-right"
      style={{ backgroundColor: colours.wash, boxShadow: `inset 0 0 0 1px ${colours.border}` }}
    >
      <span className="text-[12px] font-semibold" style={{ color: colours.text }}>
        {label}
      </span>
      {children ? (
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          {children}
        </span>
      ) : null}
    </span>
  );
}

export function SectionHeading({
  tone,
  title,
  count,
  children,
}: {
  tone: ContractTone;
  title: string;
  count?: number;
  children?: React.ReactNode;
}) {
  const colours = TONE[tone];
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b pb-2">
      <h2 className="text-[15px] font-semibold tracking-tight">
        {title}
        {count === undefined ? null : (
          <span className="tnum ml-2 font-normal" style={{ color: colours.text }}>
            {count}
          </span>
        )}
      </h2>
      {children ? (
        <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          {children}
        </p>
      ) : null}
    </div>
  );
}

export function EmptyState({
  tone,
  title,
  action,
  children,
}: {
  tone: ContractTone;
  title: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const colours = TONE[tone];
  return (
    <div
      className="rounded-sm border-l-2 px-4 py-3"
      style={{ borderColor: colours.border, backgroundColor: colours.wash }}
    >
      <p className="text-[14px] font-medium">{title}</p>
      <div className="prose-body mt-1 text-[13px]">{children}</div>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

/**
 * A completion or utilisation bar.
 *
 * The number is rendered in text beside it and the bar is decoration. A bar
 * alone is a value nobody can read off precisely, and "3 of 4" is the form the
 * customer's own question takes.
 */
export function Meter({
  value,
  max,
  tone,
}: {
  value: number;
  max: number;
  tone: ContractTone;
}) {
  const colours = TONE[tone];
  const filled = max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
  return (
    <span
      aria-hidden
      className="inline-block h-1.5 w-16 overflow-hidden rounded-full align-middle"
      style={{ backgroundColor: "var(--border)" }}
    >
      <span
        className="block h-full rounded-full"
        style={{ width: `${filled * 100}%`, backgroundColor: colours.border }}
      />
    </span>
  );
}

/** Contract status as a word the reader already uses, not the enum value. */
export const CONTRACT_STATUS_LABEL: Readonly<Record<string, string>> = {
  draft: "Draft",
  pending_signature: "Awaiting signature",
  active: "Active",
  suspended: "Suspended",
  expired: "Expired",
  cancelled: "Cancelled",
  renewed: "Renewed",
};

export function statusTone(status: string): ContractTone {
  switch (status) {
    case "active":
      return "success";
    case "expired":
    case "cancelled":
      return "critical";
    case "suspended":
      return "warning";
    default:
      return "neutral";
  }
}

/** PPM visit status as a word, with the same rule about colour. */
export const VISIT_STATUS_LABEL: Readonly<Record<string, string>> = {
  planned: "Planned",
  generated: "Job raised",
  completed: "Done",
  missed: "Missed",
  skipped: "Skipped",
};

export function visitTone(status: string): ContractTone {
  switch (status) {
    case "completed":
      return "success";
    case "missed":
      return "critical";
    case "generated":
      return "warning";
    default:
      return "neutral";
  }
}
