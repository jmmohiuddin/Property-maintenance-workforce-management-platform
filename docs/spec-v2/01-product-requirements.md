# Product Requirements Document

## SATS Operations Platform — v2.0

**Status:** Forward\-looking specification. Supersedes the reverse\-engineered *Product & Technical Master Document* (2026\-08\-09) as the statement of intent.
**Date:** 12 August 2026
**Owner:** Business owner / licence holder
**Companion documents:** `02 — Technical Requirements Document`, `03 — Wireframe & Interaction Document`, `04 — Design System & UX Document`

* * *

## 0\. How to read this document

The previous document was an *audit*. It reconstructed what the code did, and labelled everything nobody had actually decided. This document is the opposite: it states what the product **is meant to do**, decides the things that were open, and treats the existing implementation as an asset to be extended rather than a specification to be obeyed.

| Label | Meaning |
| --- | --- |
| **BUILT** | Exists in the current implementation and is fit for purpose. Carry forward unchanged. |
| **CHANGE** | Exists but must be modified because a decision has now been made. |
| **NEW** | Does not exist. Full specification given here. |
| **DECIDED** | An open question from the audit that this document closes. |
| **OPEN** | Still requires a human answer. Listed in §14 with an owner and a due point. |

Requirement IDs are module\-prefixed (`JOB-4`, `INV-11`). Where a requirement replaces one from the audit, the old ID is cited in brackets — e.g. `[was FR-4.5]`.

* * *

## 1\. The three decisions that reprice everything

The audit's §22 named one blocking strategic fork and said every roadmap choice depended on it. Three decisions are now made.

### DECIDED 1 — This is a single\-company internal system, not a SaaS product

The platform serves **one operating company**\: a Dubai mainland technical\-services contractor. There is no tenant signup, no branding\-from\-database, no plans, no billing, no self\-serve onboarding. Ever, in this document's horizon.

**Consequences, stated plainly:**

- The multi\-tenant Postgres row\-level\-security machinery is **kept**, not removed. It costs nothing to carry, it is already proven by a 12\-check adversarial harness, and it is the cheapest insurance available against a portal customer seeing another customer's data. It is reclassified from *product architecture* to *defence in depth*.
- `TD-9` (hardcoded tenant identity in `packages/core/src/tenant.ts` contradicting the multi\-tenant database) stops being a contradiction and becomes a **correct simplification** — but it must move from a source file to environment configuration so that a staging environment can run with different identity and the licence/TRN values can be corrected without a deploy. See `ADM-9`.
- Tenant provisioning, tenant branding UI and billing leave the backlog entirely. `MB-005` is closed by this paragraph.
- The `readonly` and `supervisor` roles, which the audit found had no differentiated UI, are given real jobs in §6 or deleted. No orphan enum values survive this document.

### DECIDED 2 — The market is Dubai / UAE, and the compliance surface is now specified, not assumed

The audit called the UAE localisation an "IMPLICIT DECISION — never validated". It is now explicit and validated. §11 of this document is a compliance requirements register built from primary and near\-primary sources, covering VAT, the 2027 e\-invoicing mandate, corporate tax, labour law, wage protection, the summer midday work ban, health insurance, and the Dubai contracting\-sector registration law that comes into force during the build window.

This is the single most valuable section of the document, because **compliance is the product's competitive moat**. See §4.

### DECIDED 3 — Scope expands to the whole business, not just lead\-to\-cash

The original build modelled *work coming in and money going out*. The business as actually described is wider. Four capability areas move into scope:

| Area | Why it is in scope |
| --- | --- |
| **Recruitment / ATS** | The company hires tradespeople continuously. Applications arrive through the website today with nowhere to land. Hiring is an operational bottleneck, not an HR nicety — an unstaffed trade is refused revenue. |
| **Contracts, AMC & tenders** | Annual Maintenance Contracts are the revenue model that makes a maintenance business survivable. The schema for contracts already exists and has no UI. Owners\-association work in Dubai is a *tender* channel with a legally mandated three\-bid process and an annual budget cycle — winnable only by a company that can produce documentation on demand. |
| **Technician field app** | Half the value proposition — evidence of work done, materials used, time on site, customer sign\-off — is unreachable while technicians work on paper. |
| **Admin & owner dashboard** | Today the system cannot create a user, reset a password or unlock an account without a database client. That is not a product. |

Plus one addition the audit did not anticipate: **projects**. The licence covers fit\-out and installation work (false ceilings, tiling, electromechanical installation, HVAC installation), which is multi\-week, milestone\-billed, and materially different from a two\-hour callout. A `Job` cannot model it. See §8.5.

* * *

## 2\. Business context — the real company

The previous document was written against a placeholder brand with fabricated statistics, licence claims and insurance figures. `PD-5` classified publishing those as a legal exposure. That exposure is now closed by having real facts.

### 2\.1 The operating entity

| Field | Value |
| --- | --- |
| Legal form | Dubai mainland **sole establishment** |
| Licence type | DET **professional / services** licence |
| Licence number | **930137** |
| Licence expiry | **23 January 2027** |
| Jurisdiction | Dubai, UAE (mainland — not free zone) |
| Currency | AED, minor unit fils (2 dp) |
| Timezone | Asia/Dubai (UTC\+4, no DST) |
| Primary language | English UI; Arabic on customer\-facing documents — see `INV-14` and §11.2 |

> **CHANGE — the single highest\-priority content fix in the product.**
> Every fabricated statistic, licence claim and insurance figure on the public site is replaced with the real licence number, the real licensed activity list, and either a real figure or no figure at all. Cabinet Resolution No. 107 of 2022, Article 7 (Executive Regulations of the Commercial Register Law) obliges the establishment to display its Commercial Register number **on its website and in all documents and printed material** — so the licence number is not merely permitted on the site, it is required there. Requirement `WEB-14`.

### 2\.2 The licensed service catalogue — this is the product's service taxonomy

The licence permits exactly these activities. **The service catalogue in the system is derived from this list and may not exceed it.** Quoting work outside the licensed activities is a licensing exposure, and the system should make that difficult rather than convenient.

| \# | Licensed activity | Service family | Job archetype |
| --- | --- | --- | --- |
| 1 | Painting | Finishes | Both — callout touch\-up and project repaint |
| 2 | Wallpaper | Finishes | Project |
| 3 | False ceilings | Fit\-out | Project |
| 4 | Tiling | Fit\-out | Project |
| 5 | Plumbing & sanitary | MEP | Both — leak callout and installation |
| 6 | Carpentry | Fit\-out | Both |
| 7 | Electrical fittings repair | MEP | Callout |
| 8 | Electromechanical installation | MEP | Project |
| 9 | HVAC installation & maintenance | MEP | Both — PPM visits and installation |
| 10 | Building cleaning | Soft services | Recurring / contract |

**`WEB-1` (CHANGE):** the public site's service pages are rebuilt one\-to\-one against this list. The existing 24 service pages must be audited: any page describing an activity not on this list is removed or rewritten. Any licensed activity without a page gets one.

**`JOB-17` (CHANGE):** the `services` reference data is seeded from this list with a `licensed_activity_ref` column, and the quote builder warns (does not block — see `QTE-9`) when a line item is categorised outside it.

### 2\.3 What the business actually sells

Three revenue shapes, and the system must model all three distinctly. The current implementation models only the second.

| Shape | Description | Typical value | System object |
| --- | --- | --- | --- |
| **Contract (AMC / PPM)** | Annual maintenance contract for a villa, apartment, building or commercial unit. Fixed annual fee; scheduled preventive visits plus a callout entitlement. | Apartment AED 1,200–3,600/yr; villa AED 4,500–15,000/yr depending on size and tier | `Contract` → generates `Job`s (NEW UI, schema exists) |
| **Callout / reactive job** | One\-off response to a fault. Charged by callout fee plus labour and materials. | Callout AED 150–350; handyman AED 75–150/hr; electrician AED 150–350/hr, AED 250–400/hr after hours | `Job` (BUILT) |
| **Project** | Fit\-out, installation or renovation. Multi\-week, multi\-trade, milestone\-billed, may carry a Dubai fit\-out permit. | AED 5,000 – AED 500,000\+ | `Project` → contains `Job`s (NEW) |

> Market figures above are drawn from published Dubai contractor and aggregator rate cards, not from an independent survey. They are directionally reliable — they are internally consistent across many independent sources — and they are used here to *size the product's numeric ranges* (how big does a money field need to be, what does a realistic quote look like), not as a pricing recommendation. Pricing is a business decision, not a product requirement.

* * *

## 3\. Problem statement

**For the operator:** a licensed multi\-trade contractor in Dubai wins work through phone, WhatsApp, referral and — increasingly — search. Every one of those channels loses information. An enquiry that arrives on WhatsApp at 21:00 and is not written down is revenue that never existed. A technician dispatched without checking a certification expiry is a compliance incident waiting for an inspection. An AMC renewal that nobody diarised is a customer lost silently. Work completed on a paper job card and invoiced from memory is a dispute the company will lose, because it has no evidence.

**For the customer:** a building manager or villa owner has no way to see whether their request was received, what it will cost, when someone is coming, or what was done. So they phone. Every phone call is coordination cost the operator pays for.

**For the tradesperson:** applies for a job by handing over a CV or sending a WhatsApp message, and hears nothing. The company loses good candidates to whoever replies first — in a market where a competent AC technician holds three offers at once.

**The cost is silent in all three directions.** Nothing in the current business generates a number that says how much.

* * *

## 4\. Market position and why building this is defensible

The audit's §3 said *"UNKNOWN — NEEDS CONFIRMATION. No competitive research artefact exists; this positioning is INFERRED."* That gap is now closed.

### 4\.1 The competitive set

| Product | Pricing (published, Aug 2026) | Arabic UI | AED pricing | UAE VAT / TRN invoice | UAE e\-invoicing path |
| --- | --- | --- | --- | --- | --- |
| Jobber | USD 49–699/mo, \+USD 29/extra user | No (EN/ES only) | No | No | No |
| Housecall Pro | USD 59–329/mo | No | No | No | No |
| ServiceTitan | \~USD 245–500/technician/mo (third\-party estimates; vendor publishes none) \+ USD 5k–50k implementation, 12\-month minimum | No | No | No | No |
| Zoho FSM | USD 30–55/user/mo | **Yes** (ar\-SA; statuses stay English) | No | Via Zoho Books | **Plausible** — Zoho integrating with accredited providers |
| ServiceM8 | Job\-volume tiers, unlimited users | No | No | No | No |
| Odoo Field Service | USD 24.90–49/user/mo | Yes | No | Via localisation | **Yes** — third\-party UAE Peppol modules exist |
| UAE local (Focus Softnet, PropertyAutomate, Penieltech, Fogwing) | **Quote\-only. None publish a price.** | Varies | — | Yes | Claimed |

### 4\.2 The three findings that matter

**Finding 1 — the international products are not localised, and the gap is about to get wider.** None of Jobber, Housecall Pro or ServiceTitan will emit a UAE PINT AE XML e\-invoice through an FTA\-accredited service provider. From **1 July 2027** that is a legal requirement for every B2B and B2G invoice this company issues (§11.1). A system that cannot do it will have to be replaced. Building the invoice model against the PINT AE field set *now* converts a compliance obligation into a structural advantage.

**Finding 2 — every UAE\-local vendor hides its price.** That is a market signal. It tells you the local segment sells by relationship and negotiation, not by product. It also means there is no published benchmark for what this build "should" have cost.

**Finding 3 — the real competitor is not software, it is WhatsApp and a spreadsheet**, and the audit was right about that. The product is not competing on features against ServiceTitan. It is competing against *not writing it down*. The design consequence is in §5: every screen must be faster than the thing it replaces, or it will not be used.

### 4\.3 Where demand comes from in Dubai — and what the system must be able to produce

This determines several requirements that would otherwise look arbitrary.

**Owners Associations and service\-charge\-funded work — the regulated channel.** Under Dubai Law No. 6 of 2019 on Jointly Owned Property, a management entity must obtain RERA approval before collecting service fees. The approval process requires the management company to submit **at least three competitive tenders for each major service category**, verified by a licensed audit firm, through the Dubai Land Department's **Mollak** platform, on an annual budget cycle.

> **Product consequence:** OA work is won by being on an approved\-vendor list *before* budget season, and by producing an audit\-grade tender pack on request. Requirements `CON-11` (tender pipeline with submission deadlines and outcome tracking) and `CON-12` (export a tender pack: scope of work, per\-asset PPM schedule, priced schedule of rates, licence and insurance evidence, previous\-contract references) exist because of this paragraph, not because tenders are generically nice to have.

**Fit\-out work carries a permit workflow.** In DDA\-jurisdiction areas a fit\-out permit is applied for **by the contractor**, requires a tenant appointment letter, EJARI copy, stamped drawings, authority NOCs, and a Dubai Civil Defence completion certificate before completion. Fee AED 0.90/ft² (min AED 200, max AED 10,000), typically issued in two working days. Other jurisdictions (Dubai Municipality, Trakhees) have parallel regimes.

> **Product consequence:** `PRJ-6` — a project carries a permit register with authority, reference number, applied/approved/expired dates and document attachments, and the project cannot be marked `on_site` while a required permit is un\-approved.

