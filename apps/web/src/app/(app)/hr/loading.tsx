/**
 * `HR-17` renders a live countdown against a statutory deadline, and the page
 * is `force-dynamic` — so there is always a round trip. A blank frame during it
 * reads as "nothing is due", which is the one wrong answer this screen must
 * never give even for 200ms.
 */
export default function Loading() {
  return (
    <div className="container-page py-8">
      <div className="h-8 w-72 animate-pulse rounded-sm" style={{ backgroundColor: "var(--surface-sunken)" }} />
      <div
        className="mt-8 h-48 animate-pulse rounded border"
        style={{ backgroundColor: "var(--surface-sunken)" }}
      />
      <div className="mt-10 space-y-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-20 animate-pulse rounded border"
            style={{ backgroundColor: "var(--surface-sunken)" }}
          />
        ))}
      </div>
      <p className="sr-only">Loading the employment lifecycle board.</p>
    </div>
  );
}
