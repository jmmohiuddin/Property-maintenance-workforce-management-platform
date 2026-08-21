/** `D-1`. Matches the register layout: breadcrumb, title, headline figure, rows. */
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
        <p className="sr-only">Loading the skilled headcount.</p>
        <Bar width="12rem" height={12} />
        <h1 className="mt-4 text-2xl font-semibold tracking-tight md:text-3xl">Emiratisation</h1>
        <div className="mt-8 flex flex-col gap-3 rounded-sm border-l-2 px-5 py-4">
          <Bar width="10rem" height={11} />
          <Bar width="14rem" height={28} />
          <Bar width="26rem" height={11} />
        </div>

        <ul className="mt-8 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="flex flex-wrap items-baseline justify-between gap-4 p-4">
              <span className="flex flex-col gap-2">
                <Bar width="15rem" />
                <Bar width="24rem" height={11} />
              </span>
              <Bar width="8rem" height={18} />
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
