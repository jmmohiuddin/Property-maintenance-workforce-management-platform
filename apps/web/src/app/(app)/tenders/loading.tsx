/**
 * `D-1`. A skeleton, never a spinner.
 *
 * The heading and the sentence under it are real markup rather than grey
 * blocks, because both are known before any query runs — and the sentence is
 * the one thing somebody arriving here needs to understand about the screen
 * whether or not the rows have loaded yet.
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

export default function Loading() {
  return (
    <>
      {/* The app shell is rendered by the page, not the layout, so it is absent
          here. Reserving its exact 60px band keeps the queue from shifting down
          the moment the real header arrives. */}
      <div
        aria-hidden
        className="h-[60px] border-b"
        style={{ backgroundColor: "var(--surface-raised)" }}
      />
      <div className="container-page py-8" aria-busy="true" aria-live="polite">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Tenders</h1>
          <Bar width="12rem" height={16} />
        </div>
        <p className="prose-body mt-2 max-w-3xl text-[14px]">
          Sorted by how many days are left, always.
        </p>
        <p className="sr-only">Loading the tender queue.</p>

        <ul
          className="mt-8 divide-y rounded border"
          style={{ backgroundColor: "var(--surface-raised)" }}
        >
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="flex flex-wrap items-start justify-between gap-4 p-4">
              <span className="flex flex-col gap-2">
                <Bar width="18rem" />
                <Bar width="22rem" height={11} />
                <Bar width="16rem" height={11} />
              </span>
              <Bar width="7rem" height={18} />
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
