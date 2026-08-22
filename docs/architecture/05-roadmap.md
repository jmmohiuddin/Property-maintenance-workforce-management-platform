# Roadmap

Five phases. Phases 1 and 2 are complete and verified. Phase 3 is split down the middle in a way a
single status word cannot honestly convey: the offline sync engine, the server-side completion gate
and PPM job generation are built, tested and reachable from a real cron or a real device. The
technician-facing half of the field app — the screens that would let someone actually record a photo,
a part, an outcome or a signature on their phone — is not. It has never been rendered, is excluded
from the CI typecheck gate, and every one of its data-entry controls is either disabled or an explicit
"not built yet" stub, by the app's own admission. Phase 4 is mostly still ahead of us, except that its
highest-risk row, deterministic dispatch scoring, shipped two phases early as part of Phase 2's
assignment engine. Phase 5 remains designed and sequenced rather than built, except that its
executive-dashboard row also shipped early, during Phase 3-era work, and is itself partial. The
per-row detail is below; the short version is that this platform is further along than "phase 3 in
progress" suggests in its backend and further behind than "phase 3 done" would suggest in the one
place a technician would actually touch it.

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
| Notifications: queue, templates, retry, pluggable transport | OPS-4, CUST-2 | ✅ Built and verified — **email now has a real provider; SMS and WhatsApp do not** |
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
five attempts. Delivery is no longer entirely fictional either: `ResendTransport`
(`packages/notify/src/email.ts:35`) is a genuine HTTP-based email provider, tested at
`packages/notify/test/email.test.ts`, and `selectTransport()` (`email.ts:157`) picks it automatically
whenever `RESEND_API_KEY` and `NOTIFY_FROM` are set in the environment — it is wired into every real
send path, including `api/cron/dispatch/route.ts:28`, the recruitment cron, and the customer, admin,
forgot-password and quote server actions. Falling back to `ConsoleTransport` when those variables are
absent is deliberate and loud: `selectTransport` logs "NOTHING WILL REACH A CUSTOMER" rather than
failing silently. What is still not real is every channel besides email — `ResendTransport.name` is
`"resend"` and it only claims the `email` channel (`Channel` at `transport.ts:25` also lists `sms`,
`whatsapp`, `push` and `in_app`); an SMS or WhatsApp notification still prints to the console today,
whatever the environment.

**Note on the assignment engine.** `findCandidates` (`packages/db/src/domain/assignment.ts:548`) ranks
technicians by skill match, certification validity, availability and distance, and is deliberately not
an LLM — see the module's own header at `assignment.ts:22`. That deterministic-scoring engine is what
Phase 4 lists as "dispatch optimisation." It shipped here, in Phase 2, two phases ahead of where the
roadmap places it — see the note under Phase 4.

**Sequencing note:** auth first, because every other item depends on knowing who is asking. The
dispatch board before the customer portal, because internal adoption has to precede exposing anything
to customers.

**Exit criterion:** the operations manager can run a full day without the whiteboard. **Met.** Email
notifications reach a real inbox when the provider is configured; SMS and WhatsApp still print to the
console until a provider is wired for those channels too.

---

## Phase 3 — Field execution

**Goal:** close the loop. Until technicians record work digitally, every report is built on data
entered by someone who was not there.

**Status:** the backend half of this phase — sync protocol, device auth, conflict resolution, the
completion gate and PPM generation — is built and tested. The technician-facing mobile UI that would
exercise it in the field is not: it renders nothing yet, and its capture controls are stubs. Three
further rows are customer- and growth-facing extras that were never started.

