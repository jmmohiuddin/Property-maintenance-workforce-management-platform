# Part 4 — Audit & Forward Plan

Deliverable sections 22–31: current vs ideal state, product debt, technical debt, risk
register, requirement traceability, product backlog, development roadmap, recommended
improvements, process retrospective, final executive assessment.

---

## 22. Current state vs ideal state

The strategic fork first, because it reprices every row below:

> **DECISION REQUIRED (owner-level):** Is Meridian (A) an internal tool for one FM company, or
> (B) a multi-tenant SaaS?
> The database, RLS design, and two-tenant seed were built for (B). The hardcoded brand/legal
> identity (`packages/core/src/tenant.ts`), single marketing site, and absence of any tenant
> provisioning were built for (A). Both halves are individually good; together they are a
> **CONTRADICTION** that costs money whichever way it resolves: (A) means the RLS machinery is
> insurance, not product; (B) means tenant onboarding, branding-from-DB, and billing become the
> roadmap's spine. Everything below assumes the answer arrives during Phase 0.

| Area | What currently exists | What should exist | Gap | Priority |
| --- | --- | --- | --- | --- |
| Product definition | Master prompt + ADRs + this reconstructed doc set | Confirmed owner, market validation, business model | No human has validated market, pricing, or personas | **P0 (decision), cheap** |
| UX | Coherent, honest, consequence-ordered screens; accessible feedback patterns | Same + onboarding, loading states, search, session-expiry protection | Polish and findability, not rework | P2 |
| Frontend | RSC-first, typed, token-themed, contrast-gated | Same + CSP nonces, skeletons, shared form kit | Small | P1–P2 |
| Backend | Domain layer in packages, server actions, state machines, transactional integrity | Same + scheduled work (cron), admin surface, public API later | **No background execution at all** | **P0** |
| Database | 33-table schema, forced RLS + proof harness, atomic counters, audit log | Same + applied-migration discipline in CI; prune-or-build unused tables per phase | Strong core; process gap | P1 |
| Security | See Part 3 §18 — above-norm foundations | + CSP, reset/unlock, login IP throttle, monitoring, rotated credentials | Operational, not architectural | **P0–P1** |
| Testing | 269 integration-heavy checks, RLS harness, contrast gate | + CI on every push, E2E journeys, load baseline | **Tests exist; nothing runs them automatically** | **P0** |
| Performance | Static marketing; co-located compute/DB; bounded queries mostly | + measurement (RUM/APM), pagination, cold-start awareness | Unmeasured ≠ fast | P2 |
| Documentation | ADRs, architecture docs, launch checklist, this master set | Keep current; single source of truth = this set | Now adequate; maintain | P2 (hygiene) |
| Operations | Manual everything (deploy by CLI, migrations by hand, no alerts) | CI/CD, cron, monitoring, backup drill, runbook | **The biggest overall gap** | **P0** |
| Business readiness | Fabricated stats/licences/insurance on a public site | True content, legal review (privacy/terms/UAE VAT), real domain | Publishing fabricated compliance claims is a legal exposure, not a nice-to-have | **P0 before any real traffic** |

## 23. Product debt register

| # | Debt | Why it happened | Impact | Priority |
| --- | --- | --- | --- | --- |
| PD-1 | No admin surface (users, tenants, unlock, MFA reset) | Build optimised for demonstrable end-user flows | Cannot run a real tenant without SQL; every HR event is an engineering ticket | **P1 (the MVP-completion definition)** |
| PD-2 | No password reset | Same | Lockouts become outages; "contact your administrator" points at nobody | P1 |
| PD-3 | Nobody notified of new leads or SLA breaches | Notification templates built around commerce events first | The two KPIs the product exists to improve are unwatched | P1 |
| PD-4 | No invoice/quote PDF, no UAE VAT invoice fields (TRN) | Deferred; `pdf_storage_key` column anticipates it | Real customers cannot pay through AP processes; VAT compliance unverified (**UNKNOWN — needs UAE tax confirmation**) | P1 |
| PD-5 | Fabricated marketing statistics, licence and insurance claims | Placeholder content written for realism | Legal/reputational exposure if launched | **P0 content pass** |
| PD-6 | Owner persona unserved (no KPI view) | Ops flows prioritised | The buyer sees no weekly value | P2 |
| PD-7 | No onboarding/empty-tenant experience | Seed data always present during dev | First real tenant meets blank screens with no guidance | P2 |
| PD-8 | Portal lacks invoices, request history, customer notifications | Thin-slice portal | "Stop calling us" promise half-kept | P2 |
| PD-9 | Contracts/PPM invisible (schema only) | Phase bet | "Contract workforce management" is in the product's name and absent from its UI | P2/P3 |
| PD-10 | Technician has no interface at all | Phase 3 by design (ADR-0004) | Half the workforce value proposition is future tense | P3 (by decision, not neglect) |
| PD-11 | Silent duplicate leads; silent assignment-warning overrides | Edge cases unowned | Data quality + compliance blind spots | P2 |
| PD-12 | English-only | Market assumption | Arabic likely matters for tenants' customers (**UNKNOWN**) | P3 |

