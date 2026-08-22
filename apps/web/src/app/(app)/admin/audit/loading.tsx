/**
 * `D-1`. A skeleton matching the log's shape: filter bar, then stacked rows.
 *
 * The count is deliberately absent rather than a grey block. This screen's
 * headline is "1,434 entries", and a placeholder rectangle where a number goes
 * is the one skeleton element people misread as content.
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
      <div
        aria-hidden
        className="h-[60px] border-b"
        style={{ backgroundColor: "var(--surface-raised)" }}
      />
      <div className="container-page py-8" aria-busy="true" aria-live="polite">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Audit log</h1>
        <p className="sr-only">Loading the audit log.</p>

        <div
          className="mt-6 grid gap-4 rounded-sm border p-4 md:grid-cols-2 lg:grid-cols-4"
          style={{ backgroundColor: "var(--surface-raised)" }}
        >
          {Array.from({ length: 4 }, (_, i) => (
            <span key={i} className="flex flex-col gap-2">
              <Bar width="5rem" height={10} />
              <Bar width="100%" height={34} />
            </span>
          ))}
        </div>

        <ul className="mt-8 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
          {Array.from({ length: 8 }, (_, i) => (
            <li key={i} className="flex flex-wrap items-baseline justify-between gap-4 p-4">
              <span className="flex flex-col gap-2">
                <Bar width="13rem" />
                <Bar width="18rem" height={11} />
              </span>
              <Bar width="8rem" height={11} />
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