| Deliverable | Stories | State |
| --- | --- | --- |
| Expo mobile app with offline-first sync ([ADR 0004](../adr/0004-offline-first-mobile.md), confirmed by [ADR 0009](../adr/0009-field-app-platform-confirmed.md)) | TECH-1, TECH-3 | 🟡 Partial. The sync engine is built and verified — `apps/field/src/sync/`, 14 test files (~2,600 lines) covering sync, conflicts, the outbox, clock skew and device auth. Server side: `apps/web/src/app/api/field/v1/{sync,mutations,devices/register}/route.ts` call `pullWorkingSet` (`field.ts:661`), `applyFieldMutations` (`field.ts:1918`) and `registerFieldDevice` (`field.ts:257`). The UI that would run on a technician's phone is a different matter: `App.tsx`'s own header states "**NOT TYPECHECKED BY THE ROOT GATE, AND NEVER RENDERED**... no part of this UI has been run, laid out or looked at." See the note below the table. |
| Digital job card: fault, work done, photos, signature | TECH-3, TECH-4, TECH-5 | 🟡 Partial, and the split is by *side*, not by field. The domain layer is real: `recordJobAttachment` (`jobcard.ts:634`), `recordJobMaterial` (`jobcard.ts:716`), `recordJobOutcome` (`outcomes.ts`), `recordJobSignature` (`jobcard.ts:1020`), gated by `assertJobCardComplete` (`jobcard.ts:563`) from both the web transition path (`jobs.ts:94`, `outcomes.ts:272`) and the field sync path (`field.ts:1564`), tested in `packages/db/test/jobcard.test.ts` and `apps/field/test/jobcard.test.ts`. The **web** side of this is genuinely usable today — an operator (or a customer handed a device) can attach photos, log materials, record an outcome and capture a hashed, sealed signature from `/jobs/[id]` (`sealJobSheet`, `packages/docs/src/job-sheet-seal.ts:409`, tested in `packages/docs/test/job-sheet-seal.test.ts`). The **mobile app's own screen** cannot do any of this yet: in `JobCardScreen.tsx`, "Fault codes", "Take a photo", "Scan or add a part", "Record that you used no parts" and "Choose what happened" are all `Stub` controls that show "not built yet in this version" (`JobCardScreen.tsx:247,267,281,283,312`); `SignatureScreen`'s save button is hard-`disabled` and its "nobody available to sign" fallback is commented "not wired up in this build" (`SignatureScreen.tsx`). A technician handed this app today cannot record a single field on a job card through it. |
| GPS tracking and geofenced check-in/out | TECH-8 | 🟡 Partial, and closer to not built in practice. `recordFieldAttendance` (`field.ts:1816`) will accept and store lat/lng and `withinGeofence` on a clock event, tested at `packages/db/test/field.test.ts:856-893`, and the sync protocol has an `attendance/append` mutation type (`protocol.ts:119`). But nothing produces one: there is no clock-in/out control anywhere in `JobCardScreen.tsx` or `JobListScreen.tsx`, `expo-location` is a declared dependency (`apps/field/package.json:24`) that no file imports, and the app's own transparency screen says it outright — "Location capture is not built in this version. Nothing is being recorded." (`SyncStatusScreen.tsx`). A tested write path with nothing upstream of it to call it is not the same thing as the feature. |
| Live technician tracking for customers | CUST-3, EMG-5 | ❌ Not built. `technician_locations` (`packages/db/src/schema/workforce.ts:199`), the table this needs, has no writer anywhere in the codebase — confirmed by a full-repo grep, and consistent with the row above: there is no location capture yet to feed it. The only code that touches it is a nightly purge, `purgeLocationTraces` (`retention.ts:273`), deleting rows that nothing has ever inserted. No customer-facing tracking page exists in the portal or anywhere else. The marketing site already promises this by name — "you get the technician's name and a live tracking link by SMS" (`(marketing)/page.tsx:68`, repeated at `:242`) — which is a sold feature with nothing behind it. |
| Materials capture | TECH-6 | 🟡 Partial, same split as the job card. `recordJobMaterial` (`jobcard.ts:716`) and `declareNoMaterials` (`jobcard.ts:816`) are real and tested (`jobcard.test.ts`, `job-materials-source.test.ts`, `apps/field/test/jobcard.test.ts`), and reachable from the web job-card panel. The field sync handlers `job_material/append` and `job_material/declare_none` (`field.ts:1501-1539`) exist and are tested at the mutation-application layer — but `JobCardScreen`'s "Scan or add a part" and "Record that you used no parts" controls are both stubs (`JobCardScreen.tsx:281,283`), so nothing on the device ever produces that mutation today. |
| Contract PPM job generation from `contract_visits` | — | ✅ Built and verified — `materialisePpmJobs`, `reconcileContractVisits` and `expireEndedContracts` (`contracts.ts:551` and neighbours), run every morning at 05:30 Dubai time by `apps/web/src/app/api/cron/contracts/route.ts` (scheduled in `vercel.json`). Tested in `packages/db/test/contracts.test.ts`. |
| Monthly reporting pack for property managers | CUST-5 | ❌ Not built. No domain function produces anything customer-facing on a schedule — the only periodic reports that exist are internal: the owner dashboard (`KPI-3`) and the weekly owner digest (`KPI-5`), both addressed to the business, not the customer. "Monthly reporting pack" exists only as sales copy on the contracts marketing page (`(marketing)/contracts/page.tsx:71`) — another sold promise with nothing behind it. |
| CMS for blog and case studies; Arabic locale with RTL | — | ❌ Not built. No blog or case-studies route exists under `(marketing)/`; no locale switching or RTL layout exists anywhere in the web app. The single Arabic-related finding in the codebase is an acknowledged gap in a different feature: invoice PDFs silently substitute `?` for characters the embedded font cannot set, including Arabic, and log a warning pointing at `INV-14` (`(app)/invoices/[id]/document/route.ts:68-69`) — a font limitation on a tax document, not the site-wide locale feature this row describes. |

