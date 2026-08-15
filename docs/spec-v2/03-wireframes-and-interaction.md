# Wireframe & Interaction Document

## SATS Operations Platform — v2.0

**Companion to:** `01 — Product Requirements Document` and `02 — Technical Requirements Document`.
**Date:** 12 August 2026

* * *

## 0\. How to read these wireframes

These are **low\-fidelity structural wireframes**. They specify layout, hierarchy, content order, states and interaction — not pixels, colour or typography. Those live in `04 — Design System & UX Document`.

**Conventions used throughout:**

```
┌─────┐   container / panel boundary
│     │
├─────┤   section divider
[Button]  primary action
(Button)  secondary action
‹Button›  destructive action
▸ / ▾     collapsed / expanded disclosure
◉ ○       radio selected / unselected
☑ ☐       checkbox
▰▰▱▱      progress or capacity meter
●         status dot (colour carries meaning; never colour alone — always paired with a label)
⚠         warning
⛔        hard block
…         truncated content
{field}   dynamic value
```

**Three rules govern every screen in this document,** carried forward from the existing product because they are the reason it works:

1. **Consequence order, not data order.** Lists sort by what will hurt most if ignored. The dispatch board sorts by SLA damage; the customers list leads with money at risk; certification alerts surface before assignment.
2. **Every state is specified.** Loading, empty, error, partial, permission\-denied and success. The audit found empty states missing across the app because seed data was always present in development — that is the failure this section exists to prevent.
3. **Never lose the enquiry, never blame the user.** Every failure path ends in a phone number or a plain\-language instruction. No raw error text ever reaches a screen.

* * *

## 1\. Information architecture

### 1\.1 Route map

```
(marketing)   static / SSG · site-header + site-footer shell
  /                              home
  /services                      index
  /services/[slug]               × 10 licensed activities  ← was 24; see WEB-1
  /areas  /areas/[slug]          service areas (reduced to deliverable list)
  /rates                         NEW — published AED schedule of rates (WEB-16)
  /contracts                     AMC and PPM offering
  /projects                      NEW — fit-out and installation
  /emergency                     24/7, static, no DB dependency
  /reviews                       NEW — customer reviews (WEB-17)
  /about  /contact  /privacy  /terms
  /quote                         consumer enquiry form
  /enquiry/contract              NEW — contract & tender enquiry (WEB-11)
  /careers                       NEW — role listing
  /careers/[slug]                NEW — role detail + apply
  /careers/apply/[slug]          NEW — application form
  /application/[token]           NEW — applicant status (magic link, no account)
  robots.txt · sitemap.xml · llms.txt

(app)         staff · force-dynamic · AppShell
  /login  /login/verify  /security  /denied
  /forgot-password  /reset-password/[token]      NEW
  /dispatch                      the SLA queue — default staff landing
  /schedule                      NEW — calendar / technician lanes
  /jobs  /jobs/[id]
  /leads  /leads/[id]
  /customers  /customers/[id]
  /contracts  /contracts/[id]    NEW
  /projects  /projects/[id]      NEW
  /technicians  /technicians/[id]
  /workforce                     NEW — compliance board
  /recruitment                   NEW — ATS pipeline
  /recruitment/[requisition]     NEW
  /recruitment/candidate/[id]    NEW
  /invoices  /invoices/[id]
  /reports                       NEW — owner dashboard
  /admin/users                   NEW
  /admin/company                 NEW
  /admin/reference               NEW
  /admin/audit                   NEW
  /admin/notifications           NEW — queue health

(portal)      customer · force-dynamic · PortalShell
  /portal                        dashboard
  /portal/request                raise a request
  /portal/requests  /portal/requests/[id]        NEW
  /portal/quotes/[id]
  /portal/invoices  /portal/invoices/[id]        NEW
  /portal/contract                               NEW

(field)       technician · React Native
  Today · Job detail · Capture · Sign-off · Timesheet · Sync · Profile
```

### 1\.2 Role landing and navigation

| Role | Lands on | Navigation |
| --- | --- | --- |
| `owner` | `/reports` | Everything |
| `admin` | `/admin/users` | Admin section (users, company, reference data, audit, notifications) plus read access elsewhere |
| `operations_manager` | `/dispatch` | Dispatch · Schedule · Jobs · Leads · Customers · Contracts · Projects · Technicians · Workforce · Invoices · Reports |
| `dispatcher` | `/dispatch` | Dispatch · Schedule · Jobs · Customers · Technicians |
| `supervisor` | `/dispatch` (filtered to own crew) | Dispatch · Schedule · Jobs · Projects |
| `sales` | `/leads` | Leads · Customers · Contracts · Quotes |
| `accountant` | `/invoices` | Invoices · Customers · Contracts · Reports |
| `hr` | `/recruitment` | Recruitment · Workforce · Technicians |
| `technician` | field app | — |
| `customer` | `/portal` | Portal only |
| `readonly` | `/invoices` | Invoices · Customers · Audit — **read\-only, no mutating controls rendered at all** |

> **CHANGE from the current build.** Today every staff role lands on the same dispatch board and shares one navigation. That was acceptable at the original scope. With eleven roles and eight new modules it is not: an accountant should not have to scan past the dispatch queue to reach invoices. Navigation is now role\-filtered, and `readonly` renders no mutating controls rather than rendering\-then\-refusing them.

* * *

## 2\. Marketing site

### 2\.1 Service page — `/services/[slug]`

The most important page type on the site: it is both the conversion surface and the highest\-weighted localised\-organic ranking factor.

```
┌──────────────────────────────────────────────────────────────────┐
│ [LOGO]      Services ▾  Areas ▾  Contracts  Projects  Rates      │
│             About  Reviews  Contact          ☎ 04 XXX XXXX       │
│                                              [Get a quote]       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  EYEBROW: Licensed activity                                      │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  H1  {Service name} in Dubai                               │  │
│  │                                                            │  │
│  │  One paragraph, written as a direct answer to the          │  │
│  │  question the visitor actually typed. No marketing         │  │
│  │  preamble. This is the paragraph an AI assistant lifts.    │  │
│  │                                                            │  │
│  │  [Get a quote]   (Call now — emergency 24/7)               │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│  ANSWER BLOCKS — one question per block, question as H2          │
│                                                                  │
│  H2  What does {service} cost in Dubai?                          │
│      ┌──────────────────────────────────────────────────────┐    │
│      │ Item                          Rate (AED, excl. VAT)  │    │
│      │ Callout (first hour)          {from rate card}       │    │
│      │ Additional hour               {from rate card}       │    │
│      │ After-hours / emergency       {from rate card}       │    │
│      │ Annual maintenance contract   from {rate}/year       │    │
│      └──────────────────────────────────────────────────────┘    │
│      All rates exclude 5% VAT. Materials quoted separately.      │
│      ▸ Rates are generated from our live rate card (WEB-16)      │
│                                                                  │
│  H2  How fast can you come?                                      │
│      P1 emergency 30–60 min · P2 urgent 2–4 h · P3 24 h          │
│      (Real commitments matching JOB-4 — not aspirational)        │
│                                                                  │
│  H2  What's included?          H2  What's not included?          │
│      ☑ …  ☑ …  ☑ …                 ✗ …  ✗ …  ✗ …                │
│                                                                  │
│  H2  Are you licensed for this work?                             │
│      Dubai DET licence 930137 · {activity} is a licensed         │
│      activity on that licence. {DEWA enrolment where relevant.}  │
│      ← WEB-14: legally required, and the strongest trust signal  │
│         on the page                                              │
├──────────────────────────────────────────────────────────────────┤
│  SERVICE AREAS      [Marina] [JLT] [Downtown] [Business Bay] …   │
│                     (links to /areas/[slug] — internal linking   │
│                      is a top-10 organic ranking factor)         │
├──────────────────────────────────────────────────────────────────┤
│  RELATED SERVICES   [card] [card] [card]                         │
├──────────────────────────────────────────────────────────────────┤
│  INLINE QUOTE FORM  ← do not make the visitor navigate to /quote │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Name*        [__________]   Phone*   [__________]          │  │
│  │ Area*        [ Select ▾ ]   Urgency* ◉ Emergency           │  │
│  │                                      ○ Urgent ○ Routine    │  │
│  │ Tell us what's wrong  [________________________]           │  │
│  │ ☐ I agree to be contacted about this enquiry               │  │
│  │                          [Request a quote]                 │  │
│  │ Typical response: {window}. Emergency? Call 04 XXX XXXX.   │  │
│  └────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────┤
│  FOOTER   Company name · DET licence 930137 · CR {number}        │
│           TRN {number} · Address · ☎ · Privacy · Terms           │
└──────────────────────────────────────────────────────────────────┘

JSON-LD (nonced, per SEC-2): LocalBusiness · Service · FAQPage
```

**Why this shape.** Question\-shaped H2s answered immediately below are what AI assistants lift and cite. A published price table is the single highest\-leverage asset here because almost no licensed Dubai contractor publishes one — the pages currently winning those queries are third\-party price guides. The licence line is legally required *and* the strongest trust signal available. The inline form exists because navigating to `/quote` is a step where visitors leave.

### 2\.2 Quote form states — `/quote`

**BUILT and correct.** Documented here so the states survive the rebuild.

```
DEFAULT                     SUBMITTING                  SUCCESS
┌────────────────────┐      ┌────────────────────┐      ┌────────────────────┐
│ Name*   [_______]  │      │ Name*   [_______]  │      │ ✓ Request received │
│ Phone*  [_______]  │      │ ...     (disabled) │      │                    │
│ Email   [_______]  │      │                    │      │ Reference          │
│ Service*[Select ▾] │      │  [Checking…]       │      │   {SATS-Q-00123}   │
│ Urgency*◉○○        │      │   ↑ verb-ing label │      │                    │
│ Area*   [Select ▾] │      │     per the        │      │ We'll respond      │
│ Details [_______]  │      │     existing       │      │ within {window}.   │
│ ☐ consent          │      │     convention     │      │                    │
│ [Request a quote]  │      └────────────────────┘      │ Urgent? Call       │
└────────────────────┘                                  │ 04 XXX XXXX        │
        ⟨honeypot field, visually hidden⟩               └────────────────────┘

FIELD ERROR                 RATE LIMITED                DB UNREACHABLE
┌────────────────────┐      ┌────────────────────┐      ┌────────────────────┐
│ Phone*  [_______]  │      │ ⚠ Too many         │      │ ⚠ We can't take    │
│ ● Enter a phone    │      │   requests         │      │   this online      │
│   number we can    │      │                    │      │   right now        │
│   reach you on     │      │ Please call us     │      │                    │
│                    │      │ instead:           │      │ Please call:       │
│ (role="alert")     │      │ ☎ 04 XXX XXXX      │      │ ☎ 04 XXX XXXX      │
└────────────────────┘      │                    │      │ ☎ 050 XXX XXXX     │
                            │ ← no window        │      │                    │
                            │   arithmetic       │      │ ← never lose the   │
                            │   revealed         │      │   enquiry silently │
                            └────────────────────┘      └────────────────────┘
```

