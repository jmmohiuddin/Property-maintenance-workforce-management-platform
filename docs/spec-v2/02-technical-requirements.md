# Technical Requirements Document

## SATS Operations Platform — v2.0

**Companion to:** `01 — Product Requirements Document`. Every requirement ID cited here (`JOB-6`, `INV-9`, `FLD-13`) is defined there.
**Date:** 12 August 2026
**Audience:** the engineer building this, and the engineer who inherits it.

* * *

## 1\. Purpose and standing

The previous technical documentation was reconstructed from the code after the fact. This document is a specification: it states what must be true of the system, decides the architectural questions the audit left open, and gives migration paths for the debt it found.

Where this document and an earlier architecture decision record disagree, **this document wins and the ADR should be superseded by a new one** recording why. Two such reversals are made explicitly: the field\-app platform (§8) and the deployment region (§4.3).

**Guiding constraint.** This system is operated by one company with roughly 10–30 back\-office users and up to 60 field technicians. Every architectural choice must be justified against that scale, not against a hypothetical one. The audit's verdict on the existing stack — *"coherent and boring in the right places; the risks are operational, not architectural"* — is correct and this document does not relitigate it.

* * *

## 2\. Architectural principles

These are binding. A pull request that violates one needs a written reason.

1. **The database is the security boundary.** Tenant and customer isolation is enforced by Postgres row\-level security, not by application `WHERE` clauses. A query that forgets its filter returns nothing, not someone else's data. This survives an application bug; a `WHERE` clause does not.
2. **The domain layer is pure.** `packages/core` has zero runtime dependencies, no I/O, no framework imports. Money arithmetic, state machines, SLA computation, working\-calendar rules and entitlement logic live there and are unit\-testable without a database. This is what makes the same rules reusable by the field app.
3. **State machines over free edits.** Job status, quote status, invoice status, application stage, project status and contract status move only along defined edges. The UI offers only legal transitions; the domain layer refuses illegal ones regardless of what the UI offered.
4. **Money is integer minor units in code, `numeric(14,2)` at rest, converted at the edges.** Never a float. This is already correct and is restated so it cannot be regressed.
5. **Events are append\-only; state is derived.** Attendance, status history, stage changes, audit entries and field\-app activity are immutable rows. This gives audit trails that are legally required, funnel analytics that are commercially required, and — critically — it makes most offline sync conflicts evaporate before they exist (§8.3).
6. **Nothing important happens only when a user clicks.** Notification dispatch, SLA breach detection, expiry alerting and PPM generation run on a schedule. The audit's finding that dispatch piggy\-backed on two unrelated user actions is the archetype of this failure.
7. **Fail loudly to an operator, gracefully to a user.** A user sees a plain\-language message and never a driver error. An operator sees the stack trace, in a tool that pages someone.
8. **Compliance rules are code, not documentation.** A working\-hours limit written in a policy document will be violated. The same limit expressed as a scheduler constraint will not.

* * *

## 3\. Technology stack

### 3\.1 Retained without change

| Technology | Role | Verdict |
| --- | --- | --- |
| Next.js 16 (App Router, RSC) | Web app \+ static marketing \+ server actions | Correct. The answer\-engine requirement alone justifies server components — crawlers do not execute JavaScript, and the marketing pages must be complete HTML. |
| React 19 | UI | Correct |
| TypeScript 7, strict | Everywhere | Correct |
| Tailwind v4 \+ CSS custom\-property tokens | Styling | Correct; the contrast gate is a genuine asset |
| PostgreSQL 16/18 | System of record | Correct. RLS is the tenant boundary. |
| Drizzle ORM \+ `postgres` driver | Data access | Correct. Typed schema with a raw\-SQL escape hatch. |
| `@node-rs/argon2` | Password hashing | Correct, kept out of the serverless bundle via `serverExternalPackages` |
| npm workspaces (`core`, `db`, `auth`, `notify`, `web`) | Monorepo | Correct — the boundaries are real, and `core` having zero runtime dependencies is what makes it shareable |
| Hand\-written TOTP/QR | MFA enrolment | Correct and unusually well de\-risked: RFC 6238 vectors plus a decoder in the tests. A hosted QR API would have exfiltrated the shared secret. |

### 3\.2 Additions

| Technology | Role | Justification |
| --- | --- | --- |
| **GitHub Actions** | CI | The single highest\-leverage hour available. §11.1 |
| **Sentry** (or equivalent) | Error monitoring | Production failures are currently invisible. `KPI-1` |
| **Scheduled function runner** (platform cron or equivalent) | Scheduled work | `ADM-5`. Nothing runs on a schedule today. |
| **Object storage** (S3\-compatible, UAE region) | Documents, photos, CVs, PDFs, signed job sheets | No storage layer exists at all; `invoices.pdf_storage_key` is a column nothing writes |
| **PDF renderer** (headless Chromium against a React template) | Quotes, invoices, job sheets, tender packs, statements | Reuses the existing design tokens; no second templating language |
| **React Native \+ Expo** | Technician field app | §8. Reverses the earlier PWA decision. |
| **SQLite (Expo SQLite / op\-sqlite)** | Field app local store | Durable, not evictable by the OS |
| **WhatsApp Business API or SMS gateway** | Lead alerts, technician dispatch, applicant messaging | `LEAD-2`, `ATS-14`. Email alone does not reach this workforce or this customer base. |
| **Antivirus scanning service** | CV and document uploads | `ATS-9`. Untrusted files from the public internet. |
| **Peppol Accredited Service Provider SDK/API** | E\-invoicing | `INV-10`. Selection is `OPEN-6`; integration is Phase 4 but the data model is Phase 1. |

### 3\.3 Deliberately not adopted

| Not adopting | Why |
| --- | --- |
| Redis / dedicated queue | Postgres `FOR UPDATE SKIP LOCKED` plus a cron drain covers thousands of notifications a day honestly. Introducing a second stateful system doubles the operational surface for no gain at this scale. |
| Microservices | The workspace boundaries already provide the seams. Splitting deployment units at 30 users adds distributed\-systems failure modes to a system that has none. |
| GraphQL / REST API layer | Server actions cover the entire mutable surface today. A public API is a Phase 4 project with its own contract, not a refactor. |
| Third\-party authentication SaaS | The existing auth is tested, owned and above industry norm for this stage. The gaps are *flows* (reset, unlock, admin) not *cryptography*. Replacing it would discard proven work to solve a different problem. |
| Heavyweight analytics SaaS | Start with a `product_events` table in the same Postgres and a weekly SQL report. Graduate when volume demands it, not when a vendor suggests it. |
| ORM\-level multi\-tenancy | The tenant boundary is in the database. Moving it into the ORM would move it out of the place that makes it provable. |

* * *

## 4\. System architecture

### 4\.1 Runtime topology

```
                        ┌─────────────────────────────────────┐
   Visitor / AI crawler │  Static marketing pages (CDN)        │
   ────────────────────▶│  24 service · 19 area · JSON-LD      │
                        │  sitemap · robots · llms.txt         │
                        └──────────────┬──────────────────────┘
                                       │ quote form (server action)
                                       ▼
   Staff (browser)      ┌─────────────────────────────────────┐
   ────────────────────▶│                                     │
   Customer (portal)    │   Next.js server                    │
   ────────────────────▶│   RSC pages (force-dynamic)         │
   Applicant (careers)  │   Server actions (POST, CSRF by     │
   ────────────────────▶│   action-ID)                        │
                        │   Route handlers:                   │
   Cron scheduler       │     /api/cron/*   (secret-gated)    │
   ────────────────────▶│     /api/field/*  (token auth)      │
   Field app (RN)       │     /sitemap /robots /llms.txt      │
   ────────────────────▶│                                     │
                        └───┬──────────┬──────────┬───────────┘
                            │          │          │
              app role      │          │          │
        (NOBYPASSRLS)       │          │          │
                            ▼          ▼          ▼
        ┌───────────────────────┐  ┌────────┐  ┌──────────────┐
        │  PostgreSQL           │  │ Object │  │ Outbound     │
        │  FORCE RLS on every   │  │ store  │  │ Email · SMS  │
        │  tenant table         │  │ (UAE)  │  │ WhatsApp     │
        │  SECURITY DEFINER fns │  │ private│  │ ASP (Peppol) │
        │  append-only audit    │  │ signed │  │ Sentry       │
        └───────────────────────┘  │ URLs   │  └──────────────┘
                                   └────────┘
```

