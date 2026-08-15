# Design System & UX Document

## SATS Operations Platform — v2.0

**Companion to:** `01 — PRD`, `02 — TRD`, `03 — Wireframe & Interaction Document`.
**Date:** 12 August 2026

* * *

## 0\. Position

The audit's verdict on the existing design was, in effect: *coherent, honest, consequence\-ordered, accessible in the places that were tested, and incomplete in states rather than wrong in aesthetics.* That verdict is accepted.

**This document therefore does two things and refuses a third.**

It **documents** the design system that already exists, so it survives the arrival of eight new modules and a second platform.
It **extends** that system to the surfaces that did not exist — recruitment, compliance, projects, the field app, documents.
It **refuses** to redesign what works. A reskin would consume the budget that missing loading states, empty states, keyboard access and a field app need. Where this document recommends change, the change is named and justified.

* * *

## 1\. Design principles

These six were reverse\-engineered from consistent behaviour in the implementation. They are now binding, and each carries a test.

### 1\. The HTML is the product

Marketing pages render complete answers server\-side, because AI crawlers do not execute JavaScript and content hidden behind hydration is content that does not exist to them. Nothing meaningful appears only after JavaScript runs.

> **Test:** disable JavaScript. Every marketing page still answers its question. Every form still submits.

### 2\. Consequence order, not data order

Screens answer *"what should I do next"*, never *"what data exists"*. The dispatch board sorts by SLA damage. The customers list leads with money at risk. The workforce board leads with people who cannot legally be sent to work. The invoices list leads with overdue.

This is the single strongest idea in the existing product and the one most at risk from well\-intentioned "improvements" — every request for a sortable column is a request to hand the decision back to the user.

> **Test:** the first item on any list screen is the item with the highest cost of being ignored. If a sort control exists, the default sort is still consequence.

### 3\. Never lose the enquiry; never blame the user

Every failure path ends in a phone number or a plain\-language instruction. Raw driver errors were treated as a defect and structurally removed. A database outage on the quote form shows two phone numbers, not an apology.

> **Test:** no rendered string anywhere contains database error text. There is an automated test asserting this, and it must stay.

### 4\. State machines, not free edits

Job, quote, invoice, application, contract and project status move only along defined edges. The UI offers only legal transitions — it does not offer everything and then refuse.

> **Test:** no screen renders a control that the domain layer will reject on grounds of state.

### 5\. Progressive enhancement

Forms are server\-action forms that work without JavaScript. Client JavaScript improves; it never gates. At this scale a client form library would be a dependency with no benefit.

> **Test:** as principle 1.

### 6\. Trust surfaces are explicit

*"Not actually sent."* *"Stored as hashes, shown once."* *"Nothing here affects anybody else's account."* The UI says what the system really does, in sentences.

This voice is a genuine differentiator and the security surfaces are where it earns most. It now extends to three new places where the stakes are higher: **compliance blocks** ("deploying without a valid permit carries a penalty of AED 100,000–1,000,000"), **applicant communication** ("we'll text you within 3 working days — whatever the outcome"), and **field\-app location** ("your location is recorded at these four moments. Not between them. Not outside your working hours.").

> **Test:** where the system does something a reasonable person would want explained, the screen explains it — before being asked.

### 7\. *(New)* A rule with a penalty is a wall, not a sign

Requirements that carry a statutory penalty are enforced, not advised. An assignment that would breach a work permit is not selectable. An outdoor job cannot be dropped into the summer midday ban.

The corollary matters as much: **everything else warns.** A system that blocks too much gets worked around, and a workaround is invisible. Three things block — expired blocking documents, expired work permits, the midday ban. Everything else warns and records a reason.

> **Test:** count the hard blocks. If the number grows, each addition needs a named statutory penalty.

* * *

## 2\. Design tokens

### 2\.1 Colour

The system is token\-driven with two themes (light, and dark via `prefers-color-scheme`), an ink\-neutral ramp, and a **single** signal accent. That restraint is correct and is preserved.