## 24. Technical debt register

| # | Debt | Location | Impact / risk | Severity | Fix complexity |
| --- | --- | --- | --- | --- | --- |
| TD-1 | Exposed owner credentials in build conversation (incl. one unrelated production DB) | operational | Full data compromise if transcript leaks | **Critical until rotated** | Trivial (rotate in Neon) |
| TD-2 | No CI | repo | Any regression ships silently; RLS harness only run by hand | **High** | Low (1 workflow + PG service) |
| TD-3 | No error monitoring / alerting | app | Production failures invisible; security events unwatched | **High** | Low (Sentry + 3 alerts) |
| TD-4 | No scheduler: `dispatchPending` piggy-backed on 2 user actions; `sweepRateLimits` never runs; no SLA sweep | notify/db | Retryable notifications strand until unrelated user activity; tables grow; SLA alarm impossible | **High** | Low (vercel.json crons + 1 route) |
| TD-5 | Permanent lockout + "temporarily" copy; no unlock path | auth/login | Availability failure with false UI promise (CONTRADICTION) | High | Low |
| TD-6 | No CSP | next.config | One XSS = session-adjacent compromise; currently only React escaping between you and it | High | Medium (nonce plumbing for JSON-LD) |
| TD-7 | No login IP throttle | auth | Credential stuffing across accounts unthrottled | Medium-High | Low (reuse `app_public_rate_limit`) |
| TD-8 | Migrations applied by hand from a laptop as DB owner | ops | Drift risk; bus factor 1; no audit of what ran where | Medium | Low-Medium |
| TD-9 | Hardcoded tenant identity vs multi-tenant DB | core/tenant.ts | The strategic contradiction (§22) manifested in code | Medium (High if SaaS) | Medium |
| TD-10 | Unbounded customers list; caps-not-pagination elsewhere | domain | Degrades with growth; full-table renders | Medium | Medium |
| TD-11 | 14+ unused tables carried as untested claims | schema | Migration weight; false confidence in future shapes | Medium | Low (register + revalidate per phase) |
| TD-12 | Session fixed 12h TTL; mid-form expiry loses work | auth/UX | Data loss annoyance; shift-length mismatch | Medium | Medium |
| TD-13 | `failed_login_count` stored as varchar(8) with cast arithmetic | schema/auth fn | Works; weird; invites an off-by-type bug later | Low | Low (migrate to int) |
| TD-14 | `invoices.pdf_storage_key` dead column; no storage layer exists | schema | Misleads readers into thinking PDFs exist | Low | Rolls into PD-4 |
| TD-15 | Duplicated form styles/panel scaffolding across ~6 route components | web | Drift between screens | Low | Low |
| TD-16 | Orphan/duplicate Neon marketplace resources from provisioning attempts (**UNKNOWN which remain**) | Vercel/Neon | Cost noise, confusion | Low | Trivial (inventory + remove) |
| TD-17 | Tests require live seeded Postgres + specific env; not hermetic | test harness | CI needs a service container + seed step (solvable, just work) | Low | Medium |

## 25. Risk register