### 4\.2 Request path — unchanged and correct

Every tenant\-scoped read or write follows the same path, and it must stay that way:

```
session cookie
  → resolveSession()            hashed token lookup, no plaintext at rest
  → withTenant() / withCustomerScope()
        opens a transaction
        SET LOCAL app.tenant_id   = …
        SET LOCAL app.user_id     = …
        SET LOCAL app.customer_id = …   (portal only)
  → RLS policies filter every statement in that transaction
  → commit
```

The GUCs are transaction\-local. A connection returned to the pool carries no scope. This is why connection pooling is safe here, and it must be preserved when the field\-app API is added (§8.5).

### 4\.3 Deployment region — a required change

**Finding.** UAE tax law requires electronic records to be **retained in the UAE** and accessible to the authorities. The current deployment runs compute and database in Singapore.

**Requirement `INFRA-1`\:** before the first real tax invoice is issued, either

- **(a)** move the primary database to a UAE region and co\-locate compute with it; or
- **(b)** retain the current topology for the operational system **and** write an immutable, UAE\-resident archive of every tax record (invoice, credit note, supporting document) with a documented retrieval procedure.

**(a) is recommended** — it is simpler to defend, and it removes the Dubai↔Singapore round\-trip latency of roughly 60–90 ms that the audit accepted as tolerable. The counter\-argument, that the current provider's UAE region may be less mature, is a vendor question, not an architectural one; nothing in the codebase is vendor\-coupled beyond deployment configuration.

This is `OPEN-2` in the PRD and it blocks Phase 1. Confirm the precise scope of "retained in the UAE" with a tax agent before choosing.

### 4\.4 Scale envelope

| Dimension | Target | First bottleneck | Mitigation |
| --- | --- | --- | --- |
| Back\-office users | 30 concurrent | None | — |
| Technicians | 60 | Field\-app sync fan\-out | Bounded working sets (§8.2) |
| Jobs/year | 5,000 | Dispatch board query | Composite index on `(tenant_id, status, sla_response_due)`; the board reads open jobs only |
| Customers | 500 | Unbounded list query | Keyset pagination, `LEAD-8` |
| Properties | 2,000 | — | — |
| Assets | 10,000 | Asset register load | Paginate; lazy\-load service history |
| Applicants/year | 2,000 | CV storage growth | Retention job, `ATS-18` |
| Photos/year | \~100,000 | Object storage cost and upload bandwidth | On\-device compression, `FLD-7` |
| Notifications/day | \~500 | None | Postgres queue is comfortable to \~10⁴/day |

Nothing here requires read replicas, caching layers or background worker fleets. If any of those appear in a design review, ask which number above they serve.

* * *

## 5\. Security architecture

### 5\.1 Retained — the genuine strengths

These were assessed as above industry norm for this stage and must not be weakened by any change in this document.

- `FORCE ROW LEVEL SECURITY` on every tenant table; the application role is `NOBYPASSRLS`; a boot assertion verifies it.
- A **generic RLS policy loop** so a newly added table cannot be forgotten — re\-running `rls.sql` covers it. This is the pattern that makes the guarantee durable across schema growth.
- A **12\-check adversarial proof harness** (`verify-rls.sql`) run against the real database after every schema change.
- **Customer scoping as RESTRICTIVE policies ANDed onto tenant policies** — portal code *cannot* widen access by forgetting a filter, because a RESTRICTIVE policy narrows unconditionally.
- Argon2id password hashing; session tokens hashed at rest so a database dump does not yield sessions; generic authentication failure messages so accounts cannot be enumerated; MFA with two\-step enrolment, per\-step replay guard, ±1 step clock skew tolerance, and single\-use hashed recovery codes.
- Four `SECURITY DEFINER` functions with pinned `search_path` for the unauthenticated bootstrap needs (auth lookup, MFA, public tenant resolve, rate limit), each `REVOKE`d from `PUBLIC`.
- Security headers including HSTS with preload, `nosniff`, `X-Frame-Options: SAMEORIGIN`, referrer policy, permissions policy; httpOnly cookies; no secrets in the repository.
- Server\-side zod validation on every public form; parameterised SQL throughout, with no string\-built SQL anywhere in application code.

### 5\.2 Required additions

| ID | Requirement | Priority |
| --- | --- | --- |
| `SEC-1` | **Rotate the exposed database credentials.** Two owner connection strings were pasted into a build conversation, one belonging to an unrelated production system. Until rotated this is a critical, unmitigated exposure. Rotate both, audit access logs for the exposure window, and never pass secrets through chat again — use the platform's environment pull flow. | P0 |
| `SEC-2` | **Content Security Policy with nonces.** JSON\-LD is inline and needs a nonce; the one reviewed `dangerouslySetInnerHTML` (a self\-generated QR SVG) needs to remain the only one. No `unsafe-inline`. Deploy in report\-only for one week, then enforce. | P0 |
| `SEC-3` | **Login IP throttle** reusing the existing Postgres limiter built for the quote form. Account lockout protects one account; credential stuffing across many accounts is currently unthrottled. This is genuinely an afternoon's work. | P0 |
| `SEC-4` | **Truthful lockout.** Implement time\-based decay (recommended: exponential backoff to a 30\-minute maximum) **and** an admin unlock action, then correct the UI copy. A permanent lockout with copy saying "temporarily" is a false promise plus an availability failure. | P0 |
| `SEC-5` | **Password reset** by emailed single\-use token: 32 bytes of cryptographic randomness, stored hashed, 30\-minute expiry, single use, invalidates all sessions on use, rate\-limited per account and per IP. Reset requests return a generic response whether or not the account exists. | P0 |
| `SEC-6` | **MFA reset** by an admin, with a documented identity\-verification procedure recorded in the audit log as a free\-text attestation naming who verified whom and how. The procedure is the control; the software only records it. | P1 |
| `SEC-7` | **Field\-app authentication.** Long\-lived refresh token in device secure storage (Keychain / Keystore), short\-lived access token in memory. Device registered and revocable from the admin surface. Token bound to the technician. Remote wipe of the local store on revocation, applied at next connectivity. | P2 |
| `SEC-8` | **File upload hardening.** Magic\-byte content sniffing, never trusting the client MIME type. Size caps enforced server\-side. Asynchronous virus scan with an explicit `scan_status` and downloads gated on it. Private buckets, no public URLs, short\-lived signed URLs generated per authenticated request and authorised against the requester's permissions. Never serve user\-supplied HTML or SVG same\-origin. `Content-Disposition: attachment` with a strict `Content-Type` on every download. | P1 |
| `SEC-9` | **Secrets management.** All secrets in the platform environment store, never in the repository. Quarterly rotation for long\-lived credentials. A documented inventory of every secret, what it grants, and who can rotate it. | P1 |
| `SEC-10` | **Dependency audit** in CI, failing the build on a known critical vulnerability. Lockfile committed; no CDN\-loaded scripts. | P1 |
| `SEC-11` | **Session behaviour.** Sliding renewal on activity with an absolute maximum (recommend 8\-hour sliding, 24\-hour absolute), replacing the fixed 12\-hour TTL that logs staff out mid\-shift and loses in\-flight form work. Session rotation on role or password change. | P1 |
| `SEC-12` | **Security event alerting:** authentication lockout spike, rate\-limiter degraded\-mode log line, repeated authorisation failures on a single session, unexpected `SECURITY DEFINER` function call volume. A breach or brute\-force campaign is currently invisible. | P0 |