```
SURFACES
  --surface              page background
  --surface-raised       cards, panels, dialogs
  --surface-sunken       inset regions, code, disabled fields
  --surface-wash         tinted feedback backgrounds

TEXT
  --text-primary         body and headings
  --text-secondary       supporting text, labels
  --text-muted           metadata, timestamps, placeholders
  --text-on-accent       text on accent fills

BORDERS
  --border-hairline      default 1px separators
  --border-strong        emphasised boundaries, focused fields

ACCENT — one, and only one
  --accent               primary actions, active nav, focus
  --accent-hover
  --accent-wash          tinted accent background

STATUS — semantic, never decorative
  --status-critical      breached SLA · hard block · expired
  --status-warning       expiring · at limit · overdue soon
  --status-success       complete · valid · paid
  --status-info          scheduled · pending · informational
  --status-neutral       draft · dormant · archived
  each with a matching --status-*-wash for tinted backgrounds

NEW — required by the new modules
  --status-blocked       reserved for HARD blocks only. Visually
                         distinct from --status-critical, which means
                         "urgent". Blocked means "impossible", and the
                         difference must be legible at a glance.
  --lane-nonworking      the summer midday band and non-working hours
                         in the schedule view
```

**Rules.**

- **All foreground/background pairings meet WCAG AA and this is enforced in CI.** The existing contrast gate covers 36 pairings via `scripts/check-contrast.mjs` in `npm run check`. Every new token pair added by this document is added to that gate in the same commit. *A design system with a test is rarer than it should be — do not let this one decay.*
- **Colour never carries meaning alone.** Every status dot is paired with a text label, every warning with an icon and a sentence. This is non\-negotiable for the field app, where the screen is being read in direct sunlight.
- **One accent.** A second accent colour is a request to reconsider the information hierarchy, not a request for a token.

### 2\.2 Typography

Geist Sans and Geist Mono via `next/font`. Retained.

```
DISPLAY   text-2xl – text-3xl, tracking-tight     page titles
HEADING   text-lg – text-xl                        section headings
BODY      14–15px                                  default
SMALL     13px                                     metadata, labels
MONO      Geist Mono                               references, codes, keys,
                                                   TRN, licence numbers

NUMERICS  tnum / tabular-nums on ALL money and counts
          ← already correct; the reason columns of figures align
            and do not shimmer when they update
```

**Extensions.**

- **Field app:** minimum body size 16px, headings 20px\+. Read outdoors, at arm's length, in sun.
- **Documents (PDF):** a serif is permitted for body text on invoices and contracts where it reads as more formal — but the type scale, spacing rhythm and colour tokens are shared with the web system so a brand change is one edit, not two.
- **Arabic:** when the bilingual document variant is built (`INV-14`), pair with a matching Arabic face at a size that optically matches the Latin. Arabic at the same nominal point size reads smaller — this is a rendering decision made once, in the document templates, and nowhere else.

### 2\.3 Spacing, radius, layout

```
SPACING   Tailwind v4 scale. Vertical rhythm on a 4px base.
RADIUS    2–4px. Deliberately tight — institutional, not consumer-soft.
          Consistent throughout. This is a real stylistic decision and
          it suits a licensed contractor's operating system. Keep it.
LAYOUT    container-page wrapper; per-screen content max-widths;
          CSS grid for card layouts.
```

**Field app exception.** Touch targets are minimum 48×48px, primary actions 56px tall, and spacing between adjacent tappable elements is minimum 8px. The 2–4px radius is retained for visual continuity; the *sizing* changes, the *language* does not.

### 2\.4 Iconography

Phosphor, single family, consistent weights. Retained. New icon needs — certification, permit, contract, project, applicant, sync state, compliance block — are drawn from the same family at the same weight. **Do not introduce a second icon family**, and do not use an emoji as an icon in product UI.

* * *

## 3\. Voice and content

### 3\.1 The existing voice, defended

> *"Nothing is saved to your account until this code checks out."*