| Risk | P | I | Severity | Mitigation | Contingency |
| --- | --- | --- | --- | --- | --- |
| Exposed credentials abused (TD-1) | M | Critical | **Critical** | Rotate now; never paste secrets into chat again (use env pull flows) | Neon PITR restore; audit access logs |
| Launch with fabricated licence/insurance claims (PD-5) | H (if launched as-is) | High | **High** | Content truth pass gated in launch checklist | Take pages down; legal response |
| Silent production breakage (TD-2/3/4) | H | High | **High** | CI + Sentry + crons (Phase 0) | Manual smoke after each deploy until then |
| Strategic fork unresolved (§22) | M | High | High | Force the decision in Phase 0 | Build stays demo; both halves keep half-value |
| Single maintainer / bus factor 1 | H | Medium | High | This doc set; runbook; CI as executable knowledge | — |
| UAE VAT non-compliance in invoicing (PD-4) | M | High | High | Confirm requirements with an accountant before first real invoice | Invoice outside the system meanwhile |
| Neon free-tier limits (cold starts, connections, storage) | M | Medium | Medium | Monitor; budget for paid tier at first real tenant | Upgrade is config, not code |
| RLS regression in a future migration | L | Critical | Medium | verify-rls in CI on every migration (currently manual) | PITR + incident disclosure |
| AEO bet underdelivers (traffic ≠ leads) | M | Medium | Medium | Measure funnel (events, §21); iterate content | Paid acquisition |
| Vendor coupling (Vercel+Neon) | L | Medium | Low-Med | Standard Next + standard Postgres; no proprietary APIs in domain code | Portable with days of ops work |

## 26. Requirement traceability matrix (load-bearing subset)