### 5\.3 OWASP Top 10 position after these changes

| Category | Before | After |
| --- | --- | --- |
| Broken access control | ✅ Database\-enforced and tested | ✅ Unchanged |
| Cryptographic failures | ✅ Argon2id, hashed tokens | ✅ Unchanged |
| Injection | ✅ Parameterised throughout | ✅ Unchanged |
| Insecure design | ⚠️ Reset and unlock gaps | ✅ `SEC-4` `SEC-5` `SEC-6` |
| Security misconfiguration | ⚠️ No CSP | ✅ `SEC-2` |
| Vulnerable components | ⚠️ No automated audit | ✅ `SEC-10` |
| Authentication failures | ⚠️ No IP throttle | ✅ `SEC-3` |
| Data integrity | ✅ Lockfile, no CDN scripts | ✅ Unchanged |
| **Logging & monitoring** | ❌ **None** | ✅ `KPI-1` `SEC-12` |
| SSRF | ✅ No user\-supplied fetches | ⚠️ Re\-examine when the ASP integration lands |

* * *

## 6\. Data architecture

### 6\.1 Conventions — carried forward

These are the conventions that make the existing schema durable. New tables must follow them.

- `tenant_id` is the **first column** of every tenant\-scoped table, and a generic policy loop applies RLS to all of them.
- Money is `numeric(14,2)` at rest, integer minor units in code, converted at the edges.
- Enums for every state machine. No string status columns.
- Soft delete via `deleted_at`, never a hard `DELETE`, on anything with a financial or legal trail.
- `audit_log` is INSERT\-only for the application role; `UPDATE` and `DELETE` are revoked and additionally policy\-blocked.
- Reference allocation via the `app_next_reference` SECURITY DEFINER function against an atomic counter row per tenant/prefix/year, seeded from the legacy maximum, proven correct under concurrent races. Every new reference series uses it.

### 6\.2 The 14 unused tables — build, reshape or drop

The audit found roughly 14 tables with no UI and no domain code, and correctly named them *proposals, not decisions*. This document decides each.

| Table | Decision | Requirement | Notes |
| --- | --- | --- | --- |
| `shifts` | **Build** | `JOB-8` | Needed for availability\-aware assignment and the working calendar |
| `leave_requests` | **Build** | `HR-7` | Feeds the scheduler |
| `attendance_events` | **Build, reshape** | `FLD-3`, `HR-8` | Must carry **both** device and server timestamps, and a client\-generated ID for offline creation |
| `technician_locations` | **Build, reshape** | `FLD-16` | Change from a continuous trace to **discrete geo\-stamped events**. Add a retention column and an automated purge. |
| `technician_performance` | **Drop** | — | Derive from events. A materialised performance table invites metrics nobody agreed to. |
| `job_reports` | **Build** | `FLD-6`, `JOB-14` | Add symptom/cause/remedy code columns |
| `job_attachments` | **Build, reshape** | `FLD-7` | Add `role` tag, `scan_status`, SHA\-256, extracted EXIF columns, compression state |
| `job_signoffs` | **Build, reshape** | `FLD-13`, `FLD-14` | Add signer name, role, email, consent\-statement version, **document hash**, immutable snapshot key, device and server timestamps |
| `job_materials` | **Build** | `FLD-9` | Add `source` enum and serial number |
| `property_units` | **Build** | `LEAD-11` | Needed for buildings with multiple units under one contract |
| `assets` | **Build** | `CON-13` | The basis of per\-asset PPM and commercial tender pricing |
| `communications` | **Build** | `LEAD-9` | Exists, unused; one click plus one sentence to log |
| `contracts` / `contract_properties` / `contract_visits` | **Build** | M3 | The largest single gap between the schema and the product |
| `ai_interactions` | **Drop for now** | — | Traceable only to a deferred ambition. Re\-add with the feature, not before. |

**Rule going forward:** a table without a domain code path and a test is deleted at the end of the phase in which it was added. An untested claim about the future is not free — it misleads the next reader.

### 6\.3 New entities

Presented as a logical model. Column\-level detail belongs in migrations, not here.

#### Contracts and preventive maintenance

```
contracts
  id, tenant_id, customer_id, reference, type(comprehensive|labour_only),
  status(draft|active|suspended|expired|cancelled|renewed),
  term_start, term_end, annual_value_minor, billing_frequency,
  payment_terms_days, discount_rate_bp, response_tier,
  renewal_of_contract_id, signed_document_key, created_at, deleted_at

contract_properties          contract_id, property_id, coverage_notes
contract_entitlements        contract_id, service_id, visits_per_year,
                             callouts_per_year (null = unlimited),
                             consumed_visits, consumed_callouts
contract_exclusions          contract_id, exclusion_code, description
contract_visits              contract_id, service_id, property_id,
                             sequence_no, window_start, window_end,
                             status(pending|scheduled|completed|missed|cancelled),
                             job_id
assets                       tenant_id, property_id, category, make, model,
                             serial_no, location_text, install_date,
                             warranty_expiry, last_service_at, next_service_due
```

`contract_exclusions` is machine\-readable rather than prose because `CON-6` depends on it: work matching an exclusion cannot be silently absorbed into a comprehensive contract.

#### Projects

```
projects
  id, tenant_id, customer_id, property_id, reference, name,
  status(quoted|awarded|mobilising|on_site|snagging|
         practical_completion|defects_liability|closed),
  contract_value_minor, retention_rate_bp,
  start_date, target_completion, actual_completion,
  defects_liability_end, project_manager_user_id

project_phases        project_id, name, sequence, weight_bp,
                      planned_start, planned_end, actual_start, actual_end,
                      status, depends_on_phase_id
project_milestones    project_id, phase_id, name, value_minor,
                      trigger(date|percent_complete|client_signoff),
                      trigger_value, reached_at, invoice_id
project_variations    project_id, reference, description, value_minor,
                      status(proposed|approved|rejected), approved_by,
                      approved_at, client_reference
project_permits       project_id, authority, permit_type, reference_no,
                      applied_at, approved_at, expires_at,
                      fee_minor, document_key, required boolean
project_snags         project_id, location_text, trade, description,
                      photo_key, responsible_party, target_date,
                      closed_at, closure_photo_key, severity
```

`project_permits.required` plus a check in the domain layer implements `PRJ-6`\: a project may not enter `on_site` while a required permit is not approved.

#### Recruitment

```
job_requisitions
  id, tenant_id, reference, trade, grade, headcount, location,
  contract_type, salary_band_min_minor, salary_band_max_minor,
  required_certifications jsonb, min_experience_years,
  opens_at, closes_at, hiring_manager_user_id,
  status(draft|approved|open|on_hold|filled|cancelled), public_slug

candidates
  id, tenant_id, full_name, phone_e164, phone_local_digits, email,
  primary_trade, grade, experience_band, current_location,
  uae_visa_status, source, consent_talent_pool boolean,
  consent_captured_at, last_interaction_at, delete_after
      -- phone_local_digits is stored separately and indexed:
      -- duplicate matching compares local digits, ignoring country code

applications
  id, tenant_id, candidate_id, requisition_id,
  stage_id, status(active|hired|archived|withdrawn),
  archived_at_stage_id, disposition_reason_code, source,
  applied_at, last_stage_change_at, blocked_on(us|candidate|none)

application_stages         requisition_id, name, stage_type, sequence
      -- stage_type ∈ applied|screening|trade_check|assessment|
      --               interview|offer|onboarding|hired
      -- stage is the label; stage_type is the semantic that makes
      -- reporting work across differently-shaped pipelines

application_events         application_id, event_type, from_stage_id,
                           to_stage_id, actor_user_id, occurred_at, payload
candidate_documents        candidate_id, kind(cv|certificate|id|other),
                           storage_key, filename, size_bytes, sha256,
                           scan_status(pending|clean|infected|skipped),
                           parse_status, parser_version, uploaded_at
candidate_certifications   candidate_id, scheme, certificate_no, level,
                           issuing_body, issued_at, expires_at,
                           evidence_key, verified_by, verified_at
talent_pool_members        candidate_id, pool_key, added_at,
                           reconfirm_due_at, consent_ref
```