### 2\.3 Careers listing — `/careers` *(NEW)*

```
┌──────────────────────────────────────────────────────────────────┐
│  H1  Work with us                                                │
│  Licensed Dubai contractor. {n} trades. Multi-trade maintenance  │
│  and fit-out.                                                    │
├──────────────────────────────────────────────────────────────────┤
│  FILTER   Trade [All ▾]   Type [All ▾]                           │
├──────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ AC Technician                                              │  │
│  │ Full-time · Dubai · 2+ years                               │  │
│  │ Split units, FCUs, ducted systems. Own visa or             │  │
│  │ transferable.                                              │  │
│  │ Posted {date} · Closes {date}          [View & apply →]    │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Electrician · Plumber · Painter …                          │  │
│  └────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────┤
│  EMPTY STATE                                                     │
│  No open roles right now.                                        │
│  Leave your details and we'll contact you when a {trade} role    │
│  opens.                                    [Join our list →]     │
│  ← feeds talent_pool_members with explicit consent (ATS-13)      │
└──────────────────────────────────────────────────────────────────┘

JSON-LD: JobPosting per role (WEB-7) → Google Jobs + AI citation
```

### 2\.4 Application form — `/careers/apply/[slug]` *(NEW)*

**The hardest constraint on this screen: under three minutes, on a phone, one thumb.** Roughly 60% of applicants abandon on length. Every field must earn its place.

```
MOBILE — 375px                       Progress: ▰▰▱▱  Step 2 of 4
┌───────────────────────────────┐
│ ← AC Technician               │    STEP 1 — Can you do the job
│ ▰▰▱▱  Step 2 of 4             │      Trade  [AC / HVAC        ▾]
├───────────────────────────────┤      Grade  ◉ Technician
│                               │             ○ Senior technician
│  Your certifications          │             ○ Charge hand ○ Helper
│                               │      Experience ◉ 2–5 yrs ○ 5–10 …
│  Do you hold any trade        │      Where are you now?
│  certificates?                │             ◉ In the UAE ○ Outside
│  ◉ Yes   ○ No                 │
│                               │    STEP 2 — Certifications
│  ┌─────────────────────────┐  │      (this screen)
│  │ Certificate             │  │
│  │ [ Select scheme      ▾ ]│  │    STEP 3 — When you can start
│  │ Number  [____________]  │  │      Availability ◉ Immediately
│  │ Expires [ 03/2028    ]  │  │                   ○ 1 month notice…
│  │         ↑ THE field     │  │      Driving licence ☑ UAE  ☐ None
│  │           everyone      │  │      Own transport   ☐
│  │           forgets       │  │
│  │ 📷 [ Photo of card    ] │  │    STEP 4 — How to reach you
│  │    jpg/png/heic ≤20MB   │  │      Name*  [_________________]
│  └─────────────────────────┘  │      Phone* [_________________]
│  [+ Add another certificate]  │        ↑ primary identifier in
│                               │          this market
│  ─────────────────────────    │      Email  [_________________]
│                               │        (optional)
│  Physical requirements for    │      CV     [ Attach — optional ]
│  this role: working at        │        pdf/doc/docx/rtf/txt ≤10MB
│  height, lifting to 25 kg,    │        "No CV? That's fine —
│  outdoor work in summer.      │         you've told us enough."
│                               │        ↑ a CV-mandatory form
│  Can you perform these, with  │          silently filters out
│  or without reasonable        │          good tradespeople
│  adjustment?                  │
│  ◉ Yes   ○ I'd like to        │      ☐ Keep my details for future
│          discuss              │        roles (you can withdraw
│    ↑ NEVER a health question  │        this any time)
│      — see ATS-6              │        ↑ separate, explicit
│                               │          consent for talent pool
│  (Back)      [Continue →]     │          (ATS-13)
└───────────────────────────────┘      [Submit application]
```

**Not on this form, at any step:** date of birth, nationality, ethnicity, religion, marital status, children, gender, photograph, health or disability status, current visa status.

**Visa status is asked later.** It is captured at the Trade Check stage, applied uniformly to every shortlisted candidate, and used only for permit and timeline planning — never as a filter on the public form (`ATS-5`).

```
SUCCESS
┌───────────────────────────────────────────────────┐
│ ✓  Application received                           │
│                                                   │
│    Reference  {SATS-A-00412}                      │
│                                                   │
│    We'll text you at {phone} within 3 working     │
│    days — whatever the outcome.                   │
│      ↑ a promise the system keeps (ATS-16, G14)   │
│                                                   │
│    Track your application:                        │
│    {link}  — no account needed                    │
└───────────────────────────────────────────────────┘
```

### 2\.5 Applicant status — `/application/[token]` *(NEW)*

Magic\-link, no account, mobile\-first. Exists because the single thing applicants care about most is *being told the outcome at all*.

```
┌───────────────────────────────────────────────────┐
│  AC Technician · {SATS-A-00412}                   │
├───────────────────────────────────────────────────┤
│  ● Applied              12 Aug   ✓                │
│  ● Screening            13 Aug   ✓                │
│  ● Trade check          14 Aug   ← you are here   │
│  ○ Interview / trial                              │
│  ○ Offer                                          │
├───────────────────────────────────────────────────┤
│  ⚠ We need something from you                     │
│  Please upload a photo of your {certificate}.     │
│  [ Upload ]                                       │
│  ← mirrors the internal blocked-on indicator      │
│    (ATS-8) so the candidate sees the same truth   │
│    the recruiter does                             │
├───────────────────────────────────────────────────┤
│  Questions? WhatsApp {number}                     │
└───────────────────────────────────────────────────┘
```

* * *

## 3\. Staff application — core screens

### 3\.1 App shell

```
┌────────────────────────────────────────────────────────────────────────┐
│ SATS   Dispatch  Schedule  Jobs  Leads  Customers  Contracts           │
│        Projects  Technicians  Workforce  Recruitment  Invoices  ⚙      │
│                                            🔍 Search    {User name} ▾  │
├──────┬─────────────────────────────────────────────────────────────────┤
│      │                                                                 │
│      │   PAGE CONTENT                                                  │
│      │                                                                 │
└──────┴─────────────────────────────────────────────────────────────────┘

Navigation is filtered by role (§1.2).
Global search (⌘K / Ctrl-K) — NEW: jobs, customers, properties, invoices,
candidates, by reference, name or phone. LEAD-8.
```

**Alert bar** — appears above page content only when something is actually wrong. It is deliberately hard to ignore and deliberately rare.

```
┌────────────────────────────────────────────────────────────────────────┐
│ ⛔  2 technicians cannot be dispatched — expired documents  [Review →]  │
│ ⚠  Trade licence 930137 expires in 164 days (23 Jan 2027)   [Renew →]   │
│ ⚠  WPS transfer due in 3 days — payroll pack not generated [Open →]    │
└────────────────────────────────────────────────────────────────────────┘
```

### 3\.2 Dispatch board — `/dispatch`

**BUILT and the single best screen in the product.** It sorts by SLA consequence, so the most expensive\-to\-ignore item is always first. Documented here to protect it: do not "improve" it into a generic sortable table.

```
┌────────────────────────────────────────────────────────────────────────┐
│  Dispatch                              Today, Wed 12 Aug · 14:32       │
│  [All] [Emergency] [Unassigned] [Overdue] [My crew]      [+ New job]   │
├────────────────────────────────────────────────────────────────────────┤
│  ⛔ BREACHED — 1                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ ● P1  SATS-J-01847   AC not cooling — server room                │  │
│  │       Bay Tower, Business Bay · Unit 1204                        │  │
│  │       Response due 13:15 · OVERDUE 1h 17m                        │  │
│  │       Unassigned                        [Assign] [Open]          │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ⚠ DUE WITHIN THE HOUR — 3                                             │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ ● P1  SATS-J-01849   Burst pipe — car park level 2               │  │
│  │       Marina Heights · Response due 15:00 · 28m left             │  │
│  │       Rahim K. · En route                        [Open]          │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│  … 2 more                                                              │
│                                                                        │
│  ○ TODAY — 12                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ ● P3  SATS-J-01852   AC service ×4 — contract visit              │  │
│  │       Villa 22, Arabian Ranches · Window 15:00–17:00             │  │
│  │       🔗 AMC SATS-C-0031 (visit 3 of 4)                          │  │
│  │       Unassigned                        [Assign] [Open]          │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│  … 11 more                                                             │
│                                                                        │
│  ○ SCHEDULED LATER — 24                              [Show ▾]          │
├────────────────────────────────────────────────────────────────────────┤
│  ⛔ 13:07 · Outdoor work blocked until 15:00 (summer midday rule)       │
│     4 outdoor jobs queued for the 15:00 window          [Schedule →]   │
│     ← visible 15 Jun – 15 Sep only. JOB-6.                             │
└────────────────────────────────────────────────────────────────────────┘

EMPTY STATE
┌────────────────────────────────────────────────────────────────────────┐
│                          ✓  No open work                               │
│         Everything scheduled is either done or not due yet.            │
│                    [View schedule]  [+ New job]                        │
└────────────────────────────────────────────────────────────────────────┘

LOADING — loading.tsx skeleton, currently missing (design doc §6)
┌────────────────────────────────────────────────────────────────────────┐
│  ▱▱▱▱▱▱▱▱▱▱                                                            │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ ▱▱▱▱  ▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱                                         │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

### 3\.3 Assign — the compliance\-gated dialog

**The most consequential interaction in the whole system.** `HR-9` makes certain assignments impossible; `JOB-10` makes overrides accountable. The dialog has to make both feel obvious rather than obstructive.

```
┌────────────────────────────────────────────────────────────────┐
│  Assign · SATS-J-01847                                     ✕   │
│  AC not cooling — Bay Tower, Business Bay                      │
│  Requires: HVAC · Grade: Technician+                           │
├────────────────────────────────────────────────────────────────┤
│  AVAILABLE — 3                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ ◉ Rahim Karim            ✓ HVAC (senior)  ✓ All current  │  │
│  │   Free 14:00–17:00 · 2 jobs today · 6.5 h                │  │
│  │   Last job: Marina Heights, 12 min away                  │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ ○ Imran Ali              ✓ HVAC           ✓ All current  │  │
│  │   Free 15:30 onward · 3 jobs today · 7.5 h               │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ⚠ ASSIGNABLE WITH A WARNING — 1                               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ ○ Suresh Nair            ✓ HVAC                          │  │
│  │   ⚠ Working-at-height certificate expires in 12 days     │  │
│  │   Free now · 1 job today · 3 h                           │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ⛔ CANNOT BE ASSIGNED — 2                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │   Mohammed Farooq        ✓ HVAC                          │  │
│  │   ⛔ Work permit expired 4 Aug 2026                       │  │
│  │      Deploying without a valid permit carries a penalty  │  │
│  │      of AED 100,000–1,000,000.        [Open record →]    │  │
│  │   ← no radio button. Not selectable. Not a soft warning. │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │   Anil Kumar                                             │  │
│  │   ⛔ On approved leave until 18 Aug                       │  │
│  └──────────────────────────────────────────────────────────┘  │
├────────────────────────────────────────────────────────────────┤
│  Window   [ 15:00 ] – [ 17:00 ]   ☐ Notify technician          │
│                                    (Cancel)  [Assign]          │
└────────────────────────────────────────────────────────────────┘

