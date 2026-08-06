# Roadmap

Five phases. Phases 1 and 2 are complete and verified. Everything after that is designed and
sequenced, not built.

The ordering principle: **each phase must be independently valuable.** If work stops after any phase,
what exists is still worth having. That is why the public website came first — it generates enquiries
on its own, without any of the platform behind it.

---

## Phase 1 — Foundation and public website ✅ COMPLETE

**Delivered:**

- 24-service catalogue as the shared source of truth ([ADR 0002](../adr/0002-catalogue-as-source-of-truth.md))
- Public website: 60 routes, statically prerendered, AEO/GEO optimised
- 19 area landing pages with area-specific content (not 456 thin service×area combinations — see
  [the AEO playbook](06-aeo-geo.md) for why)
- JSON-LD graph, `llms.txt`, sitemap, AI-crawler-permissive robots
- Quote request form with shared server-side validation
- Privacy, terms and careers pages; custom 404 routing to the emergency line
- Multi-tenant Postgres schema: 31 tables, forced RLS, audit triggers
- Design system with a WCAG contrast gate in CI

**Verified:** typecheck clean across three workspaces; 37 routes build; 36/36 contrast pairings pass
AA; 10/10 RLS isolation checks pass against PostgreSQL 16; JSON-LD parsed and validated on four
pages; quote form submission and validation-failure paths both confirmed in a browser.

**Business value on its own:** the site generates enquiries by phone, WhatsApp and form. That works
today with no platform behind it.

---

## Phase 2 — Operational core ✅ COMPLETE

**Goal:** replace the whiteboard. This is the phase that changes how the business runs.

| Deliverable | Stories | State |
| --- | --- | --- |
| Auth: Argon2id, revocable sessions, RBAC across 10 roles | — | ✅ Built and verified |
| `SECURITY DEFINER` authentication surface (RLS bootstrap) | — | ✅ Built and verified |
| Job lifecycle: status graph, transitions, event log | OPS-1 | ✅ Built |
| SLA clocks and breach/at-risk computation | OPS-3 | ✅ Built |
| Dispatch board: open jobs by priority and SLA risk | OPS-1, OPS-3 | ✅ Built on real data |
| Seed data across statuses and SLA states | — | ✅ Built |
| Jobs list, job detail, status-change UI | OPS-4 | ✅ Built on real data |
| Assignment with skill, certification, leave and load checks | OPS-2, OPS-4 | ✅ Built and verified |
| Website quote form creating real leads | — | ✅ Built and verified |
| Lead triage queue and conversion to customer + property + job | — | ✅ Built and verified |
| MFA: TOTP, recovery codes, replay guard, login challenge | — | ✅ Built and verified |
| Customer portal: see jobs, approve/decline quotes, see invoices | CUST-2, CUST-4, CUST-7 | ✅ Built and verified |
| Quotes, invoices, payments, AR ageing | ACC-1, ACC-3, ACC-4 | ✅ Built and verified |
| Notifications: queue, templates, retry, pluggable transport | OPS-4, CUST-2 | ✅ Built and verified — **console transport only, no provider wired** |
| Portal: raise a new request | CUST-1 | ✅ Built and verified |
| Technicians admin: roster, skills, certifications, coverage | — | ✅ Built and verified |
| Customers admin: accounts, terms, contacts, properties, AR position | — | ✅ Built and verified |