**Note the three\-axis separation.** `applications.stage_id` (where), `applications.status` (live or not), `applications.disposition_reason_code` (why it ended) — plus `archived_at_stage_id`, which preserves *where* an application died. Without that column funnel conversion analysis is impossible, and it cannot be reconstructed later.

#### Workforce compliance

```
employees                  -- extends technicians; a technician may exist
                           -- without an employee record (subcontracted)
  id, tenant_id, technician_id, employee_no,
  contract_type, contract_start, contract_end, probation_end,
  notice_period_days, basic_salary_minor, allowances jsonb,
  mohre_person_code, wps_iban, status, terminated_at, delete_after

employee_documents
  employee_id, kind, reference_no, issued_at, expires_at,
  storage_key, blocking boolean, verified_by, verified_at
      -- kind ∈ passport|residence_visa|emirates_id|work_permit|
      --        medical_fitness|health_insurance|driving_licence|other
      -- blocking = true means an expiry hard-blocks dispatch (HR-9)

company_accreditations
  tenant_id, kind, reference_no, issuing_body, issued_at, expires_at,
  storage_key, renewal_owner_user_id, tender_pack_include boolean
      -- kind ∈ trade_licence|dewa_enrolment|dm_classification|
      --        iso_cert|liability_insurance|workmen_comp|
      --        worker_protection|other

leave_requests             employee_id, type, start_date, end_date, days,
                           status, approved_by, approved_at, reason
work_injuries              employee_id, job_id, occurred_at, description,
                           mohre_reported_at, mohre_reference,
                           medical_cost_minor, salary_continuation_until
      -- mohre_reported_at drives the 48-hour alarm
payroll_periods            tenant_id, period_month, wps_due_date,
                           file_generated_at, transfer_confirmed_at,
                           total_wages_minor, transferred_minor
      -- transferred/total ≥ 0.85 is the compliance test
```

`employee_documents.blocking` is what makes `HR-9` enforceable in one query rather than a special case per document type.

#### Working calendar

```
calendar_rules
  tenant_id, rule_type, effective_from, effective_to, payload jsonb
      -- rule_type ∈ weekend|public_holiday|ramadan_reduction|
      --             midday_ban|standard_hours|emergency_cover

public_holidays            tenant_id, date, name, year
```

The **midday ban** rule is data, not code, so its dates can be corrected annually without a deploy — but it is applied by a pure function in `packages/core` so the field app, the scheduler and the SLA calculator all enforce it identically. `calendar_rules` is read by `isWorkingTime()`, `nextWorkingWindow()` and `slaDeadline()`, and those three functions are the only callers.

#### Field operations

```
field_events              -- append-only, the spine of the field app
  id (client-generated ULID), tenant_id, job_id, visit_id,
  technician_id, event_type, device_at, server_at,
  lat, lon, accuracy_m, payload jsonb, app_version, device_id
      -- event_type ∈ en_route|arrived|started_work|paused|resumed|
      --              departed|photo_captured|material_added|
      --              signature_captured|outcome_recorded

job_signoffs
  job_id, visit_id, signer_name, signer_role, signer_email,
  signature_svg, consent_statement_version,
  document_sha256, document_snapshot_key,
  device_at, server_at, technician_id, device_id,
  not_available_reason, attested_by_user_id
      -- document_sha256 hashes the exact rendered job sheet shown
      -- on screen at the moment of signing. Without it the
      -- signature proves nothing, because the job sheet is mutable.

sync_state                device_id, technician_id, last_pull_cursor,
                          last_successful_sync_at, queue_depth,
                          oldest_pending_at, dead_letter_count
```

#### Analytics

```
product_events            tenant_id, event_name, occurred_at,
                          actor_user_id, entity_type, entity_id,
                          properties jsonb
```

RLS\-protected, in the same Postgres, queried by a weekly SQL report. It graduates to a dedicated pipeline when volume demands, not before.

### 6\.4 Schema corrections

| ID | Change | Reason |
| --- | --- | --- |
| `DB-1` | `users.failed_login_count` from `varchar(8)` to `integer` | Currently works via cast arithmetic; invites an off\-by\-type bug. Migrate with a backfill. |
| `DB-2` | Populate `invoices.pdf_storage_key`; add `quotes.pdf_storage_key` | Dead column becomes live once `INV-3` and `QTE-3` render |
| `DB-3` | Add all PINT AE mandatory fields to `invoices` and `invoice_lines` | `INV-9`. Retrofitting these onto historical invoices in 2027 is the expensive path. |
| `DB-4` | Add `customers.trn`, `customers.credit_limit_minor` | Recipient TRN determines full vs simplified invoice under `INV-6` |
| `DB-5` | Add `leads.channel`, `leads.utm_*`, `leads.landing_page`, `leads.called_number` | `LEAD-4` attribution; without it the answer\-engine investment cannot be evaluated |
| `DB-6` | Add `jobs.outcome_code`, `jobs.is_outdoor`, `jobs.contract_id`, `jobs.project_id` | `JOB-13`, `JOB-6` midday\-ban check, contract and project linkage |
| `DB-7` | Add `job_assignments.override_reason`, `override_warning_type` | `JOB-10` — silent overrides become recorded decisions |
| `DB-8` | Index review: `(tenant_id, status, sla_response_due)` on jobs; `(tenant_id, phone_local_digits)` and `(tenant_id, lower(email))` on candidates and customers; `(tenant_id, expires_at)` on `employee_documents` and `company_accreditations`; `(status, next_attempt_at)` on notifications | Dispatch board, duplicate detection, expiry sweeps, queue drain |
| `DB-9` | Add `delete_after` columns to `candidates`, `employees` and location events, with an automated purge job | `ATS-18`, `HR-15`, `FLD-16`. Retention as a job, not a policy document. |

* * *

## 7\. Application architecture

### 7\.1 Workspace layout

```
packages/
  core/     pure domain. Zero runtime dependencies.
            money · state machines · SLA computation · working calendar
            · entitlement logic · fault taxonomy · validation schemas
            · PINT AE invoice mapping
  db/       Drizzle schema · migrations · security SQL · RLS harness
            · withTenant / withCustomerScope · reference allocation
  auth/     Argon2 · sessions · TOTP · recovery codes · lockout
            · reset tokens · field-app device tokens
  notify/   template registry · transactional enqueue · ledgered dispatch
            · transports (email · SMS/WhatsApp) · retry classification
  docs/     NEW. PDF rendering: quote · invoice · credit note · job sheet
            · statement · tender pack. React templates + headless render.
  files/    NEW. Object storage: signed URLs · virus scan orchestration
            · EXIF extract and strip · image compression · SHA-256
  web/      Next.js app: marketing · app · portal · careers · cron routes
            · field API
  field/    NEW. React Native app. Imports packages/core.
```

**`packages/core` is imported by both `web` and `field`.** That is the entire justification for the workspace structure, and it is why `core` must stay free of Node and browser APIs. A working\-calendar rule or an SLA calculation that differs between the office and the field is a bug that is very hard to see.

### 7\.2 Server actions remain the mutable surface

The audit noted, correctly, that there is no REST or GraphQL API and that the entire mutable surface is Next.js server actions — POST\-only, CSRF\-protected by the action\-ID mechanism, co\-located with their screens. This is right for a single first\-party web client and should not change.