Sentences, not labels. Explanation before the user thinks to ask. Plain about what the system is actually doing. The audit named this a real differentiator in the security surfaces, and it was right.

### 3\.2 Rules

| Rule | Do | Don't |
| --- | --- | --- |
| Explain the mechanism | "Your session ends at 6pm. We'll warn you 5 minutes before." | "Session timeout" |
| Name the consequence | "Deploying without a valid permit carries a penalty of AED 100,000–1,000,000." | "Compliance issue" |
| Refuse with an alternative | "That's inside the summer midday ban. Next legal window: 15:00." | "Invalid time" |
| Own system failures | "We couldn't take this online right now. Please call 04 XXX XXXX." | "An error occurred. Please try again later." |
| Never blame | "Enter a phone number we can reach you on." | "Invalid input" |
| Verb\-ing on pending buttons | "Checking…" "Saving…" "Sending…" | "Please wait" |
| Keep promises the system keeps | "We'll text you within 3 working days — whatever the outcome." | "We'll be in touch" |
| State the retention | "We keep applications for 6 months unless you ask us to keep them longer." | *(silence)* |

### 3\.3 Voice by surface

| Surface | Register |
| --- | --- |
| Marketing | Direct, answer\-first. The first paragraph answers the question in the H1. No preamble — it is also the paragraph an AI assistant lifts. |
| Operator UI | Terse and factual. This is a tool used forty times a day. |
| Compliance messages | **Specific about the penalty.** "AED 5,000 per worker" changes behaviour; "compliance risk" does not. |
| Portal | Reassuring, concrete, reference\-first. "Reference SATS\-J\-01847. Rahim will arrive between 15:00 and 17:00." |
| Applicant | **Warm and honest.** These are people the company wants to hire. A rejection that gives a real reason converts into a re\-application. |
| Field app | **Imperative and short.** "I'VE ARRIVED." "START WORK." One instruction per screen. |
| Documents | Formal, complete, legally precise. Nothing conversational on a tax invoice. |

### 3\.4 Terminology

One word per concept, everywhere — UI, documents, emails, code, this document set.

| Use | Not |
| --- | --- |
| Job | ticket, work order, call |
| Visit | appointment, attendance |
| Quote | estimate, proposal *(a quote is a priced commitment; an estimate is not, and the distinction is contractual)* |
| Tax invoice | bill, invoice *(when the document is the statutory artefact, say so)* |
| Contract | AMC, agreement *(AMC is a contract type, not a synonym)* |
| Project | job *(a project contains jobs; the distinction is billing)* |
| Technician | engineer, worker, staff |
| Candidate / applicant | applicant is the person applying; candidate is the person record. One person, many applications. |
| Property | site, location |
| Asset | equipment, unit |
| Certification | cert, ticket, card |
| Blocked | disabled, restricted *(blocked means legally impossible)* |

* * *

## 4\. Component library

### 4\.1 Existing — documented so they survive

| Component | Behaviour | Notes |
| --- | --- | --- |
| **Form** | Server action \+ `useActionState`, `INITIAL` state object, disabled\-while\-pending buttons with verb\-ing labels | Consistent across the app. No client form library — correct at this scale. |
| **Banner** | `role="alert"` for errors, `role="status"` for success; icon \+ wash background | Accessible live regions, already correct |
| **Numeric input** | `inputMode="numeric"`, `autoComplete="one-time-code"` for codes, tabular numerals for money and counts | Already correct |
| **List** | Semantic lists with hairline dividers, money right\-aligned, status as tinted badges | Not sortable, by design (§1, principle 2) |
| **Status badge** | Tinted background \+ dot \+ **text label** | Never colour alone |
| **Destructive two\-step** | Reveal, then a code\-guarded or typed confirmation | e.g. turning off two\-factor |
| **Shells** | `AppShell` / `PortalShell` / marketing header\+footer, with active\-nav highlighting | Now role\-filtered — see wireframes §1.2 |
| **Marketing** | `Section`, `Eyebrow`, `ServiceCard`, `AnswerBlock` | The only genuinely shared component set today |

