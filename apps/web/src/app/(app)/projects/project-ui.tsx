import {
  formatMoney,
  PROJECT_STATUS_LABEL,
  MILESTONE_STATUS_LABEL,
  VARIATION_STATE_LABEL,
  SNAG_SEVERITY_LABEL,
  SNAG_STATUS_LABEL,
  PERMIT_STATUS_LABEL,
  RETENTION_STAGE_LABEL,
  RETENTION_STATUS_LABEL,
  type ProjectStatus,
} from "@meridian/core";

/**
 * Presentation primitives for the projects module.
 *
 * Local to this route, like `contract-ui.tsx` is to `/amc`. They move to
 * `components/` when a second module needs them; promoting them now would be a
 * shared-file change for one caller.
 *
 * ── COLOUR IS NEVER THE MESSAGE ─────────────────────────────────────────────
 *
 * Every tone below carries a word, the same rule the contracts and compliance
 * boards follow. A red chip reading "AED 7,200" and nothing else is invisible
 * to a colourblind reader, to a screen reader, and to anybody printing the
 * retention ledger in mono for a finance meeting — which is exactly when a
 * retention ledger gets printed.
 */

export type Tone = "critical" | "warning" | "success" | "neutral";

const TONE: Readonly<Record<Tone, { border: string; wash: string; text: string }>> = {
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

/**
 * A day-valued column, formatted.
 *
 * Parsed as UTC midnight and rendered in Dubai, so `2026-08-22` reads as
 * 22 August wherever the server is. Parsing it as local time is how a target
 * date renders a day early for half the world.
 */
export function formatDay(value: string | null): string {
  if (!value) return "—";
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    dateStyle: "medium",
  });
}

export function money(minor: number, currency = "AED"): string {
  return formatMoney(minor, currency);
}

/** Basis points as a percentage a person reads. 2,727 → "27.3%". */
export function percentFromBasisPoints(basisPoints: number | null): string {
  if (basisPoints === null) return "—";
  return `${(basisPoints / 100).toFixed(1)}%`;
}

/**
 * Days as a phrase, never a bare integer.
 *
 * "8" beside a retention due date is ambiguous in the one direction that costs
 * money — days until we may ask for it, or days it has been sitting unasked.
 */
export function daysPhrase(days: number | null): string {
  if (days === null) return "not yet due — practical completion sets the date";
  if (days < 0) {
    const past = Math.abs(days);
    return past === 1 ? "due 1 day ago" : `due ${past} days ago`;
  }
  if (days === 0) return "due today";
  return days === 1 ? "due tomorrow" : `due in ${days} days`;
}

export function statusTone(status: ProjectStatus): Tone {
  switch (status) {
    case "on_site":
    case "practical_completion":
      return "success";
    case "cancelled":
      return "critical";
    case "snagging":
    case "defects_liability":
      return "warning";
    default:
      return "neutral";
  }
}

export function severityTone(severity: string): Tone {
  switch (severity) {
    case "critical":
      return "critical";
    case "major":
      return "warning";
    default:
      return "neutral";
  }
}

export function permitTone(status: string, expiresOn: string | null, today: string): Tone {
  if (status === "approved") {
    // An approval with a date in the past is the state that reads as safe. It
    // is the reason `expiresOn` is carried as a string all the way here.
    if (expiresOn && expiresOn < today) return "critical";
    return "success";
  }
  if (status === "rejected" || status === "expired") return "critical";
  return "warning";
}

/** Margin, coloured only at the point it stops being a margin. */
export function marginTone(basisPoints: number | null): Tone {
  if (basisPoints === null) return "neutral";
  if (basisPoints < 0) return "critical";
  if (basisPoints < 1000) return "warning";
  return "success";
}

export const LABEL = {
  status: PROJECT_STATUS_LABEL,
  milestone: MILESTONE_STATUS_LABEL,
  variation: VARIATION_STATE_LABEL,
  severity: SNAG_SEVERITY_LABEL,
  snag: SNAG_STATUS_LABEL,
  permit: PERMIT_STATUS_LABEL,
  retentionStage: RETENTION_STAGE_LABEL,
  retentionStatus: RETENTION_STATUS_LABEL,
};

export function Chip({
  tone,
  label,
  children,
}: {
  tone: Tone;
  label: string;
  children?: React.ReactNode;
}) {
  const colours = TONE[tone];
  return (
    <span
      className="inline-flex flex-col items-start gap-0.5 rounded-sm px-2.5 py-1"
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
  tone: Tone;
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
  children,
}: {
  tone: Tone;
  title: string;
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
    </div>
  );
}

/**
 * A completion bar.
 *
 * The number is rendered in text beside it and the bar is decoration. A bar
 * alone is a value nobody can read off precisely, and "40%" is the form the
 * question takes.
 */
export function Meter({ percent, tone }: { percent: number; tone: Tone }) {
  const colours = TONE[tone];
  return (
    <span
      aria-hidden
      className="inline-block h-1.5 w-16 overflow-hidden rounded-full align-middle"
      style={{ backgroundColor: "var(--border)" }}
    >
      <span
        className="block h-full rounded-full"
        style={{
          width: `${Math.min(100, Math.max(0, percent))}%`,
          backgroundColor: colours.border,
        }}
      />
    </span>
  );
}