| Requirement | Story (Part 1 §8) | UI | API/action | DB | Impl | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| FR-1.1–1.4 lead capture | Visitor quote | /quote | `submitQuoteRequest` | leads, rate_limits | ✅ | ✅ 16 limiter checks + live probe |
| FR-1.5 lead notification | Ops notified | — | — | notifications | ❌ | ❌ |
| FR-2.1–2.2 login+lockout | Generic errors | /login | `signIn` | users, sessions | ✅ | ✅ auth suite |
| FR-2.3 unlock/decay | Locked user | — | — | — | ❌ (defect) | ❌ |
| FR-2.4 MFA | Second factor | /security, /login/verify | 5 actions | mfa_challenges, recovery codes | ✅ | ✅ 32+35 checks |
| FR-2.5 password reset | Forgot password | — | — | — | ❌ | ❌ |
| FR-3.1 convert atomically | Sales convert | /leads | `convert` | customer/property/job/lead | ✅ | ✅ |
| FR-4.1–4.4 lifecycle+SLA+assignment | Ops/dispatcher | /dispatch, /jobs/[id] | transitions, `assign` | jobs, visits, history | ✅ | ✅ workforce+transitions |
| FR-4.5 SLA breach alert | Ops alarm | — | — | — | ❌ | ❌ |
| FR-5.x quotes + portal decision | Customer approves | /jobs/[id], /portal/quotes/[id] | quote actions, `decide` | quotes(+lines) | ✅ | ✅ commerce + RLS |
| FR-6.1–6.2 invoice+payments+AR | Accountant | /jobs/[id], /invoices, /customers | `raiseInvoiceAction`, payment | invoices, payments | ✅ | ✅ to-the-fils checks |
| FR-6.3 VAT PDF | Payable invoice | — | — | pdf_storage_key (dead) | ❌ | ❌ |
| FR-7.1–7.2 portal scope+request | Fatima | /portal/* | `createRequest` | RESTRICTIVE policies | ✅ | ✅ RLS harness |
| FR-9.x admin | Admin stories | — | — | tables ready | ❌ | ❌ |
| FR-10.1–10.2 notify pipeline | — | — | enqueue/dispatch | notifications | ✅ | ✅ dispatch+email suites |
| FR-10.3 scheduled drain | — | — | ❌ cron | — | ❌ | ❌ |
| AEO/GEO discoverability | Visitor trust | 24+19 pages, JSON-LD, llms.txt | — | — | ✅ | build gate only (no SEO monitoring) |

**Untraceable to any requirement (exists without a stated why):** 14 unused tables (TD-11);
`readonly`/`supervisor` roles; `ai_interactions` (traces to the *original master prompt's* AI
ambition — deferred by ADR-0005, so: traceable to a Won't-Have-Yet).

## 27. Product backlog (prioritised)

| ID | Epic | Item | Pri | Type | Depends | Acceptance sketch |
| --- | --- | --- | --- | --- | --- | --- |
| MB-001 | Ops | Rotate exposed Neon credentials (both projects) | **P0** | Sec | — | Old strings dead; new ones only in Vercel env |
| MB-002 | Ops | GitHub Actions CI: typecheck, 11 suites vs service PG (migrations+SQL+seed), verify-rls, build, contrast | **P0** | Infra | — | Red PR on any failure |
| MB-003 | Ops | Vercel crons: `/api/cron/dispatch` (drain+stuck alert), `/api/cron/sweep` (rate limits), `/api/cron/sla` (breach detection) — secret-gated | **P0** | Infra | — | Queued mail sends ≤5 min; sweep runs daily |
| MB-004 | Ops | Sentry + alert rules (errors, lockout spike, limiter degraded, notifications failed>0) | **P0** | Infra | — | Test alert fires |
| MB-005 | Strategy | Decide internal-tool vs SaaS; record as ADR-0006 | **P0** | Product | — | Roadmap re-ordered accordingly |
| MB-006 | Trust | Content truth pass: stats, licences, insurance, careers claims; real photography; legal review of privacy/terms | **P0** | Content | — | Launch checklist items ticked by a human |
| MB-007 | Security | CSP with nonced JSON-LD | P1 | Sec | — | No unsafe-inline; pages render |
| MB-008 | Admin | Staff user management (invite, role, deactivate, unlock, MFA reset) | P1 | Feature | MB-003 (invite email) | Zero-SQL user lifecycle |
| MB-009 | Admin | Password reset via emailed single-use token | P1 | Feature | MB-003 | Reset without support |
| MB-010 | Security | Login IP throttle reusing `app_public_rate_limit` | P1 | Sec | — | Stuffing test capped |
| MB-011 | Auth | Truthful lockout: time-decay or unlock-only + copy fix | P1 | Fix | MB-008 | Copy matches mechanics |
| MB-012 | Commerce | Quote/invoice PDF w/ confirmed UAE VAT fields (TRN) | P1 | Feature | tax confirmation | Accountant accepts a sample |
| MB-013 | Notify | New-lead + SLA-breach templates; activate Resend (env) | P1 | Feature | MB-003 | Lead → staff email ≤5 min |
| MB-014 | Portal | Portal user management from customer detail | P1 | Feature | MB-008 | Staff grants portal access |
| MB-015 | CRM | Duplicate-lead detection on convert (phone/email match) | P2 | Feature | — | Suggests existing customer |
| MB-016 | UX | Search + pagination (jobs, customers, leads) | P2 | Feature | — | 5k rows usable |
| MB-017 | Finance | CSV exports (invoices, AR, payments) | P2 | Feature | — | Accountant round-trip |
| MB-018 | Trust | Audit log viewer (entity/actor/date filters) | P2 | Feature | — | Reconstruct any record's history |
| MB-019 | Analytics | `product_events` table + Part 3 §21 event set + weekly SQL report | P2 | Infra | — | KPIs in Part 1 §7.5 answerable |
| MB-020 | Strategy | Competitive scan (1 week, written) | P2 | Research | MB-005 | Positioning validated or revised |
| MB-021 | Portal | Invoices in portal; customer status notifications | P2 | Feature | MB-012/013 | Fatima stops emailing finance |
| MB-022 | Contracts | PPM contracts UI on existing schema (create, schedule, generate visits) | P2/P3 | Feature | MB-005 | Contract generates jobs |
| MB-023 | Field | Technician PWA (offline-first per ADR-0004): my jobs, status, photos, materials, signature → job_signoffs | P3 | Epic | MB-008 | Basement-to-sync round trip |
| MB-024 | Scale | Owner KPI dashboard (breach rate, DSO, quote cycle, pipeline) | P3 | Feature | MB-019 | Weekly picture without meetings |
| MB-025 | AI | Revisit ADR-0005: triage assist, dispatch suggestions, AI receptionist | P3/P4 | Epic | MB-019 data | Per-feature PRDs first |

## 28. Development roadmap

**Phase 0 — Stabilise (days, not weeks):** MB-001…006. *DoD:* credentials rotated; CI red/green
on PRs; queued notifications drain on schedule; errors page someone; strategic ADR-0006 written;
no fabricated claim reachable in production. *Risk:* none technical — this is all known work.

**Phase 1 — MVP completion (2–4 weeks):** MB-007…014. *DoD:* a brand-new tenant staff member
can be invited, locked out, recovered, and MFA-reset with zero SQL; a real invoice PDF passes
an accountant; a new lead emails the ops manager. This phase is what turns the demo into a
product.

**Phase 2 — Operational quality (3–5 weeks):** MB-015…021 (+022 if contracts matter to the
first tenant). *DoD:* 5,000-job tenant remains pleasant; KPIs measured, not asserted; portal
fulfils its "stop calling us" promise.

**Phase 3 — Field execution & scale:** MB-022/023/024; load baseline; paid Neon tier; staging
environment. *DoD:* technicians work offline days without data loss (ADR-0004's bar); owner
dashboard adopted weekly.

**Phase 4 — Differentiation:** MB-025 AI layer (per ADR-0005 tiering), public API, and — if
ADR-0006 says SaaS — tenant self-serve, branding-from-DB, billing.

## 29. Recommended improvements — and explicit non-recommendations

Do **not**: rewrite to microservices (workspace boundaries already give the seams); adopt a
heavyweight auth SaaS (current auth is tested and owned — the gap is flows, not crypto);
introduce Redis/queue infra for notifications (Postgres claim-with-SKIP-LOCKED + cron covers
this scale honestly); redesign the UI (it is coherent; fill states, don't reskin); build the AI
features before Phase-2 data exists to ground them.

Do: everything in Phase 0 before *any* new feature. One hour of CI beats any feature on this
backlog for expected value.

## 30. What we should have done before coding (process retrospective)

| Ideal step | What actually happened | Cost of the gap |
| --- | --- | --- |
| Business analysis, market validation, model decision | Skipped — master prompt asserted the product | §22 contradiction; unknown willingness-to-pay |
| User research | Personas invented plausibly, never interviewed | Unknown fit of role model (10 roles, 2 without UI) |
| PRD, prioritisation, MVP definition | Implicit in prompt + emergent tasks | Admin surface missed because no MVP definition named "run a real tenant" as the bar |
| Compliance research (UAE VAT invoicing) | Not done | PD-4 blocks real billing; rework risk in commerce |
| IA / wireframes | Skipped; conventions emerged strong anyway | Low actual cost — an honest surprise |
| Technical architecture & DB design | **Done properly, mid-build** (ADRs, RLS-first design) | Low — this is why the foundation held |
| Security planning | Emergent but rigorous (proof harness, MFA) | Low; the *operational* security (rotation, monitoring) is where it leaked |
| Testing strategy & CI | Tests grew well; CI never set up | Every regression risk is currently human-shaped |
| Analytics plan | Skipped | Product flies blind; KPIs unmeasurable today |
| Content strategy (truthful claims) | Skipped — realism-first placeholder copy | P0 legal exposure to unwind |

Honest overall verdict on process: *code-first worked unusually well here* for architecture and
domain modelling (the ADRs written mid-flight are genuinely good), and failed exactly where
code-first always fails: market truth, compliance truth, content truth, and operations. The
lesson is not "always write docs first"; it is "the things code cannot validate must be
validated by someone, and nobody was assigned."

## 31. Final executive assessment

**What did we build?** A UAE-localised field-service platform: AEO-optimised public site,
lead-to-cash back office, customer portal, on a genuinely hardened multi-tenant Postgres core —
deployed, seeded, and proven by 269 automated checks plus a live production RLS run.

**How mature?** Marketing site: production-grade *pending content truth*. Domain/data layer:
production-grade. Operational shell: demo-grade. Overall: **a strong foundation two focused
phases away from first real tenant.**

**Currently good (keep, and say so in reviews):** DB-enforced tenant isolation with an
adversarial proof harness; money math in integer minor units tested to the fils; MFA built to
spec with negative-path tests; transactional notification ledger; the writing voice in the UI;
workspace boundaries; the ADR habit.

**Currently weak:** no admin surface; no background execution; no monitoring; no CI; no
password reset; fabricated public claims; unresolved SaaS-vs-internal strategy; VAT compliance
unverified.

**Fix immediately (this week):** rotate credentials; CI; crons; Sentry; strategy ADR; content
truth pass. **Can wait:** everything Phase 2+, including every new feature.

**Is the architecture good enough for production?** Yes — for the realistic target (tens of
tenants, thousands of jobs/month) it is over-built in the right places (isolation, integrity)
and under-built only in operations, which is cheap to add. No rewrite is justified.

**Starting again today, what changes?** (1) Decide internal-vs-SaaS on day one and let it size
the tenancy work. (2) Define MVP as "run one real tenant with zero SQL", which forces admin,
reset, and PDFs into scope from the start. (3) CI before the second feature. (4) One
accountant conversation about UAE VAT before writing a line of commerce code. (5) Everything
else — RLS-first design, integer money, state machines, tests against real Postgres — exactly
the same. Those were the right calls, and they are the reason this audit found process gaps
rather than architectural ones.
