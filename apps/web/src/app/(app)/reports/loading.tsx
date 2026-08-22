/**
 * `D-1`. A skeleton, never a spinner.
 *
 * The card titles are real text rather than grey blocks. They are known before
 * any query runs, and rendering them means the person waiting — on a phone, on
 * a Sunday, on hotel wifi — already knows they are on the right screen and
 * roughly what is coming. A wall of grey rectangles conveys neither.
 *
 * The shapes match the real stack: a wide first card, then a two-column grid of
 * eight, so nothing jumps when the figures arrive.
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

function CardSkeleton({ title, rows }: { title: string; rows: number }) {
  return (
    <section className="rounded-sm border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
      <p
        className="text-[13px] font-semibold uppercase tracking-wide"
        style={{ color: "var(--text-secondary)" }}
      >
        {title}
      </p>
      <div className="mt-4 space-y-3">
        {Array.from({ length: rows }, (_, i) => (
          <span key={i} className="flex items-baseline justify-between gap-4">
            <Bar width="8rem" height={12} />
            <Bar width="6rem" height={12} />
          </span>
        ))}
      </div>
    </section>
  );
}

export default function Loading() {
  return (
    <>
      {/* The shell is rendered by the page rather than the layout, so reserving
          its exact 60px band is what stops the whole stack sliding down when the
          real header arrives. */}
      <div
        aria-hidden
        className="h-[60px] border-b"
        style={{ backgroundColor: "var(--surface-raised)" }}
      />
      <div className="container-page py-8" aria-busy="true" aria-live="polite">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">This week</h1>
        <p className="sr-only">Loading the owner dashboard.</p>

        <div className="mt-8 grid gap-4 lg:grid-cols-2">
          <div className="lg:col-span-2">
            <CardSkeleton title="Needs you" rows={2} />
          </div>
          <CardSkeleton title="Cash" rows={5} />
          <CardSkeleton title="Revenue" rows={4} />
          <CardSkeleton title="Work" rows={4} />
          <CardSkeleton title="Pipeline" rows={4} />
          <CardSkeleton title="Contracts" rows={3} />
          <CardSkeleton title="People" rows={4} />
        </div>
      </div>
    </>
  );
}