**Note on MFA.** TOTP is implemented against the RFC 6238 test vectors, with a replay guard that
refuses a code within the step it was already used in, single-use recovery codes, and a login
challenge that is a separate short-lived token rather than a half-built session. Enrolment is two
steps — scan, then prove with a live code — so an account is never left requiring a factor its owner
cannot produce. See [the security model](03-security.md#second-factor).

**Note on notifications.** The pipeline is real: messages are queued inside the transaction that
caused them, claimed with `FOR UPDATE SKIP LOCKED`, retried on transient failure and abandoned after
five attempts. What is *not* real is delivery — the only transport is `ConsoleTransport`, which
stamps a `console:` provider id and prints. Wiring a provider is a one-file change, and until it is
done nothing actually reaches a customer.

**Sequencing note:** auth first, because every other item depends on knowing who is asking. The
dispatch board before the customer portal, because internal adoption has to precede exposing anything
to customers.

**Exit criterion:** the operations manager can run a full day without the whiteboard. **Met**, with the caveat that notifications print rather than send until a provider is wired.

---

## Phase 3 — Field execution

**Goal:** close the loop. Until technicians record work digitally, every report is built on data
entered by someone who was not there.

| Deliverable | Stories |
| --- | --- |
| Expo mobile app with offline-first sync ([ADR 0004](../adr/0004-offline-first-mobile.md)) | TECH-1, TECH-3 |
| Digital job card: fault, work done, photos, signature | TECH-3, TECH-4, TECH-5 |
| GPS tracking and geofenced check-in/out | TECH-8 |
| Live technician tracking for customers | CUST-3, EMG-5 |
| Materials capture | TECH-6 |
| Contract PPM job generation from `contract_visits` | — |
| Monthly reporting pack for property managers | CUST-5 |
| CMS for blog and case studies; Arabic locale with RTL | — |

**Exit criterion:** every completed job has photos and a signature attached, captured on site.

---

## Phase 4 — AI layer

**Goal:** remove work, not add features. Deliberately fourth: every capability below needs a corpus
of real records to be evaluated against, and that corpus only exists after phase 3.

Model selection, tiering and guardrails: [ADR 0005](../adr/0005-ai-model-tiering.md).

| Deliverable | Why it needs phases 2–3 first |
| --- | --- |
| AI triage: suggest trade, priority, duration | Needs historical jobs to evaluate against |
| AI quote drafting from fault description and history | Needs a quote corpus |
| AI report summarisation for customer-facing text | Needs technician notes from the field |
| AI receptionist for out-of-hours calls | Needs the job creation API to be reliable first |
| Dispatch optimisation — **deterministic scoring, not an LLM** | Needs GPS and duration data |
| Preventive maintenance forecasting from asset history | Needs an asset service history |
| Contract analysis: extract obligations and risk flags | Standalone; could move earlier if valuable |

**Exit criterion:** measurable reduction in dispatcher and quoting time, evidenced by
`ai_interactions.accepted_by_human` and cost per job.

---

## Phase 5 — Scale and commercial

| Deliverable | Notes |
| --- | --- |
| Payment gateway integration | Region-specific |
| Payroll and commission | Country-specific labour rules; needs specialist input |
| Executive dashboard | MD-1 through MD-5 |
| Multi-city, multi-currency | FX rate table; see the data model's known gaps |
| Tenant onboarding and billing | Only if the SaaS reading of the brief is confirmed — see [assumptions](../product/00-assumptions.md) |

---

## What is deliberately not planned

Being explicit about non-goals is as useful as the roadmap.

- **A full inventory and stock system.** `job_materials` records consumption. Real stock control is a
  different product; integrate with an existing one if it is needed.
- **An accounting system.** Invoices and payments are recorded and exported. Do not rebuild
  QuickBooks or Xero.
- **A general-purpose CRM.** The CRM here is scoped to maintenance: customers, properties, assets,
  contracts. It is not a sales platform.
- **AI-driven dispatch as the first automation.** Deterministic scoring first, measured against the
  dispatcher, before anything learned. `job_visits.assignment_method` exists precisely to enable that
  comparison.

## Honest risk register

| Risk | Mitigation |
| --- | --- |
| Phase 2 is large and the temptation is to ship it half-done | Shipped whole and verified end to end. The one thing that is *not* real is message delivery, and that is stated everywhere it could mislead rather than left to be discovered |
| Technicians reject the mobile app | Involve them in phase 3 design; the app must be faster than paper on day one, not eventually |
| AI cost scales with job volume and erodes margin | `ai_interactions.cost_micros`, per-tenant alerting shipped *with* phase 4 |
| Placeholder company data reaches production | On the [launch checklist](../ops/03-launch-checklist.md) as a blocker |
| RLS regression on a new table | `verify-rls.sql` check 9 in CI on every migration |