**Two exceptions are added:**

1. **`/api/cron/*`** — secret\-gated route handlers for scheduled work (§7.4).
2. **`/api/field/*`** — a thin, versioned JSON API for the technician app only (§8.5). Deliberately narrow: `GET /field/v1/sync` and `POST /field/v1/mutations`. It is not a general\-purpose API and must not become one.

### 7\.3 Server action conventions

Every mutating action follows the same shape, and this is enforced by review:

```
1. Parse and validate input with zod            → field-level errors
2. Resolve session and authorise by role        → typed refusal
3. Open a scoped transaction (withTenant)
4. Load current state; check the state machine  → typed refusal
5. Mutate
6. Write audit_log row
7. Enqueue notifications in the SAME transaction
8. Commit
9. Emit product_event (best-effort, outside the transaction)
10. revalidatePath / redirect
```

Steps 6 and 7 inside the transaction are what make the system honest: an audit entry cannot exist for a mutation that rolled back, and a notification cannot promise something that did not happen. This pattern is already implemented and is the strongest thing in the codebase after the RLS design.

**Error surfacing:** only `UserFacingError` renders to a user. Everything else is logged with full context and rendered as a generic message. The raw\-driver\-message leak found and fixed during the original build must not regress — add a test that asserts no database error text reaches a rendered response.

### 7\.4 Scheduled work

`ADM-5`. Every route is secret\-gated, idempotent, and reports its own health.

| Route | Cadence | Does | Alerts on |
| --- | --- | --- | --- |
| `/api/cron/dispatch` | Every 5 min | Drain the notification queue; classify failures as retryable or terminal; detect stuck items | Any item stuck \> 30 min; any terminal failure |
| `/api/cron/sweep` | Hourly | Expire rate\-limit windows; expire sessions; expire quotes past validity | Sweep did not run |
| `/api/cron/sla` | Every 10 min | Detect jobs past response or resolution deadline, computed against the working calendar; notify | Any breach; and the job's own failure |
| `/api/cron/compliance` | Daily 06:00 Asia/Dubai | Employee document expiry; company accreditation expiry; certification expiry; contract renewal windows; WPS countdown | Any expiry inside its alert window; WPS T\-5 and the 2nd\-of\-month alarm |
| `/api/cron/contracts` | Daily | Generate `contract_visit` → `Job` for visits entering their scheduling window; update entitlement consumption | Generation failure |
| `/api/cron/retention` | Daily 02:00 | Purge applicant data past `delete_after`; purge raw location traces past retention; log every deletion | Purge failure |
| `/api/cron/health` | Every 5 min | Heartbeat; verify each other cron ran within its expected interval | **A missed cron** — the meta\-check that makes the rest trustworthy |

**Every cron writes a `cron_runs` row** with start, finish, items processed and outcome. `/api/cron/health` reads that table. A scheduler that fails silently is the failure this whole section exists to prevent, so the scheduler must itself be monitored.

### 7\.5 Notification pipeline — extend, don't replace

The existing design is sound and stays: transactional enqueue that rolls back with its business record; a ledgered dispatch table with attempt counts, `FOR UPDATE SKIP LOCKED` claiming, retryable versus terminal failure classification, and stuck detection; a template registry with a loud console transport when email is unconfigured.

Extensions required:

- **Actually schedule the drain** (`/api/cron/dispatch`). This is the whole of `TD-4`.
- **Activate the email transport** — set the API key and sending address, with SPF, DKIM and DMARC on a real domain (`OPEN-10`).
- **Add an SMS/WhatsApp transport** for `LEAD-2`, `ATS-14` and technician dispatch, with the same ledger and retry semantics.
- **Add the templates** in the PRD's §12 catalogue.
- **Add per\-recipient, per\-event suppression**, respected by the dispatcher rather than by each caller.
- **Add digest batching** so non\-urgent staff notifications collapse into one message per recipient per hour.
- **Surface failures to an operator**, not only to a log — a notification that exhausts its retries appears in a queue someone reads.

### 7\.6 Document rendering

`packages/docs` renders React templates with headless Chromium.

| Document | Requirement | Notes |
| --- | --- | --- |
| Quote | `QTE-3` | Licence 930137, TRN, lines, discount, 5% VAT, total, validity, inclusions and exclusions, portal accept link |
| Tax invoice (full) | `INV-3` | Complete Article 59 field set; sequential number; date of supply |
| Tax invoice (simplified) | `INV-6` | A **rendering variant of the same invoice object**, never a second object — it disappears in 2027 |
| Tax credit note | `INV-7` | Own sequential series; references the original |
| Job sheet | `FLD-14` | The signed artefact. Its SHA\-256 is stored. Immutable after signature. |
| Statement of account | `INV-13` | — |
| Tender pack | `CON-12` | Assembled from `company_accreditations` so it is always current |

**Rendering rules.** Templates consume the same CSS custom\-property tokens as the web UI, so a brand change is one edit. Every document carries the legal name, trade licence 930137, Commercial Register number and TRN. Rendered PDFs are written to object storage and the key stored on the record — never re\-rendered on demand for a financial document, because the artefact must be stable even if a template changes. Arabic bilingual output is a **layout variant** of the same template (`INV-14`), not a separate template.

* * *

## 8\. Field application architecture

### 8\.1 Platform decision — reversing the earlier ADR

**Recommendation: React Native (Expo), not a PWA.** The earlier architecture decision selected an offline\-first PWA. The evidence does not support it, and the reasons are specific:

| Blocker | Detail | Consequence |
| --- | --- | --- |
| **Background Sync API unsupported in Safari** | Not supported on iOS or desktop Safari at any version. Also unsupported in Firefox. | A PWA on iOS **cannot** sync after the technician leaves a basement unless they reopen the app. That is the core promise of the product. |
| **Storage eviction, not storage capacity** | WebKit proactively evicts script\-writable storage for origins with no user interaction for roughly seven days. Persistent storage exempts an origin but is granted **heuristically** — home\-screen installation helps, guarantees nothing. | Unsynced job data can vanish over a holiday, silently. |
| **Push requires manual home\-screen install** | iOS 16.4\+ supports web push only for PWAs added via Share → Add to Home Screen, with no automatic prompt. | A real drop\-off point for a non\-technical workforce; dispatch push is a core feature. |
| **No Web NFC, no Web Bluetooth on iOS** | Unavailable to PWAs. | Rules out asset\-tag scanning and instrument integration — both plausible near\-term needs for HVAC and electrical work. |

> **A common counter\-argument is out of date.** "Safari caps web storage at 50 MB" has not been true since iOS 17 — current WebKit policy allows up to roughly 60% of disk per origin, and home\-screen web apps get the same quota as the browser. Capacity is genuinely fine. **Eviction and background sync are the problem, and they are not fixable from application code.**

**What stays PWA:** the dispatcher console (online\-mostly, benefits from zero install), the customer "track my technician" page, and the customer\-facing sign\-off page opened on the customer's own phone. Those are the right shape for the web.

**Cost of the reversal:** one additional build target and app\-store distribution. **Cost of not reversing it:** silent data loss on a technician's phone, which is the one failure this product cannot survive.

This is `OPEN-1` and should be confirmed before Phase 3 begins.

### 8\.2 Bounded working set

The device syncs a **declared, bounded** set — never "everything":

- This technician's jobs for today and tomorrow, plus any job in an open state assigned to them
- Customers and properties referenced by those jobs
- Assets at those properties
- The parts catalogue (whole, but small)
- Fault\-code taxonomy, disposition reasons, PPE and RAMS templates
- The technician's own certifications and their expiry states

Everything else is fetched on demand when online and is explicitly unavailable offline. The screen says so, rather than showing an empty state that looks like "no data".

### 8\.3 Sync — server\-authoritative with a transactional outbox