### 4\.2 The shared form kit — the one real refactor

**Problem the audit found:** app\-side components are duplicated per route. Each panel re\-declares `inputClass` / `inputStyle`, in roughly six files. Tolerable at the original scope; not tolerable across eight new modules, because the drift is guaranteed.

**`components/form.tsx`** — extract now, before the new modules multiply the duplication:

```
Field           label + control + description + error, wired for a11y
                (aria-describedby, aria-invalid, id association)
TextInput · TextArea · Select · Checkbox · RadioGroup
DateInput       forced DD/MM/YYYY, Asia/Dubai
MoneyInput      AED, integer minor units under the hood, tabular display
PhoneInput      UAE format, stores E.164 + local digits separately
                (the local-digits column is what duplicate matching uses)
FileInput       drag-drop, size and type validation, scan-status display
FormActions     primary + secondary, pending state, verb-ing labels
FieldError      role="alert", adjacent to its field
FormBanner      form-level error or success
```

**Rule adopted:** the third duplicate is a component. It already exists in about six files, so this is overdue rather than speculative.

### 4\.3 New components

| Component | Purpose | Notes |
| --- | --- | --- |
| **`ComplianceBlock`** | The hard\-block presentation | No interactive control at all. Icon \+ statement \+ penalty \+ link to fix. **Never a disabled button** — a disabled button reads as "try again later"; the absence of a control reads as "this is not possible". |
| **`WarningWithReason`** | Overridable warning requiring a typed reason | Primary action stays disabled until the reason is entered. `JOB-10`. |
| **`ExpiryChip`** | Date \+ days\-remaining \+ severity | `valid` / `expiring` / `expired` / `blocking`. Used identically on technicians, certifications, contracts, permits, licences. One component, five contexts. |
| **`SLAClock`** | Deadline \+ remaining/overdue \+ severity | Live\-updating. Announces politely to screen readers on threshold crossing, not on every tick. |
| **`ConsequenceList`** | The grouped list pattern | Severity\-grouped sections with counts, expandable. The dispatch board, the workforce board, the invoices list and the leads list are all this component. |
| **`StageCard`** | Kanban card for the ATS | Carries the **blocked\-on** indicator: colour \+ text label \+ duration. `ATS-8`. |
| **`EntitlementMeter`** | Consumed vs remaining | `▰▰▰▱ 3 of 4`. Contracts, and the portal. |
| **`EvidenceGrid`** | Role\-tagged photo grid | Enforces minimum before/after counts. Shows scan status where relevant. |
| **`SyncIndicator`** | Field app sync state | Persistent, in the header. Never hidden. `FLD-17`. |
| **`SignaturePad`** | Vector stroke capture | Consent statement rendered above the pad, version recorded. `FLD-13`. |
| **`TimelineList`** | Event stream | Jobs, applications, audit log. Append\-only data rendered as append\-only UI. |
| **`ScheduleLane`** | Technician row in the schedule | Renders the non\-working band, including the midday ban. |
| **`DocumentTemplate`** | PDF layout primitives | Shares tokens with the web system. |

### 4\.4 The `ComplianceBlock` pattern, in detail

Worth specifying precisely, because it is the component that carries the most legal weight and it is easy to get subtly wrong.

```
┌────────────────────────────────────────────────────────────┐
│  Mohammed Farooq · HVAC                                    │
│  ⛔ Work permit EXPIRED 4 Aug 2026                          │
│     Deploying without a valid permit carries a penalty of  │
│     AED 100,000–1,000,000.                                 │
│                                     [Open record →]        │
└────────────────────────────────────────────────────────────┘

  · No radio button, no checkbox, no disabled button
  · The reason is stated, not implied
  · The penalty is a number, not "a compliance risk"
  · There is always a route to fixing it
  · aria: role="note" with an accessible name; not an alert —
    it is a persistent condition, not an event
```

**Contrast with `WarningWithReason`\:**