WHEN A WARNED TECHNICIAN IS SELECTED — the reason becomes mandatory
┌────────────────────────────────────────────────────────────────┐
│  ⚠ Suresh Nair's working-at-height certificate expires in      │
│    12 days. This job is flagged as working at height.          │
│                                                                │
│    Why are you assigning anyway?  (recorded, JOB-10)           │
│    [__________________________________________________]        │
│                                       (Cancel)  [Assign]       │
│    ← [Assign] stays disabled until a reason is typed.          │
│      Silent overrides are indistinguishable from mistakes.     │
└────────────────────────────────────────────────────────────────┘

WHEN THE MIDDAY BAN APPLIES
┌────────────────────────────────────────────────────────────────┐
│  ⛔ This job is flagged as outdoor work and the window you      │
│     chose (13:15) falls inside the summer midday ban           │
│     (12:30–15:00, 15 Jun – 15 Sep).                            │
│                                                                │
│     Next legal window: today 15:00–17:00      [Use 15:00]      │
│     ← refuse, name the rule, offer the fix. Never just refuse. │
└────────────────────────────────────────────────────────────────┘
```

### 3\.4 Schedule — `/schedule` *(NEW)*

```
┌────────────────────────────────────────────────────────────────────────┐
│  Schedule    [Day] [Week] [Month]      ◀ Wed 12 Aug 2026 ▶   [Today]   │
│              Filter: [All trades ▾] [All technicians ▾]                │
├──────────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┬───────────┤
│          │ 08   │ 10   │ 12   │ 14   │ 16   │ 18   │ 20   │           │
├──────────┼──────┴──────┴───▓▓▓▓▓▓───┴──────┴──────┴──────┼───────────┤
│ Rahim K. │ ███ J-01840 ███ │▓▓▓▓│ ██ J-01847 ██          │ 7.5 h ✓   │
│ HVAC     │                 │▓▓▓▓│                        │           │
├──────────┼─────────────────┼────┼────────────────────────┼───────────┤
│ Imran A. │ ██ J-01841 ██   │▓▓▓▓│ ███ J-01852 ███        │ 8.0 h ⚠   │
│ HVAC     │                 │▓▓▓▓│                        │ at limit  │
├──────────┼─────────────────┼────┼────────────────────────┼───────────┤
│ Suresh N.│      ██ J-01844 │▓▓▓▓│                        │ 3.0 h     │
│ Plumbing │                 │▓▓▓▓│                        │           │
├──────────┼─────────────────┼────┼────────────────────────┼───────────┤
│ Anil K.  │ ░░░░░ ON LEAVE — returns 18 Aug ░░░░░░░░░░░░░░│  —        │
├──────────┴─────────────────┴────┴────────────────────────┴───────────┤
│  ▓▓▓▓ = 12:30–15:00 summer midday ban. Outdoor work cannot be         │
│         placed here. Indoor work can. (15 Jun – 15 Sep only.)         │
├────────────────────────────────────────────────────────────────────────┤
│  UNSCHEDULED — 6                                                       │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐                          │
│  │ P1 J-01849 │ │ P3 J-01853 │ │ P3 J-01855 │  ← drag onto a lane      │
│  │ Burst pipe │ │ AC service │ │ Paint touch│                          │
│  │ ⚠ 28m left │ │ 🔗 AMC     │ │ 🏠 outdoor │                          │
│  └────────────┘ └────────────┘ └────────────┘                          │
└────────────────────────────────────────────────────────────────────────┘

Drag interactions:
· Drop onto a lane → assign + schedule
· Drop onto ▓▓▓ with an outdoor job → refused, with the JOB-6 explanation
· Drop onto a technician at the 8-hour limit → warning + reason required
· Drop onto a blocked technician → refused, with the HR-9 explanation
```

### 3\.5 Job detail — `/jobs/[id]`

```
┌────────────────────────────────────────────────────────────────────────┐
│  ← Jobs      SATS-J-01847                       ● P1 · In progress     │
├────────────────────────────────────────────────────────────────────────┤
│  AC not cooling — server room                                          │
│  Bay Tower, Business Bay · Unit 1204                                   │
│  Emirates Property Management · Fatima Al Rashid · 050 XXX XXXX        │
│  🔗 AMC SATS-C-0031 · comprehensive · visit 3 of 4                     │
├───────────────────────────────────────┬────────────────────────────────┤
│  TIMELINE                             │  SLA                           │
│  ● 13:02  Created (portal)            │  Response  13:15  ⛔ +1h 17m    │
│  ● 13:04  Triaged — Yusuf             │  Resolve   17:02  ⚠ 2h 30m     │
│  ● 14:32  Assigned Rahim K. — Yusuf   │                                │
│           ⚠ override: cert expiring   │  ASSIGNED                      │
│  ● 14:48  En route (field app)        │  Rahim Karim · HVAC senior     │
│  ● 15:06  Arrived — 📍 verified       │  📞 050 XXX XXXX               │
│  ○ Work in progress                   │  Last sync 15:41  ● healthy    │
│                                       │  [Reassign] [Message]          │
│  ─────────────────────────────────    │                                │
│  EVIDENCE                       (4)   │  ACTIONS                       │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐          │  [Mark work complete]          │
│  │ 📷 │ │ 📷 │ │ 📷 │ │ 📷 │          │  (Add note)  (Raise quote)     │
│  │before│before│defect│serial│         │  ‹Cancel job›                  │
│  └────┘ └────┘ └────┘ └────┘          │                                │
│  ⚠ No "after" photo yet — required    │  ACCESS                        │
│    before completion (JOB-15)         │  Security desk, gate 2.        │
│                                       │  Ask for building engineer.    │
│  MATERIALS                            │  Parking: P3 visitor bay.      │
│  Capacitor 45µF ×1 · van stock        │                                │
│  R410A refrigerant 0.8 kg · van stock │  ASSETS AT THIS PROPERTY       │
│  [+ Add]                              │  Daikin FXFQ100 · s/n 4471…    │
│                                       │  Last serviced 12 May 2026     │
│  FAULT                                │  ▸ 6 previous jobs             │
│  Reported: not cooling                │                                │
│  Diagnosed: [ Select ▾ ]              │  QUOTE / INVOICE               │
│  Symptom [▾] Cause [▾] Remedy [▾]     │  No quote raised.              │
│    ← JOB-14 controlled taxonomy       │  Invoice locked until sign-off.│
└───────────────────────────────────────┴────────────────────────────────┘
```

### 3\.6 Leads — `/leads`

```
┌────────────────────────────────────────────────────────────────────────┐
│  Leads    🔍 [name, phone, reference]    Stage [All ▾]  Source [All ▾] │
│                                                        [+ Log enquiry] │
├────────────────────────────────────────────────────────────────────────┤
│  ⚠ NEW — UNTOUCHED  (3)      ← consequence order: response time is a   │
│                                 KPI (G2), so untouched leads lead      │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ ● SATS-L-00412  Ahmed Hassan · 050 XXX XXXX                      │  │
│  │   AC repair · Dubai Marina · EMERGENCY                           │  │
│  │   Web form · 14 min ago                                          │  │
│  │   ⚠ Possible duplicate: existing customer "A. Hassan"            │  │
│  │      matched on phone                    [Review] [Qualify]      │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│  … 2 more                                                              │
│                                                                        │
│  ○ IN PROGRESS  (7)      ○ QUOTED  (4)      ○ DORMANT  (11)  [Show ▾]  │
└────────────────────────────────────────────────────────────────────────┘

LOG ENQUIRY — a 30-second form. If this is slower than a notepad,
              phone enquiries will not be logged and G1 fails.