**Electrical work touching supply, meters, circuits or main boards requires a DEWA\-enrolled contractor.** DEWA enrolment is at **company** level (categories include Electrical, Civil, Fit\-out, Demolition), graded Platinum/Gold/Silver/Bronze on past performance.

> **Product consequence:** `HR-14` — company\-level accreditations (DEWA enrolment category and grade, DM contractor classification, ISO certificates, insurance policies) are a first\-class register with expiry tracking, separate from individual certifications, and are attachable to a tender pack.

### 4\.4 Search and AI visibility — sharpening the existing bet

The build already made a heavy answer\-engine\-optimisation bet: 24 service pages, 19 area pages, JSON\-LD, `llms.txt`. Research says the bet is directionally right and incompletely executed.

- **Google Business Profile is the foundation and is currently absent from the product entirely.** Google's own AI surfaces ground on it; Gemini's local recommendation rate is roughly ten times ChatGPT's precisely because it is grounded in Google Maps. Whitespark's 2026 ranking\-factor study puts *primary GBP category*, *proximity*, *keywords in the GBP title*, *address in the searched city* and — newly high — *business open at the time of search* as the top five local\-pack factors.
- **Your own website is still a source in \~58% of ChatGPT searches**, so the static\-HTML\-first architecture (`ADR` on RSC) remains correct.
- **Reviews behave as a threshold, not a gradient.** Businesses recommended by ChatGPT average around 4.3 stars; businesses near 3.4 stars with review\-response rates under 5% are effectively invisible.
- **Directories are cited across every industry tested.** Getting onto UAE vertical directories and "best AC repair in Dubai" listicles is a distribution requirement, not a marketing garnish.
- **Dedicated service pages score highest of all localised\-organic factors.** The 24\-page structure is the right shape; it needs to be *true* rather than plausible.
- **AI referral share moved violently in eight months** (ChatGPT 89.1% → 62.6%; Claude 1.4% → 18.5%; Gemini 2.4% → 10.6%). Optimising for one assistant is a mistake.
- **The pages currently winning Dubai maintenance\-pricing queries are published AED price tables** — and almost no licensed contractor publishes one.