```
┌────────────────────────────────────────────────────────────┐
│  ⚠ Suresh Nair's working-at-height certificate expires in  │
│    12 days. This job is flagged as working at height.      │
│                                                            │
│    Why are you assigning anyway?                           │
│    [________________________________________________]      │
│                                     (Cancel)  [Assign]     │
└────────────────────────────────────────────────────────────┘

  · Selectable, but the primary action is disabled until a
    reason is typed
  · The reason is stored and reportable
  · This is a decision, and it is recorded as one
```

The visual difference between these two must be immediate. A dispatcher under time pressure should never have to read carefully to know which one they are looking at.

* * *

## 5\. Accessibility

### 5\.1 Position

Contrast is genuinely good and CI\-enforced. **Keyboard traversal and screen\-reader behaviour have never been audited.** That is the gap.

### 5\.2 Requirements

| ID | Requirement | Status |
| --- | --- | --- |
| `A11Y-1` | WCAG 2.2 AA across all surfaces | Contrast ✅ · rest unaudited |
| `A11Y-2` | Contrast gate in CI, extended to every new token pair | ✅ Extend |
| `A11Y-3` | **Define a `--focus-ring` token and apply `:focus-visible` consistently.** Focus is currently undefined — a genuine gap for keyboard users, and the audit flagged it. | ❌ Required |
| `A11Y-4` | **Keyboard traversal audit** — every interactive element reachable, logical order, no traps, skip link to main content, dialogs trap focus and restore it on close | ❌ Never performed |
| `A11Y-5` | **Screen\-reader audit** — NVDA and VoiceOver, on the five load\-bearing journeys: quote submission, login \+ MFA, assign, quote approval, application | ❌ Never performed |
| `A11Y-6` | Live regions: `role="alert"` for errors, `role="status"` for success. Already correct — extend to the SLA clock (polite, on threshold only) and the sync indicator | ✅ Extend |
| `A11Y-7` | Every form control has an associated label. Placeholder is never the label. | Verify |
| `A11Y-8` | Errors announced and programmatically associated via `aria-describedby` and `aria-invalid` | Verify |
| `A11Y-9` | Colour never sole carrier of meaning — every status has a text label | ✅ Maintain |
| `A11Y-10` | Respect `prefers-reduced-motion` | Verify — motion is minimal today |
| `A11Y-11` | Field app: iOS and Android accessibility APIs, dynamic type support, minimum 48px targets | New |
| `A11Y-12` | Marketing pages usable and complete without JavaScript | ✅ Maintain |
| `A11Y-13` | Documents: tagged PDFs with a logical reading order | New |

### 5\.3 Keyboard shortcuts *(new)*

The dispatch\-heavy personas — operations manager and dispatcher — are in these screens all day. Shortcuts are an efficiency feature *and* an accessibility feature.

```
⌘K / Ctrl-K    global search
G then D       dispatch          G then J   jobs
G then S       schedule          G then L   leads
G then C       customers         G then I   invoices
N              new (context-sensitive)
/              focus filter
Esc            close dialog, clear filter
?              shortcut help
```

Discoverable via `?` and shown inline in the search overlay. Never the only route to an action.

* * *

## 6\. Motion

### 6\.1 Position

Motion is currently minimal, and that is correct for an operations tool. This section resists adding any.

### 6\.2 Rules

| Use | Duration | Easing |
| --- | --- | --- |
| State change (badge, chip) | 120ms | ease\-out |
| Dialog enter / exit | 180ms / 120ms | ease\-out / ease\-in |
| Panel expand / collapse | 200ms | ease\-in\-out |
| Skeleton shimmer | 1\.4s loop | linear |
| Drag feedback (schedule) | immediate | — |
| Field app screen transition | 200ms | platform default |

**All motion respects `prefers-reduced-motion: reduce` and drops to an instant state change.**

**No** page transitions, parallax, scroll\-triggered animation, or animated illustration. Every one of those costs time in a tool used forty times a day.

