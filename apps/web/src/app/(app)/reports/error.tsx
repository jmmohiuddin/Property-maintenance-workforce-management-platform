"use client";

import { useEffect } from "react";

/**
 * The error state for the owner dashboard (§12.1).
 *
 * Plain language and a way forward, never a stack trace. `error.message` is
 * redacted by Next in production anyway, and in development it is a database
 * error that tells the owner nothing.
 *
 * The second paragraph is the part specific to this screen, and it is the
 * opposite of the compliance board's. A failed dashboard read is genuinely
 * cosmetic: it aggregates records that are all still there, nothing on it
 * enforces anything, and the same figures arrive by email on Sunday regardless.
 * Saying so is what stops a Sunday morning read failure being treated as an
 * incident — while the sentence after it names the one case that is not
 * cosmetic.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[dashboard] failed to load", error);
  }, [error]);

  return (
    <div className="container-page py-16">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">
          The dashboard could not be loaded
        </h1>
        <p className="prose-body mt-4 text-[14px]">
          Nothing has changed and nothing was lost. Every figure on this screen is a read of records
          that are still there &mdash; invoices, jobs, documents &mdash; and none of it is a write.
        </p>
        <p className="prose-body mt-3 text-[14px]">
          The weekly email carries the same numbers and runs from a scheduled job, not from this
          page, so it will still arrive. If <em>both</em> stop, the cause is shared &mdash; check{" "}
          <code>/api/cron/health</code>.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <button type="button" onClick={reset} className="btn btn-primary">
            Try again
          </button>
          <a href="/dispatch" className="btn btn-secondary">
            Back to dispatch
          </a>
        </div>

        {error.digest ? (
          <p className="mt-6 text-[12px]" style={{ color: "var(--text-muted)" }}>
            Still stuck? Quote reference <code className="tnum">{error.digest}</code> when you
            report it.
          </p>
        ) : null}
      </div>
    </div>
  );
}
