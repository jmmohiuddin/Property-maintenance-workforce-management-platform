"use client";

import { useEffect } from "react";

/**
 * The error state for the tender queue (§12.1).
 *
 * Plain language and a way forward, never a stack trace — `error.message` is
 * redacted by Next in production anyway, and in development it is a database
 * error string that tells a salesperson nothing and tells anyone who can
 * trigger it something about the schema.
 *
 * The second paragraph is the part that matters and it is specific to this
 * screen. Nothing else in this system watches a tender deadline: there is no
 * cron job counting down to a closing date and no alert if one passes. A
 * dispatch board that is down still has the SLA enforced inside the assignment
 * transaction; a tender queue that is down has nothing behind it. Treat a
 * persistent failure here as a business risk with a date on it, not a cosmetic
 * one, and open the tender file by hand in the meantime.
 */
export default function TendersError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[tenders] queue failed to load", error);
  }, [error]);

  return (
    <div className="container-page py-16">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">
          The tender queue could not be loaded
        </h1>
        <p className="prose-body mt-4 text-[14px]">
          Nothing has changed and nothing was lost. This is a read that failed, not a write.
        </p>
        <p className="prose-body mt-3 text-[14px]">
          No other part of the system is watching these deadlines &mdash; there is no job counting
          down to a closing date. While this screen is down, a tender that closes this week closes
          silently. Treat a persistent failure here as urgent rather than cosmetic.
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
