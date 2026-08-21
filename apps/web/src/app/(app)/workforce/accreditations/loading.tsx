/** `D-1`. Matches the register layout: breadcrumb, title, rows, entry form. */
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
        <p className="sr-only">Loading the accreditation register.</p>
        <Bar width="12rem" height={12} />
        <h1 className="mt-4 text-2xl font-semibold tracking-tight md:text-3xl">
          Company accreditations
        </h1>

        <ul className="mt-8 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="flex flex-wrap items-baseline justify-between gap-4 p-4">
              <span className="flex flex-col gap-2">
                <Bar width="15rem" />
                <Bar width="21rem" height={11} />
              </span>
              <Bar width="10rem" height={18} />
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
