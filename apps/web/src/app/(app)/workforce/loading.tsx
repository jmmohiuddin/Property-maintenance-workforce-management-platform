/**
 * `D-1`. A skeleton, never a spinner.
 *
 * The shapes below match the real board — heading, summary line, then three
 * sections of stacked rows — because a skeleton that does not match causes a
 * visible jump when the content arrives, and a jump is worse than a spinner.
 *
 * The header is real markup rather than grey blocks: the title and the section
 * names are known before any query runs, and showing them means the person
 * waiting already knows they are on the right page.
 */
function Bar({ width, height = 14 }: { width: string; height?: number }) {
  return (
    <span
      aria-hidden
      className="block animate-pulse rounded-sm"
      style={{ width, height, backgroundColor: "var(--surface-sunken)" }}
    />
  );
}

function RowBlock({ rows }: { rows: number }) {
  return (
    <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex flex-wrap items-baseline justify-between gap-4 p-4">
          <span className="flex flex-col gap-2">
            <Bar width="11rem" />
            <Bar width="16rem" height={11} />
          </span>
          <Bar width="9rem" height={18} />
        </li>
      ))}
    </ul>
  );
}

export default function Loading() {
  return (
    <>
      {/* The app shell is rendered by the page, not the layout, so it is absent
          here. Reserving its exact 60px band keeps the whole board from
          shifting down the moment the real header arrives. */}
      <div
        aria-hidden
        className="h-[60px] border-b"
        style={{ backgroundColor: "var(--surface-raised)" }}
      />
      <div className="container-page py-8" aria-busy="true" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Workforce compliance</h1>
        <Bar width="14rem" height={16} />
      </div>
      <p className="sr-only">Loading the compliance board.</p>

      <div className="mt-10">
        <p className="text-[15px] font-semibold uppercase tracking-wide" style={{ color: "var(--status-blocked-text)" }}>
          Blocked from dispatch
        </p>
        <RowBlock rows={2} />
      </div>

      <div className="mt-10">
        <p className="text-[15px] font-semibold uppercase tracking-wide" style={{ color: "var(--status-warning-text)" }}>
          Expiring within 30 days
        </p>
        <RowBlock rows={3} />
      </div>

      <div className="mt-10">
        <p className="text-[15px] font-semibold uppercase tracking-wide" style={{ color: "var(--status-warning-text)" }}>
          Company accreditations
        </p>
        <RowBlock rows={2} />
        </div>
      </div>
    </>
  );
}
