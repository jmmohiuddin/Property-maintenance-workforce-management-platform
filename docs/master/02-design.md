# Part 2 — Design

Deliverable sections 11–13: product design document, information architecture, UX/UI
specification. Everything here is **CURRENT DESIGN** unless explicitly marked
**RECOMMENDED DESIGN** — the rule of this audit is to document what shipped, not to invent a
prettier system that conflicts with it.

---

## 11. Product Design Document

### 11.1 Design principles (reverse-engineered from consistent behaviour in the implementation)

1. **The HTML is the product.** Marketing pages render complete answers server-side because AI
   crawlers don't execute JavaScript. No content hides behind hydration.
2. **Consequence-ordered screens.** The dispatch board sorts by SLA damage, the customers list
   leads with money at risk, cert alerts surface before assignment. Screens answer "what should
   I do next", not "what data exists".
3. **Never lose the enquiry / never blame the user.** Every failure path ends in a phone number
   or a plain-language instruction. Raw driver errors were treated as a defect and structurally
   removed (`UserFacingError` + `userMessage()`).
4. **State machines over free edits.** Job status, quote status, invoice status only move along
   defined edges; the UI offers only legal transitions.
5. **Progressive enhancement.** Forms are server-action forms that work without JS
   (`useActionState` + hidden action refs); client JS improves, never gates.
6. **Trust surfaces are explicit.** "Not actually sent", "stored as hashes, shown once",
   "nothing here affects anybody else's account" — the UI says what the system really does.

### 11.2 Information architecture

Three route groups, three shells, one auth boundary:

```
(marketing)  public, static/SSG, site-header/site-footer shell
  / /services /services/[24 slugs] /areas /areas/[19 slugs] /industries /contracts
  /emergency /careers /about /contact /quote /privacy /terms  (+ robots, sitemap, llms.txt)
(app)        staff, force-dynamic, AppShell (nav: Dispatch, Jobs, Leads, Customers,
             Technicians, Invoices; user name → /security)
  /login /login/verify /security /denied
  /dispatch /jobs /jobs/[id] /leads /customers /customers/[id] /technicians /technicians/[id]
  /invoices
(portal)     customer, force-dynamic, PortalShell
  /portal /portal/request /portal/quotes/[id]
```

Role → landing: staff → /dispatch; customer role → /portal; wrong-role access → /denied.
**IMPLICIT DECISION:** dispatchers and accountants land on the same board and share one nav —
no role-tailored home. Fine at this size; revisit when accountants outnumber ops.

### 11.3 Screen inventory (condensed; states verified in code)

| Screen | User | Purpose / primary action | States implemented |
| --- | --- | --- | --- |
| Home, service ×24, area ×19, industries, contracts, emergency, about, careers, contact | Visitor | Answer questions; convert → /quote or phone | Static; no loading/error states needed |
| /quote | Visitor | Submit enquiry (primary CTA of the whole public site) | Field errors, success w/ reference, rate-limited refusal, DB-failure fallback w/ phones ✅ |
| /login, /login/verify | All | Authenticate; second factor (TOTP or recovery code, same box) | Generic error, locked, MFA challenge, expired challenge ✅ |
| /security | All | MFA enrol (QR + manual key), recovery codes (shown once), turn off, session info | Pending-enrolment kept alive on wrong code ✅; recovery-code-used banner w/ remaining count ✅ |
| /dispatch | Ops/dispatcher | Work the SLA queue | Populated; empty ("no open work") — *loading state: none; RSC blocks* |
| /jobs, /jobs/[id] | Staff | Status filter; transitions, assignment, quote panel, invoice panel | Legal-transition buttons only; assignment warnings; invoice gated on sign-off ✅ |
| /leads | Sales/ops | Qualify, convert form | Stage badges; convert validation errors ✅ |
| /customers, /customers/[id] | Staff | AR position; terms/contacts/properties panels | Overdue alert banner; exactly-one-primary contact enforced; coordinate warnings ✅ |
| /technicians, /technicians/[id] | Ops | Roster, cert alerts, coverage warnings; skill/cert panels | Lapsed-cert and uncovered-service banners ✅ |
| /invoices | Accountant | AR ageing list | Populated/empty ✅ |
| /portal | Customer | Dashboard: jobs, quotes awaiting decision | Empty states with guidance ✅ |
| /portal/request | Customer | Raise request → job | Validation, success w/ reference ✅ |
| /portal/quotes/[id] | Customer | Approve/reject with reason | Decided state locks form; cross-customer access = 404-equivalent ✅ |