**Not CRDTs.** Job data is single\-writer in practice — one assigned technician per visit — so the merge machinery buys almost nothing and costs a great deal of comprehension.

```
Local mutation
  ├─ write domain row          ─┐
  └─ write outbox row          ─┴─ same SQLite transaction
                                   (survives the app being killed mid-save)

Outbox row:
  client_id (ULID, generated on device)   ← also the idempotency key
  entity · op · payload
  base_version                            ← optimistic concurrency
  created_at · attempt_count · next_attempt_at
  status(pending|inflight|done|dead)
  depends_on_client_id                    ← ordering

Drain (when online):
  FIFO per aggregate root, dependency-aware
  POST /api/field/v1/mutations  with client_id as Idempotency-Key
  409 on base_version mismatch → conflict resolution (§8.4)
  exponential backoff + jitter, capped
  after N attempts → status = dead, VISIBLE IN THE UI

Pull:
  GET /api/field/v1/sync?cursor=…   delta only, server watermark
```

**Client\-generated IDs are non\-negotiable.** A technician must be able to create a job note offline, attach four photos to it, and reference it, before the server has ever seen it. The server accepts the client ID; the client never waits for a server ID.

**Idempotency keys are non\-negotiable.** The dominant real\-world failure is *request succeeded, response lost, client retries*. Without server\-side deduplication on `client_id` you get duplicate job completions and double\-billed parts.

**Photo uploads reference their job event by client ID and must sync after it.** `depends_on_client_id` expresses that; a completion record must never arrive before the evidence it cites.

### 8\.4 Conflict resolution by data class

This is the table that prevents the whole problem. Most "sync conflicts" in field service are self\-inflicted by modelling events as mutable state.

| Data class | Strategy | Why |
| --- | --- | --- |
| Immutable event facts — arrival, departure, photo, signature | **Append\-only.** No conflict possible. | The biggest single design win available |
| Job status, dispatch assignment | **Server\-authoritative.** Dispatcher wins; client accepts and surfaces the change. | The office reassigned the job while the technician was in a basement. The office is right. |
| Additive collections — materials, notes, photos | **Union by client\-generated ID.** | An or\-set, implementable without a CRDT library |
| Free\-text scalars — job notes body | Last\-write\-wins on server receipt, **with the loser preserved and surfaced** | Never silently discard a technician's typing |
| Counters — hours, quantities | Stored as entries, summed server\-side | Never an absolute overwritten scalar |
| Post\-signature records | **Immutable.** Corrections are new linked amendments. | `FLD-14`. A mutable signed job sheet has no evidential value. |

### 8\.5 Field API surface

```
GET  /api/field/v1/sync?cursor=<watermark>
       → { jobs, customers, properties, assets, parts, taxonomies,
           certifications, next_cursor, server_time }

POST /api/field/v1/mutations
       Idempotency-Key: <client_id>
       → { accepted: [client_id…], conflicts: [{client_id, reason,
                                                server_state}] }

POST /api/field/v1/uploads/init      → presigned, chunked, resumable
POST /api/field/v1/uploads/complete  → triggers scan + EXIF extraction
```

Authentication per `SEC-7`. The API runs the same `withTenant()` scoping as every other path — the field app is a client, not a privileged actor, and its access is bounded by the technician's own row\-level scope. `server_time` in the sync response exists so the device can detect and report clock divergence rather than silently recording a wrong timestamp.

### 8\.6 Media pipeline

```
Capture (in-app only, never the camera roll)
  → extract EXIF: lat, lon, timestamp, orientation → structured columns
  → apply orientation, then STRIP EXIF from the stored image
  → compress: longest edge 1920–2048px, JPEG q≈0.75, target ≤ 1 MB
  → generate local thumbnail (gallery renders instantly, offline)
  → keep the original locally until the compressed copy is confirmed synced
  → queue: Wi-Fi preferred, "upload now over mobile data" always available
  → chunked resumable upload
  → server: virus scan → scan_status; SHA-256; private bucket
  → egress (customer copy, emailed report): EXIF stripped again, verified
```

**Why EXIF is extracted before being stripped:** EXIF is fragile — processing pipelines strip it, resizing alters it, and it is invisible to database queries. The evidential value lives in your columns. **Why it is stripped on egress:** embedded GPS in a domestic job photo leaks the customer's home coordinates to anyone the photo is forwarded to.

A typical phone photo is 4–12 MB; a technician shoots 20–40 per job. Uncompressed that is roughly 300 MB per technician per day on cellular, which is the single most common cause of "the app doesn't work" complaints in this category.

* * *

## 9\. Integrations

| Integration | Direction | Priority | Notes |
| --- | --- | --- | --- |
| **Email (transactional)** | Out | P0 | Single HTTP POST with an idempotency header; no SDK, no SMTP on serverless. Already designed, not activated. |
| **SMS / WhatsApp Business** | Out | P1 | Lead alerts, applicant messaging, technician dispatch. Template pre\-approval is required for WhatsApp — allow lead time. |
| **Error monitoring** | Out | P0 | Server actions and RSC, release\-tagged |
| **Object storage** | Both | P1 | UAE region per `INFRA-1` |
| **Virus scanning** | Out | P1 | Async; `scan_status` gates every download |
| **Peppol ASP (e\-invoicing)** | Both | P2 build / P1 design | PINT AE / UBL 2.1 XML. Inbound matters too — supplier invoices arrive this way. Provider selection is `OPEN-6`. |
| **Google Business Profile** | Both | P2 | `WEB-15`. Hours synchronised from `calendar_rules` so "open at time of search" is true. |
| **Accounting export** | Out | P2 | CSV plus the accountant's preferred import format. `INV-16` |
| **Bank / WPS file** | Out | P3 | The system produces payroll *inputs*; the bank or exchange house generates the SIF |
| **MOHRE / ICP portals** | — | Never | No public API. Document expiry is tracked from manually entered dates, which is why `HR-5` alerting matters so much. |

**Integration principles.** Every outbound integration goes through the ledgered dispatch pattern — enqueue, attempt, classify, retry, dead\-letter — so a third\-party outage degrades rather than loses. No integration is on the critical path of a user\-facing write. Credentials live in the environment store with a documented rotation owner.

* * *

## 10\. Compliance implemented as code

The PRD's §11 is a register of obligations. This is where each one becomes a mechanism. **The distinction that matters: a rule enforced by validation is a rule; a rule written in a policy document is a hope.**

| Obligation | Mechanism | Layer | Failure mode if only documented |
| --- | --- | --- | --- |
| Tax invoice completeness | zod schema on the invoice document model; render refuses on a missing mandatory field | `core` \+ `docs` | Non\-compliant invoices issued for months before an audit finds them |
| 14\-day issuance | Daily cron flags signed\-off jobs un\-invoiced at day 10 | `cron/compliance` | AED 2,500 per instance |
| Sequential numbering | `app_next_reference` atomic counter; a gap\-detection report | `db` | FTA audit flag |
| PINT AE readiness | Mandatory fields present and populated from Phase 1 | `db` \+ `core` | Retrofitting historical invoices in 2027 |
| 7\-year retention | `delete_after` columns; the purge job **skips** financial records | `cron/retention` | Records deleted that a tax audit needs |
| UAE data residency | Deployment constraint, `INFRA-1` | Infrastructure | Records outside the jurisdiction |
| **Work permit validity** | `employee_documents.blocking = true`; assignment query **excludes** technicians with an expired blocking document | `core` assignment logic | **AED 100,000 – 1,000,000 per worker** |
| **Summer midday ban** | `isWorkingTime()` in `core`; the scheduler cannot place an outdoor job in the window | `core` \+ scheduler | AED 5,000 per worker, capped 50,000 |
| Working hours and overtime | Hour accumulation per technician per day and week, checked at assignment | `core` | Labour claim exposure |
| **WPS payment date** | Countdown from T\-5; alarm on the 2nd if unconfirmed; the 85% test computed from `payroll_periods` | `cron/compliance` | Permits suspended at day 5 — hiring stops |
| Work injury 48\-hour report | Timer starts at incident creation; escalating alerts | `cron/compliance` | Statutory breach |
| No recruitment\-cost recovery | Deduction type validation **rejects** visa/recruitment categories | `core` | Statutory prohibition breached |
| Applicant retention | `delete_after` default 6 months from last interaction; automated purge; deletions logged | `cron/retention` | Indefinite retention of personal data |
| Employee retention | 2 years post\-termination minimum; 7 years for payroll and tax | `cron/retention` | Records destroyed too early, or kept too long |
| Certification expiry | Warning at assignment; override requires a reason and is logged | `core` \+ `JOB-10` | Compliance failure discovered after dispatch |
| Company accreditation expiry | Daily sweep with T\-90/60/30/7 alerts; feeds the tender pack | `cron/compliance` | Trade licence 930137 expires 23 Jan 2027 unnoticed |
| Audit trail | Append\-only `audit_log`, UPDATE and DELETE revoked; viewer for auditors | `db` \+ `ADM-7` | Unreconstructable history |

