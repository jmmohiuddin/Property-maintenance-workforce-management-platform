# System architecture

## Shape

```
                    ┌──────────────────────────────────────────┐
                    │  Public website  (apps/web)              │
   Customers ──────▶│  Next.js, statically prerendered         │
   AI crawlers ────▶│  32 routes, JSON-LD, llms.txt            │  BUILT
                    └───────────────┬──────────────────────────┘
                                    │ server actions
                    ┌───────────────▼──────────────────────────┐
                    │  Platform API  (apps/api)                │  PHASE 2
   Portal ─────────▶│  Auth, RBAC, jobs, dispatch, billing     │
   Mobile ─────────▶│                                          │
                    └───────────────┬──────────────────────────┘
                                    │ withTenant(ctx, fn)
                    ┌───────────────▼──────────────────────────┐
                    │  PostgreSQL  (packages/db)               │
                    │  31 tables, forced RLS, audit triggers   │  BUILT
                    └──────────────────────────────────────────┘

                    ┌──────────────────────────────────────────┐
                    │  packages/core                           │
                    │  Catalogue, tenant profile, JSON-LD,     │  BUILT
                    │  shared validation schemas               │
                    └──────────────────────────────────────────┘
```

`packages/core` is shared by every layer on purpose. The service catalogue is simultaneously the
marketing taxonomy, the structured-data source and the job taxonomy the dispatcher will schedule
against. Keeping one definition means a service added for SEO is automatically bookable, and a job
type the dispatcher understands automatically has a public page.

## Stack, and why

| Layer | Choice | Why this over the obvious alternative |
| --- | --- | --- |
| Web | Next.js 16, App Router, React 19 | Static prerendering is the requirement (crawlers), and RSC keeps the shipped JS near zero on content pages. A SPA would have failed the crawlability constraint outright. |
| Styling | Tailwind v4 + CSS custom properties | Semantic tokens (`--surface`, `--text-muted`) rather than `dark:` on every utility, so dark mode is one override block. Contrast is gated by a script, not by review. |
| Database | PostgreSQL 16 | RLS is the reason. No other mainstream database gives a tenant boundary the application cannot bypass. |
| ORM | Drizzle | SQL-first, so RLS session variables and raw policy interaction are natural. Prisma's abstraction fights `set_config` patterns. |
| Validation | Zod 4 | One schema shared by client form, server action and eventually the API, so validation cannot drift between them. |
| Icons | Phosphor | Consistent weights, tree-shakeable, SSR entry point. |
| Mobile (phase 3) | Expo + WatermelonDB | See ADR 0004. Offline-first is non-negotiable for technicians in basements and plant rooms. |
| AI (phase 4) | Claude API | See ADR 0005 for model tiering. |

TypeScript 7 is used across all workspaces. Note that it does not auto-discover ambient `@types`
the way TS 5 did, so Node-only packages declare `"types": ["node"]` explicitly in their tsconfig.
This is documented because it cost time to diagnose once.

## Rendering strategy

| Route | Mode | Reason |
| --- | --- | --- |
| `/`, `/services`, `/services/[slug]`, `/emergency`, `/contracts`, `/industries`, `/about`, `/contact` | Static (prerendered) | Content pages with no per-request state. Crawlers get complete HTML. |
| `/quote` | Dynamic | Reads `?service=` to preselect. Could be static with client-side reading, but the server render is cheap and keeps the preselected state in the HTML. |
| `/llms.txt`, `/sitemap.xml`, `/robots.txt` | Static | Generated at build from the catalogue. |

24 of the 37 built routes are prerendered service pages.

## Data flow: a job, end to end

This is the path the platform is being built toward. Steps marked BUILT exist today.

1. **Capture.** Customer submits `/quote` (BUILT), calls, or WhatsApps. The form validates against
   the shared Zod schema server-side (BUILT) and will create a `leads` row, or a `jobs` row directly
   when urgency is `emergency` (PHASE 2).
2. **Triage.** Service type, priority and estimated duration confirmed. AI-assisted triage writes to
   `jobs.ai_triage` with its reasoning, and a human can override (PHASE 4).
3. **SLA clock starts.** `respond_by_at` and `resolve_by_at` are stamped from the contract's
   `sla_targets` or from defaults. Breach reporting compares actuals against these two columns.
4. **Assign.** The dispatcher creates a `job_visits` row. `assignment_method` records whether a human
   or the optimiser made the call, and `assignment_score` records why. That column exists so the
   optimiser can be measured against the dispatcher before it is trusted with more of the board.
5. **Execute.** Technician accepts, travels, arrives. `job_visits` timestamps each transition;
   `within_geofence` flags arrivals that do not match the property location.
6. **Record.** `job_reports` (fault found, work done), `job_attachments` (before/after photos),
   `job_materials` (parts consumed), `job_signoffs` (customer signature, geotagged).
7. **Close and bill.** Job moves to `signed_off`, then an invoice is raised against what was actually
   signed for.

Every status transition writes a `job_events` row, so "why did this job sit for three days" is
answerable without guessing.

## Why a job has visits

`job_visits` is a separate table rather than a `scheduled_at` column on `jobs` because in this trade
the multi-visit case is normal, not exceptional: parts on order, no access, customer deferred,
multi-day works, a second trade needed. Modelling one job as one visit forces every one of those
into either a status hack or a duplicate job, and it makes first-time-fix rate uncomputable.

## Deferred deliberately

The brief asked for these. They are designed but not built, and pretending otherwise would be
misleading:

- Customer portal, admin dashboard, dispatch board (phase 2)
- Technician mobile app with offline sync (phase 3)
- AI receptionist, quote generation, dispatch optimisation, forecasting (phase 4)
- Payments, payroll, commission (phase 5)

See [the roadmap](05-roadmap.md) for sequencing and the reasoning behind that order.
