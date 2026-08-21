/**
 * `D-1`. Matches the record layout: breadcrumb, name, document rows, form.
 *
 * The name is a grey bar rather than a guess. This route is reached by id, so
 * nothing on the server knows whose record it is until the query returns, and a
 * placeholder name would be a lie for however long the query takes.
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
      {/* The 60px band the app shell will occupy, reserved so the record does
          not jump down when the real header arrives. */}
      <div
        aria-hidden
        className="h-[60px] border-b"
        style={{ backgroundColor: "var(--surface-raised)" }}
      />
      <div className="container-page py-8" aria-busy="true" aria-live="polite">
        <p className="sr-only">Loading the employment record.</p>
        <Bar width="12rem" height={12} />
        <div className="mt-4 flex flex-wrap items-baseline justify-between gap-4">
          <Bar width="18rem" height={28} />
          <Bar width="14rem" height={13} />
        </div>

        <div className="mt-8">
          <Bar width="14rem" height={20} />
          <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
            {Array.from({ length: 4 }, (_, i) => (
              <li key={i} className="flex flex-wrap items-baseline justify-between gap-4 p-4">
                <span className="flex flex-col gap-2">
                  <Bar width="13rem" />
                  <Bar width="20rem" height={11} />
                </span>
                <Bar width="10rem" height={18} />
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-8 rounded border p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
          <Bar width="11rem" height={20} />
          <div className="mt-5 flex flex-col gap-4">
            <Bar width="100%" height={42} />
            <Bar width="100%" height={42} />
            <Bar width="9rem" height={40} />
          </div>
        </div>
      </div>
    </>
  );
}
