# ADR 0002: One service catalogue drives content, structured data and operations

**Status:** Accepted · **Date:** 2026-08-06

## Context

The same list of services appears in at least seven places: marketing page copy, `Service` JSON-LD,
`FAQPage` JSON-LD, the sitemap, `llms.txt`, the quote form's picker, and (later) the job taxonomy the
dispatcher schedules against and the coverage list on AMC contracts.

Every one of those is a place the list can drift. And the AEO/GEO strategy rests on a specific
claim — that structured data never asserts something the visible page does not also say — which is
exactly the kind of claim that quietly stops being true.

## Decision

[`packages/core/src/catalog.ts`](../../packages/core/src/catalog.ts) is the single source of truth.
Every consumer derives from it; nothing hand-writes a service name, price or FAQ.

Each `Service` carries what all consumers need: `slug` (the shared taxonomy key), `answer` (the
extractable paragraph), `aliases` (how people actually search), `scope`, `commonProblems`,
`responseTime`, `priceFrom`, `emergency`, `amcEligible`, `faqs`, `related` and `industries`.

The same `slug` is used as `jobs.service_slug`, `technician_skills.service_slug` and
`assets.service_slug`, so a service added for SEO is automatically dispatchable and a job type the
dispatcher understands automatically has a public page.

## Consequences

**Good.** The "never mark up an unstated claim" guarantee holds *structurally* rather than by review:
the JSON-LD builder and the page component read the same object. Adding a service is one entry and it
appears in the nav, the grid, the sitemap, `llms.txt`, the structured data and the quote form with no
further work. Type errors catch missing fields at build time.

**Bad.** Content changes require a developer and a deploy. That is acceptable now and becomes
unacceptable once marketing wants to publish independently — which is what phase 3's CMS is for. The
migration path is to keep the shape and change the source from a TypeScript literal to a fetch, so
consumers do not change.

**Bad.** The file is long (24 services with full content). That is content, not logic, and splitting
it per-service would trade one navigable file for 24 and make cross-service consistency harder to
see.

## Constraint this places on future work

If someone later adds a hand-written JSON-LD block, or writes service copy directly into a page
component, the guarantee is gone and the AEO claims in
[the playbook](../architecture/06-aeo-geo.md) become aspirational. Reviewers should treat
hand-written structured data as a defect.