### 6\.3 Loading states — the one real addition

The audit found **no loading skeletons anywhere**, tolerated because React Server Components plus fast queries made it invisible — but noted that database cold starts would eventually expose it.

**`D-1`\:** add `loading.tsx` per route group for the heaviest routes — dispatch, schedule, jobs, customers, invoices, recruitment pipeline, workforce.

**Skeletons match the real layout.** A skeleton that does not match causes a visible jump when content arrives, which is worse than a spinner. **Never a spinner for page load.**

* * *

## 7\. Layout patterns

### 7\.1 Page archetypes

Five archetypes cover every screen in the product. New screens choose one rather than inventing a sixth.

```
A — CONSEQUENCE LIST          B — DETAIL + SIDEBAR
┌──────────────────────┐      ┌───────────────┬──────────┐
│ Title      [Primary] │      │ Header + status          │
│ [Filters]            │      ├───────────────┼──────────┤
├──────────────────────┤      │ Main content  │ Actions  │
│ ⛔ CRITICAL      (n)  │      │ Timeline      │ Meta     │
│  ┌────────────────┐  │      │ Related       │ Related  │
│  └────────────────┘  │      │               │          │
│ ⚠ WARNING       (n)  │      └───────────────┴──────────┘
│ ○ NORMAL        (n)  │      Stacks below 900px,
└──────────────────────┘      actions panel FIRST on mobile

C — BOARD / KANBAN            D — CALENDAR / LANES
┌────┬────┬────┬────┐         ┌──────┬─────────────────┐
│ St │ St │ St │ St │         │ Lane │ ████  ▓▓  ███   │
│ ┌┐ │ ┌┐ │ ┌┐ │ ┌┐ │         │ Lane │ ██   ▓▓   ████  │
│ └┘ │ └┘ │ └┘ │ └┘ │         ├──────┴─────────────────┤
└────┴────┴────┴────┘         │ Unscheduled tray       │
Tabs per stage on mobile      └────────────────────────┘
                              Desktop only; list on mobile

E — FORM / WIZARD
┌──────────────────────┐
│ ▰▰▱▱ Step 2 of 4     │   One question group per step
├──────────────────────┤   Progress always visible
│ Fields               │   Back never loses entered data
│ Inline errors        │   Mobile-first
│ (Back)  [Continue →] │
└──────────────────────┘

Archetype by screen:
  A  dispatch · leads · jobs · customers · invoices · workforce ·
     contracts · projects · technicians
  B  job · lead · customer · contract · project · invoice ·
     candidate · technician
  C  recruitment pipeline · project phases
  D  schedule
  E  quote form · application · convert lead · hire · onboarding
```

### 7\.2 Density

| Surface | Density | Rationale |
| --- | --- | --- |
| Marketing | Generous | Reading, and being crawled |
| Operator lists | **Dense** | Forty times a day; scanning, not reading |
| Detail screens | Medium | Reading and acting |
| Portal | Generous | Occasional use, mobile, non\-expert |
| Field app | **Generous with large targets** | Gloves, sunlight, one hand |
| Documents | Formal | Print and legal review |

* * *

## 8\. Document design

New surface. Quotes, tax invoices, credit notes, job sheets, statements and tender packs are the artefacts that leave the building — a customer, an accountant, a tax auditor and an owners\-association tender committee will judge the company on them. They deserve the same care as the UI, and more scrutiny.

### 8\.1 Shared structure