> **Requirements arising:** `WEB-15` (Google Business Profile as a tracked operational asset with hours synchronised from the working calendar, so "open at time of search" is true); `WEB-16` (a published AED schedule of rates page, generated from the system's own rate card so it cannot drift); `WEB-17` (a reviews page linked from primary navigation, with review\-response rate as a tracked KPI); `WEB-18` (a directory\-listing register with NAP consistency checks).

* * *

## 5\. Users, personas and roles

### 5\.1 Design principle inherited from the audit and kept

> *Consequence\-ordered screens.* Screens answer "what should I do next", not "what data exists". This survived the audit as a genuine strength and is reaffirmed as a binding design principle. See `04 — Design System`, §2.

### 5\.2 Personas

| \# | Persona | Role in system | What they need | Primary screens |
| --- | --- | --- | --- | --- |
| P1 | **Owner / licence holder** | `owner` | To know the business is healthy without asking three people. Cash position, pipeline, SLA breaches, contract renewals, headcount and hiring, compliance expiries — weekly, on a phone. | Owner dashboard (NEW) |
| P2 | **Operations manager** | `operations_manager` | Nothing breaches SLA. Every job staffed by someone qualified and legally permitted to do it. Empty triage queue at day's end. | Dispatch board, schedule |
| P3 | **Dispatcher / coordinator** | `dispatcher` | Fast assignment with confidence in skills, certifications, availability and — in summer — the legal working window. | Dispatch board, schedule, technician roster |
| P4 | **Supervisor / foreman** | `supervisor` | Owns a crew and a site. Approves technician sign\-offs, resolves no\-access visits, signs off project milestones. *(Role now given real UI — closes an audit orphan.)* | Dispatch board filtered to own crew, project board, sign\-off queue |
| P5 | **Accountant / admin** | `accountant` | Every signed\-off job becomes a compliant tax invoice. Knows who owes what. Survives an FTA audit and a WPS deadline. | Invoices, AR ageing, VAT return pack, payroll pack |
| P6 | **HR / recruiter** | `hr` (NEW role) | Fill an open trade role in days, not weeks. Never dispatch someone whose permit, visa, medical or certification has lapsed. | ATS pipeline, workforce compliance board (NEW) |
| P7 | **Technician** | `technician` | See today's jobs, record the work, prove it happened, go home. Works in basements, plant rooms and rooftops with poor connectivity. | Field app (NEW) |
| P8 | **Customer contact** | `customer` | Raise a request, approve a quote, see status and invoices, without phoning. | Portal (BUILT, extended) |
| P9 | **Job applicant** | *(unauthenticated / magic\-link)* | Apply in under three minutes on a phone. Know the outcome. | Careers site \+ application form (NEW) |
| P10 | **Auditor / read\-only** | `readonly` | An external accountant or auditor granted time\-boxed, non\-mutating access to financial records and the audit log. *(Role now given real UI — closes an audit orphan.)* | Read\-only finance \+ audit log viewer (NEW) |

**`ADM-1` (CHANGE):** the role enum becomes `owner`, `admin`, `operations_manager`, `dispatcher`, `supervisor`, `technician`, `accountant`, `hr`, `sales`, `customer`, `readonly`. `hr` is added; every role now has at least one screen it alone can reach. Any role that fails that test at implementation time is deleted from the enum in the same commit.

* * *

## 6\. Scope

### 6\.1 In scope for v2

Modules M1–M13 in §8. In summary: the existing lead\-to\-cash spine, hardened and made operable without a database client; plus contracts, projects, recruitment, workforce compliance, a field app, an admin surface, an owner dashboard, and a compliance layer that makes the whole thing legal to run.

### 6\.2 Explicitly out of scope, with reasons

| Not building | Why | Revisit when |
| --- | --- | --- |
| Multi\-tenant SaaS, tenant signup, billing, plans | DECIDED 1 | Never, within this document |
| Consumer marketplace / lead marketplace | Different business; the company owns the customer relationship | Never |
| Payment gateway / card collection | Recording a payment ≠ taking one. Adds PCI scope for little gain at this size | When online quote\-acceptance\-with\-deposit is proven to convert |
| Full accounting general ledger | This system feeds an accountant; it does not replace one. **Export, don't replace.** | Never — but the export is `INV-16`, and it is mandatory |
| Full inventory / warehouse management | Van stock and per\-job material consumption are in scope; stock control, purchase orders and supplier ledgers are not | Phase 4 |
| Payroll calculation and disbursement | WPS salary files are generated by the bank/exchange house. The system produces the **inputs** (hours, overtime, absence) and the compliance calendar, not the payroll run | Phase 4 |
| Native Arabic UI | English\-only operator UI. Arabic appears on **customer\-facing documents** where it has commercial value. A full RTL UI is a large, low\-return project at ten users | When a non\-English\-reading staff member is hired |
| AI triage, AI receptionist, dispatch suggestions | There is no data to ground them yet. The audit deferred these correctly | After 6 months of `product_events` and 500\+ completed jobs |
| Route optimisation / mapping | Dubai geography plus 5–15 technicians is a human\-solvable problem | 25\+ technicians |

* * *

## 7\. Success metrics

The audit listed ten metrics and marked most "no events". Instrumentation is now a first\-class requirement (`KPI-1`…`KPI-4`), so these become measurable rather than aspirational.

### 7\.1 Product goals with targets

| \# | Metric | Definition | Target | Instrumented by |
| --- | --- | --- | --- | --- |
| G1 | Enquiry capture | Enquiries recorded in system ÷ total enquiries received (all channels) | ≥ 95% within 3 months | `KPI-2` channel\-tagged lead creation |
| G2 | Lead response time | Lead created → first stage change | \< 30 min in working hours, \< 2 h out of hours | `lead_stage_changed` event |
| G3 | Time to dispatch | Job triaged → dispatched | P1 \< 30 min; P2 \< 4 h; P3 \< 1 working day | `job_status_changed` |
| G4 | SLA breach rate | Jobs past response deadline ÷ all jobs | \< 5% | SLA sweep (`JOB-5`) |
| G5 | Quote conversion | Quotes approved ÷ quotes sent | ≥ 50% | `quote_decided` |
| G6 | Quote cycle time | Sent → decided | Median \< 5 days | `quote_decided.hours_to_decision` |
| G7 | Invoice lag | Job signed off → invoice issued | Median \< 2 working days | `invoice_issued.days_since_signoff` |
| G8 | DSO | Days sales outstanding | \< 45 days | AR ageing |
| G9 | Portal deflection | Customer actions in portal ÷ all customer interactions | ≥ 60% by month 6 | `portal_*` events |
| G10 | Contract renewal rate | AMCs renewed ÷ AMCs expiring | ≥ 80% | `CON-8` renewal pipeline |
| G11 | First\-time fix rate | Jobs closed on first visit ÷ all reactive jobs | \> 85% | Field app outcome codes |
| G12 | PPM completion | Contract visits completed on schedule ÷ scheduled | \> 98% | `CON-7` |
| G13 | Time to hire | Application received → offer accepted | Median \< 14 days | ATS stage events |
| G14 | Applicant response rate | Applicants receiving an outcome ÷ all applicants | **100%** | `ATS-16` |
| G15 | Compliance expiry breaches | Dispatches to a technician with a lapsed certification, permit, visa or medical | **Zero** | `HR-9` hard block |
| G16 | Payroll punctuality | WPS transfers landing on or before the 1st | **100%** | `HR-17` calendar \+ alert |

**G15 and G16 are zero\-tolerance targets.** They are the two metrics where a single failure has a regulatory consequence rather than a commercial one, and both are enforced by system behaviour rather than reporting.

### 7\.2 Anti\-metrics — things we deliberately do not optimise

- **Number of jobs logged.** Rewards busywork.
- **Technician utilisation as a headline KPI.** Drives dispatch that ignores the midday work ban and travel realities. Track it; never target it publicly.
- **Portal login count.** A customer who never needs to log in because everything arrived by email is a success, not a failure.

* * *

## 8\. Functional requirements

Format: each module states purpose, actors, then numbered requirements. Requirements marked **(P0)** block a real operating week; **(P1)** block a real customer or a real hire; **(P2)** are operational quality; **(P3)** are expansion.

* * *

### M1 — Public website, content truth and discoverability

**Actors:** visitor, AI crawler, prospective employee.
**Current state:** 66 routes; strong structure; fabricated content; no Google Business Profile linkage; no careers functionality.

| ID | Requirement | Pri |
| --- | --- | --- |
| `WEB-1` | Service pages rebuilt one\-to\-one against the ten licensed activities (§2.2). Any page describing an unlicensed activity is removed. | P0 |
| `WEB-2` | **Content truth pass.** Every statistic, licence claim, insurance figure, years\-in\-business claim, team\-size claim and testimonial on the site is either replaced with a verified fact or deleted. A claim with no evidence is deleted, not softened. *(Closes `PD-5`, `MB-006`.)* | P0 |
| `WEB-3` | All `picsum.photos` and stock placeholder imagery replaced with real photography of real work. Until real photography exists, use typographic/illustrative treatments rather than stock — a stock photo of a smiling American electrician is a trust liability in this market. | P0 |
| `WEB-4` | Emergency phone number reachable in one tap from every page, on a statically rendered path that does not depend on the database. **BUILT** — verify it survives the rebuild. | P0 |
| `WEB-5` | Quote form: server\-side zod validation authoritative, honeypot, Postgres\-backed IP rate limit (5 per 10 min), fail\-open with logged degradation, DB\-failure fallback showing phone numbers. **BUILT** — carry forward unchanged. | P0 |
| `WEB-6` | Area pages retained but reduced to areas the company will genuinely travel to, each stating a real response\-time commitment consistent with `JOB-4` SLA tiers. A 19\-area promise the dispatcher cannot keep is an SLA breach generator. | P1 |
| `WEB-7` | JSON\-LD: `LocalBusiness` with complete attributes (hours from the working calendar, geo coordinates, licensed service list, `AggregateRating` once real reviews exist), `Service` per service page, `FAQPage`, `JobPosting` per open role (`ATS-2`). | P1 |
| `WEB-8` | `sitemap.xml`, `robots.txt`, `llms.txt` maintained. `llms.txt` states the licensed activities, service areas, and the emergency number in plain text. **BUILT** — extend with careers and rate card. | P1 |
| `WEB-9` | Content Security Policy with nonced JSON\-LD; no `unsafe-inline`. *(Closes `TD-6`, `MB-007`.)* | P1 |
| `WEB-10` | Privacy policy and terms rewritten for UAE reality: PDPL (Federal Decree\-Law 45/2021) framing, data retention periods matching §11.5, applicant\-data handling, and — if any technician location data ever reaches a customer\-facing surface — a statement of it. Legal review before publication. | P1 |
| `WEB-11` | **Contract & tender enquiry path**, distinct from the consumer quote form: captures organisation, property portfolio size, contract type sought (AMC / PPM / project / tender), budget cycle, decision date. Routes to a `contract_opportunity`, not a consumer lead. | P1 |
| `WEB-12` | **Careers section** — see M9. | P1 |
| `WEB-13` | WCAG 2.2 AA: contrast gate retained (36 pairings, CI\-enforced); **add** keyboard traversal and screen\-reader audit, which the audit found had never been performed. Focus\-visible ring token defined. | P1 |
| `WEB-14` | Trade licence number **930137** and Commercial Register number displayed in the site footer and on every quote, invoice and contract document. Legally required by Cabinet Resolution 107/2022 Art. 7. | P0 |
| `WEB-15` | Google Business Profile registered as a tracked operational asset: primary category set to the highest\-value licensed activity, opening hours **synchronised from the system working calendar** so the "open at time of search" ranking factor is true, service list mirrored, photos maintained. A weekly check surfaces drift. | P1 |
| `WEB-16` | **Published AED schedule of rates page**, generated from the system's own rate card table so it cannot drift from what is quoted. Prices stated excluding VAT with the 5% shown separately, per market convention. This is the single highest\-leverage AEO asset available and almost no licensed competitor publishes one. | P1 |
| `WEB-17` | Reviews page linked from primary navigation, aggregating verified customer reviews. Review\-response rate tracked as an operational KPI — research shows sub\-5% response rates correlate with AI\-search invisibility. | P2 |
| `WEB-18` | Directory listing register: which UAE vertical directories the business is listed on, with NAP (name/address/phone) consistency checks and a re\-verification cadence. | P2 |

* * *

### M2 — Lead capture and CRM

**Actors:** visitor, sales, operations manager.
**Current state:** lead capture works end to end; nobody is notified; no search, no pagination, no dedupe, no communications log.

| ID | Requirement | Pri |
| --- | --- | --- |
| `LEAD-1` | Every enquiry becomes a `lead` within one minute of arrival, from any channel. Channels: web form, phone, WhatsApp, walk\-in, referral, contract enquiry, aggregator. Manual channels get a **30\-second create form** — if logging a phone call takes longer than writing it on a pad, it will not happen. | P0 |
| `LEAD-2` | **Staff notification on lead creation** — email plus optional WhatsApp/SMS, within 5 minutes, routed by service family and urgency. *(Closes `PD-3`, `FR-1.5`, `MB-013`.)* | P0 |
| `LEAD-3` | Emergency\-flagged leads raise a distinct, louder notification and appear pinned at the top of the triage queue regardless of age. | P0 |
| `LEAD-4` | Attribution recorded on every lead: referrer, UTM parameters, landing page, user agent, channel, and — for phone leads — which number was called. Without this the AEO investment cannot be evaluated. | P1 |
| `LEAD-5` | **Duplicate detection** on create and on convert: exact phone match (comparing local digits, ignoring country code, per standard practice) or exact email match surfaces existing customer/lead with a merge\-or\-link action. Two tiers: a loose matcher that *suggests*, a strict matcher (phone **and** email) that may *auto\-link*. *(Closes `PD-11`, `MB-015`.)* | P1 |
| `LEAD-6` | Lead stages: `new → contacted → qualified → quoted → won / lost / dormant`. Lost and dormant require a **reason from a controlled list**. Free\-text reasons are rejected — the reason field is what makes the funnel analytically useful. | P1 |
| `LEAD-7` | Convert creates customer \+ property \+ job atomically in one transaction, with race\-safe reference allocation. **BUILT** — carry forward. | P0 |
| `LEAD-8` | **Search and pagination** on leads, customers, jobs, invoices, applicants. Server\-side, indexed, keyset pagination. *(Closes `TD-10`, `MB-016`.)* | P1 |
| `LEAD-9` | **Communications log** per lead and customer: calls, WhatsApp, emails, site visits — who, when, what, outcome. The `communications` table exists and is unused. Logging must be one click plus one sentence. | P2 |
| `LEAD-10` | Customer record: trading name, TRN (if VAT\-registered — determines invoice type under `INV-6`), billing address, exactly\-one\-primary contact, contacts, properties, payment terms, credit limit, AR position. **Mostly BUILT** — add TRN and credit limit. | P1 |
| `LEAD-11` | Property record: address, community/area, unit type (villa / apartment / office / retail / building), size (sq ft), floors, access notes, parking, security/permit requirements, key assets. Access notes are what stop a wasted visit. | P1 |

* * *

### M3 — Contracts, AMC and tenders

**Actors:** sales, operations manager, accountant, owner.
**Current state:** `contracts`, `contract_properties`, `contract_visits` tables exist. **Zero UI. Zero domain code.** "Contract workforce management" is in the product's own name and absent from the product.

| ID | Requirement | Pri |
| --- | --- | --- |
| `CON-1` | Create a contract: customer, properties covered, contract type (`comprehensive` — labour, parts and consumables included; `labour_only` — parts billed separately), term start/end, annual value, billing frequency (annual / semi\-annual / quarterly / monthly), payment terms. The two contract types are the two models that actually exist in this market and they differ in who carries parts risk. | P1 |
| `CON-2` | **Entitlement definition** per contract: scheduled visits per service family per year (e.g. 4 × AC service, 2 × plumbing inspection, 2 × water tank clean); callout entitlement (unlimited / N per year); response\-time tier; discount rate on out\-of\-scope work; explicit **exclusions list** (compressors, fan motors, concealed pipe replacement, waterproofing, pumps, rewiring, pools — the standard Dubai AMC exclusion set). Exclusions must be machine\-readable, because they drive `CON-6`. | P1 |
| `CON-3` | **PPM schedule generation:** on activation, the contract generates its scheduled visits for the full term as `contract_visit` records with target date windows, not fixed dates. A window is what makes a schedule survivable. | P1 |
| `CON-4` | A `contract_visit` becomes a `Job` when it enters its scheduling window (configurable lead time, default 21 days), inheriting scope, property, entitlement and priority. Jobs generated this way are marked `source = contract`. | P1 |
| `CON-5` | **Entitlement consumption tracking:** each completed job against a contract decrements the relevant entitlement. Remaining entitlement visible on the contract, on the customer record, and in the portal. | P2 |
| `CON-6` | Work identified as **out of scope** (matching the exclusions list, or exceeding entitlement) cannot be silently absorbed: it raises a quote at the contract discount rate. This is the single mechanism that stops a comprehensive AMC becoming a loss. | P1 |
| `CON-7` | **PPM compliance view:** visits scheduled vs completed vs overdue, per contract and in aggregate. Target \> 98% (`G12`). This is the number an OA management company asks for at renewal. | P2 |
| `CON-8` | **Renewal pipeline:** contracts entering their final 90 days appear in a renewal queue with prior\-year job count, entitlement utilisation, margin, and a one\-click "generate renewal quote" prefilled from actuals. | P1 |
| `CON-9` | Renewal reminders to the owner at T\-90, T\-60, T\-30, T\-7 days. A silently expired AMC is the most expensive failure mode in this business model. | P1 |
| `CON-10` | Contract documents: signed contract PDF, scope annexe, asset register, insurance certificates — attached, versioned, retrievable. | P2 |
| `CON-11` | **Tender pipeline** (distinct from leads): opportunity source (OA management company / developer / property manager / government eSupply portal), submission deadline, budget cycle, decision date, competitors known, bid value, outcome \+ reason. Deadline\-driven, not stage\-driven — a tender queue sorts by *days until deadline*, always. | P2 |
| `CON-12` | **Tender pack export**\: a single PDF/ZIP containing scope of work, per\-asset PPM schedule, priced schedule of rates, trade licence, DEWA enrolment evidence, ISO certificates, insurance certificates, and reference contracts. Assembled from the company accreditation register (`HR-14`) so it is always current. This is the artefact that wins the RERA\-mandated three\-bid process. | P2 |
| `CON-13` | **Asset register** per property: chillers, split units, FCUs, pumps, water tanks, DBs, lifts — make, model, serial, location, install date, warranty expiry, service history. The `assets` table exists and is unused. Per\-asset PPM is how commercial AMCs are priced and how tenders are evaluated. | P2 |

* * *

### M4 — Jobs, dispatch and scheduling

**Actors:** operations manager, dispatcher, supervisor, technician.
**Current state:** the strongest part of the build. 13\-state lifecycle with enforced transitions, SLA deadlines by priority, status history with actor, dispatch board ordered by SLA consequence, skill and certification matched assignment with coverage warnings. Missing: schedule/calendar view, availability awareness, SLA breach alerting, and every UAE\-specific working\-time constraint.

| ID | Requirement | Pri |
| --- | --- | --- |
| `JOB-1` | Job lifecycle state machine with enforced transitions; every change writes a history row with actor and timestamp. **BUILT** — carry forward unchanged. | P0 |
| `JOB-2` | Job carries: customer, property, service (from licensed catalogue), priority, source, description, reported fault, access notes, contract link (if any), project link (if any), SLA deadlines. | P0 |
| `JOB-3` | SLA deadlines derived from priority at creation. **CHANGE:** deadlines must be computed against the **working calendar** (`JOB-6`), not wall\-clock, for P2–P4. A P3 job created at 18:00 Thursday should not breach at 18:00 Friday when nobody works Friday. P1 emergency remains wall\-clock 24/7. | P0 |
| `JOB-4` | SLA tiers aligned to commercial norms in this market: **P1 emergency** respond 30–60 min, resolve 2–4 h; **P2 urgent** respond 2–4 h, resolve 24 h; **P3 routine** respond 24 h, resolve 48–72 h; **P4 planned** scheduled by agreement. Contract customers may hold tighter tiers, which override the default. | P0 |
| `JOB-5` | **SLA breach detection and alerting.** A scheduled sweep detects jobs past response or resolution deadline and notifies the operations manager and owner. *(Closes `PD-3`, `FR-4.5`.)* The audit's phrase is worth keeping: *the clock exists; the alarm does not.* | P0 |
| `JOB-6` | **Working calendar** — the UAE constraint layer. See the four hard constraints immediately below this table. | P0 |
| `JOB-7` | **Schedule / calendar view** — day, week and technician\-lane views. Drag to assign, drag to reschedule. Shows the midday\-ban band as a visually blocked region during summer. *(Closes `FR-4.6`, `MB-016` partially.)* | P1 |
| `JOB-8` | **Availability\-aware assignment.** The `shifts` and `leave_requests` tables exist and are unused. Assignment must consider: on shift, not on approved leave, not already booked, within daily/weekly hour limits, and — where the job is outdoor in summer — outside the ban window. | P1 |
| `JOB-9` | Assignment warns on missing skill and on expired or expiring certification. **BUILT** — extended by `HR-9`, which upgrades certain warnings to hard blocks. | P0 |
| `JOB-10` | **Assignment override is logged with a reason.** The audit found overrides were silent. An override without a recorded reason is indistinguishable from a mistake. `assignment_warning_overridden` event with type and reason. *(Closes `PD-11`.)* | P1 |
| `JOB-11` | Dispatch board ordered by SLA consequence, not by age or creation order. **BUILT** — the best single design decision in the existing product. Carry forward and do not "improve" into a generic sortable table. | P0 |
| `JOB-12` | Multi\-visit jobs: a job may carry N `job_visits`, each with its own assignee, window and outcome. Needed for "parts on order, returning Thursday" and for multi\-trade work. **Schema exists.** | P1 |
| `JOB-13` | **Job outcome codes** on completion, from a controlled list: `completed`, `partial`, `return_visit_required`, `no_access`, `customer_not_home`, `aborted_unsafe`, `quote_required`. `no_access` and `return_visit_required` are a large share of real visits and must be first\-class, not an afterthought. | P1 |
| `JOB-14` | **Fault coding** — a three\-part controlled taxonomy: symptom / cause / remedy. This is the field that converts service history into reliability data, PPM justification and tender evidence. Shipping it as free text is the mistake that cannot be retrofitted. | P2 |
| `JOB-15` | Job cannot be marked complete without: outcome code, at least one "after" photo (or an explicit reason\-coded exemption), materials recorded or explicitly "none", and labour time. Enforced in the domain layer, not the UI. | P1 |
| `JOB-16` | Sign\-off gate: only a `supervisor`, `operations_manager` or `owner` may move a job to `signed_off`. Invoicing is gated on sign\-off. **BUILT** — carry forward. | P0 |

#### `JOB-6` in full — the UAE working calendar

This is the requirement most likely to be missed and most expensive to miss. The scheduler must enforce four constraints:

1. **Summer midday work ban.** Outdoor work in direct sun is prohibited **12:30–15:00, from 15 June to 15 September**. Penalty is **AED 5,000 per worker found working**, capped at AED 50,000, plus a company classification downgrade. Jobs flagged `outdoor` **cannot be scheduled** into that window during that period. This is a hard block, not a warning — the dispatcher must not be able to click through it.
2. **Ramadan reduced hours.** Normal working hours are reduced by two hours per day for the month.
3. **UAE public holidays**, maintained annually in reference data (`ADM-10`).
4. **Statutory working hours.** Maximum 8 hours per day and 48 hours per week; a break of at least one hour after 5 consecutive hours worked; weekend pattern configurable (Saturday–Sunday is the common private\-sector arrangement — see `OPEN-8`).

Every SLA calculation, schedule view, availability check and assignment decision reads from this calendar. It is a single service, not a rule duplicated per screen.

### M5 — Projects (fit\-out, installation, renovation)

**Actors:** operations manager, supervisor, accountant, owner.
**Current state:** does not exist. `Job` cannot model multi\-week milestone\-billed work.

| ID | Requirement | Pri |
| --- | --- | --- |
| `PRJ-1` | A `Project` is a container: customer, property, scope, contract value, start and target completion dates, project manager, status (`quoted → awarded → mobilising → on_site → snagging → practical_completion → defects_liability → closed`). | P2 |
| `PRJ-2` | A project contains **phases**, each with planned start/end, dependencies, assigned trades and a percentage weight. Phases produce `Job`s for daily execution. | P2 |
| `PRJ-3` | **Milestone billing:** milestones defined against phases with a value and a trigger (date, percentage completion, or client sign\-off). A reached milestone raises an invoice. This is the mechanism the current invoicing model — one job, one invoice — cannot express. | P2 |
| `PRJ-4` | **Variation orders:** a change to scope creates a variation with its own value and approval state. Unapproved variations are visible and total separately. Unrecorded variations are the standard way a fit\-out contractor loses money. | P2 |
| `PRJ-5` | **Retention:** a configurable percentage (commonly 5–10%) withheld from each invoice, released on practical completion and end of defects liability period, with its own due\-date tracking and reminders. Retention nobody chases is a gift to the client. | P2 |
| `PRJ-6` | **Permit register:** authority (DDA / Dubai Municipality / Trakhees / DEWA / Dubai Civil Defence), permit type, reference number, applied / approved / expiry dates, fee paid, documents attached. A project may not enter `on_site` while a permit flagged *required* is not `approved`. | P2 |
| `PRJ-7` | **Snag list:** items raised against a project with location, trade, photo, responsible party, target date and closure evidence. Practical completion cannot be recorded with open critical snags. | P2 |
| `PRJ-8` | **Project cost tracking:** labour hours × rate, materials at cost, subcontractor invoices, plant hire — against contract value plus approved variations. Live margin. | P3 |
| `PRJ-9` | **Subcontractor register:** a subcontractor is an organisation with a licence, insurance, accreditations and expiry dates, engaged against a project scope with its own payment terms. Dubai Law No. 7 of 2025 requires prior approval for subcontracting within the contracting sector — see §11.4. | P3 |

* * *

### M6 — Quotes and pricing

**Current state:** money mathematics is exemplary — integer minor units, VAT applied after discount, proven by tests to the fils. Missing: a document a customer can actually receive.

| ID | Requirement | Pri |
| --- | --- | --- |
| `QTE-1` | Quote built from lines in integer minor units (fils); VAT applied **after** discount; totals proven by tests. **BUILT** — do not touch the arithmetic. | P0 |
| `QTE-2` | Quote lifecycle `draft → sent → approved / rejected / expired / superseded`, with a validity period defaulting to 30 days and automatic expiry. The audit noted `expired` existed but enforcement was unverified — `QTE-2` requires enforcement plus a test. | P1 |
| `QTE-3` | **Quote PDF** — a real document, with company identity, trade licence 930137, TRN, itemised lines, subtotal, discount, 5% VAT, total, validity date, scope inclusions and exclusions, payment terms, and an accept/reject link into the portal. *(Closes `PD-4`, `FR-5.5`, `MB-012`.)* | P1 |
| `QTE-4` | **Rate card**\: standard prices per service, per unit, per hour and per rate band (standard / after\-hours / emergency / weekend), versioned with effective dates. Quote lines default from it. This is also the source for the published rate card page (`WEB-16`). | P1 |
| `QTE-5` | Contract customers automatically receive their contracted discount rate; the discount source is shown on the quote line. | P2 |
| `QTE-6` | Quote sent → customer notification enqueued transactionally. **BUILT** — carry forward. | P0 |
| `QTE-7` | Portal approval/rejection is customer\-scoped by RESTRICTIVE row\-level security and audit\-logged with actor and reason. **BUILT** — this is the security pattern most teams get wrong and this one is right. | P0 |
| `QTE-8` | Approved quote unlocks invoice prefill. **BUILT.** | P0 |
| `QTE-9` | Quote lines categorised outside the licensed activity list (§2.2) raise a **warning with a required acknowledgement reason**, not a block. Sometimes a customer asks for something adjacent and the answer is to subcontract it — but it should never happen by accident. | P2 |
| `QTE-10` | Quote versioning: revising a sent quote creates version 2 and supersedes version 1; both retained; the customer sees only the current version but the audit trail retains both. | P2 |

* * *

### M7 — Invoicing, VAT and e\-invoicing

**This is the module with the hardest external deadline in the entire document.** See §11.1.

**Current state:** invoices prefill from approved quotes, gated on sign\-off; payments recorded; AR ageing computed in integer minor units excluding written\-off debt. No PDF. No tax\-invoice fields. `invoices.pdf_storage_key` is a column nothing writes.

| ID | Requirement | Pri |
| --- | --- | --- |
| `INV-1` | Invoice only from signed\-off jobs (or reached project milestones, `PRJ-3`); prefilled from the approved quote; issuing allocates a reference and enqueues notification. **BUILT** — extend for projects. | P0 |
| `INV-2` | Payments recorded against invoices; outstanding and overdue computed in minor units, excluding written\-off debt. **BUILT.** | P0 |
| `INV-3` | **Full UAE tax invoice**, containing every field required by Article 59 of the VAT Executive Regulations: the words **"Tax Invoice"**; supplier name, address and 15\-digit **TRN**; recipient name, address and TRN (where registered); **sequential unique invoice number**; date of issue and date of supply where different; description of services; per line quantity/unit, unit price, tax rate and amount in **AED**; discount; gross amount in AED; tax amount in AED; and the exchange rate where any amount originates in another currency. Plus trade licence 930137 and Commercial Register number per `WEB-14`. | P1 |
| `INV-4` | **Sequential numbering with no gaps.** Already implemented correctly via the `app_next_reference` SECURITY DEFINER atomic counter — the audit called this "the pattern other teams get wrong". Extend: a gap in the issued\-invoice sequence must be detectable by a report, because gaps are an FTA audit flag. | P1 |
| `INV-5` | **14\-day issuance rule.** A tax invoice must be issued within 14 days of the date of supply. The system tracks days\-since\-supply on every un\-invoiced signed\-off job and alerts at day 10. Failure to issue carries an AED 2,500 administrative penalty. | P1 |
| `INV-6` | **Simplified tax invoice** supported for the near term: permitted where the recipient is not VAT\-registered, **or** the recipient is registered and consideration does not exceed AED 10,000. Fields: "Tax Invoice", supplier name/address/TRN, date of issue, description, total consideration, tax amount. **Note this route disappears when e\-invoicing applies (`INV-9`)** — so build it as a rendering variant of one invoice object, never as a second object. | P1 |
| `INV-7` | **Tax credit notes** for any reduction in output tax (return, discount, cancellation, correction), issued within 14 days, referencing the original invoice, with their own sequential series. | P1 |
| `INV-8` | Rounding to the nearest fils, mathematical rounding, two decimal places at rest, integer minor units in code. **BUILT** — reaffirmed as a requirement so it cannot be accidentally regressed. | P0 |
| `INV-9` | **E\-invoicing readiness — PINT AE.** The invoice data model is designed against the UAE PINT AE specification (Peppol International Invoice, built on UBL 2.1), which defines approximately **51 mandatory fields** for a standard tax invoice. Any field required by PINT AE that the current schema lacks is added **now**, populated **now**, and validated **now** — even though transmission is not yet required. Retrofitting mandatory fields onto historical invoices in 2027 is the expensive path. | P1 |
| `INV-10` | **Accredited Service Provider integration.** The UAE model is a decentralised Peppol 5\-corner (DCTCE) architecture: supplier → supplier's ASP → buyer's ASP → buyer, with tax data reported to the FTA in parallel and near real\-time. Both issuer and recipient must appoint an ASP. **Deadlines for this business (revenue \< AED 50m, therefore Phase 2): appoint an ASP by 31 March 2027; live by 1 July 2027.** Scope is B2B and B2G; B2C is currently excluded — so villa\-owner invoices stay out, and OA / developer / property\-manager / government invoices are in. Penalties run from AED 100 per invoice for transmission failure up to AED 5,000 per month, plus up to AED 5,000/month for failing to appoint an ASP. | P2 (delivery) / P1 (design) |
| `INV-11` | **VAT return pack:** output tax by period, input tax from recorded supplier invoices, adjustments, credit notes — exportable in the format the accountant files from. Quarterly periods, due within 28 days of period end. | P1 |
| `INV-12` | **AR ageing** by customer with current / 30 / 60 / 90\+ buckets and total exposure. **BUILT** — add a collections queue with next\-action and promised\-payment\-date tracking. | P1 |
| `INV-13` | **Statement of account** per customer, emailable, showing invoices, credit notes, payments and balance. | P2 |
| `INV-14` | **Bilingual document rendering.** There is **no legal requirement to issue UAE tax invoices in Arabic** — the Executive Regulations impose no Arabic mandate, and the Tax Procedures Executive Regulations permit English records, subject to the FTA's right to demand a certified Arabic translation. Therefore: English is the default, an Arabic\-bilingual layout is a **rendering option** on quotes, invoices and contracts, offered because it has commercial value with Arabic\-speaking clients and government bodies — not because it is compelled. | P2 |
| `INV-15` | **Retention: 7 years minimum**, records stored in the UAE. VAT requires 5 years from the end of the relevant tax period; Corporate Tax requires 7 years; extensions apply during disputes, audits and pending refunds. Seven years is the operating rule because it covers both. Storage region is a deployment constraint, not a preference — see the TRD. | P1 |
| `INV-16` | **Accounting export** — invoices, credit notes, payments, AR, in CSV and in a format the company's accountant can import. The system feeds an accountant; it does not replace one. *(Closes `MB-017`.)* | P2 |
| `INV-17` | **Corporate tax support pack:** revenue by tax period against the AED 3,000,000 Small Business Relief threshold, with an alert as revenue approaches it. This matters more than it looks: SBR is elected annually, tested on **revenue not profit**, and **breaching AED 3m once permanently disqualifies the business for all later periods**. A dashboard number that creeps past AED 3m without anyone noticing is a permanent, irreversible tax cost. | P2 |

* * *

### M8 — Customer portal

**Current state:** correct and safe but thin. Dashboard, raise request, quote approve/reject, all customer\-scoped by RESTRICTIVE RLS enforced in the database rather than in application code.

| ID | Requirement | Pri |
| --- | --- | --- |
| `POR-1` | Portal users see exactly their customer's data, enforced in the database. **BUILT** — proven by a 12\-check adversarial harness. Do not weaken. | P0 |
| `POR-2` | Raise request → creates a real job (`source = customer_portal`, `status = submitted`) with a customer\-visible reference. **BUILT.** | P0 |
| `POR-3` | **Request history and detail:** every request the customer has raised, with status, assigned visit window, outcome and evidence photos. *(Closes `PD-8`, `FR-7.3`.)* | P1 |
| `POR-4` | **Invoices in the portal:** issued invoices, amounts, due dates, payment status, downloadable PDF, statement of account. Stops finance emailing PDFs. | P1 |
| `POR-5` | **Customer notifications** on status change: request received, visit scheduled, technician en route, work complete, quote awaiting decision, invoice issued, payment received. Per\-event opt\-out. | P1 |
| `POR-6` | Quote approve/reject with reason, one action, audit\-logged. **BUILT.** | P0 |
| `POR-7` | **Contract view** for AMC customers: entitlements, consumed vs remaining, PPM schedule, next visit, renewal date. This is the single feature that makes an AMC feel worth its price. | P2 |
| `POR-8` | **Portal user management from the customer detail screen:** staff can grant, revoke and re\-invite portal access. Currently impossible without SQL. *(Closes `MB-014`.)* | P1 |
| `POR-9` | **Job evidence visible to the customer:** before/after photos, work performed, materials used, signed job sheet. This is the deflection mechanism — it answers "what did you actually do" before it is asked. | P2 |
| `POR-10` | Mobile\-first. Portal users are building managers with phones, not desks. | P1 |

* * *

### M9 — Recruitment / Applicant Tracking System

**Actors:** applicant, HR, operations manager, owner.
**Current state:** a static `/careers` marketing page. Nothing else.

**Design foundation.** The model separates three axes that must never be collapsed — collapsing them is the most common homegrown\-ATS defect:

1. **Stage** — where in the funnel (ordered, per\-role configurable).
2. **Status** — is this application live: `active` / `hired` / `archived` / `withdrawn`. Orthogonal to stage; you archive *from* a stage and must retain which stage the application died at, because that is the entire basis of funnel analytics.
3. **Disposition reason** — a controlled vocabulary attached to the archive event. Free text here destroys the module's analytical value and its defensibility.

| ID | Requirement | Pri |
| --- | --- | --- |
| `ATS-1` | **Job requisition:** trade, headcount, location, contract type, salary band, required certifications, required experience, opening/closing dates, hiring manager, approval state. | P1 |
| `ATS-2` | **Public job posting** rendered on the careers site with `JobPosting` JSON\-LD so postings are indexable by Google Jobs and citable by AI assistants. | P1 |
| `ATS-3` | **Application form — under 3 minutes, mobile\-first, one screen.** Roughly 60% of applicants abandon on length. Captures: name, phone (primary identifier in this market), email (optional), trade(s) from a controlled taxonomy, grade (helper / technician / senior technician / charge hand / supervisor), banded years of experience, current UAE location or "outside UAE", certifications, availability / notice period, driving licence, CV upload **optional with a structured fallback**. Many tradespeople have no CV; a CV\-mandatory form silently filters out good candidates. | P1 |
| `ATS-4` | **Certifications captured as structured records, not a text blob:** `{scheme, certificate/registration number, level, issuing body, issue date, expiry date, evidence file}`. **Expiry is the field everyone forgets** and it is the one that later blocks a dispatch (`HR-9`). Same entity as the technician certification record — modelled once, on the person, spanning ATS and field operations. | P1 |
| `ATS-5` | **Visa and permit status captured as an operational field, after shortlisting, never as a screening filter on the form.** In the UAE the employer sponsors the residence visa, so the status genuinely determines the hiring path and timeline — this is not the same situation as a right\-to\-work check elsewhere. Values: `own visa / spouse-sponsored`, `employment visa — transferable`, `employment visa — requires cancellation`, `outside UAE — requires entry permit`, `visit visa in UAE`. Rule: **collected at the Trade Check stage, applied to every shortlisted candidate uniformly, used for permit and timeline planning only.** Never used to auto\-filter, never asked on the public form. | P1 |
| `ATS-6` | **Do not capture, on the application form or anywhere:** date of birth (capture "over 18?" only), nationality, ethnicity, religion, marital status, children, gender, photograph, health or disability status, or any pre\-offer health questionnaire. Physical requirements are **stated in the job ad** and confirmed with a single "can you perform the essential functions, with or without reasonable adjustment? Y/N". Any medical fitness assessment happens **post\-conditional\-offer**, as part of the statutory visa medical, and its results live in the employee record — never the applicant record. | P1 |
| `ATS-7` | **Pipeline:** `Applied → Screening → Trade check → Interview / site trial → Offer → Onboarding docs → Hired`, with `Archived` \+ reason orthogonal at every stage. **Site trial is a first\-class stage type** — it is the trades equivalent of a technical assessment and is absent from generic ATS defaults. Cap at 12 stages. | P1 |
| `ATS-8` | **Blocked\-on indicator per applicant**, in the manner of a well\-designed pipeline: green \= up to date; **amber \= waiting on the candidate** (availability, documents, offer decision); **red \= waiting on us**. Falls back to time\-in\-stage where no structured activity exists (\< 2 days green, 2–5 amber, 5\+ red). This is the cheapest high\-value feature in the module — in a market where a good AC technician holds three offers, "who is blocking this" is the only question that matters. | P1 |
| `ATS-9` | **CV handling:** accept `.pdf .doc .docx .rtf .txt`, cap **10 MB**; accept `.jpg .png .heic` for certification evidence specifically, capped 20 MB, with server\-side HEIC conversion — trades candidates photograph their cards. **Asynchronous virus scanning** with an explicit per\-file `scan_status ∈ {pending, clean, infected, skipped}`; **downloads gated on scan status**; flagged files never attached to outbound staff email. Private object storage, no public URLs, short\-lived signed URLs generated per authenticated request. SHA\-256 stored per upload. MIME sniffed from magic bytes, never trusted from the client. | P1 |
| `ATS-10` | **CV parsing produces suggestions requiring confirmation, never the record of truth.** Parse failure is a frequent, first\-class state — trades CVs are often photographs. Retain the original file always; store `parse_status` and parser version so documents can be reprocessed. | P2 |
| `ATS-11` | **Duplicate handling, two tiers.** Loose matcher (phone **or** email, phone compared on local digits ignoring country code) *suggests* a duplicate for human review. Strict matcher (phone **and** email exact) may auto\-link. Candidate\-level data (name, current employer) collapses to one value with the **older profile winning**; application\-level data (stage, source, attachments, disposition) is preserved **per application**. Nothing is ever deleted by a merge — everything lands in the activity feed. | P2 |
| `ATS-12` | **Same person, different role** \= one candidate, N applications, each with independent stage and outcome. This is the core data shape: `Candidate 1—N Application`. **Same person, same role, again** \= consolidated under the candidate with prior outcome and disposition surfaced prominently, plus a configurable cool\-off flag on re\-application within N days of rejection. | P2 |
| `ATS-13` | **Talent pool as a separate entity from the pipeline.** A candidate is *in a pool* (by trade, area, certification status, availability), not *in a stage*. Requires: its own lawful basis — **consent**, captured and timestamped, for retention beyond the standard rejection window; a periodic re\-confirmation cycle, because a tradesperson's availability and certification validity go stale in weeks; and **certification\-expiry alerts as the pool's killer feature**. Candidates archived from late stages are auto\-tagged as strong prospects by disposition reason. | P2 |
| `ATS-14` | **Communications: SMS/WhatsApp first, email second.** For blue\-collar funnels email response rates are poor. Immediate acknowledgement on application. Interview confirmations carry site address, parking, PPE requirements and what to bring (certificates, tools), with one\-tap reschedule and reminders at 24 h and 2 h — no\-shows are the dominant loss in trades interviewing. | P1 |
| `ATS-15` | **Every automated message carries a minimum delay (≥ 1 day for rejections) so it can be cancelled** if the decision changes. Automated rejection is permitted only at the earliest stages (Applied, Screening); after any human interaction a human must send. Never auto\-reject within seconds of applying. | P1 |
| `ATS-16` | **Every applicant receives an outcome. Target 100% (`G14`).** Around 65% of applicants never or rarely hear back, and about 80% say they would not reapply to a company that ghosted them — in a referral\-driven trades market this compounds directly into hiring cost. Disposition reason maps to a message template, so "certifications not current" produces actionable feedback that often converts into a later re\-application. | P1 |
| `ATS-17` | **Hired applicant converts to a technician record in one action**, carrying across identity, trade, grade, certifications with their expiry dates, and documents. No re\-keying. The conversion is the point of the whole module. | P1 |
| `ATS-18` | **Applicant data retention: default 6 months from last meaningful interaction**, automated deletion job (not a policy document), with a separate longer clock once a candidate becomes an employee, and consent\-based extension for talent\-pool members. Deletions logged. Legal basis for processing applicant data without consent is the **pre\-contractual negotiation** exception under Federal Decree\-Law 45/2021, Article 4 — that basis covers the recruitment purpose and expires with it. | P1 |
| `ATS-19` | **No automated ranking, scoring or auto\-rejection of candidates.** A human decides every rejection after Screening. If scoring is ever introduced, log model version, inputs and output per decision from day one and keep a human in the loop. Cheap to honour now; very expensive to unwind later. | P1 |

* * *

### M10 — Workforce, HR and compliance

**Actors:** HR, operations manager, owner, accountant.
**Current state:** technician roster with skills (graded, verifier recorded) and certifications with expiry states driving assignment warnings — a good foundation. Everything statutory is absent.

| ID | Requirement | Pri |
| --- | --- | --- |
| `HR-1` | Technician roster: identity, trade(s), grade, employment status, start date, contact, emergency contact, assigned vehicle, van stock location. **Mostly BUILT.** | P0 |
| `HR-2` | Skills, graded, with a recorded verifier. **BUILT.** | P1 |
| `HR-3` | Certifications with issue and expiry dates and evidence documents; expiry states (`valid`, `expiring_soon`, `expired`) driving warnings. **BUILT** — extended by `HR-9`. | P0 |
| `HR-4` | **Employment record:** fixed\-term contract (UAE private\-sector contracts are fixed\-term only since Federal Decree\-Law 33/2021; the previous three\-year cap was removed in 2022, and a contract continued past expiry without renewal auto\-renews on the same terms), start date, end date, renewal date, probation end (max 6 months, non\-extendable), notice period (30–90 days), basic salary, allowances, working pattern. | P1 |
| `HR-5` | **Document register per employee** with expiry tracking and escalating alerts at T\-90 / T\-60 / T\-30 / T\-7 days: passport, residence visa, Emirates ID, **MOHRE labour card / work permit (2\-year standard validity)**, medical fitness certificate, health insurance policy, trade certifications, driving licence. | P0 |
| `HR-6` | **Health insurance is mandatory in Dubai** (Dubai Law No. 11 of 2013), employer\-funded, and the premium **may not be deducted from salary**. Workers earning under AED 4,000/month require an **Essential Benefits Plan**. Non\-compliance carries recurring monthly penalties and blocks visa processing. Tracked per employee with expiry alerting. | P1 |
| `HR-7` | **Leave management:** 30 calendar days annual leave after one year (2 days per month for 6–12 months' service); sick leave 15 days full pay, 30 days half pay, 45 days unpaid; public holidays; unpaid leave. Approved leave feeds the scheduler (`JOB-8`). Leave balances accrue and carry over per policy. | P1 |
| `HR-8` | **Time and attendance:** clock\-in/out from the field app, hours by rate band (standard / overtime / night / rest\-day), against the statutory maxima — 8 hours/day, 48 hours/week; overtime at basic rate **\+25%**; work between **22:00 and 04:00 at \+50%**; maximum 2 extra hours per day; rest\-day work compensated by a substitute day or \+50%. The system computes; it does not disburse. | P1 |
| `HR-9` | **Compliance\-gated dispatch.** Assignment is **hard\-blocked** — not warned — where the technician has an **expired work permit, expired residence visa, expired Emirates ID, expired medical fitness certificate, or expired health insurance**. Assignment is **warned** where a trade certification is expired or expiring within 30 days, and the override requires a reason (`JOB-10`). Rationale: employing or deploying a worker without a valid permit carries penalties of **AED 100,000 to AED 1,000,000** since the 2024 amendment to Article 60 of the Labour Law — multiplied by the number of workers in fictitious\-employment cases. Target `G15` is zero. This is the requirement that most justifies building the system at all. | P0 |
| `HR-10` | **Working\-time compliance monitoring:** flags any technician exceeding daily or weekly limits, any outdoor assignment inside the summer midday ban, and any missing statutory break. Reported weekly to the owner. | P1 |
| `HR-11` | **Work injury register.** A work injury or occupational illness must be **reported to MOHRE within 48 hours**. The employer pays all medical costs, full salary for 6 months, then half salary for a further 6 months if treatment continues. The system logs the incident, starts the 48\-hour clock with an alarm, records the report reference, and tracks the salary\-continuation obligation. | P1 |
| `HR-12` | **HSE records:** risk assessments / RAMS per job type, toolbox talks, PPE issue records, working\-at\-height certification. Dubai Municipality publishes numbered technical guidelines for ladders (TG\-73), mobile access towers (TG\-74), MEWPs (TG\-67), rope access (TG\-35), confined space (TG\-39), LPG cylinders (TG\-53), lifting equipment (TG\-48) and heat stress (TG\-38). Rope\-access work specifically requires **EIAC\-accredited third\-party certified personnel** (IRATA Level 1/2 for technicians, Level 3 for supervisors) — the clearest published competency standard and a good template for the others. | P2 |
| `HR-13` | **End\-of\-service gratuity accrual:** 21 days' basic pay per year for the first five years, 30 days per year thereafter, on **basic salary only** (excluding housing, transport, utilities and furniture allowances), capped at two years' total wages, minimum one year's continuous service, payable with all other dues **within 14 days** of termination. Accrued and visible as a liability so it is never a surprise. | P2 |
| `HR-14` | **Company accreditation register** (distinct from individual certifications): trade licence 930137 with its 23 January 2027 expiry, DEWA contractor enrolment category and grade, Dubai Municipality contractor classification, ISO certificates, third\-party liability insurance, workmen's compensation cover, Workers Protection Programme / bank guarantee. Each with expiry, document, renewal owner and escalating alerts. Feeds the tender pack (`CON-12`). | P1 |
| `HR-15` | **Employee record retention: minimum 2 years after termination of service** per Article 13 of the Labour Law. Payroll and tax\-relevant records follow the 7\-year rule in `INV-15`. Two clocks, both automated. | P1 |
| `HR-16` | **Recruitment costs are never recovered from workers.** Article 6 prohibits charging or collecting recruitment and employment fees from a worker, directly or indirectly. The system must make it structurally impossible to create a salary deduction of type "visa cost", "recruitment fee" or equivalent. Enforced as a validation rule with a plain\-language refusal, not a policy note. | P1 |
| `HR-17` | **WPS payroll calendar. The highest\-frequency compliance obligation in the business.** Since Ministerial Resolution No. 340 of 2026, effective 1 June 2026, wages for the previous month are due **on the 1st day of each Gregorian month** — replacing the older "within 15 days" practice. An establishment is compliant when it transfers **≥ 85% of total wages due** by the deadline. Escalation: **day 2** automated warnings; **day 5 new work\-permit issuance suspended**; **day 11** administrative fines and category downgrade; **day 16** automatic labour\-dispute registration; **day 21** executive orders and possible travel bans. The system therefore: counts down to the 1st with escalating alerts from T\-5 days; produces the wage file inputs (hours, overtime, absences, deductions) by T\-3; and alarms loudly on the 2nd if the transfer is unconfirmed. Target `G16` is 100%. | P1 |
| `HR-18` | **Emiratisation monitoring — with the correct denominator.** Targets apply to establishments with 50 or more **skilled** employees. "Skilled" requires ISCO occupational levels 1–5 **and** a post\-secondary certificate **and** a salary of at least AED 4,000/month. Manual and craft workers, drivers, security and cleaners are excluded from **both** the numerator and the denominator. A contractor with 60 tradesmen and 6 office staff is measured against the 6. The system computes the skilled headcount continuously and alerts as it approaches 50 — the failure mode is discovering the threshold was crossed a quarter ago. *(A separate rule applies to establishments with 20–49 employees in certain designated sectors; whether technical services is among them is `OPEN-4`.)* | P2 |
| `HR-19` | **Subcontractor / manpower supplier register** with licence, insurance, accreditation expiry and per\-worker permit verification, since responsibility for site compliance does not transfer with the work. | P3 |

* * *

### M11 — Technician field application

**Actors:** technician, supervisor.
**Current state:** does not exist. `job_signoffs`, `job_reports`, `job_attachments`, `job_materials`, `attendance_events` and `technician_locations` tables exist unused.

> **RECOMMENDATION — this reverses an earlier architecture decision.** The existing ADR selected an offline\-first PWA. Current research does not support that for the field app, and the reason is specific and decisive: **the Background Sync API is unsupported in Safari on every version, desktop and iOS.** A field app's core promise is *"finish the job in a basement; the data reaches the office when you walk outside, whether or not you reopen the app."* On iOS a PWA cannot keep that promise. Secondary blockers: WebKit proactively evicts script\-writable storage for origins with no user interaction for roughly seven days unless persistent storage is granted (it is granted heuristically, and installation to the home screen helps but does not guarantee it) — meaning unsynced job data can silently vanish over a holiday; push notifications require manual Add\-to\-Home\-Screen on iOS 16.4\+, a real drop\-off point for a non\-technical workforce; and Web NFC and Web Bluetooth are unavailable on iOS, which rules out asset\-tag scanning and instrument integration.
> 
> **Note one common claim is obsolete:** Safari has not capped web storage at 50 MB since iOS 17 — the current WebKit policy allows up to roughly 60% of disk per origin. Capacity is not the problem. **Eviction and background sync are.**
> 
> **Decision:** build the technician app as **React Native**, sharing the TypeScript domain layer in `packages/core`. Keep PWA for the adjacent surfaces where it genuinely fits — the dispatcher console, a customer "track my technician" page, and a customer sign\-off page opened on the customer's own phone. **This is `OPEN-1`, and it is the only architectural decision in this document that should be re\-litigated before implementation.**

| ID | Requirement | Pri |
| --- | --- | --- |
| `FLD-1` | **My jobs** — today and tomorrow, ordered by scheduled window, fully readable offline. The UI reads only from the local store, never from the network. | P2 |
| `FLD-2` | **Bounded offline working set**, explicitly scoped: this technician's jobs for today and tomorrow, their customers and properties, the assigned assets, the parts catalogue, the fault\-code taxonomy. Never "sync everything". | P2 |
| `FLD-3` | **Attendance and timing events**, append\-only: `en_route`, `arrived`, `started_work`, `paused` (\+ reason), `resumed`, `departed`. Each records **both the device timestamp and the server\-received timestamp** — device clocks are wrong and users change them; store both and flag divergence rather than trusting either. Travel time and on\-site time separated, because they cost differently. | P2 |
| `FLD-4` | **Safety gate:** the `started_work` action is blocked until the risk assessment / RAMS acknowledgement, permit\-to\-work reference (where required) and PPE confirmation are recorded. In this trade that is frequently a legal precondition, not a formality. | P2 |
| `FLD-5` | **Asset identification** by QR or barcode scan in preference to typing; falls back to selection from the property's asset register (`CON-13`). | P3 |
| `FLD-6` | **Fault capture:** reported fault (from the customer) and **diagnosed fault** as separate fields, both from controlled code lists, plus the symptom/cause/remedy taxonomy (`JOB-14`). | P2 |
| `FLD-7` | **Photos.** Role\-tagged: `before`, `after`, `defect`, `serial_plate`, `meter_reading`, `parts_used`, `site_access`. Minimum counts enforced per job type — at least one `before` and one `after` is the standard rule and the single strongest defence against a billing dispute or a callback claim. Compressed on\-device before queueing (longest edge 1920–2048 px, JPEG quality ≈ 0.75, target ≤ 1 MB); original retained locally until the compressed copy is confirmed synced. Chunked, resumable uploads. Client\-side thumbnails so the gallery renders instantly offline. **Wi\-Fi\-preferred by default with an always\-available "upload now over mobile data" override** — a technician who needs the office to see a photo *now* must never be blocked by a policy toggle. | P2 |
| `FLD-8` | **EXIF handled in three deliberate parts:** (a) capture geotag and timestamp where the photo is evidence; (b) **extract latitude, longitude, timestamp and orientation into structured database columns at capture** — EXIF is fragile, stripped by processing pipelines and invisible to queries; (c) **strip EXIF on every egress path** — customer copies, emailed reports, anything leaving the organisation, because embedded GPS in a domestic job photo leaks the customer's home coordinates. Honour the orientation tag before discarding it. In\-app capture only; never ingest from the camera roll. | P2 |
| `FLD-9` | **Materials used:** part, quantity, unit, source (`van_stock` / `purchased` / `customer_supplied`), serial where serialised. Scan to add. Works offline against the cached catalogue, with a free\-text escape hatch flagged for office reconciliation. | P2 |
| `FLD-10` | **Labour** derived from the timing events, overridable with a reason, split by rate band. Feeds both invoicing and `HR-8`. | P2 |
| `FLD-11` | **Job outcome and disposition** from the controlled list in `JOB-13`, with `no_access` and `customer_not_home` as fully supported paths that end the visit cleanly and schedule a return. | P2 |
| `FLD-12` | **Recommendations / follow\-up work identified** — a free field with an optional photo that raises a lead. Commercially the highest\-value field in the entire form: a technician on site is the cheapest sales channel the business has. | P2 |
| `FLD-13` | **Customer signature capture.** A simple electronic signature is legally sufficient for a job sheet; the courts' test is intention to be bound, not signature technology. Capture: signature stroke data (vector, not raster — smaller and richer), signer's **printed name, role/relationship to the site, and email** for the copy, device and server timestamps, technician identity, app version, and a **versioned consent statement rendered above the pad**. **`customer_not_available` is an explicit reason\-coded path with supervisor attestation** — never force a fake signature, which is what always happens when a signature is made mandatory. | P2 |
| `FLD-14` | **Evidential integrity: store a SHA\-256 hash of the exact rendered job sheet that was on screen at the moment of signing, plus an immutable PDF snapshot of it.** Without this the signature proves nothing, because "signed a job sheet" is meaningless if the job sheet is mutable afterwards. After signature the job record is **locked**; corrections happen only as a new, linked, reason\-coded amendment. Written to versioned, immutable object storage. A copy is emailed to the customer immediately — a contemporaneous unrebutted copy is powerful evidence and is also what customers want. | P2 |
| `FLD-15` | **Do not perform biometric signature verification.** Capturing the image and basic stroke geometry for rendering is fine; running stroke\-dynamics analysis for the purpose of uniquely identifying a person turns the signature into biometric data with a materially higher legal bar. Stated in the privacy notice. | P2 |
| `FLD-16` | **Location capture: discrete geo\-stamped events, not a continuous breadcrumb.** Stamp arrival, departure, job start, job completion, photo and signature. This satisfies proof of attendance and SLA verification at a fraction of the intrusion. Continuous tracking, if ever enabled, is **strictly shift\-bounded**, has a hard\-off for breaks, is never active outside working hours, and is disclosed in an always\-accessible in\-app "what we track" screen with a persistent visible indicator while collecting. Raw traces retained 30–90 days; the discrete job\-event stamps persist as part of the service record. Lawful basis is legitimate interest, documented, with a completed impact assessment — **not consent**, which is not freely given in an employment relationship. Location is **never** used for performance management or disciplinary inference without explicit prior disclosure of that use. | P2 |
| `FLD-17` | **Sync observability, technician\-facing and office\-facing.** The technician sees "3 items waiting · last synced 14:02" and can force a resync. The office sees per\-device queue depth, oldest unsynced item age, and dead\-letter count. A silently stuck queue is worse than a visible error, and field technicians will happily work for a week on a broken sync if nothing tells them. | P2 |
| `FLD-18` | **Push notification on assignment**, with the job reference, address, window and priority. | P2 |
| `FLD-19` | Certification\-blocked jobs (`HR-9`) never appear in a technician's list at all. The block is enforced at dispatch; the app simply never receives the work. | P2 |

* * *

### M12 — Platform administration, notifications and scheduled work

**This module is the definition of "MVP complete".** The audit's judgement stands: *there is no way to create a user, a tenant, or a recovered password without SQL.*

| ID | Requirement | Pri |
| --- | --- | --- |
| `ADM-1` | **Staff user management:** invite by email, assign role, deactivate, reactivate, unlock, force MFA reset with a documented identity\-verification procedure. Zero\-SQL user lifecycle. *(Closes `PD-1`, `FR-9.1`, `MB-008`.)* | P0 |
| `ADM-2` | **Password reset** by emailed single\-use, time\-limited token. *(Closes `PD-2`, `FR-2.5`, `MB-009`.)* | P0 |
| `ADM-3` | **Truthful lockout.** Today lockout is permanent and requires manual SQL, while the UI says "temporarily". Either implement time\-based decay or implement an admin unlock action — and in both cases make the copy match the mechanism. *(Closes `TD-5`, `MB-011`. The audit is right that a false UI promise is worse than the missing feature.)* | P0 |
| `ADM-4` | **Login IP throttle**, reusing the existing Postgres rate limiter built for the quote form. Account lockout protects one account; credential stuffing across many accounts is currently unthrottled. *(Closes `TD-7`, `MB-010`.)* | P0 |
| `ADM-5` | **Scheduled work — the single highest\-leverage infrastructure item in the document.** Today nothing runs on a schedule: notification dispatch piggy\-backs on two unrelated user actions, the rate\-limit sweep never runs, and SLA breach detection is therefore impossible. Required cron routes, secret\-gated: `/api/cron/dispatch` (drain the notification queue, alert on stuck), `/api/cron/sweep` (rate limits, expired sessions, expired quotes), `/api/cron/sla` (breach detection), `/api/cron/compliance` (document, certification, licence and contract expiry alerts), `/api/cron/contracts` (PPM visit generation, renewal reminders); `/api/cron/retention` (automated data\-retention purges); `/api/cron/health` (heartbeat — verifies every other cron ran, the meta\-check that makes the rest trustworthy). *(Closes `TD-4`, `FR-10.3`, `MB-003`.)* | P0 |
| `ADM-6` | **Notification templates** for every event in §12.1, with the transactional\-enqueue pattern already built (enqueue rolls back with its business record; ledgered dispatch with ≤ 5 attempts, retryable/terminal classification, stuck detection). Email transport activated. WhatsApp/SMS transport added for `LEAD-2`, `ATS-14` and technician dispatch. | P0 |
| `ADM-7` | **Audit log viewer** with entity, actor and date filters, able to reconstruct any record's history. The append\-only `audit_log` exists with UPDATE and DELETE revoked from the application role — it just has no reader. *(Closes `MB-018`.)* | P1 |
| `ADM-8` | **Read\-only auditor access** — time\-boxed, non\-mutating, scoped to financial records and the audit log, for an external accountant or auditor. Gives the `readonly` role a real purpose. | P2 |
| `ADM-9` | **Company identity in configuration, not source.** Legal name, trade licence number, Commercial Register number, TRN, address, phone, bank details, logo — loaded from environment configuration with a database fallback, editable in an admin screen by the `owner` role, with changes audit\-logged. *(Resolves `TD-9` in the direction chosen by DECIDED 1.)* | P1 |
| `ADM-10` | **Reference data administration:** services, rate card, fault codes, disposition reasons, exclusion lists, certification schemes, holiday calendar. Editable without a deploy — otherwise every taxonomy change is an engineering ticket, and taxonomies change constantly. | P1 |
| `ADM-11` | **Session behaviour.** Currently a fixed 12\-hour TTL with no sliding renewal, so staff are logged out mid\-shift at hour 12 and in\-progress form work is lost silently. Required: sliding renewal on activity with an absolute maximum, plus a warning banner before expiry and preservation of in\-flight form state. *(Closes `TD-12`.)* | P1 |
| `ADM-12` | **Onboarding and empty states.** Seed data was always present during development, so the first real week meets blank screens with no guidance. Every list screen gets a purposeful empty state that explains the next action. *(Closes `PD-7`.)* | P2 |

* * *

### M13 — Owner dashboard, analytics and observability

| ID | Requirement | Pri |
| --- | --- | --- |
| `KPI-1` | **Error monitoring and alerting** (Sentry or equivalent) across server actions and RSC, with release tagging. Alert rules: notification failures or stuck items \> 0, authentication lockout spike, rate\-limiter degraded\-mode log line, cron job missed, unhandled server\-action error rate. Today production failures are invisible. *(Closes `TD-3`, `MB-004`.)* | P0 |
| `KPI-2` | **Product event stream** — a tenant\-scoped `product_events` table in the same Postgres, RLS\-protected, plus a weekly SQL report. Events: quote\-form funnel, lead stage changes, job status changes, assignment\-warning overrides, quote sent/decided, invoice issued, payment recorded, portal actions, authentication events, ATS stage changes, field\-app sync health. Graduate to a dedicated pipeline only when volume demands it; do not bolt on a heavyweight analytics SaaS before the questions in §7 are being asked. | P1 |
| `KPI-3` | **Owner dashboard** — designed for a phone, read weekly: cash position and AR ageing; revenue this month vs last; pipeline value by stage; jobs open by priority with SLA status; SLA breaches this week; contracts expiring in 90 days; **compliance expiries in 90 days** (licence, permits, visas, certifications, insurance); open roles and days\-to\-hire; headcount and skilled\-headcount against the Emiratisation threshold; **revenue against the AED 3m Small Business Relief line**. | P1 |
| `KPI-4` | **Uptime monitoring** on the public site, the quote form, the portal and the cron health endpoint. | P1 |
| `KPI-5` | **Weekly digest email** to the owner containing the dashboard as text, so the number arrives whether or not anyone logs in. The audit's `PD-6` finding — the buyer sees no weekly value — is closed by this one email, not by the dashboard. | P2 |

* * *

## 9\. Non\-functional requirements

| Area | Requirement | Current state |
| --- | --- | --- |
| **Performance** | Public pages static/CDN. App pages \< 1.5 s p95 in\-region. Field app screens render from local store in \< 200 ms regardless of connectivity. | Public ✅; app acceptable but unmeasured — add RUM |
| **Scalability** | 30 staff, 60 technicians, 5,000 jobs/year, 500 customers, 2,000 properties, 10,000 assets without redesign. | Plausible; unbounded list queries fail first (`LEAD-8`) |
| **Availability** | Emergency page and phone path: 24/7, statically served, no database dependency. Back office: business\-hours critical. Field app: **functional with zero connectivity** — this is the hardest availability requirement in the system. | Emergency page ✅; field app not built |
| **Security** | Tenant isolation provable in the database; OWASP Top 10 addressed; CSP shipped; credentials rotated; login throttled; monitoring live. | Foundations above norm; operational gaps are P0 |
| **Privacy** | PDPL\-aligned. Documented lawful basis per processing purpose. Automated retention clocks. Data\-subject access, correction and erasure supported, including object\-storage files. | Minimal PII today; no retention policy — `WEB-10`, `ATS-18`, `HR-15`, `FLD-16` |
| **Data residency** | Electronic tax records **retained in the UAE** and accessible to the authorities. This constrains the hosting decision and is not negotiable. See TRD §4. | Currently Singapore region — **must change**, `OPEN-2` |
| **Accessibility** | WCAG 2.2 AA. Contrast gate CI\-enforced across all pairings. Keyboard traversal and screen\-reader audit performed and re\-run per release. Field app: usable in bright sunlight, with gloves, one\-handed. | Contrast ✅; keyboard/SR audit never done |
| **Localisation** | English operator UI. AED, `Asia/Dubai`. Arabic as a document rendering option (`INV-14`). Dates `DD MMM YYYY`; money `AED 1,234.56`. | English\-only ✅ |
| **Maintainability** | Typed end to end; workspace boundaries with `core` holding zero runtime dependencies; full check runnable in one command. | ✅ genuinely good |
| **Observability** | Errors, queues, SLAs and sync health visible to the people operating the system. | ❌ none — P0 |
| **Disaster recovery** | Point\-in\-time restore with a **documented and rehearsed** restore drill. An untested backup is a hypothesis. | PITR exists at platform level; never drilled |
| **Auditability** | Append\-only audit log covering every mutation of a financial, employment or compliance record, with actor and timestamp, readable by an auditor. | Log ✅; viewer ❌ |

* * *

## 10\. Prioritisation and release plan

### Phase 0 — Stabilise *(days, not weeks — do this before any new feature)*

`ADM-5` crons · `KPI-1` error monitoring · `WEB-9` CSP · `ADM-4` login throttle · credential rotation · CI on every push · `WEB-2` content truth pass · `WEB-14` licence display.

**Definition of done:** queued notifications drain on a schedule; errors reach a human; no fabricated claim is reachable in production; every push runs typecheck, 11 test suites, the RLS proof harness and the contrast gate.

> The audit's judgement holds and is worth repeating: *one hour of CI beats any feature on this backlog for expected value.*

### Phase 1 — Operable *(2–4 weeks)* — "run a real week with zero SQL"

`ADM-1` `ADM-2` `ADM-3` `ADM-9` `ADM-10` `ADM-11` · `LEAD-2` `LEAD-3` · `JOB-5` `JOB-6` · `QTE-3` · `INV-3` `INV-4` `INV-5` `INV-6` `INV-7` `INV-15` · `HR-5` `HR-9` `HR-14` · `POR-8`.

**Definition of done:** a new staff member can be invited, locked out, recovered and MFA\-reset without a database client; a real tax invoice passes an accountant's review; a new lead emails the operations manager within five minutes; a technician with an expired permit **cannot be dispatched**; no job is scheduled into the summer midday ban.

### Phase 2 — Complete the business *(4–6 weeks)*

M3 contracts and AMC (`CON-1`…`CON-10`) · M9 recruitment (`ATS-1`…`ATS-19`) · `HR-4` `HR-6` `HR-7` `HR-8` `HR-17` · `POR-3` `POR-4` `POR-5` · `LEAD-5` `LEAD-8` `LEAD-9` · `KPI-2` `KPI-3` `KPI-5` · `ADM-7` `ADM-12`.

**Definition of done:** an AMC generates its own PPM visits and warns before renewal; an applicant applies on a phone in under three minutes and always receives an outcome; the owner reads one weekly email that answers "is the business healthy".

### Phase 3 — Field execution *(6–10 weeks)*

M11 field app in full · `JOB-7` schedule view · `JOB-8` availability\-aware assignment · `JOB-13` `JOB-14` outcome and fault codes · `POR-9` evidence in portal · `CON-13` asset register.

**Definition of done:** a technician works a full day with no connectivity and loses nothing; every completed job carries before/after photos, materials, labour and a signed job sheet; first\-time\-fix rate is measured.

### Phase 4 — Projects and scale

M5 projects in full · `CON-11` `CON-12` tenders · `INV-10` ASP integration **(hard external deadline: appoint by 31 March 2027, live by 1 July 2027)** · `INV-16` `INV-17` · `HR-13` `HR-18` `HR-19` · load baseline · staging environment.

### Explicit non\-recommendations *(carried forward from the audit, still correct)*

Do **not**\: rewrite to microservices — the workspace boundaries already provide the seams; adopt a heavyweight authentication SaaS — the existing auth is tested and owned, and the gap is flows not cryptography; introduce Redis or a queue service for notifications — Postgres claim\-with\-`SKIP LOCKED` plus cron covers this scale honestly; redesign the UI — it is coherent, so fill the missing states rather than reskin; build AI features before the data exists to ground them.

* * *

## 11\. Compliance requirements register

**This section is a requirements source, not background reading.** Each row is a system behaviour with a deadline and a penalty. It is placed after the functional requirements so it can be read as the justification for the ones that look expensive.

> **Not legal or tax advice.** Every item here should be confirmed with a UAE\-registered tax agent and a UAE employment lawyer before the system is relied upon. Items marked ⚠ were not confirmed against a primary source during research and are the ones to verify first.

### 11\.1 Tax and invoicing

| Obligation | Requirement | Deadline | Penalty | Implements |
| --- | --- | --- | --- | --- |
| VAT registration | Mandatory once taxable supplies exceed **AED 375,000** (voluntary at AED 187,500), tested on a rolling 12 months or expectation of crossing within 30 days; apply within 30 days | Immediate at this revenue | AED 10,000 late registration | Business action; TRN feeds `INV-3` |
| Tax invoice content | Full Article 59 field set | Every invoice | AED 2,500 for failure to issue | `INV-3` |
| Issuance window | Within **14 days** of date of supply | Every invoice | AED 2,500 | `INV-5` |
| Sequential numbering | Unique, traceable, gaps are an audit flag | Continuous | Audit exposure | `INV-4` |
| Credit notes | Within 14 days, referencing the original | Per event | AED 2,500 | `INV-7` |
| Simplified invoices | Permitted where recipient unregistered, or registered with consideration ≤ AED 10,000. **Abolished once e\-invoicing applies** | Until 1 Jul 2027 | — | `INV-6` |
| VAT returns | Quarterly, within 28 days of period end | Quarterly | Late\-filing penalties | `INV-11` |
| **E\-invoicing (Phase 2)** | **Appoint an Accredited Service Provider** | **31 March 2027** | Up to AED 5,000/month | `INV-10` |
| **E\-invoicing go\-live** | **PINT AE (UBL 2.1 XML) via Peppol 5\-corner, B2B and B2G** | **1 July 2027** | From AED 100/invoice, up to AED 5,000/month | `INV-9`, `INV-10` |
| Corporate Tax | 0% to AED 375,000 taxable income, 9% above. Natural persons (including sole establishments) taxable once turnover exceeds AED 1m in a calendar year; registration by 31 March of the following year | Annual | AED 10,000 late registration | `INV-17` |
| Small Business Relief | Revenue ≤ **AED 3,000,000**, **elected annually in the return**, available for periods ending on or before 31 December 2029. **One breach permanently disqualifies later periods** | Annual | Loss of relief | `INV-17` |
| Record retention | 5 years (VAT) / **7 years (Corporate Tax)**; extensions during disputes, audits and pending refunds; **records retained in the UAE** | Continuous | AED 10,000, AED 20,000 on repeat | `INV-15`, NFR data residency |
| Licence number display | Commercial Register number on invoices, quotes, printed material **and the website** | Continuous | — | `WEB-14` |

### 11\.2 Language

**There is no requirement to issue UAE tax invoices in Arabic.** The VAT Executive Regulations impose no Arabic mandate, and the Tax Procedures Executive Regulations provide that the FTA accepts records in English, subject to its right to require a certified Arabic translation within a specified period. Arabic rendering is therefore a **commercial feature** (`INV-14`), and the operational requirement is only that the system can produce a translation on demand.

### 11\.3 Employment

| Obligation | Requirement | Penalty | Implements |
| --- | --- | --- | --- |
| Work permit validity | No deployment of a worker without a valid permit | **AED 100,000 – AED 1,000,000**, multiplied by worker count for fictitious employment | `HR-9` **hard block** |
| **WPS payment date** | Wages due **on the 1st of each Gregorian month**; ≥ 85% of wages transferred | Day 5: permits suspended. Day 11: fines \+ downgrade. Day 16: auto labour disputes. Day 21: executive orders, possible travel bans | `HR-17` |
| **Summer midday ban** | No outdoor work in direct sun **12:30–15:00, 15 June – 15 September** | **AED 5,000 per worker**, capped AED 50,000, plus company downgrade | `JOB-6` **hard block** |
| Working hours | 8 h/day, 48 h/week; ≥ 1 h break after 5 consecutive hours; Ramadan reduced by 2 h/day | Labour claim exposure | `JOB-6`, `HR-8`, `HR-10` |
| Overtime | Basic rate **\+25%**; 22:00–04:00 **\+50%**; max 2 extra hours/day; rest\-day work \= substitute day or \+50% | Labour claim | `HR-8` |
| Contract form | Fixed\-term only; auto\-renews on the same terms if performance continues past expiry | Dispute exposure | `HR-4` |
| Probation | Max 6 months, non\-extendable; 14 days' notice by employer | — | `HR-4` |
| Notice | 30–90 days post\-probation | — | `HR-4` |
| Annual leave | 30 calendar days after 1 year; 2 days/month for 6–12 months; ≥ 1 month's notice of leave dates | — | `HR-7` |
| Gratuity | 21 days' basic per year (first 5), 30 days thereafter; basic salary only; capped at 2 years' wages; paid **within 14 days** of termination | Labour claim | `HR-13` |
| Health insurance | Mandatory in Dubai, employer\-funded, **not deductible from salary**; Essential Benefits Plan below AED 4,000/month | AED 500 – 150,000 monthly; blocks visas | `HR-6` |
| Work injury | Report to MOHRE **within 48 hours**; all medical costs; full salary 6 months then half for 6 more | Statutory liability | `HR-11` |
| Recruitment costs | **Never** charged to or recovered from a worker, directly or indirectly | Statutory prohibition | `HR-16` structural block |
| Employee records | Retained **≥ 2 years** after termination | — | `HR-15` |
| Claim limitation | 2 years from termination; MOHRE decisions binding under AED 50,000 | — | Evidence retention |
| Emiratisation | Thresholds apply at **50\+ skilled employees** (skilled \= ISCO 1–5 **and** post\-secondary certificate **and** ≥ AED 4,000/month); manual and craft workers excluded from both numerator and denominator | \~AED 9,000/month per unfilled post | `HR-18` |
| ILOE | Mandatory for the employee, employee\-paid; unpaid fines block permit renewals in practice | AED 400 on the worker | `HR-5` verification at onboarding |
| Worker protection | Workers Protection Programme insurance **or** the AED 3,000 per\-worker bank guarantee | Practically compulsory | `HR-14` |

### 11\.4 Sector licensing and safety

| Obligation | Requirement | Status | Implements |
| --- | --- | --- | --- |
| **Dubai Law No. 7 of 2025 (contracting sector)** | Unified Contractors Register at Dubai Municipality, classification, work within classification limits, **prior approval for subcontracting**, and **professional competency certificates from Dubai Municipality for technical personnel** | In force \~January 2026 with a one\-year grace period → **\~January 2027**. ⚠ Whether small technical\-services/maintenance firms are in scope, and whether "technical personnel" reaches tradesmen or only engineers, is **`OPEN-3` — the highest\-priority unknown in this document** | `HR-14`, `PRJ-9` |
| Penalties under that law | AED 1,000 – AED 100,000, **doubling to AED 200,000** on repeat within a year; plus suspension, classification downgrade, register removal, licence revocation | — | — |
| DEWA contractor enrolment | Company\-level enrolment required for work touching supply, meters, circuits or main boards; categories include Electrical and Fit\-out; graded Platinum/Gold/Silver/Bronze on past performance | Applies now | `HR-14`, `CON-12` |
| Dubai Municipality HSE | Technical guidelines for ladders, mobile towers, MEWPs, rope access, confined space, LPG, lifting equipment, heat stress. Rope access requires **EIAC\-accredited third\-party certified** personnel (IRATA L1/L2 technicians, L3 supervisors) | Applies now | `HR-12`, `FLD-4` |
| Fit\-out permits | Contractor applies; tenant appointment letter, EJARI, stamped drawings, authority NOCs, Civil Defence completion certificate. AED 0.90/ft² (min 200, max 10,000), \~2 working days | Per project | `PRJ-6` |
| Gas / LPG | Regulated by the Dubai Supreme Council of Energy; installation governed by the UAE Fire and Life Safety Code via Dubai Civil Defence. ⚠ Contractor registration and individual gas\-fitter certification requirements **unconfirmed** | ⚠ **Verify with DCD before quoting any LPG work.** Highest regulatory risk in the licensed scope | `OPEN-5` |

### 11\.5 Data protection

Federal Decree\-Law No. 45 of 2021 (PDPL) is **in force**, but its Executive Regulations have **still not been issued** as of August 2026, no penalties are yet codified, and the regulator is not fully operational. Organisations will have **six months to comply once the Regulations are published**.

**Posture:** build to the law's shape now — it is cheap while the system is small and expensive later. Specifically: document a lawful basis per purpose (**employment obligation** for employee data; **pre\-contractual negotiation** for applicant data; **contract performance** for customer data; **legitimate interest, with an impact assessment**, for technician location); maintain a record of processing; implement retention clocks as automated jobs rather than policy documents; support access, correction, erasure and portability including files in object storage; and be careful about cross\-border transfers, since the adequacy list is still pending — which is a further argument for UAE data residency.

**Biometric caution:** signature stroke dynamics analysed for identification, and biometric time\-and\-attendance, are the two features in this product most likely to cross into a higher\-risk processing category. `FLD-15` declines the first. The second is not specified.

* * *

## 12\. Notifications catalogue

Every notification must have: a trigger, a recipient rule, a channel, a template, and a suppression rule. The transactional\-enqueue pattern (enqueue rolls back with its business record) is already built and is used for all of them.

### 12\.1 Catalogue

| Trigger | Recipient | Channel | Priority |
| --- | --- | --- | --- |
| Lead created | Ops manager, routed by service family | Email \+ WhatsApp | P0 |
| Lead created, emergency flagged | Ops manager \+ owner | WhatsApp \+ email, distinct tone | P0 |
| SLA response breach imminent (T\-30 min) | Assigned owner \+ ops manager | Email | P0 |
| SLA breached | Ops manager \+ owner | Email \+ WhatsApp | P0 |
| Job assigned | Technician | Push (field app) \+ SMS fallback | P2 |
| Job status → en route | Customer | Email/SMS | P1 |
| Job completed | Customer, with job sheet | Email | P1 |
| Quote sent | Customer | Email with PDF \+ portal link | P0 (built) |
| Quote decided | Sales \+ ops | Email | P1 |
| Quote expiring in 3 days | Customer \+ sales | Email | P2 |
| Invoice issued | Customer, with PDF | Email | P0 (built) |
| Invoice overdue at 7 / 30 / 60 days | Customer \+ accountant | Email | P1 |
| Payment recorded | Customer receipt | Email | P2 |
| Un\-invoiced signed\-off job at day 10 | Accountant | Email | P1 |
| Contract renewal at T\-90 / 60 / 30 / 7 | Owner \+ sales | Email | P1 |
| PPM visit due for scheduling | Dispatcher | In\-app queue | P1 |
| **Employee document expiring at T\-90 / 60 / 30 / 7** | HR \+ owner | Email | P0 |
| **Company accreditation expiring at T\-90 / 60 / 30 / 7** | Owner | Email | P0 |
| **WPS payroll countdown from T\-5 days** | Owner \+ accountant | Email, escalating | P0 |
| **WPS transfer unconfirmed on the 2nd** | Owner | WhatsApp \+ email, alarm tone | P0 |
| Work injury logged — 48\-hour MOHRE clock | Owner \+ HR | WhatsApp \+ email | P0 |
| Application received | Applicant | SMS/WhatsApp \+ email | P1 |
| Application stage change | Applicant | SMS/WhatsApp | P1 |
| Interview scheduled / reminder at 24 h and 2 h | Applicant | SMS/WhatsApp | P1 |
| Application outcome (always) | Applicant | SMS/WhatsApp \+ email | P1 |
| New application received | HR | Email digest, or immediate for priority roles | P1 |
| Notification queue stuck | Owner \+ engineering | Email | P0 |
| Cron job missed | Engineering | Email | P0 |
| Error rate spike / lockout spike | Engineering | Email | P0 |

### 12\.2 Rules

- **Every automation carries a cancellable delay.** Rejections wait at least a day.
- **Digest, don't drip.** Non\-urgent staff notifications batch into a digest. One alert per event per recipient per hour, maximum.
- **Suppression by role and by event**, respected everywhere. A person who mutes contract renewals must stop receiving contract renewals.
- **Failure is visible.** A notification that exhausts its retries appears in an operator\-facing queue, not only in a log.

* * *

## 13\. Traceability — audit findings closed by this document

| Audit finding | Closed by | Status |
| --- | --- | --- |
| §22 strategic fork unresolved | DECIDED 1 | ✅ Closed |
| `PD-1` no admin surface | `ADM-1` `ADM-2` `ADM-3` | Phase 1 |
| `PD-2` no password reset | `ADM-2` | Phase 1 |
| `PD-3` nobody notified of leads or SLA breaches | `LEAD-2` `JOB-5` | Phase 0/1 |
| `PD-4` no quote/invoice PDF, no VAT fields | `QTE-3` `INV-3` | Phase 1 |
| `PD-5` fabricated marketing claims | `WEB-2` `WEB-14` — real licence 930137 and real activity list | Phase 0 |
| `PD-6` owner persona unserved | `KPI-3` `KPI-5` | Phase 2 |
| `PD-7` no onboarding / empty states | `ADM-12` | Phase 2 |
| `PD-8` thin portal | `POR-3`…`POR-9` | Phase 2 |
| `PD-9` contracts invisible | M3 in full | Phase 2 |
| `PD-10` no technician interface | M11 in full | Phase 3 |
| `PD-11` silent duplicates and silent overrides | `LEAD-5` `JOB-10` | Phase 1/2 |
| `PD-12` English only | Scoped decision §6.2 \+ `INV-14` | ✅ Decided |
| `TD-1` exposed credentials | Phase 0 rotation | Phase 0 |
| `TD-2` no CI | Phase 0 | Phase 0 |
| `TD-3` no error monitoring | `KPI-1` | Phase 0 |
| `TD-4` no scheduler | `ADM-5` | Phase 0 |
| `TD-5` permanent lockout, false copy | `ADM-3` | Phase 0 |
| `TD-6` no CSP | `WEB-9` | Phase 0 |
| `TD-7` no login IP throttle | `ADM-4` | Phase 0 |
| `TD-8` manual migrations | TRD §12.2 (`OPS-1`, `OPS-2`) | Phase 0 |
| `TD-9` hardcoded tenant identity | `ADM-9` — now a correct simplification, moved to config | Phase 1 |
| `TD-10` unbounded lists | `LEAD-8` | Phase 2 |
| `TD-11` 14 unused tables | M3, M5, M11 build on most of them; the register in TRD §6 marks each build\-or\-drop | Phases 2–4 |
| `TD-12` fixed session TTL | `ADM-11` | Phase 1 |
| `TD-13` `failed_login_count` as varchar | TRD §6 migration | Phase 1 |
| `TD-14` dead `pdf_storage_key` | `QTE-3` `INV-3` populate it | Phase 1 |
| `TD-15` duplicated form styles | Design doc §7 shared form kit | Phase 2 |
| `TD-16` orphan cloud resources | Phase 0 inventory | Phase 0 |
| `TD-17` non\-hermetic tests | TRD §11.1 (`CI-2`) — CI service container | Phase 0 |
| `MB-020` competitive scan never done | §4 of this document | ✅ Closed |
| Untraceable `readonly` / `supervisor` roles | P4 supervisor queue, P10 auditor access (`ADM-8`) | ✅ Given purpose |

* * *

## 14\. Open questions

These require a human answer. Each has an owner and a point at which it blocks.

| \# | Question | Owner | Blocks | Recommendation |
| --- | --- | --- | --- | --- |
| `OPEN-1` | Field app: React Native (recommended, §M11) or PWA (existing ADR)? | Owner \+ engineering | Phase 3 start | **React Native.** iOS Safari has no Background Sync at any version, and WebKit evicts unsynced storage after \~7 days of no interaction. The failure mode is silent data loss on a technician's phone. |
| `OPEN-2` | Hosting region — tax records must be **retained in the UAE**. Current deployment is Singapore. | Owner \+ engineering | Phase 1 (before real invoices exist) | Move the database to a UAE region, or add UAE\-resident archival storage for tax records with a documented retrieval path. Confirm the precise scope of "retained in the UAE" with a tax agent. |
| `OPEN-3` | **Does Dubai Law No. 7 of 2025 apply to this business, and does "technical personnel" include tradesmen?** If yes, every electrician and AC technician needs a Dubai Municipality professional competency certificate by roughly January 2027. | Owner | `HR-14` scope; potentially the whole hiring model | **Verify with Dubai Municipality directly, this month.** Highest\-consequence unknown in the document. |
| `OPEN-4` | Is technical services among the designated sectors for the 20–49 employee Emiratisation rule? Sources conflict. | Owner | `HR-18` thresholds | Confirm with MOHRE. Assume in scope until told otherwise. |
| `OPEN-5` | Does Dubai Civil Defence require contractor registration or individual certification for gas/LPG installation work? | Owner | Whether gas work is quoted at all | **Confirm with DCD before quoting any LPG work.** Least\-documented, highest\-risk area of the licensed scope. |
| `OPEN-6` | Which Accredited Service Provider for e\-invoicing? 32\+ are accredited. | Owner \+ accountant | 31 March 2027 | Shortlist by December 2026. Selection criterion: API quality and PINT AE coverage, not price. |
| `OPEN-7` | Is the business VAT\-registered, and what is the TRN? | Owner | `INV-3` — every invoice | Mandatory above AED 375,000 turnover. If not registered, this is the most urgent item on the list. |
| `OPEN-8` | Working week — Saturday–Sunday weekend, and what are the standard hours? Emergency cover pattern? | Owner | `JOB-6` calendar | Configure once, in `ADM-10`. |
| `OPEN-9` | Which trades are hired directly versus supplied by manpower agencies? | Owner | ATS scope, `HR-19` | Affects whether M9 is the primary hiring path or one of two. |
| `OPEN-10` | Real domain name and email sending domain, with SPF/DKIM/DMARC. | Owner | All email notifications | Blocks Phase 0 notification delivery. |

* * *

## 15\. What this document changes about how the product gets built

The audit's process retrospective concluded: *"the things code cannot validate must be validated by someone, and nobody was assigned."* Three assignments follow from this document.

1. **Compliance has an owner.** §11 is a live register, reviewed quarterly, with `OPEN-3`, `OPEN-5` and `OPEN-7` resolved before Phase 1 ships. Regulations move — the e\-invoicing deadline and the WPS payment date both changed within the last twelve months.
2. **Content truth has an owner.** Every public claim traces to evidence, and the licence number displayed is real and re\-verified before its 23 January 2027 expiry.
3. **The definition of MVP is written down and it is not "the demo works".** It is: *run one real operating week — hire, dispatch, invoice, get paid, stay compliant — without opening a database client.* That definition is what forces admin, password reset, PDFs, crons and compliance blocking into scope, which is precisely what the first build missed.

Everything else about how the first build was done — row\-level\-security\-first design, integer money, enforced state machines, tests against real Postgres, architecture decision records written as decisions are made — was right, and should not change.
