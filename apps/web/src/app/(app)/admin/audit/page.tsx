import type { Metadata } from "next";
import Link from "next/link";
import {
  withTenant,
  auditTrail,
  auditActors,
  AUDITED_TABLES,
  type AuditEntry,
} from "@meridian/db";
import { tenant } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { EmptyState, PartialNotice } from "@/components/empty-state";

export const metadata: Metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

/**
 * The audit log viewer (`ADM-7`, closing `MB-018`).
 *
 * ── WHAT WAS ACTUALLY MISSING ───────────────────────────────────────────────
 *
 * The log itself has existed since migration 0000. It is written by a Postgres
 * trigger rather than by application code, it records only the columns that
 * changed, and `UPDATE` and `DELETE` are revoked from the application role — so
 * the evidence is there and it is tamper-resistant. What did not exist was any
 * way to read it. Evidence nobody can look at is evidence that was not
 * collected, the first time anyone asks a question about a record.
 *
 * ── WHY THIS IS A GET FORM AND NOT A CLIENT COMPONENT ───────────────────────
 *
 * Every filter is a query parameter and the form is a plain `method="get"`. It
 * works with JavaScript disabled, each view is a URL that can be pasted into a
 * ticket or an email to an accountant, and the browser's back button does what
 * it looks like it does. An auditor's most common action is "send me the link
 * to what you just showed me", and a client-side filter cannot answer it.
 *
 * ── THE ROLE THIS GIVES A JOB ───────────────────────────────────────────────
 *
 * `audit:read` is held by `owner`, `admin` and `readonly`. `readonly` was an
 * orphan enum value the audit called out as having no differentiated UI; this
 * is the screen it exists for, and `ADM-8` builds on it.
 */

/** 50 rows fits a laptop screen and a phone scroll; 200 is the query's ceiling. */
const PAGE_SIZE = 50;