```
┌──────────────────────────────────────────────────────────┐
│  [LOGO]                              TAX INVOICE         │
│  SUMON AKON TECHNICAL SERVICES       SATS-INV-2026-0184  │
│  DET licence 930137 · CR {number}    Issued  12 Aug 2026 │
│  TRN {15 digits}                     Supply  11 Aug 2026 │
│  {address} · ☎ {phone}               Due     11 Sep 2026 │
├──────────────────────────────────────────────────────────┤
│  BILL TO                                                 │
│  Emirates Property Management                            │
│  TRN {15 digits} · {address}                             │
├──────────────────────────────────────────────────────────┤
│  Description              Qty   Unit    VAT      Amount  │
│  ──────────────────────────────────────────────────────  │
│  AC repair — SATS-J-01847                                │
│   Labour                  2.5   180.00   5%      450.00  │
│   Capacitor 45µF          1     120.00   5%      120.00  │
│                                                          │
│                              Subtotal        AED 1,450.00│
│                              Discount        AED  −145.00│
│                              Net             AED 1,305.00│
│                              VAT 5%          AED    65.25│
│                              ══════════════════════════  │
│                              TOTAL DUE       AED 1,370.25│
├──────────────────────────────────────────────────────────┤
│  Payment terms 30 days · Bank {details}                  │
│  {legal footer · licence · CR · TRN}          Page 1/1   │
└──────────────────────────────────────────────────────────┘
```

### 8\.2 Rules

- **Every legally mandated field is present and unmissable.** "Tax Invoice" as a heading, not a subtitle. TRN adjacent to the name, not buried in a footer. Sequential number top\-right where an accountant looks first.
- **Money is right\-aligned, tabular, always with the AED prefix**, always two decimals. VAT applied after discount, and the arithmetic shown so a reader can verify it without a calculator.
- **The licence and Commercial Register numbers appear on every document.** Legally required, and the strongest trust signal available.
- **Type and colour tokens are shared with the web system.** A brand change is one edit.
- **Print\-safe:** everything legible in greyscale. Status is never conveyed by colour alone on a document, because documents get photocopied and faxed.
- **Tagged PDFs** with a logical reading order (`A11Y-13`).
- **Arabic bilingual is a layout variant of the same template**, never a second template. Two\-column parallel layout, Arabic right\-aligned, with an Arabic face optically matched to the Latin.
- **Job sheets are hashed and immutable.** The rendered artefact is what the SHA\-256 covers (`FLD-14`). Template changes must never alter an already\-signed document — which is why rendered PDFs are stored, not re\-rendered on demand.

### 8\.3 Tender pack

A separate discipline: this document competes against two other bidders in a RERA\-mandated three\-bid process.

```
Cover              company identity, licence 930137, tender reference
Company profile    licensed activities, years operating, team size
Accreditations     DET licence · DEWA enrolment + grade · ISO ·
                   insurance certificates — all with expiry dates,
                   assembled live from company_accreditations so the
                   pack is never stale (CON-12)
Scope of work      per property, per asset
PPM schedule       per asset, per frequency — the artefact that
                   distinguishes a real contractor from a price
Schedule of rates  priced, per service, per rate band
References         previous contracts, with permission
Compliance         HSE policy, method statements, risk assessments
```

* * *

## 9\. Field app design

Different physical context, same design language.

### 9\.1 Constraints

| Constraint | Response |
| --- | --- |
| Bright sunlight | Maximum contrast. Light theme default. Large type. No thin weights. |
| Gloves | 48px minimum targets, 56px for primary actions, 8px minimum separation |
| One\-handed | Primary actions in the bottom third; navigation reachable by thumb |
| No signal | Every screen renders from the local store. Sync state always visible. |
| Battery | No polling. No background animation. Photos compressed on device. |
| Interrupted | Every screen resumes exactly where it left off after the app is killed |

### 9\.2 Rules

- **One primary action per screen.** "I'VE ARRIVED." "START WORK." "FINISH THE JOB." If a screen needs two, it needs to be two screens.
- **Never a dead end.** Every path — including "no access", "customer refused to sign", "unsafe to proceed" — ends cleanly with a recorded outcome. A technician who cannot record what actually happened will write nothing.
- **Sync state is permanent furniture**, in the header, on every screen. Not a settings page, not a badge that appears on failure.
- **Offline is a normal state, not an error.** "Everything you record is saved. It will send when you have signal." Never a red banner for a condition the technician cannot control and does not need to worry about.
- **Location transparency is a screen, not a policy page.** Always reachable, in plain language, naming the four moments location is recorded and stating that it is not recorded between them or outside working hours.

