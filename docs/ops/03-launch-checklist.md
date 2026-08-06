# Launch checklist

Everything here applies to the **public website**, which is the only thing currently shippable.

## Blockers — do not go live until these are done

- [ ] **Replace all invented company data.** `packages/core/src/tenant.ts` contains a fabricated legal
      name, trade licence numbers, phone numbers, an `.example` domain, and ISO certifications.
- [ ] **Replace or remove the statistics.** `62,000+ jobs`, `94% renewal rate`, `under 60 min median
      response`, `180+ technicians` are all invented and are presented on the site as fact.
      Publishing unverified performance claims is a legal and reputational problem, not a copy nit.
      Either substitute real figures or delete the band.
- [ ] **Review every price** in `packages/core/src/catalog.ts` with whoever owns margin. They are
      market-plausible research, not rates this business has agreed to honour.
- [ ] **Confirm the market assumption.** Everything is Dubai/UAE/AED. See
      [assumptions](../product/00-assumptions.md). Changing this after indexing costs rankings.
- [ ] **Replace placeholder photography.** All images are `picsum.photos` seeds. Remove the
      `picsum.photos` entry from `next.config.ts` `remotePatterns` once real assets are hosted.
- [ ] **Set `NEXT_PUBLIC_SITE_URL`** to the real domain. Every absolute URL in JSON-LD, the sitemap
      and `llms.txt` derives from it; leaving it wrong silently poisons all structured data.
- [ ] **Verify the emergency phone number reaches a person 24/7.** The site states this explicitly and
      repeatedly. If it is not true, the claim has to come off the site before launch.

## Legal and compliance

- [ ] **Have `/privacy` and `/terms` reviewed by a UAE-qualified lawyer.** Both pages are written and
      describe intended practice in plain language, but they are unreviewed. Each currently renders a
      visible "pending legal review" banner so nobody mistakes them for vetted documents. Remove the
      `ReviewBanner` component from both pages once sign-off is done.
- [ ] Confirm the terms match reality: the 90-day workmanship warranty, the 10-year waterproofing
      warranty, the 4-hour cancellation window and the AED 10,000,000 liability figure are all stated
      as commitments
- [ ] Confirm the careers page claims are true — WPS payment, visa sponsorship, accommodation and
      transport, paid certification. It is a recruitment promise and people will hold you to it
- [ ] Cookie/consent handling if any analytics are added — the site currently sets no cookies
- [ ] Confirm licence and certification claims are accurate and current
- [ ] Confirm the public liability insurance figure

## Technical

- [ ] `npm run check` passes (typecheck + contrast gate)
- [ ] `npx next build` succeeds
- [ ] Deployed behind HTTPS; confirm HSTS preload is intended before submitting to the preload list
- [ ] Add a Content-Security-Policy. Currently absent because inline JSON-LD needs a nonce or hash;
      see [the security model](../architecture/03-security.md)
- [ ] Rate limiting on the quote form endpoint
- [ ] Wire the quote form to a real destination. It currently validates and logs; the integration
      point is documented in `apps/web/src/app/quote/actions.ts`
- [ ] Error monitoring
- [ ] Uptime monitoring on `/` and `/emergency` specifically — the emergency page is the one that
      matters at 3am

## SEO and AEO verification

Do these **after** deploying, against the live domain:

- [ ] Validate structured data with Google's Rich Results Test on the home page, one service page,
      and the emergency page
- [ ] Confirm `/sitemap.xml` returns 53 URLs, all absolute and on the real domain, with `/privacy`
      and `/terms` absent (both are noindex)
- [ ] Spot-check three area pages for factual accuracy. The `commonIssues` in
      [`areas.ts`](../../packages/core/src/areas.ts) are written from general knowledge of UAE
      building stock, not from this company's job history. Someone who has worked these areas should
      confirm they are right before they go live as expertise claims
- [ ] Confirm `/robots.txt` allows the AI crawlers and points at the real sitemap
- [ ] Confirm `/llms.txt` returns `text/plain` and contains no claim absent from the HTML pages
- [ ] Submit the sitemap to Google Search Console and Bing Webmaster Tools
- [ ] Set up Google Business Profile — it is a heavy local-search ranking factor and is separate from
      anything in this repo
- [ ] Run Lighthouse on the home page and one service page; confirm LCP < 2.5s, CLS < 0.1
- [ ] Test on a real phone on a slow connection. The emergency user is the one most likely to be on
      bad signal and least able to wait
- [ ] Baseline AI visibility: ask ChatGPT, Perplexity, Claude and Google AI Overviews the target
      queries and record what they currently return, so improvement is measurable rather than assumed

## Accessibility

- [ ] Full keyboard traversal of the quote form
- [ ] Screen reader pass on the emergency page and the quote form
- [ ] Confirm the contrast gate covers any colours added since launch prep

## Post-launch, first month

- [ ] Instrument AI-referral tracking. Without it, the AEO/GEO work in this codebase is untested
      theory — this is the single highest-value follow-up
- [ ] Review Search Console queries against the `aliases` in the catalogue and add the ones that
      actually convert
- [ ] Build per-area landing pages for the highest-volume city/service combinations
- [ ] Review quote-form submissions for spam volume; tighten if the honeypot is insufficient