**Three of these are hard blocks, not warnings:** work permit validity, blocking document expiry, and the summer midday ban. Everything else warns. The distinction is deliberate — a system that blocks too much gets worked around, and a workaround is worse than a warning because it is invisible.

* * *

## 11\. Testing and CI

### 11\.1 Continuous integration — the highest\-leverage item in this document

Today: 269 automated checks across 11 suites, integration\-heavy against real Postgres, with negative\-path\-heavy authentication and MFA coverage, RFC vectors for TOTP, an in\-test QR decoder, stub\-server transport tests pinning retry classification, a 12\-check RLS adversarial harness, a 36\-pair contrast gate, and typecheck across six workspaces.

**None of it runs automatically.** Every regression risk in this system is currently human\-shaped.

**`CI-1` — GitHub Actions on every push and pull request:**

```
1. typecheck across all workspaces
2. lint
3. spin up a Postgres service container
4. apply migrations + the six security SQL files, in order
5. seed
6. run all 11 suites
7. run verify-rls.sql              ← the 12-check adversarial harness
8. run check-contrast.mjs          ← 36 pairings, WCAG AA
9. next build                      ← smoke
10. dependency audit               ← fail on known critical
```

Red pull request on any failure. No merge on red. This is roughly one hour of setup and it is worth more than any feature in the backlog.

**`CI-2` — make the tests hermetic.** They currently require a live seeded database and specific environment variables. The service container plus a deterministic seed step solves this; it is work, not research.

### 11\.2 Test strategy by layer

| Layer | Approach | Coverage bar |
| --- | --- | --- |
| `core` domain | Pure unit tests. Money to the fils. State machine legal and illegal transitions. SLA computation across the working calendar including the midday ban, Ramadan and holidays. Entitlement consumption. PINT AE field mapping. | 100% of branches — it has no I/O, there is no excuse |
| `db` | Integration against real Postgres. RLS positive and negative. Reference allocation under concurrency. Trigger behaviour. | Every policy exercised |
| `auth` | Negative\-path heavy. Lockout, decay, reset token single\-use and expiry, MFA replay guard, recovery code normalisation, session rotation. | Every failure path |
| `notify` | Stub transport. Retry classification. Transactional rollback. Suppression. Digest batching. | Every classification branch |
| Server actions | Integration. Authorisation refusal per role. Validation. Audit row written. Notification enqueued in\-transaction. | Every action |
| Field sync | **Simulated offline.** Queue durability across app kill. Idempotent replay. Conflict paths per §8.4. Dependency ordering. Clock divergence. | Every conflict class |
| E2E | Playwright, five journeys: quote → lead; login \+ MFA; lead → job → assign; quote approve in portal; job sign\-off → invoice. **Add:** apply for a job → outcome. | Happy path plus one failure each |
| Accessibility | Contrast gate in CI. **Add** keyboard traversal and screen\-reader audit per release — the audit found this had never been done. | AA |
| Load | k6 against the dispatch board and quote form before the first real tenant week | Baseline recorded |

### 11\.3 Edge cases requiring tests

The audit listed edge cases the implementation handles and cases it misses. These need tests before Phase 1 ships:

- Technician deactivated while holding open visits — **behaviour currently unverified**
- Quote approved after its expiry date — `expired` status exists; **enforcement unverified**
- Session expiry mid\-form — currently loses work silently (`SEC-11`)
- Duplicate lead from a double\-click — currently accepted silently (`LEAD-5`)
- Assignment override with no reason — must now be refused (`JOB-10`)
- Outdoor job scheduled at 13:00 on 1 July — must be **refused** (`JOB-6`)
- Dispatch to a technician whose work permit expired yesterday — must be **refused** (`HR-9`)
- Invoice issued from an un\-signed\-off job — must be structurally impossible (already true; keep the test)
- Field app killed mid\-photo\-upload, restarted a day later — must resume without loss
- Two devices claiming the same job visit — server\-authoritative resolution

* * *

## 12\. Operations

### 12\.1 Environments

| Environment | Purpose | Data |
| --- | --- | --- |
| Local | Development | Seeded synthetic |
| **Staging** *(NEW)* | Pre\-production verification, migration rehearsal, restore drills | Anonymised copy or synthetic |
| Production | Live | Real |

A staging environment does not exist today. Migrations are applied by hand from a laptop as the database owner — the audit rated this medium severity with a bus factor of one, and it is the change most likely to cause an outage during Phase 1.

### 12\.2 Migrations

**`OPS-1`\:** migrations are applied by CI on deploy, in checksummed order, including the six security SQL files, with `verify-rls.sql` run afterward. Never by hand from a laptop. A failed migration fails the deploy.

**`OPS-2`\:** every migration is rehearsed against staging with a production\-shaped dataset before production.

**`OPS-3`\:** every schema change re\-runs the RLS proof harness. A new table without a policy fails the build — the generic policy loop makes this automatic, and the harness verifies it happened.

### 12\.3 Backup and recovery

**`OPS-4`\:** point\-in\-time recovery is enabled and its retention window is **documented and verified**, not assumed. The audit found the retention configuration was unknown.

**`OPS-5`\:** a **restore drill is performed and written up quarterly.** Restore to staging, verify data integrity, record the elapsed time. An untested backup is a hypothesis.

**`OPS-6`\:** object storage is versioned with lifecycle rules matching the retention requirements in §10 — signed job sheets and tax documents are write\-once.

**Targets:** RPO ≤ 5 minutes (PITR). RTO ≤ 4 hours, measured by the drill, not estimated.

### 12\.4 Runbook

**`OPS-7`\:** a written runbook covering, at minimum — restore from PITR; rotate every credential; notification queue stuck; cron missed; database connection exhaustion; deploy rollback; revoke a compromised session or field device; respond to a suspected data breach including the PDPL notification path.

The audit named single\-maintainer bus factor as a high\-severity risk with no contingency. This document set plus CI plus the runbook is the contingency: **CI is executable knowledge.**

### 12\.5 Monitoring and alerting

| Signal | Threshold | Route |
| --- | --- | --- |
| Unhandled server\-action error rate | \> 1% over 5 min | Engineering, immediate |
| Notification queue depth | \> 50, or any item stuck \> 30 min | Engineering |
| Notification terminal failures | Any | Engineering |
| Cron missed | Any expected run absent | Engineering, immediate |
| Authentication lockout rate | \> 5× baseline | Engineering \+ owner |
| Rate limiter degraded (fail\-open) | Any occurrence | Engineering |
| Database connection saturation | \> 80% of budget | Engineering |
| p95 page latency | \> 2 s over 10 min | Engineering |
| Uptime — public site, quote form, portal | Any failure | Engineering \+ owner |
| Field sync — device with no successful sync | \> 4 working hours | Operations manager |
| Field sync — dead\-letter items | Any | Operations manager |
| **WPS transfer unconfirmed on the 2nd** | Any | **Owner, alarm** |
| **Blocking employee document expired** | Any | **HR \+ owner** |