┌────────────────────────────────────────────────────┐
│  Log an enquiry                                ✕   │
│  Channel  ◉ Phone ○ WhatsApp ○ Walk-in ○ Referral  │
│  Name*    [_____________]  Phone* [_____________]  │
│           ⚠ matches existing customer "A. Hassan"  │
│             [Use existing] [Create new]            │
│  Service  [ Select ▾ ]     Urgency ◉ ○ ○           │
│  What do they need?  [__________________________]  │
│                            (Cancel)  [Save lead]   │
└────────────────────────────────────────────────────┘
```

### 3\.7 Convert lead — `/leads/[id]`

```
┌────────────────────────────────────────────────────────────────┐
│  Convert to customer                                       ✕   │
│  One transaction: customer + property + job. Nothing retyped.  │
├────────────────────────────────────────────────────────────────┤
│  CUSTOMER      ◉ New   ○ Link to existing                      │
│    Name*       [ Ahmed Hassan                ]                 │
│    Type        ◉ Individual  ○ Company                         │
│    TRN         [ ______________ ]  (companies only —           │
│                  determines full vs simplified invoice, INV-6) │
│    Terms       [ 30 days ▾ ]                                   │
│  PROPERTY                                                      │
│    Address*    [ Marina Heights, Tower 2, Apt 1204 ]           │
│    Area*       [ Dubai Marina ▾ ]   Type [ Apartment ▾ ]       │
│    Access      [ Security desk, gate 2 ]                       │
│  JOB                                                           │
│    Service*    [ AC repair ▾ ]   Priority* [ P1 ▾ ]            │
│    ☐ Outdoor work   ← drives the midday-ban rule (JOB-6)       │
│    SLA: respond by 15:47 · resolve by 19:32                    │
│                                    (Cancel)  [Convert]         │
└────────────────────────────────────────────────────────────────┘
```

* * *

## 4\. Contracts and projects

### 4\.1 Contract detail — `/contracts/[id]` *(NEW)*

```
┌────────────────────────────────────────────────────────────────────────┐
│  ← Contracts   SATS-C-0031                          ● Active           │
│  Emirates Property Management · Comprehensive AMC                      │
│  1 Jan 2026 – 31 Dec 2026 · AED 42,000/year · Quarterly billing        │
├───────────────────────────────────────┬────────────────────────────────┤
│  ENTITLEMENTS                         │  RENEWAL                       │
│  AC service          ▰▰▰▱  3 of 4     │  Expires in 141 days           │
│  Plumbing inspection ▰▱▱▱  1 of 2     │  Utilisation 71%               │
│  Water tank clean    ▰▰    2 of 2 ✓   │  Jobs YTD 34 · Margin 31%      │
│  Callouts            unlimited (17)   │  [Generate renewal quote]      │
│                                       │                                │
│  PPM SCHEDULE                         │  PROPERTIES  (3)               │
│  ✓ Q1 AC service      14 Mar   done   │  Bay Tower, Business Bay       │
│  ✓ Q2 AC service      11 Jun   done   │  Marina Heights T2             │
│  ● Q3 AC service      15 Aug   sched  │  Ranches Villa 22              │
│    → SATS-J-01852                     │  [+ Add property]              │
│  ○ Q4 AC service      Nov     pending │                                │
│  Completion 100% ✓  ← the number an   │  ASSETS  (14)                  │
│    OA asks for at renewal (G12)       │  4 × Daikin FXFQ100            │
│                                       │  2 × water tank 2,000 L …      │
│  EXCLUSIONS  (machine-readable)       │                                │
│  ✗ Compressor replacement             │  DOCUMENTS                     │
│  ✗ Fan motor replacement              │  📄 Signed contract            │
│  ✗ Concealed pipe replacement         │  📄 Scope annexe               │
│  ✗ Waterproofing                      │  📄 Insurance certificate      │
│  → out-of-scope work auto-raises a    │  [+ Attach]                    │
│    quote at 15% contract discount     │                                │
│    (CON-6) rather than being absorbed │                                │
└───────────────────────────────────────┴────────────────────────────────┘
```

### 4\.2 Project detail — `/projects/[id]` *(NEW)*

```
┌────────────────────────────────────────────────────────────────────────┐
│  ← Projects   SATS-P-0009      Villa 42 fit-out    ● On site           │
│  Al Barari · Contract AED 285,000 + AED 18,500 variations              │
│  Started 3 Jul · Target 28 Sep · PM: Yusuf                             │
├────────────────────────────────────────────────────────────────────────┤
│  ⛔ Civil Defence completion certificate not yet applied for            │
│     Required before practical completion.            [Open permits →]  │
├───────────────────────────────────────┬────────────────────────────────┤
│  PHASES                               │  MILESTONES                    │
│  ✓ Strip out          15%  done       │  ✓ Mobilisation  20%  invoiced │
│  ✓ First fix MEP      25%  done       │  ✓ First fix     30%  invoiced │
│  ● False ceilings     20%  ▰▰▰▱ 68%   │  ● Second fix    30%  pending  │
│  ○ Tiling             20%  pending    │  ○ Completion    20%  pending  │
│  ○ Painting           15%  pending    │                                │
│  ○ Snagging            5%  pending    │  RETENTION 5%                  │
│                                       │  Held AED 7,125                │
│  VARIATIONS  (3)                      │  Release: PC + 12 months       │
│  ✓ VO-01 Extra sockets     AED 4,200  │                                │
│  ✓ VO-02 Upgrade tiles    AED 14,300  │  PERMITS                       │
│  ⚠ VO-03 Additional AC     AED 9,800  │  ✓ DDA fit-out   approved      │
│    unapproved — not in the total      │  ⛔ DCD completion  not applied │
│    ← unrecorded variations are how a  │                                │
│      fit-out contractor loses money   │  SNAGS  (12 open · 3 critical) │
│                                       │  ⚠ 3 critical block PC         │
│  COST vs VALUE                        │                                │
│  Labour     AED  84,200               │  TEAM  6 assigned              │
│  Materials  AED  96,400               │  Subcontractors: 1 (tiling)    │
│  Subcontract AED 22,000               │                                │
│  ───────────────────────              │                                │
│  Cost       AED 202,600               │                                │
│  Value      AED 303,500               │                                │
│  Margin     AED 100,900  (33%)        │                                │
└───────────────────────────────────────┴────────────────────────────────┘
```

* * *

## 5\. Recruitment

### 5\.1 Pipeline — `/recruitment/[requisition]` *(NEW)*

Kanban by stage. The **blocked\-on** indicator is the highest\-value element on the screen: in a market where a good technician holds three offers, *who is blocking this* is the only question that matters.

```
┌────────────────────────────────────────────────────────────────────────┐
│  ← Recruitment   AC Technician · 2 positions      Open · 24 applicants │
│  Posted 1 Aug · Closes 31 Aug · Hiring manager: Yusuf                  │
│  [View posting] [Edit] [Close role]                                    │
├──────────┬──────────┬──────────┬──────────┬──────────┬────────────────┤
│ APPLIED  │SCREENING │  TRADE   │INTERVIEW │  OFFER   │  ONBOARDING    │
│   (11)   │   (5)    │  CHECK   │ / TRIAL  │   (1)    │     (1)        │
│          │          │   (4)    │   (2)    │          │                │
├──────────┼──────────┼──────────┼──────────┼──────────┼────────────────┤
│ ┌──────┐ │ ┌──────┐ │ ┌──────┐ │ ┌──────┐ │ ┌──────┐ │ ┌────────────┐ │
│ │●Rajesh│ │ │●Suresh│ │ │●Imran │ │ │●Mohd │ │ │●Anil │ │ │●Vikram S.  │ │
│ │ 6 yrs │ │ │ 8 yrs │ │ │ 4 yrs │ │ │10 yrs│ │ │ 5 yrs│ │ │ 7 yrs      │ │
│ │ ●2d   │ │ │ ●1d   │ │ │ ●4d   │ │ │ ●1d  │ │ │ ●2d  │ │ │ ●3d        │ │
│ │waiting│ │ │ ours  │ │ │ OURS  │ │ │waitng│ │ │waitng│ │ │ ours       │ │
│ │on cand│ │ │to act │ │ │4 DAYS │ │ │on cnd│ │ │on cnd│ │ │ to act     │ │
│ └──────┘ │ └──────┘ │ └──────┘ │ └──────┘ │ └──────┘ │ └────────────┘ │
│  green   │  amber   │   RED    │  amber   │  amber   │  amber         │
│ ┌──────┐ │ ┌──────┐ │ ┌──────┐ │ ┌──────┐ │          │                │
│ │  …   │ │ │  …   │ │ │  …   │ │ │  …   │ │          │                │
│ └──────┘ │ └──────┘ │ └──────┘ │ └──────┘ │          │                │
└──────────┴──────────┴──────────┴──────────┴──────────┴────────────────┘

Colour rule (never colour alone — each card carries a text label too):
  green  · up to date, or waiting on a scheduled event
  amber  · waiting on the candidate (documents, availability, decision)
  RED    · waiting on US — nobody has acted, and the clock is running
  Fallback where no structured activity exists: <2d green, 2–5d amber, 5d+ red

ARCHIVED (12)  [Show ▾]   — with disposition reason, always
  Certification not current (4) · Salary expectation (3) ·
  Withdrew (2) · No response (2) · Hired elsewhere (1)
