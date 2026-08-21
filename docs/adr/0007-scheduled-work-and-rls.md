# ADR 0007: Scheduled work runs through SECURITY DEFINER functions, and records every run

**Status:** Accepted · **Date:** 2026-08-21 · **Implements:** `ADM-5` · **Closes:** `TD-4`

## Context

Nothing in the system ran on a schedule. Notification dispatch piggy-backed on two unrelated user
actions, the rate-limit sweep function was written and never called, and SLA breach detection was
therefore impossible — the deadlines were computed and stored, the dispatch board sorted by them,
and then nothing ever looked at them again. The audit's phrase for it was exact: *the clock exists;
the alarm does not.*

Adding scheduled routes exposes two problems that only appear once a job runs with no session.

**A cron has no tenant context.** The application role is `NOBYPASSRLS` — that is the whole security
model — and the policy on `tenants` is `id = app_current_tenant()`. A scheduled job has no tenant,
so the GUC is unset, so a plain `SELECT` matches zero rows. Critically, `withoutTenantBoundary()`
does not help: it skips the `withTenant` wrapper and logs loudly, but it cannot grant an RLS
exemption to a role that has none. The first implementation did exactly this, and every cron
returned `200 OK` with `tenants: 0`. A green tick over a system doing no work is worse than a red
one, because nobody investigates it.

**A cron that stops is invisible by construction.** Nothing runs, so nothing complains, and the
absence of an alert is indistinguishable from everything being fine. Once SLA alerts, expiry
warnings and the notification drain all depend on the scheduler, the scheduler becomes the single
point whose silent failure takes every downstream check with it.

## Decision

**Cross-boundary reads go through narrow SECURITY DEFINER functions**, in
`packages/db/sql/cron-functions.sql` — the same answer authentication reached for the same
bootstrap problem, and for the same reason. Two functions: `app_cron_active_tenants()` returns ids
and nothing else, and `app_cron_sweep_sessions(days)` deletes only provably dead rows. Both pin
`search_path`, are revoked from `PUBLIC`, and are granted only to the application role.

They live in their own file rather than in `public-functions.sql`, because that file is documented
as the surface an unauthenticated visitor can reach and its bar is deliberately higher.

**Every run is recorded.** `cron_runs` carries one row per invocation with start, finish, outcome,
items processed and any error. It has no `tenant_id` — it holds no tenant data — so the generic RLS
policy loop correctly skips it.

**The scheduler monitors itself.** `/api/cron/health` reads `cron_runs`, compares each job's last
completed run against a per-job allowance, and returns a non-200 when anything is overdue. Non-200
rather than a cheerful 200 with a problem in the body, because the outermost check is an external
uptime monitor and those read status codes.

**Every route is secret-gated, and refuses when unconfigured.** A missing `CRON_SECRET` refuses
every request in every environment, including development. Open-in-development is how an
unauthenticated cron endpoint reaches production: the guard is never exercised locally, so nobody
notices it was never configured. Unauthorised callers get a 404, not a 401.

**Alerts are enqueued, not sent.** Detection and delivery stay separate, so a provider outage delays
an alert rather than losing the detection. Suppression is read from the notification ledger — one
alert per template per recipient per hour — because a ten-minute sweep re-detecting the same breach
would otherwise send six identical emails an hour, and six identical emails an hour is a filter rule.

## Consequences

**Five routes, not seven.** `dispatch`, `sweep`, `sla`, `compliance` and `health` are built because
the data they act on exists. `contracts` (PPM visit generation) and `retention` (automated purges)
are not, because `contract_visits` has no domain code and no `delete_after` columns exist yet.
Registering routes that report `ok` while checking nothing would reproduce the failure this ADR
exists to fix. They arrive with their data, in Phases 2 and 1 respectively.

**`compliance` is honest about its own scope.** It checks technician certifications, and says in
every response that employee documents (`HR-5`), company accreditations (`HR-14`) and the WPS
countdown (`HR-17`) are not yet checked. Those are the checks carrying six-figure penalties; the
route is built now so the schedule, the secret, the ledger and the health check are already proven
when they land.

**A known gap.** If `dispatch` is the job that has stopped, `health` queues its alert into a queue
nobody is draining. The external uptime monitor on `/api/cron/health` (`KPI-4`) is what covers that
case, which is why the status code matters more than the email.

**The run ledger is append-and-update only.** The application role has no `DELETE` on `cron_runs`.
Pruning the evidence that the schedule fired is an administrative action, not something the
application does to itself.