### 9\.3 Field colour adjustments

```
--surface        near-white, maximum luminance for sunlight
--text-primary   near-black, maximum contrast
--status-*       higher saturation than web; sunlight desaturates
                 perceived colour
Dark theme       available but NOT default — a technician in a plant
                 room at 2pm needs maximum luminance, not a dark UI
```

* * *

## 10\. Change register

What this document changes about the existing design, with justification.

| \# | Change | Why | Priority |
| --- | --- | --- | --- |
| `D-1` | Add `loading.tsx` skeletons to the seven heaviest routes | Database cold starts will expose the absence; skeletons must match layout | P2 |
| `D-2` | Extract `components/form.tsx` | Already duplicated in \~6 files; eight new modules would multiply it | P2 |
| `D-3` | Define `--focus-ring`; audit keyboard traversal | Contrast is tested, focus is not — a real gap for keyboard users | P1 |
| `D-4` | Screen\-reader audit on five journeys | Never performed | P1 |
| `D-5` | Replace all placeholder imagery | Both a brand risk and an external request on every marketing page view | P0 |
| `D-6` | Role\-filtered navigation | Eleven roles and eight new modules; one shared nav no longer works | P1 |
| `D-7` | Add `--status-blocked`, visually distinct from critical | "Impossible" must not look like "urgent" | P1 |
| `D-8` | Add keyboard shortcuts for dispatch personas | All\-day users; efficiency and accessibility | P2 |
| `D-9` | Document design system (new surface) | Quotes, invoices, job sheets, tender packs leave the building | P1 |
| `D-10` | Field app design language | New platform, same system | P3 |
| `D-11` | Session\-expiry warning with state preservation | Currently loses work silently at hour 12 | P1 |
| `D-12` | Empty states on every list | Seed data was always present in development; the first real week meets blank screens | P2 |

### 10\.1 Explicitly not changing

- **The colour system.** One accent, ink neutrals, semantic status. Restrained and correct.
- **The 2–4px radius.** Institutional rather than consumer\-soft. A real decision that suits the product.
- **The typography.** Geist Sans and Mono, tabular numerals on money. Correct.
- **Consequence\-ordered lists.** The best idea in the product.
- **Inline feedback instead of toasts.** A message that vanishes after four seconds is not a message.
- **Server\-action forms with progressive enhancement.** No client form library at this scale.
- **The voice.** Sentences, not labels. Extend it to the new surfaces; do not sand it down.

* * *

## 11\. Design governance

**Contrast gate stays in CI.** Every new token pair joins it in the same commit that introduces it. A design system with a test is rare; this one has one and it should not decay.

**New components join §4.3 before they ship**, or they will be reinvented by the next screen.

**The archetype rule:** a new screen picks one of the five layout archetypes in §7.1. Inventing a sixth requires a written reason.

**The hard\-block rule:** adding a hard block requires naming the statutory penalty it prevents. There are currently three. Growth needs justification, because a system that blocks too much gets worked around, and a workaround is invisible.

**The duplication rule:** the third duplicate is a component.

**The accessibility rule:** keyboard and screen\-reader audits are re\-run per release, not once. They were never run at all, which is how the gap opened.

* * *

## 12\. What good looks like

> A dispatcher opens the board at 14:32. The overdue P1 is first, because it costs the most to ignore. She clicks assign.
> 
> Five technicians appear in three groups. Three are available. One carries an amber warning. Two are in a group with no radio buttons at all — one has an expired work permit, and the screen says exactly what that would cost.
> 
> She picks the warned one, because he is twelve minutes away. The assign button is dead until she types why. She types it. It is recorded.
> 
> She drags the next job — an outdoor repaint — onto the 13:15 slot. The lane refuses it, names the summer midday rule, and offers 15:00. She takes it.
> 
> None of that required her to read a policy document, and none of it took longer than the phone call it replaced.
> 
> That is the whole design brief.