**Note on what "built" means for the field app.** `apps/field` is two things wearing one directory
name. The sync engine — down-sync of a bounded working set, up-sync of mutations, conflict rules,
clock-skew correction, device auth, the outbox — is real, exercised by fourteen test files, and is the
harder half of ADR 0004's design by the ADR's own account. The four screens that would put that engine
in front of a technician are a different project at a different stage: `App.tsx` states plainly that
none of `apps/field/src/app/**` has been typechecked by the root gate or rendered even once, and inside
it, every control that would capture a fault code, a photo, a part, an outcome, a signature or an
attendance event is either absent or an explicit stub. This is not a matter of interpretation — the
app tells the technician so itself, on its own sync-status screen ("What is not built yet"). Treat the
sync engine as delivered infrastructure and the UI as not started; conflating them is exactly the kind
of claim this document exists to stop making.

**Exit criterion:** every completed job has photos and a signature attached, captured on site.
**Not met, in the sense the phase was built for.** `assertJobCardComplete` does refuse a completion
missing an after-photo, materials or labour, identically from the web and from a synced device — that
part of the gate is real. Signature is deliberately *not* one of its four conditions (`jobcard.ts:1009`
says so directly, so that a technician with nobody on site to sign can still close a job), so "photos
and a signature attached" was never a hard gate even on paper. In practice, the whole promise —
captured on site, offline, by the technician who did the work — is not achievable today: the only
working capture surface is the web job-sheet flow at `/jobs/[id]`, which needs connectivity and is
normally operated by an office user, not a technician in a basement with no signal. That is the
condition ADR 0004 exists to serve, and it is the piece not yet built.

---

## Phase 4 — AI layer

**Goal:** remove work, not add features. Deliberately fourth: every capability below needs a corpus
of real records to be evaluated against, and that corpus only exists after phase 3.

Model selection, tiering and guardrails: [ADR 0005](../adr/0005-ai-model-tiering.md).

| Deliverable | Why it needs phases 2–3 first | State |
| --- | --- | --- |
| AI triage: suggest trade, priority, duration | Needs historical jobs to evaluate against | ❌ Not built — no triage or trade-suggestion function exists. |
| AI quote drafting from fault description and history | Needs a quote corpus | ❌ Not built. |
| AI report summarisation for customer-facing text | Needs technician notes from the field | 🟡 Partial — the consuming half exists, the generating half does not. `job_reports.ai_summary` and `ai_summary_approved_by_id` (`operations.ts:190-191`) are read by the portal (`portal.ts:532`, `:630`) to decide what a customer sees, gated on human approval exactly as designed. Nothing anywhere writes `ai_summary` — it is a correctly-guarded reader with no producer. |
| AI receptionist for out-of-hours calls | Needs the job creation API to be reliable first | ❌ Not built — the only trace is the string `"ai_receptionist"` sitting unused as a schema constant (`_shared.ts:77`). |
| Dispatch optimisation — **deterministic scoring, not an LLM** | Needs GPS and duration data | ✅ Already built — as part of Phase 2, not this phase. See the note under Phase 2. This row can be struck; it shipped two phases early. |
| Preventive maintenance forecasting from asset history | Needs an asset service history | ❌ Not built. |
| Contract analysis: extract obligations and risk flags | Standalone; could move earlier if valuable | ❌ Not built. |

**Exit criterion:** measurable reduction in dispatcher and quoting time, evidenced by
`ai_interactions.accepted_by_human` and cost per job. **Not currently measurable.** The table
(`packages/db/src/schema/audit.ts:41`) is fully built — `capability`, `model`, `cost_micros`,
`accepted_by_human`, indexed by tenant and by subject — but nothing in the codebase inserts a row into
it. The metric this phase will be judged on is unpopulated by construction until the first capability
above ships with a write to this table as part of it, not after.