```

### 5\.2 Candidate detail — `/recruitment/candidate/[id]` *(NEW)*

```
┌────────────────────────────────────────────────────────────────────────┐
│  ← Pipeline   Imran Sheikh                    ● Trade check · 4 days   │
│  AC / HVAC · Technician · 4 yrs · In UAE · 050 XXX XXXX                │
│  🔴 Waiting on us for 4 days                                           │
├───────────────────────────────────────┬────────────────────────────────┤
│  CERTIFICATIONS                       │  MOVE TO                       │
│  ✓ HVAC Level 2                       │  [Interview / trial →]         │
│    #HV-4471 · expires 11/2027         │  (Back to screening)           │
│    📎 evidence · verified by HR 12 Aug│  ‹Archive›                     │
│                                       │                                │
│  ⚠ Working at height                  │  SCHEDULE                      │
│    #WH-8823 · EXPIRED 06/2026         │  [Send self-scheduling link]   │
│    Renewal needed before dispatch to  │  ← the single biggest cycle-   │
│    height work (HR-9 warning)         │    time reduction available    │
│                                       │                                │
│  VISA & PERMIT     (Trade check stage)│  MESSAGES                      │
│  Status  [ Employment visa —          │  WhatsApp ✓ delivered · read   │
│            transferable        ▾ ]    │  12 Aug 09:14 "Application     │
│  Current sponsor  [ ______________ ]  │  received…"                    │
│  Est. transfer time  ~3 weeks         │  13 Aug 11:02 "Please send a   │
│  ← operational planning only; applied │  photo of your certificate"    │
│    uniformly to every shortlisted     │  [Message]                     │
│    candidate (ATS-5)                  │                                │
│                                       │  DOCUMENTS                     │
│  ACTIVITY                             │  📄 CV.pdf  ✓ scanned clean    │
│  12 Aug 09:12  Applied (careers site) │     ⚠ parse failed — fields    │
│  12 Aug 09:14  Ack sent (WhatsApp)    │       entered by hand          │
│  12 Aug 16:40  → Screening (HR)       │  📷 HVAC-cert.jpg ✓ clean      │
│  13 Aug 10:55  → Trade check (HR)     │  ⏳ WH-cert.jpg  scanning…     │
│  13 Aug 11:02  Docs requested         │     download disabled until    │
│  14–16 Aug     — no activity —        │     scan completes (SEC-8)     │
│                                       │                                │
│  ▸ Previous application:              │  ☐ Talent pool (consent given  │
│    Plumber, Mar 2026 — archived,      │    12 Aug, reconfirm 12 Feb)   │
│    "role filled"                      │                                │
└───────────────────────────────────────┴────────────────────────────────┘
```

### 5\.3 Archive dialog — the reason is the product

```
┌────────────────────────────────────────────────────────────────┐
│  Archive · Imran Sheikh                                    ✕   │
├────────────────────────────────────────────────────────────────┤
│  Reason*  (recorded — drives analytics and the message sent)   │
│    ○ Certification not current                                 │
│    ○ Insufficient experience                                   │
│    ○ Salary expectation above band                             │
│    ○ Visa situation not workable in time                       │
│    ○ Role filled                                               │
│    ○ Candidate withdrew        ○ No response                    │
│    ○ Failed trade check        ○ Other (specify)               │
│    ← controlled vocabulary. Free text here destroys the        │
│      module's analytical value.                                │
├────────────────────────────────────────────────────────────────┤
│  ☑ Send outcome message  (required — ATS-16, target G14 = 100%)│
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Hi Imran, thanks for applying for AC Technician. We're    │  │
│  │ not moving forward this time — your working-at-height     │  │
│  │ certificate has expired. Renew it and please do apply     │  │
│  │ again; we hire regularly.                                 │  │
│  └──────────────────────────────────────────────────────────┘  │
│  Sends in 24 hours — cancellable until then. (ATS-15)          │
│                                                                │
│  ☐ Add to talent pool (asks the candidate for consent first)   │
│                                    (Cancel)  ‹Archive›         │
└────────────────────────────────────────────────────────────────┘
```

### 5\.4 Hire — the conversion that justifies the module

```
┌────────────────────────────────────────────────────────────────┐
│  Hire · Anil Kumar → technician record                     ✕   │
├────────────────────────────────────────────────────────────────┤
│  CARRIED ACROSS AUTOMATICALLY                                  │
│  ✓ Name, phone, email       ✓ Trade: AC / HVAC · Technician    │
│  ✓ HVAC Level 2 (exp 03/2029)  ✓ Working at height (exp 09/27) │
│  ✓ CV and certificate evidence files                           │
│  ← nothing re-keyed. This is the point of the module.          │
├────────────────────────────────────────────────────────────────┤
│  EMPLOYMENT                                                    │
│  Contract  Fixed-term ▾   Start [ 01/09/2026 ]                 │
│            ← UAE private-sector contracts are fixed-term only  │
│  End       [ 31/08/2028 ]  Probation ends [ 28/02/2027 ]       │
│            (max 6 months, non-extendable)                      │
│  Notice    [ 30 ▾ ] days   (30–90)                             │
│  Basic salary  AED [ 3,200 ]  Allowances [ + Add ]             │
│  ⚠ Below AED 4,000 → Essential Benefits Plan health insurance  │
│    required (HR-6), and this role is excluded from the         │
│    Emiratisation skilled-headcount denominator (HR-18)         │
├────────────────────────────────────────────────────────────────┤
│  ONBOARDING CHECKLIST — creates document records with expiry   │
│  ☐ Signed MOHRE offer      ☐ Work permit                       │
│  ☐ Entry permit            ☐ Medical fitness                   │
│  ☐ Emirates ID             ☐ Residence visa                    │
│  ☐ Health insurance (EBP)  ☐ ILOE subscription verified        │
│  ☐ WPS bank account / IBAN ☐ PPE issued                        │
│  ☐ Safety induction                                            │
│                                                                │
│  ⛔ Cannot be dispatched until work permit, residence visa,     │
│     Emirates ID, medical fitness and health insurance are all  │
│     recorded and valid. (HR-9)                                 │
│                                                                │
│  ⛔ Recruitment and visa costs may never be deducted from this  │
│     employee's salary. Deduction types for those categories    │
│     are not available anywhere in this system. (HR-16)         │
│                                    (Cancel)  [Create employee] │
└────────────────────────────────────────────────────────────────┘
```

* * *

## 6\. Workforce compliance — `/workforce` *(NEW)*

The board that stops a six\-figure penalty. Consequence\-ordered: hard blocks first.

```
┌────────────────────────────────────────────────────────────────────────┐
│  Workforce            Headcount 34 · Deployable 32 · Blocked 2         │
│  [Documents] [Certifications] [Leave] [Hours] [Injuries] [Payroll]     │
├────────────────────────────────────────────────────────────────────────┤
│  ⛔ BLOCKED FROM DISPATCH — 2                                           │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ Mohammed Farooq · HVAC                                           │  │
│  │ ⛔ Work permit EXPIRED 4 Aug 2026 (8 days)                        │  │
│  │    Deploying without a valid permit: AED 100,000–1,000,000       │  │
│  │    Renewal not started                    [Open] [Log renewal]   │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ Kamal Ahmed · Plumbing                                           │  │
│  │ ⛔ Health insurance EXPIRED 1 Aug 2026                            │  │
│  │    Recurring monthly penalty; blocks visa processing             │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ⚠ EXPIRING WITHIN 30 DAYS — 5                                         │
│  Suresh Nair    Working at height   24 days  ⚠ warns at assignment     │
│  Imran Ali      Residence visa      18 days  ⛔ will block             │
│  Rahim Karim    Emirates ID         29 days  ⛔ will block             │
│  … 2 more                                                              │
│                                                                        │
│  ⚠ COMPANY ACCREDITATIONS                                              │
│  ⚠ DET trade licence 930137        expires 23 Jan 2027   164 days      │
│  ✓ DEWA contractor enrolment       expires 12 Mar 2027   Gold          │
│  ✓ Third-party liability insurance expires 30 Nov 2026                 │
│  ⚠ Workmen's compensation          expires 15 Sep 2026    34 days      │
│  ○ Dubai Municipality contractor classification — NOT REGISTERED       │
│    ⚠ Dubai Law 7/2025 may require this. Verify. (OPEN-3)              │
├────────────────────────────────────────────────────────────────────────┤
│  WORKING TIME — this week                                              │
│  ⚠ Imran Ali        49.5 h  — exceeds the 48 h weekly maximum          │
│  ✓ All other technicians within limits                                 │
│  ✓ No outdoor work scheduled inside the midday ban this week           │
└────────────────────────────────────────────────────────────────────────┘
```

### 6\.1 Payroll / WPS tab

```
┌────────────────────────────────────────────────────────────────────────┐
│  Payroll · August 2026                                                 │
├────────────────────────────────────────────────────────────────────────┤
│  ⚠ WPS TRANSFER DUE  1 September 2026  —  20 days                      │
│                                                                        │
│  Wages must reach employee accounts ON the 1st of the month.           │
│  Escalation if late:                                                   │
│    Day 2   automated warnings                                          │
│    Day 5   NEW WORK PERMITS SUSPENDED  ← hiring stops                  │
│    Day 11  administrative fines + establishment downgrade              │
│    Day 16  automatic labour-dispute registration                       │
│    Day 21  executive orders; possible travel bans                      │
│                                                                        │
│  Compliance test: ≥ 85% of total wages transferred by the deadline.    │
├────────────────────────────────────────────────────────────────────────┤
│  Employees      34        Total wages    AED 187,400                   │
│  Overtime       412 h     Absence        6 days unpaid                 │
│                                                                        │
│  [Generate payroll pack]   → hours, overtime, absences, deductions     │
│                              for the bank's SIF                        │
│                                                                        │
│  ⛔ Deduction categories for recruitment or visa costs do not exist     │
│     in this system and cannot be created. (HR-16)                      │
├────────────────────────────────────────────────────────────────────────┤
│  HISTORY                                                               │
│  Jul 2026   ✓ transferred 1 Aug   100%   on time                       │
│  Jun 2026   ✓ transferred 1 Jul   100%   on time                       │
└────────────────────────────────────────────────────────────────────────┘
```

* * *

## 7\. Invoicing

### 7\.1 Invoice detail — `/invoices/[id]`

```
┌────────────────────────────────────────────────────────────────────────┐
│  ← Invoices   SATS-INV-2026-0184                      ● Issued         │
│  Emirates Property Management · TRN 100XXXXXXXXXXX                     │
│  Issued 12 Aug · Supply date 11 Aug · Due 11 Sep (30 days)             │
│  ✓ Full tax invoice  (recipient is VAT-registered)                     │
├───────────────────────────────────────┬────────────────────────────────┤
│  LINES                                │  TOTALS                        │
│  AC repair — SATS-J-01847             │  Subtotal    AED  1,450.00     │
│    Labour 2.5 h @ 180.00     450.00   │  Discount     −AED   145.00    │
│    Capacitor 45µF ×1         120.00   │  ─────────────────────────     │
│    R410A 0.8 kg              280.00   │  Net         AED  1,305.00     │
│  AC service — SATS-J-01852            │  VAT 5%      AED     65.25     │
│    Contract visit — no charge   0.00  │  ─────────────────────────     │
│  Emergency callout           600.00   │  TOTAL       AED  1,370.25     │
│                                       │  ← VAT applied AFTER discount  │
│  ─────────────────────────────────    │    Integer minor units. Proven │
│  COMPLIANCE                           │    to the fils by tests.       │
│  ✓ "Tax Invoice" shown                │                                │
│  ✓ Supplier TRN                       │  PAYMENT                       │
│  ✓ Recipient name, address, TRN       │  Received  AED 0.00            │
│  ✓ Sequential number (no gap)         │  Outstanding AED 1,370.25      │
│  ✓ Issue date + supply date           │  [Record payment]              │
│  ✓ Per-line AED amounts               │                                │
│  ✓ Licence 930137 · CR {number}       │  ACTIONS                       │
│  ✓ Issued 1 day after supply          │  [Download PDF] [Email]        │
│    (14-day limit — INV-5)             │  (Credit note) ‹Void›          │
│  ○ PINT AE fields populated —         │                                │
│    ready for ASP transmission from    │  AUDIT                         │
│    1 Jul 2027 (INV-9)                 │  Created 12 Aug 09:14 Ayesha   │
│                                       │  Issued  12 Aug 09:22 Ayesha   │
│                                       │  Emailed 12 Aug 09:22 system   │
└───────────────────────────────────────┴────────────────────────────────┘
```

### 7\.2 Invoices list — collections framing

```
┌────────────────────────────────────────────────────────────────────────┐
│  Invoices    🔍 [ref, customer]   [All][Draft][Issued][Overdue][Paid]  │
│                                                        [+ New invoice] │
├────────────────────────────────────────────────────────────────────────┤
│  ⚠ ACTION NEEDED                                                       │
│  ⚠ 3 signed-off jobs not yet invoiced — oldest is 10 days              │
│    The 14-day statutory limit applies. Penalty AED 2,500 each.         │
│                                              [Raise invoices →]        │
├────────────────────────────────────────────────────────────────────────┤
│  AR AGEING                     Total outstanding  AED 84,320           │
│  Current  ▰▰▰▰▰▰▰▰  AED 42,100        DSO 38 days ✓ (target < 45)     │
│  1–30     ▰▰▰▰      AED 21,800                                         │
│  31–60    ▰▰        AED 12,400                                         │
│  61–90    ▰         AED  6,380                                         │
│  90+      ▰         AED  6,020  ⚠                                      │
├────────────────────────────────────────────────────────────────────────┤
│  ⚠ OVERDUE — 7        ← money at risk leads, per consequence order     │
│  SATS-INV-2026-0141  Emirates Property Mgmt  AED 6,020  91 days ⚠      │
│    Last chased 2 Aug · promised 15 Aug          [Chase] [Open]         │
│  … 6 more                                                              │
└────────────────────────────────────────────────────────────────────────┘
```

* * *

## 8\. Owner dashboard — `/reports` *(NEW)*

Designed for a phone, read weekly. Also delivered as a text email (`KPI-5`) so the number arrives whether or not anyone logs in.

```
MOBILE — 375px
┌───────────────────────────────┐
│  This week           Wed 12   │
├───────────────────────────────┤
│  ⛔ NEEDS YOU                  │
│  2 technicians blocked from   │
│  dispatch — expired documents │
│  Trade licence expires in     │
│  164 days                     │
│                    [Review →] │
├───────────────────────────────┤
│  CASH                         │
│  Outstanding    AED  84,320   │
│  Overdue        AED  42,220 ⚠ │
│  Invoiced (Aug) AED 142,800   │
│  DSO 38 days  ✓               │
├───────────────────────────────┤
│  REVENUE vs SMALL BUSINESS    │
│  RELIEF THRESHOLD             │
│  ▰▰▰▰▰▰▰▱▱▱  AED 2.1m of 3.0m │
│  Crossing AED 3m permanently  │
│  ends the relief. Watch this. │
│                     (INV-17)  │
├───────────────────────────────┤
│  WORK                         │
│  Open jobs  38  (P1: 2)       │
│  SLA breaches this week   1 ⚠ │
│  First-time fix        87% ✓  │
│  PPM completion       100% ✓  │
├───────────────────────────────┤
│  PIPELINE                     │
│  Leads (new)     12           │
│  Quoted      AED 186,000      │
│  Conversion       54% ✓       │
├───────────────────────────────┤
│  CONTRACTS                    │
│  Active 14 · AED 412,000/yr   │
│  Expiring in 90 days: 3       │
│  Renewal rate     83% ✓       │
├───────────────────────────────┤
│  PEOPLE                       │
│  Headcount 34 · deployable 32 │
│  Open roles 2 · avg 11 days   │
│  Skilled headcount 6 of 50    │
│    (Emiratisation threshold)  │
│  WPS due 1 Sep — 20 days      │
└───────────────────────────────┘
```

* * *

## 9\. Admin

### 9\.1 Users — `/admin/users` *(NEW)*

The screen whose absence means "not a product yet".

```
┌────────────────────────────────────────────────────────────────────────┐
│  Users                                                  [+ Invite]     │
├────────────────────────────────────────────────────────────────────────┤
│  Name            Role              MFA    Last seen      Status        │
│  ──────────────────────────────────────────────────────────────────    │
│  Yusuf Rahman    Operations mgr    ✓      2 min ago      ● Active      │
│                                              [Edit] [Reset MFA]        │
│  Ayesha Khan     Accountant        ✓      1 h ago        ● Active      │
│  Fatima Noor     Dispatcher        ✗ ⚠    3 d ago        ● Active      │
│                                     ↑ nudge, don't force               │
│  Sara Ali        HR                ✓      —              ⏳ Invited    │
│                                              [Resend] [Cancel]         │
│  Kamal Das       Sales             ✓      12 d ago       ⛔ Locked     │
│                  5 failed attempts, 12 Aug 09:14                       │
│                                              [Unlock] [Reset password] │
│  ← the unlock action that currently requires SQL (ADM-1, SEC-4)        │
└────────────────────────────────────────────────────────────────────────┘

