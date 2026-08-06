# Data model

31 tables across five domains. Schema in [`packages/db/src/schema/`](../../packages/db/src/schema/),
generated migration in `packages/db/drizzle/0000_init.sql`.

## Domains

**Tenancy** (`tenancy.ts`) — `tenants`, `users`, `memberships`, `sessions`

**CRM** (`crm.ts`) — `customers`, `customer_contacts`, `properties`, `property_units`, `assets`,
`leads`, `communications`

**Workforce** (`workforce.ts`) — `technicians`, `technician_skills`, `technician_certifications`,
`shifts`, `leave_requests`, `attendance_events`, `technician_locations`, `technician_performance`

**Operations** (`operations.ts`) — `jobs`, `job_visits`, `job_reports`, `job_attachments`,
`job_signoffs`, `job_materials`, `job_events`

**Commerce** (`commerce.ts`) — `quotes`, `quote_lines`, `contracts`, `contract_properties`,
`contract_visits`, `invoices`, `invoice_lines`, `payments`

**Audit** (`audit.ts`) — `audit_log`, `ai_interactions`, `notifications`

## Core relationships

```
tenants ──┬── memberships ── users
          ├── customers ──┬── customer_contacts
          │               ├── properties ──┬── property_units
          │               │                └── assets
          │               ├── contracts ───┬── contract_properties
          │               │                └── contract_visits ──▶ jobs
          │               ├── quotes ── quote_lines
          │               └── invoices ─┬─ invoice_lines
          │                             └─ payments
          ├── technicians ─┬── technician_skills
          │                ├── technician_certifications
          │                ├── shifts / leave_requests
          │                ├── attendance_events
          │                └── technician_locations
          └── jobs ────────┬── job_visits ──▶ technicians
                           ├── job_reports
                           ├── job_attachments
                           ├── job_signoffs
                           ├── job_materials
                           └── job_events
```

## Modelling decisions worth explaining

### `users` is global; `memberships` binds to a tenant

One person can work for two maintenance companies, and a property manager can hold portal accounts
with several providers. Putting `tenant_id` on `users` would force duplicate accounts and duplicate
password resets.

The cost is that `users` cannot use the standard tenant-isolation policy. It is scoped by shared
membership instead, and login-by-email runs outside the tenant boundary. That trade is documented in
[the security model](03-security.md).

### `technicians` is separate from `users`

Not every technician needs a login. Supplied labour deployed to a client site often does not. Merging
them would put `visa_expires_on`, `hourly_cost` and `primary_trade` on the authentication table.

### One job, many visits

Covered in [the architecture doc](01-system-architecture.md). The short version: parts on order and
no-access are normal, so one-visit-per-job would make first-time-fix rate uncomputable.

### Skills are separate from `primary_trade`

Dispatch matches on *any* qualifying skill. A plumber also certified on pumps should be reachable for
both, and `technician_skills` has a `(tenant_id, service_slug, proficiency)` index so
"who can do this, ranked" is one indexed lookup.

`proficiency` exists so dispatch can prefer the *lowest* grade that qualifies, which keeps senior
technicians available for work that needs them.

### Certifications carry expiry, and it is indexed

`technician_certifications.expires_on` is indexed because assignment must refuse a technician whose
required certification has lapsed. That is a liability question, not a preference, so it is checked at
assignment time rather than surfaced on a dashboard nobody reads.

### Money is `numeric(14,2)` with a separate currency column

Never float. Drizzle returns `numeric` as a string and this codebase keeps it that way, converting
only at the edge, so no rounding happens implicitly.

Quote and invoice totals are **stored, not computed on read**. The numbers on a sent quote must not
change because someone later edited a line's price. Similarly, `invoices.customer_trn` is captured at
issue time rather than read from the customer record, so a reissued invoice shows the historical TRN.

### Percentages are stored in basis points

`sla_met_basis_points`, `avg_rating_basis_points`, `tax_rate_basis_points`. Integers, so reports do
not drift. `8500` is 85.00%.

### AI output is separated from human-authored content

`job_reports` keeps `raw_notes` (the technician's own words, never overwritten) alongside
`ai_summary` and `ai_summary_approved_by_id`. `jobs.ai_triage`, `quotes.ai_generation` and
`contracts.ai_analysis` are all JSONB carrying the model's output *and its reasoning*.

This exists so AI assistance is auditable and reversible. If the summariser starts producing
misleading customer-facing text, the source is intact and the blast radius is knowable.

### `job_visits.assignment_method` and `assignment_score`

Records whether a human or the optimiser made each assignment, and the score behind it. Without this
you cannot answer "is the optimiser actually better than the dispatcher" before handing it more of the
board. Measuring the automation is a prerequisite for trusting it.

### Soft delete via `deleted_at`

Present on most tables. Maintenance records get referenced in disputes and insurance claims long
after someone clicks delete.

## Indexing

Indexes are placed against known query shapes rather than sprinkled on foreign keys:

| Index | Serves |
| --- | --- |
| `jobs_board_idx (tenant_id, status, priority, scheduled_for)` | The dispatch board's main query |
| `jobs_sla_idx (tenant_id, resolve_by_at, status)` | SLA breach report |
| `job_visits_tech_window_idx (tenant_id, technician_id, scheduled_start)` | Technician day view, capacity checks |
| `assets_due_idx (tenant_id, next_service_due_at)` | PPM job generator |
| `contracts_expiry_idx (tenant_id, ends_on, status)` | Renewals dashboard and auto-renewal notices |
| `invoices_ageing_idx (tenant_id, due_on, status)` | AR ageing |
| `properties_geo_idx (lat, lng)` | Nearest-technician lookup |
| `technician_skills_lookup_idx (tenant_id, service_slug, proficiency)` | Dispatch candidate matching |
| `payments_gateway_key (tenant_id, gateway_provider, gateway_payment_id)` | Unique: makes webhook replay a no-op rather than a duplicate payment |

`properties_geo_idx` is a plain btree on `(lat, lng)`, which is adequate for the bounding-box
prefilter the dispatcher will do first. If proximity search becomes a bottleneck, PostGIS with a GiST
index is the upgrade path. Deliberately not adopted upfront: it is a heavy dependency for a query
that is not yet slow.

## Known gaps

- **No `parts` or `inventory` table.** `job_materials` records consumption with a free-text
  description and optional SKU. A real stock system is out of scope for now, and pretending otherwise
  by adding an unused table would be worse.
- **`technician_locations` needs partitioning.** See [the data lifecycle doc](04-data-lifecycle.md).
- **No multi-currency FX.** Each row carries a currency but there is no rate table. Fine while the
  operation is single-country; needed at the first cross-border tenant.