const ACTION_TONE: Readonly<Record<string, { wash: string; text: string }>> = {
  insert: { wash: "var(--status-success-wash)", text: "var(--status-success-text)" },
  update: { wash: "var(--status-info-wash)", text: "var(--status-info-text)" },
  // Deletion is the action an auditor is looking for, so it is the one that
  // reads differently at a glance. Hue, not just lightness — `D-7`.
  delete: { wash: "var(--status-critical-wash)", text: "var(--status-critical-text)" },
};

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.trim() !== "" ? v.trim() : undefined;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSessionWith("audit:read");
  const params = await searchParams;

  // Every filter is validated against a closed set or a shape before it reaches
  // the query. The query binds them as parameters anyway — there is no
  // string-built SQL in this codebase — but a table name that is not an audited
  // table returns zero rows, and zero rows for a typo is indistinguishable from
  // zero rows for "nothing happened".
  const rawTable = first(params["table"]);
  const tableName = AUDITED_TABLES.includes(rawTable as (typeof AUDITED_TABLES)[number])
    ? rawTable
    : undefined;

  const rawAction = first(params["action"]);
  const action =
    rawAction === "insert" || rawAction === "update" || rawAction === "delete"
      ? rawAction
      : undefined;

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const rawRecord = first(params["record"]);
  const recordId = rawRecord && UUID.test(rawRecord) ? rawRecord : undefined;
  const rawActor = first(params["actor"]);
  const actorId = rawActor && UUID.test(rawActor) ? rawActor : undefined;

  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const rawFrom = first(params["from"]);
  const from = rawFrom && ISO_DATE.test(rawFrom) ? rawFrom : undefined;
  const rawTo = first(params["to"]);
  const to = rawTo && ISO_DATE.test(rawTo) ? rawTo : undefined;

  const page = Math.max(1, Number.parseInt(first(params["page"]) ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const { entries, total, actors } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => {
      const result = await auditTrail(tx, {
        ...(tableName ? { tableName } : {}),
        ...(recordId ? { recordId } : {}),
        ...(actorId ? { actorId } : {}),
        ...(action ? { action } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        limit: PAGE_SIZE,
        offset,
      });
      return { ...result, actors: await auditActors(tx) };
    },
  );

  const filtered = Boolean(tableName || recordId || actorId || action || from || to);
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  /** Rebuild the current query string with one parameter changed. */
  const withParam = (key: string, value: string | undefined): string => {
    const next = new URLSearchParams();
    const carry: Record<string, string | undefined> = {
      table: tableName,
      record: recordId,
      actor: actorId,
      action,
      from,
      to,
    };
    for (const [k, v] of Object.entries(carry)) if (v) next.set(k, v);
    if (value) next.set(key, value);
    else next.delete(key);
    const query = next.toString();
    return query ? `/admin/audit?${query}` : "/admin/audit";
  };

  return (
    <AppShell session={session} active="admin/audit">
      <div className="container-page py-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Audit log</h1>
          <p className="tnum text-[14px]" style={{ color: "var(--text-secondary)" }}>
            {total.toLocaleString("en-GB")} {total === 1 ? "entry" : "entries"}
            {filtered ? " matching" : ""}
          </p>
        </div>

        <p className="prose-body mt-2 max-w-3xl text-[14px]">
          Written by the database on every change to a financial, employment or compliance record,
          not by the application &mdash; so a repair made directly in SQL during an incident is
          captured too. <strong>Nothing here can be edited or deleted</strong>, including by this
          application: <code>UPDATE</code> and <code>DELETE</code> are revoked from the role the
          software connects as.
        </p>

        {/* ── Filters ──────────────────────────────────────────────────────
            A GET form. Plain, unstyled-first, and each control names what it
            narrows. `defaultValue` rather than `value` because there is no
            client state here — the URL is the state. */}
        <form
          method="get"
          action="/admin/audit"
          aria-label="Filter the audit log"
          className="mt-6 rounded-sm border p-4"
          style={{ backgroundColor: "var(--surface-raised)" }}
        >
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="block text-[12px] font-medium" style={{ color: "var(--text-secondary)" }}>
                Record type
              </span>
              <select name="table" defaultValue={tableName ?? ""} className="mt-1 w-full">
                <option value="">Everything audited</option>
                {AUDITED_TABLES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="block text-[12px] font-medium" style={{ color: "var(--text-secondary)" }}>
                Who
              </span>
              <select name="actor" defaultValue={actorId ?? ""} className="mt-1 w-full">
                <option value="">Anyone</option>
                {actors.map((a) => (
                  <option key={a.userId} value={a.userId}>
                    {a.fullName} ({a.entries})
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="block text-[12px] font-medium" style={{ color: "var(--text-secondary)" }}>
                From
              </span>
              <input type="date" name="from" defaultValue={from ?? ""} className="mt-1 w-full" />
            </label>

            <label className="block">
              <span className="block text-[12px] font-medium" style={{ color: "var(--text-secondary)" }}>
                To
              </span>
              <input type="date" name="to" defaultValue={to ?? ""} className="mt-1 w-full" />
            </label>
          </div>

          {/* Kept out of the grid: `record` is not a filter somebody types, it
              is one they arrive at by clicking a record id in the table below.
              Rendered as a hidden field so it survives a filter change rather
              than being silently dropped. */}
          {recordId ? <input type="hidden" name="record" value={recordId} /> : null}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="submit" className="btn btn-primary">
              Apply
            </button>
            {filtered ? (
              <Link href="/admin/audit" className="text-[13px]" style={{ color: "var(--accent-text)" }}>
                Clear filters
              </Link>
            ) : null}
            <span className="flex flex-wrap gap-2">
              {(["insert", "update", "delete"] as const).map((a) => {
                const active = action === a;
                return (
                  <Link
                    key={a}
                    href={withParam("action", active ? undefined : a)}
                    aria-current={active ? "true" : undefined}
                    className="rounded-sm border px-2 py-1 text-[12px] font-medium"
                    style={
                      active
                        ? {
                            backgroundColor: ACTION_TONE[a]!.wash,
                            color: ACTION_TONE[a]!.text,
                            borderColor: ACTION_TONE[a]!.text,
                          }
                        : { color: "var(--text-secondary)" }
                    }
                  >
                    {a}
                  </Link>
                );
              })}
            </span>
          </div>
        </form>

        {recordId ? (
          <p
            className="mt-4 rounded-sm border-l-2 px-4 py-3 text-[13px]"
            style={{ borderColor: "var(--status-info)", color: "var(--text-secondary)" }}
          >
            Showing one record&rsquo;s complete history, oldest change at the bottom.{" "}
            <Link href={withParam("record", undefined)} style={{ color: "var(--accent-text)" }}>
              Back to everything
            </Link>
          </p>
        ) : null}

        {/* ── The entries ──────────────────────────────────────────────────── */}
        {entries.length === 0 ? (
          <div className="mt-8">
            {filtered ? (
              <EmptyState kind="filtered" title="No audited change matches these filters.">
                <p>
                  Records exist &mdash; {total === 0 ? "none" : total} match what was asked for. Widen
                  the date range, or clear the filters and narrow one at a time. A record type with
                  no entries usually means nothing of that kind has been changed yet, not that the
                  log is missing them.
                </p>
              </EmptyState>
            ) : (
              <EmptyState kind="start" title="Nothing has been changed yet.">
                <p>
                  The log fills itself: the first time somebody edits a job, issues an invoice or
                  records a payment, the change appears here with their name against it. There is
                  nothing to configure.
                </p>
              </EmptyState>
            )}
          </div>
        ) : (
          <>
            <ul
              className="mt-8 divide-y rounded border"
              style={{ backgroundColor: "var(--surface-raised)" }}
            >
              {entries.map((entry) => (
                <Entry key={entry.id} entry={entry} recordHref={withParam("record", entry.recordId ?? undefined)} />
              ))}
            </ul>

            <PartialNotice shown={offset + entries.length} total={total} noun="entries">
              {page < lastPage ? (
                <Link href={`${withParam("page", String(page + 1))}`} style={{ color: "var(--accent-text)" }}>
                  Next {Math.min(PAGE_SIZE, total - (offset + entries.length))} &rarr;
                </Link>
              ) : null}
            </PartialNotice>

            {page > 1 ? (
              <p className="mt-2 text-[12px]">
                <Link href={withParam("page", page === 2 ? undefined : String(page - 1))} style={{ color: "var(--accent-text)" }}>
                  &larr; Previous
                </Link>
              </p>
            ) : null}
          </>
        )}

        {/*
          Said on the screen rather than left in a document, because the person
          reading this is the person who will ask why a technician's location
          history is not here.
        */}
        <p className="mt-10 max-w-3xl text-[12px]" style={{ color: "var(--text-muted)" }}>
          The trigger is attached to {AUDITED_TABLES.length} tables &mdash; jobs, visits, sign-offs,
          quotes, contracts, invoices, payments, customers, properties, assets, technicians,
          memberships and leave. High-churn telemetry such as technician GPS traces is deliberately
          not audited: it would be most of the rows and none of the answers. Employment documents
          are covered by the retention log rather than this one.
        </p>
      </div>
    </AppShell>
  );
}

/**
 * One entry, with its diff behind a `<details>`.
 *
 * `<details>` rather than a client component: expanding a row needs no
 * JavaScript, survives printing (open rows print open), and keeps this whole
 * screen a server component. An auditor working through three hundred entries
 * expands a dozen of them, and paying for a hydration boundary to do that would
 * be paying for nothing.
 */
function Entry({ entry, recordHref }: { entry: AuditEntry; recordHref: string }) {
  const tone = ACTION_TONE[entry.action] ?? {
    wash: "var(--status-neutral-wash)",
    text: "var(--status-neutral-text)",
  };

  const fields = entry.changedFields ?? {};
  const keys = Object.keys(fields);
  // `__new` and `__old` are whole-row snapshots written on insert and delete;
  // everything else is one changed column. Counting them as "1 field changed"
  // would be technically true and useless.
  const wholeRow = keys.includes("__new") || keys.includes("__old");
  const summary = wholeRow
    ? keys.includes("__new")
      ? "row created"
      : "row deleted"
    : keys.length === 0
      ? "no field recorded"
      : `${keys.length} field${keys.length === 1 ? "" : "s"}: ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? "…" : ""}`;

  return (
    <li className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[14px] font-medium">
          <span
            className="mr-2 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
            style={{ backgroundColor: tone.wash, color: tone.text }}
          >
            {entry.action}
          </span>
          {entry.tableName.replace(/_/g, " ")}
          {entry.recordId ? (
            <Link
              href={recordHref}
              className="tnum ml-2 text-[12px] font-normal"
              style={{ color: "var(--accent-text)" }}
              title="Show this record's complete history"
            >
              {entry.recordId.slice(0, 8)}
            </Link>
          ) : null}
        </p>
        <p className="tnum text-[12px]" style={{ color: "var(--text-muted)" }}>
          {entry.occurredAt.toLocaleString("en-GB", {
            timeZone: tenant.timezone,
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </p>
      </div>

      <p className="mt-1 text-[12px]" style={{ color: "var(--text-secondary)" }}>
        {/*
          "System" rather than a blank. A change with no actor is a scheduled job
          or a database repair, and an empty cell reads as a rendering fault —
          which is the moment somebody stops trusting the column.
        */}
        {entry.actorName ?? (entry.actorKind === "user" ? "Actor not recorded" : `System (${entry.actorKind})`)}
        {entry.ipAddress ? <span className="tnum"> &middot; {entry.ipAddress}</span> : null}
        {" · "}
        {summary}
      </p>

      {keys.length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-[12px]" style={{ color: "var(--accent-text)" }}>
            {wholeRow ? "The whole row" : "What changed"}
          </summary>
          <div className="mt-2 overflow-x-auto">
            {wholeRow ? (
              <pre
                className="tnum rounded-sm p-3 text-[11px]"
                style={{ backgroundColor: "var(--surface-sunken)" }}
              >
                {JSON.stringify(fields[keys.includes("__new") ? "__new" : "__old"], null, 2)}
              </pre>
            ) : (
              <table className="w-full text-left text-[12px]">
                <thead>
                  <tr style={{ color: "var(--text-muted)" }}>
                    <th className="py-1 pr-4 font-medium">Field</th>
                    <th className="py-1 pr-4 font-medium">Was</th>
                    <th className="py-1 font-medium">Became</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((key) => {
                    const change = fields[key] as { old?: unknown; new?: unknown } | undefined;
                    return (
                      <tr key={key} className="border-t">
                        <td className="py-1 pr-4 align-top font-medium">{key}</td>
                        <td className="tnum py-1 pr-4 align-top" style={{ color: "var(--text-secondary)" }}>
                          {render(change?.old)}
                        </td>
                        <td className="tnum py-1 align-top">{render(change?.new)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </details>
      ) : null}
    </li>
  );
}

/**
 * A JSONB value as text.
 *
 * `null` renders as the word "null" rather than an empty cell, because "this
 * field was cleared" and "this field is not in the diff" are different facts
 * and a blank cell says neither.
 */
function render(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "—";
  if (typeof value === "string") return value === "" ? '""' : value;
  return JSON.stringify(value);
}