RESET MFA — the procedure is the control; the software records it
┌────────────────────────────────────────────────────────────────┐
│  Reset MFA · Yusuf Rahman                                  ✕   │
│  ⚠ This removes their second factor. Verify their identity     │
│    by a channel other than email before continuing.            │
│                                                                │
│  How did you verify them?*  (recorded in the audit log)        │
│  [ Video call, confirmed Emirates ID, 12 Aug 15:04__________]  │
│                                                                │
│  ☑ Revoke all their sessions                                   │
│  ☑ Require re-enrolment at next login                          │
│                                    (Cancel)  ‹Reset MFA›       │
└────────────────────────────────────────────────────────────────┘
```

### 9\.2 Company — `/admin/company` *(NEW)*

Resolves `TD-9`\: identity moves out of a source file.

```
┌────────────────────────────────────────────────────────────────────────┐
│  Company                                        Changes are audited    │
├────────────────────────────────────────────────────────────────────────┤
│  IDENTITY                                                              │
│  Legal name*     [ SUMON AKON TECHNICAL SERVICES              ]        │
│  Trading name    [ ____________________________________       ]        │
│  Licence no.*    [ 930137 ]        Expires* [ 23/01/2027 ]  ⚠ 164 d    │
│  CR number*      [ ______________ ]                                    │
│  TRN             [ ______________ ]  ⚠ not set — required on every     │
│                                        tax invoice (INV-3)             │
│  Address*        [ ____________________________________       ]        │
│  Phone*          [ ______________ ]  Emergency [ ____________ ]        │
│                                                                        │
│  These appear on every quote, invoice, contract and the website        │
│  footer. Displaying the CR number is a legal requirement.  (WEB-14)    │
├────────────────────────────────────────────────────────────────────────┤
│  LICENSED ACTIVITIES  — the service catalogue may not exceed this list │
│  ☑ Painting          ☑ Wallpaper        ☑ False ceilings               │
│  ☑ Tiling            ☑ Plumbing & sanitary  ☑ Carpentry                │
│  ☑ Electrical fittings repair           ☑ Electromechanical install    │
│  ☑ HVAC install & maintenance           ☑ Building cleaning            │
├────────────────────────────────────────────────────────────────────────┤
│  WORKING CALENDAR                                                      │
│  Weekend      ◉ Sat–Sun  ○ Fri–Sat  ○ Custom                           │
│  Hours        [ 08:00 ] – [ 18:00 ]  Break [ 1 ] hour                  │
│  Emergency    ☑ 24/7 cover                                             │
│  ☑ Summer midday ban   12:30–15:00, 15 Jun – 15 Sep  (locked)          │
│  ☑ Ramadan reduction   −2 hours/day                                    │
│  Public holidays 2026  [ Manage → ]                                    │
└────────────────────────────────────────────────────────────────────────┘
```

### 9\.3 Notification queue — `/admin/notifications` *(NEW)*

Makes the invisible pipeline visible.

```
┌────────────────────────────────────────────────────────────────────────┐
│  Notifications                          ● Healthy · drained 15:40      │
├────────────────────────────────────────────────────────────────────────┤
│  Pending 3 · Sent today 47 · Failed 1 ⚠ · Stuck 0                      │
├────────────────────────────────────────────────────────────────────────┤
│  ⚠ FAILED — needs attention                                            │
│  new_lead → yusuf@… · 5 attempts · terminal: invalid recipient         │
│    12 Aug 14:32                              [Retry] [Dismiss]         │
│  ← failures surface to an operator, not only to a log                  │
├────────────────────────────────────────────────────────────────────────┤
│  CRON HEALTH                                                           │
│  dispatch    every 5 min   ✓ 15:40   47 processed                      │
│  sla         every 10 min  ✓ 15:35   1 breach found                    │
│  compliance  daily 06:00   ✓ 06:00   7 alerts sent                     │
│  contracts   daily         ✓ 06:02   2 visits generated                │
│  retention   daily 02:00   ✓ 02:00   4 records purged                  │
│  sweep       hourly        ⚠ 13:00   MISSED 2 runs   [Investigate]     │
│  ← the meta-check that makes the rest trustworthy                      │
└────────────────────────────────────────────────────────────────────────┘
```

* * *

## 10\. Customer portal

### 10\.1 Dashboard — `/portal`

```
MOBILE — 375px                        DESKTOP
┌───────────────────────────────┐     ┌──────────────────────────────────┐
│ Emirates Property Mgmt    ☰   │     │  Requests │ Quotes │ Invoices │  │
├───────────────────────────────┤     │  Contract │                     │
│  ⚠ NEEDS YOUR DECISION        │     ├──────────────────────────────────┤
│  ┌─────────────────────────┐  │     │  Two-column: decisions left,     │
│  │ Quote SATS-Q-0092       │  │     │  activity right                  │
│  │ Chiller pump replace    │  │     └──────────────────────────────────┘
│  │ AED 8,450 incl. VAT     │  │
│  │ Expires in 4 days       │  │
│  │      [Review & decide]  │  │
│  └─────────────────────────┘  │
├───────────────────────────────┤
│  IN PROGRESS  (2)             │
│  ● SATS-J-01847               │
│    AC not cooling — Bay Tower │
│    Technician arrived 15:06   │
│  ● SATS-J-01852               │
│    AC service — scheduled     │
│    15 Aug, 15:00–17:00        │
├───────────────────────────────┤
│  YOUR CONTRACT                │
│  Comprehensive AMC            │
│  Renews 31 Dec 2026           │
│  AC service     ▰▰▰▱ 3 of 4   │
│  Callouts       unlimited     │
│  Next visit  15 Aug           │
├───────────────────────────────┤
│  INVOICES                     │
│  Outstanding  AED 6,020       │
│  ⚠ 1 overdue                  │
│                    [View all] │
├───────────────────────────────┤
│      [ + Raise a request ]    │
└───────────────────────────────┘

