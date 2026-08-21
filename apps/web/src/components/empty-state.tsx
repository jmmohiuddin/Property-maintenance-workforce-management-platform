/**
 * `ADM-12` / `PD-7` / `D-12` — the empty state, as a component.
 *
 * ── THE FAILURE THIS CLOSES ─────────────────────────────────────────────────
 *
 * Seed data was present throughout development, so no list screen was ever
 * seen with nothing in it. The first real week is the first time these render,
 * and what several of them said was written for a developer: "Run the seed
 * script", "or the seed has not run". A new operations manager reading that on
 * their first morning has been told the software is broken.
 *
 * ── AN EMPTY LIST IS A STATEMENT, AND WHICH ONE DEPENDS ON THE LIST ─────────
 *
 * The whole point of `kind` is that four different zeros are four different
 * messages, and rendering them identically is what makes people stop reading
 * the section:
 *
 *  * `start` — nothing exists yet, and that is expected on day one. The next
 *    action is the message.
 *  * `filtered` — records exist; none match what was asked for. The next action
 *    is to widen the filter, and saying "no jobs yet" here is simply false.
 *  * `good` — zero is the target. No blocked technicians, no overdue invoices.
 *    This must not look like a failure.
 *  * `gap` — zero because nothing is being recorded. The most dangerous of the
 *    four, because it renders identically to `good` and means the opposite:
 *    "nobody is blocked" over an empty document register means *nothing is
 *    being checked*.
 *
 * Colour never carries the message on its own (§4.3, `D-7`). Every state has a
 * heading in words, and the tone only reinforces it — the board gets printed in
 * mono for site meetings, and is read by people who cannot distinguish the
 * hues.
 */

export type EmptyStateKind = "start" | "filtered" | "good" | "gap";

const KIND: Readonly<
  Record<EmptyStateKind, { border: string; wash: string; text: string; mark: string }>
> = {
  start: {
    border: "var(--border-strong)",
    wash: "var(--surface-raised)",
    text: "var(--text-primary)",
    mark: "○",
  },
  filtered: {
    border: "var(--border-strong)",
    wash: "var(--surface-raised)",
    text: "var(--text-secondary)",
    mark: "⌕",
  },
  good: {
    border: "var(--status-success)",
    wash: "var(--status-success-wash)",
    text: "var(--status-success-text)",
    mark: "✓",
  },
  gap: {
    border: "var(--status-warning)",
    wash: "var(--status-warning-wash)",
    text: "var(--status-warning-text)",
    mark: "⚠",
  },
};

export function EmptyState({
  kind,
  title,
  children,
  action,
}: {
  kind: EmptyStateKind;
  /**
   * A sentence, not a noun phrase.
   *
   * "No invoices yet" tells the reader what they can already see. "Invoices are
   * raised from a job once the customer has signed off" tells them what to do
   * next, which is the requirement `ADM-12` actually states.
   */
  title: string;
  /** One or two sentences on why that is fine, or what to do about it. */
  children: React.ReactNode;
  /** The next action, as a real control. Optional — some zeros need no action. */
  action?: React.ReactNode;
}) {
  const colours = KIND[kind];
  return (
    <div
      className="rounded-sm border p-6"
      style={{ borderColor: colours.border, backgroundColor: colours.wash }}
    >
      <p className="flex items-baseline gap-2 text-[14px] font-semibold" style={{ color: colours.text }}>
        {/* Decorative: the heading already carries the meaning in words, so a
            screen reader announcing "check mark" adds nothing. */}
        <span aria-hidden>{colours.mark}</span>
        <span>{title}</span>
      </p>
      <div className="prose-body mt-2 text-[13px]">{children}</div>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/**
 * "Showing 50 of 312" — the partial state from wireframe §12.1.
 *
 * A silently capped list is the one variant that is worse than a slow query:
 * somebody asking "did anyone change this invoice" and seeing fifty rows has no
 * way to know there were three hundred. This says so, every time.
 */
export function PartialNotice({
  shown,
  total,
  noun,
  children,
}: {
  shown: number;
  total: number;
  /** Plural, e.g. "entries". */
  noun: string;
  /** How to narrow it — a filter hint, or a link to the next page. */
  children?: React.ReactNode;
}) {
  if (shown >= total) return null;
  return (
    <p
      className="mt-3 text-[12px]"
      style={{ color: "var(--text-secondary)" }}
      role="status"
    >
      Showing <span className="tnum">{shown}</span> of <span className="tnum">{total}</span> {noun}.
      {children ? <> {children}</> : null}
    </p>
  );
}
