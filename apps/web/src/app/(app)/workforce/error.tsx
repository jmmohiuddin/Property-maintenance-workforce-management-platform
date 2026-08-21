"use client";

import { useEffect } from "react";

/**
 * The error state for the compliance board (§12.1).
 *
 * Plain language and a way forward, never a stack trace — `error.message` is
 * redacted by Next in production anyway, and in development it is a database
 * error string that tells an operations manager nothing and tells anyone who
 * can trigger it something about the schema.
 *
 * The second paragraph is the part that matters and it is specific to this
 * screen: an unreachable compliance board does not mean nobody is blocked. It
 * means nobody knows. Dispatch still enforces the block inside the assignment
 * transaction, so the wall is standing even when this page is not.
 */
export default function WorkforceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[workforce] board failed to load", error);
  }, [error]);

  return (
    <div className="container-page py-16">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">
          The compliance board could not be loaded
        </h1>
        <p className="prose-body mt-4 text-[14px]">
          Nothing has changed and nothing was lost. This is a read of the document register that
          failed, not a write.
        </p>
        <p className="prose-body mt-3 text-[14px]">
          Assignment checks a technician&rsquo;s permits inside the transaction that creates the
          visit, not from this page. A blocked technician is still blocked while this screen is
          down &mdash; but nobody can see <em>who</em>, so treat a persistent failure here as
          urgent rather than cosmetic.
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
            Still stuck? Quote reference{" "}
            <code className="tnum">{error.digest}</code> when you report it.
          </p>
        ) : null}
      </div>
    </div>
  );
}