EMPTY — first login
┌───────────────────────────────┐
│  Welcome, Fatima              │
│  Nothing needs your attention.│
│  Raise a request here and     │
│  you'll get a reference       │
│  straight away — no phone     │
│  call needed.                 │
│      [ + Raise a request ]    │
└───────────────────────────────┘
```

### 10\.2 Request detail with evidence — `/portal/requests/[id]` *(NEW)*

`POR-9`. This is the deflection mechanism: it answers "what did you actually do" before it is asked.

```
┌───────────────────────────────────────────────────┐
│  ← Requests   SATS-J-01847        ● Completed     │
│  AC not cooling — server room                     │
│  Bay Tower, Unit 1204                             │
├───────────────────────────────────────────────────┤
│  ● 12 Aug 13:02  Request received                 │
│  ● 12 Aug 14:32  Technician assigned              │
│  ● 12 Aug 14:48  On the way                       │
│  ● 12 Aug 15:06  Arrived                          │
│  ● 12 Aug 16:41  Work completed                   │
│  ● 12 Aug 16:44  Signed off by Fatima Al Rashid   │
├───────────────────────────────────────────────────┤
│  WHAT WAS DONE                                    │
│  Replaced failed run capacitor (45µF) on FCU-3.   │
│  Recharged 0.8 kg R410A. Tested — cooling normal, │
│  supply air 14°C.                                 │
│                                                   │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐              │
│  │  📷  │ │  📷  │ │  📷  │ │  📷  │              │
│  │before│ │defect│ │ part │ │after │              │
│  └──────┘ └──────┘ └──────┘ └──────┘              │
│  ← EXIF stripped on this path. The customer's     │
│    own coordinates are not re-broadcast. (FLD-8)  │
├───────────────────────────────────────────────────┤
│  MATERIALS                                        │
│  Capacitor 45µF ×1 · R410A 0.8 kg                 │
│  Covered by your contract — no charge.            │
├───────────────────────────────────────────────────┤
│  [Download job sheet]   [Raise a related request] │
└───────────────────────────────────────────────────┘
```

* * *

## 11\. Technician field app

Design constraints that differ from every other surface: **used outdoors in bright sun, often with gloves, one\-handed, frequently with no signal.** Minimum touch target 48 px. Maximum contrast. Never more than one primary action per screen.

### 11\.1 Today

```
┌───────────────────────────────┐
│ ☰  Today       ● 3 unsynced   │  ← sync state is ALWAYS visible
│    Wed 12 Aug        [↻]      │     FLD-17: a silently stuck queue
├───────────────────────────────┤     is worse than a visible error
│ ⛔ 12:30–15:00                 │
│    No outdoor work            │  ← shown 15 Jun – 15 Sep only
│    (summer rule)              │
├───────────────────────────────┤
│ ┌───────────────────────────┐ │
│ │ ● NOW                     │ │
│ │ SATS-J-01847              │ │
│ │ AC not cooling            │ │
│ │ Bay Tower, Business Bay   │ │
│ │ Unit 1204                 │ │
│ │ ⚠ P1 · resolve by 17:02   │ │
│ │                           │ │
│ │ [    I'VE ARRIVED    ]    │ │  ← one primary action, 56px tall
│ │ (Navigate)  (Call)        │ │
│ └───────────────────────────┘ │
│ ┌───────────────────────────┐ │
│ │ ○ 15:00–17:00             │ │
│ │ SATS-J-01852              │ │
│ │ AC service ×4  🔗 AMC     │ │
│ │ Villa 22, Arabian Ranches │ │
│ └───────────────────────────┘ │
├───────────────────────────────┤
│  Today  Timesheet  Profile    │
└───────────────────────────────┘

OFFLINE                          SYNC PROBLEM
┌───────────────────────────────┐ ┌───────────────────────────────┐
│ ☰  Today   ⚠ Offline · 7 held │ │ ⚠ 3 items haven't sent        │
│ Everything you record is      │ │   Oldest: 4 hours ago         │
│ saved. It will send when you  │ │   You're online — retrying.    │
│ have signal.                  │ │   [Try now]  [Tell the office] │
└───────────────────────────────┘ └───────────────────────────────┘
```

### 11\.2 Job — safety gate before work can start

```
┌───────────────────────────────┐
│ ← SATS-J-01847     ● Arrived  │
├───────────────────────────────┤
│  BEFORE YOU START             │
│                               │
│  ☑ I have read the risk       │
│    assessment for AC work at  │
│    height                     │
│    [View RAMS]                │
│                               │
│  ☑ PPE: gloves, safety        │
│    glasses, harness           │
│                               │
│  Permit to work               │
│  [ PTW-2026-0412__________ ]  │
│                               │
│  ☑ I have checked the area is │
│    safe to work in now        │
│                               │
│  [     START WORK      ]      │  ← disabled until all confirmed
│                               │     FLD-4: frequently a legal
└───────────────────────────────┘     precondition, not a formality
```

### 11\.3 Capture

```
┌───────────────────────────────┐   PHOTO
│ ← SATS-J-01847   ● Working    │   ┌───────────────────────────────┐
│    Started 15:11  ⏱ 1h 24m    │   │  What is this photo?          │
├───────────────────────────────┤   │  ◉ Before   ○ After           │
│  PHOTOS              4        │   │  ○ Defect   ○ Serial plate    │
│  ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐     │   │  ○ Meter    ○ Parts used      │
│  │📷│ │📷│ │📷│ │📷│ │ +│     │   │  ○ Site access                │
│  └──┘ └──┘ └──┘ └──┘ └──┘     │   │  Note (optional)              │
│  ⚠ 1 "after" photo required   │   │  [_________________________]  │
│                               │   │            [Save]             │
│  MATERIALS           2        │   └───────────────────────────────┘
│  Capacitor 45µF ×1  van       │
│  R410A 0.8 kg       van       │   MATERIAL
│  [+ Add material]             │   ┌───────────────────────────────┐
│                               │   │  [ 📷 Scan barcode ]          │
│  WHAT I FOUND                 │   │  or search  [___________]     │
│  Symptom [ Not cooling    ▾ ] │   │  Capacitor 45µF 440V          │
│  Cause   [ Component fail ▾ ] │   │  Qty [ 1 ]  Unit: each        │
│  Remedy  [ Replaced part  ▾ ] │   │  From ◉ Van stock             │
│  Notes                        │   │       ○ Purchased today       │
│  [_________________________]  │   │       ○ Customer supplied     │
│                               │   │            [Add]              │
│  [    FINISH THE JOB    ]     │   └───────────────────────────────┘
└───────────────────────────────┘
```

### 11\.4 Outcome and sign\-off

```
OUTCOME                            SIGN-OFF
┌───────────────────────────────┐  ┌───────────────────────────────┐
│  How did it end?              │  │  Customer sign-off            │
│                               │  ├───────────────────────────────┤
│  ◉ Completed                  │  │  SATS-J-01847                 │
│  ○ Partly done — returning    │  │  AC not cooling               │
│  ○ Return visit needed        │  │  Work: replaced 45µF          │
│  ○ No access                  │  │  capacitor, recharged 0.8 kg  │
│  ○ Customer not home          │  │  R410A, tested OK             │
│  ○ Stopped — unsafe           │  │  Time on site: 1h 34m         │
│  ○ Needs a quote first        │  │  Materials: 2 items           │
│                               │  ├───────────────────────────────┤
│  ─────────────────────────    │  │  "I confirm the work          │
│  ANYTHING ELSE THEY NEED?     │  │   described above has been     │
│  [_________________________]  │  │   completed."      (v1.2)      │
│  📷 [ Photo ]                 │  │                               │
│  ↑ raises a lead. The cheapest│  │  ┌─────────────────────────┐  │
│    sales channel the business │  │  │                         │  │
│    has. (FLD-12)              │  │  │   ✍  sign here          │  │
│                               │  │  │                         │  │
│  [       CONTINUE       ]     │  │  └─────────────────────────┘  │
└───────────────────────────────┘  │           [Clear]             │
                                   │                               │
NO ACCESS PATH                     │  Name*  [_________________]   │
┌───────────────────────────────┐  │  Role   [ Building manager ▾] │
│  No access — why?             │  │  Email  [_________________]   │
│  ◉ Nobody on site             │  │         (they get a copy)     │
│  ○ Security refused entry     │  │                               │
│  ○ Wrong address              │  │  [        SUBMIT        ]     │
│  ○ Unsafe to enter            │  │  ( Customer not available )   │
│  ○ Area locked, no key        │  └───────────────────────────────┘
│  Note [__________________]    │
│  📷 [ Photo of the door ]     │  CUSTOMER NOT AVAILABLE
│                               │  ┌───────────────────────────────┐
│  Rebook?  ◉ Yes ○ Office will │  │  Why not?                     │
│  [        CONFIRM       ]     │  │  ◉ Nobody authorised on site  │
│  ← a full, clean path. Not an │  │  ○ They left before I finished│
│    afterthought. (JOB-13)     │  │  ○ They refused to sign       │
└───────────────────────────────┘  │  Note [__________________]    │
                                   │  ⚠ Goes to your supervisor    │
                                   │    for attestation.           │
                                   │  ← never force a fake         │
                                   │    signature. (FLD-13)        │
                                   └───────────────────────────────┘
```

### 11\.5 Sync detail

```
┌───────────────────────────────┐
│ ← Sync                        │
├───────────────────────────────┤
│  ● Last synced  15:41         │
│  Connection     4G            │
│  Photos wait for Wi-Fi        │
│  [Upload photos now anyway]   │
│  ← never let a policy toggle  │
│    block a technician who     │
│    needs the office to see    │
│    a photo now (FLD-7)        │
├───────────────────────────────┤
│  WAITING TO SEND          3   │
│  ✓ Arrived 15:06        sent  │
│  ⏳ Photo ×4      2.1 MB      │
│  ⏳ Materials ×2              │
│  ⏳ Job sheet + signature     │
├───────────────────────────────┤
│  ⚠ COULDN'T SEND          1   │
│  Photo (16:20) — failed 5×    │
│  [Try again] [Tell the office]│
│  ← dead-letter items are      │
│    visible, never silent      │
├───────────────────────────────┤
│  Storage used  184 MB         │
│  [Clear synced photos]        │
├───────────────────────────────┤
│  WHAT THIS APP RECORDS        │
│  Your location is recorded    │
│  only at these moments:       │
│   · when you mark en route    │
│   · when you arrive           │
│   · when you finish           │
│   · when you take a photo     │
│  Not between them. Not        │
│  outside your working hours.  │
│  [Read the full notice]       │
│  ← always accessible. FLD-16. │
└───────────────────────────────┘
```

* * *

## 12\. Cross\-cutting states

Every list, form and detail screen implements these. The audit found empty states missing across the app because seed data was always present during development.

### 12\.1 The six states

```
LOADING              EMPTY                 ERROR
┌──────────────┐     ┌──────────────┐      ┌──────────────┐
│ ▱▱▱▱▱▱▱▱▱    │     │      ○       │      │      ⚠       │
│ ▱▱▱▱▱▱       │     │ No {things}  │      │ Couldn't     │
│ ▱▱▱▱▱▱▱▱▱▱   │     │ yet          │      │ load this    │
│              │     │              │      │              │
│ skeleton     │     │ {One line on │      │ [Try again]  │
│ matching the │     │  why that's  │      │ Still stuck? │
│ real layout, │     │  fine or     │      │ Call {ext}   │
│ never a      │     │  what to do} │      │              │
│ spinner      │     │              │      │ ← plain      │
│              │     │ [Do the      │      │   language,  │
│ loading.tsx  │     │  thing]      │      │   never a    │
│ per route    │     │              │      │   stack      │
│ group        │     │ ← never a    │      │   trace      │
└──────────────┘     │   blank box  │      └──────────────┘
                     └──────────────┘

PARTIAL              DENIED                SUCCESS
┌──────────────┐     ┌──────────────┐      ┌──────────────┐
│ Showing 50   │     │      ⛔       │      │      ✓       │
│ of 312       │     │ You don't    │      │ {What        │
│              │     │ have access  │      │  happened}   │
│ [Load more]  │     │ to this      │      │              │
│              │     │              │      │ {Reference}  │
│ or 🔍 to     │     │ Ask your     │      │              │
│ narrow       │     │ administrator│      │ inline,      │
│              │     │              │      │ role=status  │
│ ← never a    │     │ ← named, not │      │              │
│   silent cap │     │   a 404      │      │ ← never a    │
└──────────────┘     └──────────────┘      │   toast that │
                                           │   vanishes   │
                                           └──────────────┘