The last two are in a monitoring table rather than a compliance table on purpose: they are production incidents with a financial cost, and they should page someone exactly like an error rate spike does.

* * *

## 13\. Migration and sequencing

### 13\.1 Phase 0 — Stabilise *(days)*

`SEC-1` rotate credentials · `CI-1` GitHub Actions · `CI-2` hermetic tests · `ADM-5` cron routes · `KPI-1` error monitoring · `SEC-2` CSP · `SEC-3` login throttle · `SEC-4` truthful lockout · `SEC-12` security alerting · `OPS-1` CI migrations · orphan cloud resource inventory · `WEB-2` content truth pass.

**Nothing else starts until this is done.** Every item is known work with no research component, and every one of them makes the next phase safer.

### 13\.2 Phase 1 — Operable *(2–4 weeks)*

`INFRA-1` region decision · `SEC-5` `SEC-6` reset and MFA reset · `ADM-1` `ADM-9` `ADM-10` `SEC-11` · `packages/files` and `packages/docs` · `DB-1`…`DB-8` migrations · `QTE-3` `INV-3`…`INV-7` `INV-15` · `LEAD-2` `LEAD-3` notifications · `JOB-5` SLA sweep · `JOB-6` working calendar in `core` · `HR-5` `HR-9` `HR-14` compliance blocking · `POR-8`.

**Exit criterion:** a real operating week — hire, dispatch, invoice, get paid, stay compliant — with **zero SQL**.

### 13\.3 Phase 2 — Complete the business *(4–6 weeks)*

M3 contracts · M9 recruitment · `HR-4` `HR-6` `HR-7` `HR-8` `HR-17` · `POR-3`…`POR-5` · `LEAD-5` `LEAD-8` `LEAD-9` · `KPI-2` `KPI-3` `KPI-5` · `ADM-7` `ADM-12` · staging environment · `OPS-5` first restore drill.

### 13\.4 Phase 3 — Field execution *(6–10 weeks)*

`packages/field` React Native app · field API · sync engine · media pipeline · `JOB-7` schedule view · `JOB-8` availability\-aware assignment · `JOB-13` `JOB-14` · `CON-13` assets · `POR-9`.

**Highest\-risk phase.** Build the sync engine first, with its full simulated\-offline test suite, before any UI. Everything else in the app is straightforward; sync is where field apps fail.

### 13\.5 Phase 4 — Projects and scale

M5 projects · `CON-11` `CON-12` tenders · **`INV-10` ASP integration — hard external deadline: appoint by 31 March 2027, live by 1 July 2027** · `INV-16` `INV-17` · `HR-13` `HR-18` `HR-19` · load baseline · public API if a third party ever needs one.

### 13\.6 Sequencing constraints

```
CI ─────────────────────────────▶ everything else
Credential rotation ────────────▶ everything else
Cron ───────────────────────────▶ SLA alerts · compliance sweeps · PPM generation
packages/files ─────────────────▶ PDFs · CV upload · field photos
Region decision ────────────────▶ first real invoice
Working calendar in core ───────▶ SLA computation · scheduling · field app
Admin surface ──────────────────▶ real users · portal management · field devices
Sync engine ────────────────────▶ every other field-app feature
PINT AE fields in schema ───────▶ ASP integration (design now, integrate later)
```

* * *

## 14\. Technical debt disposition

| ID | Debt | Disposition | Phase |
| --- | --- | --- | --- |
| `TD-1` | Exposed credentials | `SEC-1` rotate | 0 |
| `TD-2` | No CI | `CI-1` | 0 |
| `TD-3` | No error monitoring | `KPI-1` | 0 |
| `TD-4` | No scheduler | `ADM-5` | 0 |
| `TD-5` | Permanent lockout, false copy | `SEC-4` | 0 |
| `TD-6` | No CSP | `SEC-2` | 0 |
| `TD-7` | No login IP throttle | `SEC-3` | 0 |
| `TD-8` | Manual migrations | `OPS-1` `OPS-2` | 0 |
| `TD-9` | Hardcoded tenant identity | `ADM-9` — reclassified as a **correct simplification**, moved to configuration | 1 |
| `TD-10` | Unbounded lists | `LEAD-8` keyset pagination | 2 |
| `TD-11` | 14 unused tables | §6.2 decides each; drop\-if\-unbuilt rule adopted | 2–4 |
| `TD-12` | Fixed 12h session | `SEC-11` sliding renewal | 1 |
| `TD-13` | `failed_login_count` varchar | `DB-1` | 1 |
| `TD-14` | Dead `pdf_storage_key` | `DB-2` — populated by `QTE-3` `INV-3` | 1 |
| `TD-15` | Duplicated form styles across \~6 route components | Shared form kit, Design Document §7 | 2 |
| `TD-16` | Orphan cloud resources | Inventory and remove | 0 |
| `TD-17` | Non\-hermetic tests | `CI-2` service container \+ seed | 0 |

* * *

## 15\. Architectural decisions requiring a new record

These supersede or add to the existing decision records and should each be written up as one:

| \# | Decision | Supersedes |
| --- | --- | --- |
| `ADR-0006` | Single\-company internal system; multi\-tenant RLS retained as defence in depth, not as product architecture | Resolves the audit's §22 fork |
| `ADR-0007` | Field app is React Native, not a PWA — iOS Safari lacks Background Sync at every version and evicts unsynced storage after \~7 days without interaction | Supersedes the offline\-mobile ADR |
| `ADR-0008` | Deployment region moves to the UAE (or a UAE\-resident tax\-record archive is added) to satisfy the in\-country retention requirement | New |
| `ADR-0009` | Invoice model built against PINT AE / UBL 2.1 from Phase 1; ASP integration deferred to Phase 4 against a 1 July 2027 deadline | New |
| `ADR-0010` | Working calendar (midday ban, Ramadan, holidays, statutory hours) is a pure `core` service consumed by scheduling, SLA and the field app — one implementation, three consumers | New |
| `ADR-0011` | Field sync is server\-authoritative with a transactional outbox and append\-only events; no CRDTs | New |
| `ADR-0012` | Compliance rules that carry a statutory penalty are hard blocks in the domain layer, not UI warnings | New |

* * *

## 16\. What good looks like

A concrete acceptance picture for the end of Phase 1, written so it can be demonstrated rather than argued about:

> A new coordinator is invited by email, sets a password, enrols MFA, locks herself out, recovers via a reset link, and is unlocked by an administrator — **without anyone opening a database client**.
> 
> A quote\-form submission at 21:40 creates a lead, emails the operations manager within two minutes, and appears at the top of the triage queue flagged as an emergency.
> 
> She converts it. The system refuses to assign the technician whose work permit expired last week, and says why. She assigns another, overriding an expiring\-certification warning and typing a reason, which is logged.
> 
> It is 3 July. She tries to schedule an outdoor visit for 13:15. The system refuses, names the rule, and offers 15:15.
> 
> The job completes and is signed off. The invoice prefills from the approved quote and renders as a PDF carrying the words "Tax Invoice", the TRN, trade licence 930137, the Commercial Register number, a gapless sequential number, the date of supply, per\-line AED amounts, 5% VAT applied after discount, and a total that is correct to the fils.
> 
> The accountant reads it and finds nothing to object to.
> 
> Nine days later, an un\-invoiced signed\-off job triggers a day\-10 warning before the 14\-day statutory window closes.
> 
> On 27 August the owner gets a WPS countdown. On the 1st the transfer is confirmed. Nothing escalates.
> 
> Every one of those steps is covered by a test that runs on every push.