**Gaps (RECOMMENDED DESIGN):** no loading skeletons anywhere (RSC + fast queries make this
tolerable today; add `loading.tsx` per group when Neon cold starts bite); no toast system —
success/error is inline-only; no global search; no keyboard shortcuts for the dispatch-heavy
personas; session-expiry mid-form loses work silently (F2 debt).

## 12. Interaction & component patterns

| Pattern | Implementation | Notes |
| --- | --- | --- |
| Forms | Server actions + `useActionState`, `INITIAL` state object, disabled-while-pending buttons with verb-ing labels ("Checking…") | Consistent across app; no client-side form library — correct call at this scale |
| Feedback | Inline `Banner` with `role="alert"` (errors) / `role="status"` (success), icon + wash background | Accessible live regions ✅ |
| Numeric input | `inputMode="numeric"`, `autoComplete="one-time-code"` for codes; `tnum`/tabular-nums for all money and counts | ✅ |
| Tables/lists | Semantic lists with hairline dividers, money right-aligned, status as tinted badges | No sortable tables — acceptable |
| Destructive/risky | Two-step reveal (e.g. "Turn off two-factor" → code-guarded confirm) | ✅ |
| Shells | `AppShell` / `PortalShell` / marketing header+footer; active-nav highlighting | ✅ |
| Reusable components | `Section`, `Eyebrow`, `ServiceCard`, `AnswerBlock` (marketing); panels are route-local client components | **IMPLICIT DECISION:** app-side components are duplicated per route rather than shared (each panel re-declares `inputClass`/`inputStyle`). Tolerable now; extract a shared form kit when the third duplicate appears — it already exists in ~6 files. |

## 13. Design system (CURRENT)

- **Typography:** Geist Sans / Geist Mono via `next/font`; display sizes `text-2xl–3xl`
  tracking-tight for page titles; body 14–15px; mono for references/codes/keys.
- **Color:** token-driven, two themes (light + `prefers-color-scheme: dark`), ink neutral ramp +
  single `signal` accent; semantic tokens (`--surface`, `--surface-raised`, `--text-primary`,
  `--text-secondary`, `--text-muted`, `--border-hairline/strong`, `--accent*`). All 36
  foreground/background pairings are enforced ≥ WCAG AA by `scripts/check-contrast.mjs` in
  `npm run check` — the design system has a *test*, which is rarer than it should be.
- **Radii:** deliberately tight (2–4px) — institutional, not consumer-soft. Consistent.
- **Spacing/layout:** Tailwind v4 utilities; `container-page` wrapper; content max-widths
  per screen; CSS grid for card layouts.
- **Iconography:** Phosphor (`@phosphor-icons/react`), single family, consistent weights.
- **Voice:** sentences, not labels ("Nothing is saved to your account until this code checks
  out."). This is a real differentiator in the security surfaces — keep it.

**RECOMMENDED DESIGN (only where non-conflicting):** (1) add `loading.tsx` skeletons for the
four heaviest app routes; (2) extract the repeated input/button styles into `components/form.tsx`;
(3) define a focus-visible ring token and audit keyboard traversal (contrast is tested,
focus is not); (4) replace `picsum.photos` placeholders before any real launch — they are both
a brand risk and an external request on every marketing page view.
