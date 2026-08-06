# Assumptions

Read this first. The brief specified an extremely broad platform but not the business operating it,
so the following were decided rather than given. Each one is cheap to change now and expensive to
change after the site is indexed or the first contract is signed.

## Confirm these before launch

### 1. Market is Dubai / UAE, currency AED

**Why assumed:** the requested service mix is regionally specific. Annual maintenance contracts as a
named product, gypsum and false ceiling as a standalone trade, glass and aluminium works, and
contract workforce supply as a service line together describe the GCC market, and the UAE most
strongly.

**What depends on it:** all pricing, `tenant.ts`, area lists, DEWA and Dubai Municipality references,
VAT at 5%, the `AE` country code in structured data, the Arabic/Hindi/Urdu locale list.

**Cost to change:** one file, [`packages/core/src/tenant.ts`](../../packages/core/src/tenant.ts), plus
the price figures in `catalog.ts`. Under an hour. **After launch it also costs your search rankings**,
because every service page targets `<service> in Dubai`.

### 2. The company is the operator, not a SaaS vendor

**Why assumed:** the brief describes both "help the business automate operations" (single operator)
and "scale into a multi-branch business" and "multi-tenant architecture" (SaaS). These are different
products.

**What was built:** the schema is multi-tenant from day one, so selling the platform later does not
require a migration. The website is single-tenant and branded as the operator. This covers both
readings at close to zero extra cost, which is why it was not escalated as a blocking question.

**What to confirm:** whether the medium-term intent is to sell this platform to other maintenance
companies. If yes, phase 4 needs a tenant onboarding and billing surface that is not currently scoped.

### 3. Brand name and all company details are placeholders

`Meridian Facilities Management LLC`, the trade licence numbers, the phone numbers, the `.example`
domain, the statistics, and the ISO certifications are **all invented**.

The statistics in particular (`62,000+ jobs`, `94% renewal rate`, `under 60 min` median response) are
presented on the website as fact. **They must be replaced with real figures or removed before the
site goes live.** Publishing invented performance claims is a legal and reputational problem, not a
content-polish task. This is on the [launch checklist](../ops/03-launch-checklist.md) as a blocker.

### 4. Prices are market-plausible, not quoted

Every price in `catalog.ts` is a researched-plausible Dubai market rate, not a rate this business has
agreed to honour. They are marked "from" throughout and the site says final pricing follows a survey,
but they still set expectations. Review the full list with whoever owns margin before launch.

### 5. Photography is placeholder

All images are `picsum.photos` seeds. They are visually coherent but they are stock strangers, not
this company's technicians. Replace before launch.

## Decided without needing confirmation

These were judgment calls where any reasonable answer works and the cost of being wrong is low.

- **English-first, i18n-ready.** The site ships in English with `locales` declared in the tenant
  profile. Arabic matters commercially in this market and needs RTL layout work, which is scheduled
  in phase 3 rather than bolted on now.
- **Static rendering over SSR.** The marketing site has no per-request state. Static is faster,
  cheaper, and more reliable for crawlers.
- **No CMS yet.** Content lives in typed TypeScript, which gives type safety and makes structured
  data impossible to desync. A CMS becomes worth it when non-engineers need to publish, which is
  phase 3.
- **AI crawlers allowed in `robots.txt`.** Optimising for answer engines while blocking their
  crawlers is self-defeating. Reversible in one line if the client disagrees.

## Where this document is referenced from

`packages/core/src/tenant.ts` points here, so anyone reading the tenant profile finds the assumption
before they trust the data.