---

## Phase 5 — Scale and commercial

| Deliverable | Notes | State |
| --- | --- | --- |
| Payment gateway integration | Region-specific | ❌ Not built — no gateway integration exists (checked for Stripe, Telr, PayFort and a generic name). Payments are recorded once made; nothing in this codebase collects one. |
| Payroll and commission | Country-specific labour rules; needs specialist input | ❌ Not built, and the code says so about itself: a WPS payroll countdown metric is listed as waiting on the HR stream "because there is no payroll calendar table" (`reporting.ts:707-708`). |
| Executive dashboard | MD-1 through MD-5 | 🟡 Partial, and delivered early under a different name. The owner dashboard (`KPI-3` in the current spec, which supersedes the older `MD-1`…`MD-5` framing) is live at `apps/web/src/app/(app)/reports/page.tsx`, in the nav, backed by `ownerDashboard()` (`reporting.ts:626`, tested in `reporting.test.ts`). `MD-2` (contracts expiring within the horizon) and `MD-4` (overdue invoices, via AR ageing) are genuinely covered. `MD-1` is only partly covered: `RevenuePosition` (`reporting.ts:429`) has this-month, last-month, year-to-date and trailing-90-day totals, but no margin figure and no breakdown by service line or by month exists anywhere in the file — MD-1 asks for all three and the dashboard gives a currency total. `MD-3` (technician utilisation, first-time-fix rate) and `MD-5` (at-risk customers) are not covered at all — `DASHBOARD_GAPS` (`packages/core/src/reporting.ts:704`) names first-time-fix and contract-renewal rate as explicitly unsourced, and no customer-churn signal exists anywhere in the domain layer. |
| Multi-city, multi-currency | FX rate table; see the data model's known gaps | ❌ Not built, and already honestly documented elsewhere: "No multi-currency FX. Each row carries a currency but there is no rate table." (`docs/architecture/02-data-model.md:147`). Still true. |
| Tenant onboarding and billing | Only if the SaaS reading of the brief is confirmed | ❌ Not built. The only code path that creates a tenant row is the seed script (`seed.ts:267`) — no signup or onboarding flow exists. This remains correctly conditional, not stale: `docs/product/00-assumptions.md:23-26` states plainly that the company is the operator here, not a SaaS vendor. |

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
  dispatcher, before anything learned. That scoring function is now built (`assignment.ts`) and is
  what any future dispatch-optimisation work would be measured against.

## Honest risk register

| Risk | Mitigation |
| --- | --- |
| Phase 2 is large and the temptation is to ship it half-done | Shipped whole and verified end to end. The one thing that is *not* real is message delivery, and that is stated everywhere it could mislead rather than left to be discovered |
| Technicians reject the mobile app | Too early to be the live risk — the sync engine a pilot would depend on is built and tested, but the screens a technician would actually use are stubs that have never been rendered (see the note under Phase 3). The current risk is narrower and earlier: finish the four capture screens before scheduling a trial, not after. |
| A document describes UI capability the codebase doesn't have | This is the sixth instance of that defect in this repository (ADR 0009 names the first four; `apps/field/src/domain/signature.ts:28-29` names its own fifth — a stale comment about the signature flow, corrected in place by the same engineer who wrote it). It keeps recurring because "the domain function exists and is tested" reads as "built" unless someone separately checks for a live caller — and for a mobile screen, checks whether the screen has ever been rendered at all. Treat "built" claims about `apps/field` as backend-only until a device has run the UI. |
| Sales copy promises features the platform doesn't have yet | The homepage and the contracts page already promise live technician tracking and a monthly reporting pack (see Phase 3). Either build these before the next customer tests the claim, or amend the copy — a promise a support call disproves costs more than a shorter page. |
| AI cost scales with job volume and erodes margin | `ai_interactions.cost_micros` and the per-tenant index exist (`audit.ts:41`) but the table is empty — nothing writes to it yet. The mitigation is defined, not yet load-bearing; per-tenant cost alerting has to land with the *first* AI capability's write path, not be retrofitted after several ship without one. |
| Placeholder company data reaches production | On the [launch checklist](../ops/03-launch-checklist.md) as a blocker — invented legal identity and licence numbers, fabricated statistics, unreviewed prices and stock photography are each listed by name. |
| RLS regression on a new table | `verify-rls.sql` runs in CI on every migration, in the "Prove tenant isolation" step of `.github/workflows/ci.yml`. |