```

### 12\.2 Form conventions — BUILT and consistent, carried forward

```
IDLE                  PENDING               ERROR
[Save changes]        [Saving…]             ● Enter a valid phone number
                      ↑ disabled,             ↑ field-level, role="alert",
                        verb-ing label          adjacent to the field,
                                                never only at the top

Progressive enhancement: every form is a server-action form that works
without JavaScript (useActionState + hidden action refs). Client JS
improves; it never gates. — BUILT, and worth protecting.
```

### 12\.3 Destructive actions — two\-step, BUILT

```
STEP 1                          STEP 2
(Turn off two-factor)     →     ┌─────────────────────────────────┐
                                │ Enter a code from your app to   │
                                │ confirm.                        │
                                │ [ ______ ]                      │
                                │ This will not affect anybody    │
                                │ else's account.                 │
                                │      (Cancel)  ‹Turn off›       │
                                └─────────────────────────────────┘
                                ↑ the voice that makes the security
                                  surfaces trustworthy. Keep it.
```

### 12\.4 Session expiry — a fix, not a state

```
CURRENT (broken)                 REQUIRED (SEC-11)
Hour 12: logged out mid-form,    ┌─────────────────────────────────┐
work lost, no warning.           │ ⚠ You'll be signed out in 5     │
                                 │   minutes. Your work is saved.  │
                                 │            [Stay signed in]     │
                                 └─────────────────────────────────┘
                                 Sliding renewal on activity, with
                                 an absolute maximum. In-flight form
                                 state preserved across re-auth.
```

* * *

## 13\. Responsive behaviour

| Surface | Primary device | Behaviour |
| --- | --- | --- |
| Marketing | Mobile | Mobile\-first. Single column below 768 px. Sticky call and quote buttons. |
| Careers & application | **Mobile** | Applications arrive from phones. Multi\-step, one question group per screen, thumb\-reachable controls. |
| Dispatch & schedule | **Desktop** | Dense information. Below 1024 px, collapse to a prioritised list; the lane view is desktop\-only. |
| Job detail | Both | Two columns → stacked below 900 px, with the actions panel first on mobile. |
| Portal | **Mobile** | Building managers use phones. Single column throughout. |
| Owner dashboard | **Mobile** | Read on a phone, weekly. Card stack. |
| Recruitment pipeline | Desktop, mobile\-capable | Kanban → per\-stage tabs on mobile. |
| Field app | **Mobile only** | 48 px minimum targets. Maximum contrast for sunlight. One\-handed. One primary action per screen. |

* * *

## 14\. Screen inventory and build status

| Screen | Status | Requirements | Phase |
| --- | --- | --- | --- |
| Home, service ×10, area, about, contact | CHANGE — content truth | `WEB-1` `WEB-2` `WEB-3` | 0 |
| `/rates` published rate card | NEW | `WEB-16` | 1 |
| `/reviews` | NEW | `WEB-17` | 2 |
| `/quote` | BUILT | `WEB-5` | — |
| `/enquiry/contract` | NEW | `WEB-11` | 2 |
| `/careers`, `/careers/[slug]`, apply, status | NEW | `ATS-2` `ATS-3` | 2 |
| `/login`, `/login/verify`, `/security` | BUILT | — | — |
| `/forgot-password`, `/reset-password/[token]` | NEW | `ADM-2` `SEC-5` | 1 |
| `/dispatch` | BUILT \+ midday banner | `JOB-11` `JOB-6` | 1 |
| Assign dialog | CHANGE — blocking \+ reasons | `HR-9` `JOB-10` `JOB-6` | 1 |
| `/schedule` | NEW | `JOB-7` `JOB-8` | 3 |
| `/jobs`, `/jobs/[id]` | CHANGE — evidence, fault codes, outcome | `JOB-13` `JOB-14` `JOB-15` | 3 |
| `/leads`, `/leads/[id]`, log enquiry | CHANGE — dedupe, search, log | `LEAD-1` `LEAD-5` `LEAD-8` | 1–2 |
| `/customers`, `/customers/[id]` | CHANGE — TRN, portal users | `LEAD-10` `POR-8` | 1 |
| `/contracts`, `/contracts/[id]` | NEW | M3 | 2 |
| `/projects`, `/projects/[id]` | NEW | M5 | 4 |
| `/technicians`, `/technicians/[id]` | CHANGE — documents, blocking | `HR-5` `HR-9` | 1 |
| `/workforce` | NEW | M10 | 1–2 |
| `/recruitment` and children | NEW | M9 | 2 |
| `/invoices`, `/invoices/[id]` | CHANGE — tax invoice, PDF | `INV-3` `INV-5` | 1 |
| `/reports` | NEW | `KPI-3` | 2 |
| `/admin/users` | NEW | `ADM-1` | 1 |
| `/admin/company` | NEW | `ADM-9` | 1 |
| `/admin/reference` | NEW | `ADM-10` | 1 |
| `/admin/audit` | NEW | `ADM-7` | 2 |
| `/admin/notifications` | NEW | `ADM-5` `ADM-6` | 0 |
| `/portal` | CHANGE — contract, invoices | `POR-4` `POR-7` | 2 |
| `/portal/requests`, `/portal/requests/[id]` | NEW | `POR-3` (P2) · `POR-9` (P3) | 2–3 |
| `/portal/invoices` | NEW | `POR-4` | 2 |
| Field app — 7 screens (Today · Job · Capture · Outcome · Sign\-off · Timesheet · Sync/Profile) | NEW | M11 | 3 |

* * *

## 15\. What these wireframes deliberately do not do

- **No new visual language.** The existing design system is coherent; the gap the audit found was *missing states*, not wrong aesthetics. Filling states is the work. Reskinning is not.
- **No dashboard\-first navigation for operators.** The dispatch board is the operator's home because it answers "what should I do next". A metrics dashboard as the landing screen would be a regression.
- **No sortable data grids.** Consequence\-ordered lists make the decision for the user. A sortable table hands the decision back and is slower for everyone.
- **No toast notifications.** Success and error are inline, adjacent to the action, in a live region. A message that disappears after four seconds is not a message.
- **No modal stacking.** One dialog at a time. A dialog that opens another dialog is a screen that should have been a page.
- **No infinite scroll on operational lists.** Keyset pagination with an explicit count. An operator needs to know how much work exists, not scroll until it stops.
