import type { Metadata } from "next";
import Link from "next/link";
import { withTenant, countOpenFieldConflicts, listFieldConflicts, type FieldConflictRow } from "@meridian/db";
import { formatDubai } from "@meridian/core";
import { can } from "@meridian/auth";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { EmptyState, PartialNotice } from "@/components/empty-state";
import { ResolveConflictForm } from "./resolve-conflict-form";

export const metadata: Metadata = { title: "Field conflicts" };
export const dynamic = "force-dynamic";

/**
 * The full field-conflict queue (§8.4, ADR 0004).
 *
 * ── WHAT A CONFLICT IS ──────────────────────────────────────────────────────
 *
 * A technician completed a job offline while a dispatcher cancelled it online
 * (or the reverse). ADR 0004 treats that as a real disagreement that needs a
 * human, not something a merge rule can settle silently — so every row here
 * shows all three of what the sentence at detection time said (`detail`),
 * what the device attempted (`attempted`), and what the server held at the
 * time (`serverState`). A dispatcher cannot judge this from one side of it.
 *
 * ── WHY RESOLVING IS NOT THE SAME AS FIXING THE JOB ─────────────────────────
 *
 * `resolveFieldConflict` records the verdict only. It does not reopen the
 * job, correct its outcome or touch billing — those already have their own
 * rules (`transitionJob`, `recordJobOutcome`, `JOB-15`), and a resolver that
 * performed them would be a second, less-checked path into them. This screen
 * says so next to every form, not just once in a comment.
 */
const LIMIT = 200; // listFieldConflicts' own cap.

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.trim() !== "" ? v.trim() : undefined;
}

export default async function DispatchConflictsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSessionWith("jobs:read");
  const params = await searchParams;
  const includeResolved = first(params["view"]) === "all";
  const canResolve = can(session.principal, "jobs:update");

  const { conflicts, openCount } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      conflicts: await listFieldConflicts(tx, { unresolvedOnly: !includeResolved, limit: LIMIT }),
      // Independent of the (capped) list above — see the note on the dispatch
      // board. This is the number that says whether the queue is actually
      // under control.
      openCount: await countOpenFieldConflicts(tx),
    }),
  );

  return (
    <AppShell session={session} active="dispatch">
      <div className="container-page py-8">
        <p className="text-[12px]">
          <Link href="/dispatch" style={{ color: "var(--accent-text)" }}>
            &larr; Dispatch board
          </Link>
        </p>

        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Field conflicts</h1>
          <p className="tnum text-[14px]" style={{ color: "var(--text-secondary)" }}>
            {openCount} unresolved
          </p>
        </div>

        <p className="prose-body mt-2 max-w-3xl text-[14px]">
          Raised when a device sync disagrees with the server about a job&apos;s state — a technician
          finished it offline while the office cancelled it, or the reverse. Resolving records{" "}
          <strong>your decision only</strong>: it does not reopen the job, change its outcome, or bill
          the visit. If the work still needs finishing, do that from the job page itself.
        </p>

        {!includeResolved ? (
          <p className="mt-3 text-[13px]">
            <Link href="/dispatch/conflicts?view=all" style={{ color: "var(--accent-text)" }}>
              Include already-resolved conflicts
            </Link>
          </p>
        ) : (
          <p className="mt-3 text-[13px]">
            <Link href="/dispatch/conflicts" style={{ color: "var(--accent-text)" }}>
              Show unresolved only
            </Link>
          </p>
        )}

        {conflicts.length === 0 ? (
          <div className="mt-8">
            <EmptyState kind="good" title="No unresolved field conflicts.">
              <p>
                Nothing is waiting on a decision right now. A conflict appears the moment a device
                sync disagrees with the server about a job&apos;s state, and stays here until somebody
                resolves it.
              </p>
            </EmptyState>
          </div>
        ) : (
          <>
            <ul className="mt-8 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              {conflicts.map((c) => (
                <ConflictRow key={c.id} conflict={c} canResolve={canResolve} />
              ))}
            </ul>

            {!includeResolved ? (
              <PartialNotice shown={conflicts.length} total={openCount} noun="unresolved conflicts" />
            ) : conflicts.length >= LIMIT ? (
              <p className="mt-3 text-[12px]" style={{ color: "var(--text-muted)" }}>
                Showing the {LIMIT} most relevant entries — the list is capped.
              </p>
            ) : null}
          </>
        )}
      </div>
    </AppShell>
  );
}

function ConflictRow({ conflict: c, canResolve }: { conflict: FieldConflictRow; canResolve: boolean }) {
  return (
    <li className="p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[14px] font-medium">
          <Link href={`/jobs/${c.jobId}`} className="underline underline-offset-2" style={{ color: "var(--accent-text)" }}>
            {c.jobReference}
          </Link>
          <span style={{ color: "var(--text-secondary)" }}> &middot; {c.jobTitle}</span>
        </p>
        <p className="tnum text-[12px]" style={{ color: "var(--text-muted)" }}>
          Raised {formatDubai(c.raisedAt)}
        </p>
      </div>

      <p className="mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
        {c.technicianName} on {c.deviceLabel}
      </p>

      <p className="mt-2 text-[14px]">{c.detail}</p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-sm border p-3" style={{ backgroundColor: "var(--surface-sunken)" }}>
          <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            What the device attempted
          </p>
          <pre className="tnum mt-1 overflow-x-auto text-[11px]">{JSON.stringify(c.attempted, null, 2)}</pre>
        </div>
        <div className="rounded-sm border p-3" style={{ backgroundColor: "var(--surface-sunken)" }}>
          <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            What the server held
          </p>
          <pre className="tnum mt-1 overflow-x-auto text-[11px]">{JSON.stringify(c.serverState, null, 2)}</pre>
        </div>
      </div>

      {c.resolvedAt ? (
        <p className="mt-3 text-[13px]" style={{ color: "var(--text-secondary)" }}>
          Resolved {formatDubai(c.resolvedAt)} as <strong>{c.resolution}</strong>. The job itself was not
          changed by this — check the job page for what actually happened to it.
        </p>
      ) : canResolve ? (
        <ResolveConflictForm conflictId={c.id} />
      ) : (
        <p className="mt-3 text-[12px]" style={{ color: "var(--text-muted)" }}>
          You do not have permission to resolve this.
        </p>
      )}
    </li>
  );
}
