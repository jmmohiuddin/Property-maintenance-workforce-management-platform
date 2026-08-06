# AEO and GEO playbook

How this codebase is built to be quoted by answer engines, and why each mechanism is there.

**AEO** (Answer Engine Optimization) is being the direct answer: featured snippets, voice results,
AI Overviews. **GEO** (Generative Engine Optimization) is being the cited source inside a generated
answer from ChatGPT, Perplexity, Claude or Gemini. They overlap heavily and the same work serves
both, so this document treats them together and flags where they diverge.

## The one rule everything else follows from

**Never mark up a claim the page does not also state in visible text.**

Structured data that has no visible counterpart is a manual-action risk with Google, and more
practically, a model that cannot corroborate a claim in the page body will not cite it. Every
`Service`, `FAQPage` and `HowTo` node emitted by this site is generated from the same catalogue
object that renders the visible copy, so divergence is structurally impossible rather than something
a reviewer has to catch.

That is the single most important design decision in the AEO layer, and it is worth protecting: if
someone later adds a hand-written JSON-LD block that is not derived from `catalog.ts`, the guarantee
is gone.

## Mechanisms, and what each one buys

### 1. The answer block

Every page has exactly one `<AnswerBlock>`: a standalone paragraph, immediately after the `<h1>`,
that answers the page's question without depending on surrounding context.

Content rules enforced when writing `Service.answer`:

- **No pronouns pointing outside the paragraph.** "It is available 24/7" is useless when lifted;
  "AC breakdowns are attended the same day" survives extraction.
- **Name the entity.** Start with the company or the service name, not "We".
- **Include a number.** Answers with a concrete figure are quoted far more than hedged prose.
- **No marketing adjectives.** "Leading", "premium" and "world-class" are unverifiable and models
  discount them.

It is also the visually most prominent text on the page. That is not decoration: burying the
extractable answer while marking it up as the main content is the most common way sites undercut
their own structured data.

### 2. Structured data as a linked graph

One `<script type="application/ld+json">` per page containing an `@graph`, not several disconnected
blocks. Every entity carries an `@id`, and pages reference the site-wide `Organization` and `WebSite`
nodes by `@id` rather than repeating them.

Emitted per page type:

| Page | Nodes |
| --- | --- |
| All pages (layout) | `Organization` + `LocalBusiness` + `HomeAndConstructionBusiness`, `WebSite` |
| Home | `WebPage`, `FAQPage` |
| Service detail (×24) | `WebPage`, `Service` (with `Offer` and `OfferCatalog`), `FAQPage`, `BreadcrumbList` |
| Emergency | `WebPage`, `FAQPage`, `HowTo`, `BreadcrumbList` |
| Contracts | `WebPage`, `FAQPage`, `BreadcrumbList` |

The `Organization` node carries `hasCredential` for each trade licence and `areaServed` down to
neighbourhood level. Both are entity-disambiguation signals: they help a model be confident that
*this* Meridian is the Dubai maintenance contractor rather than something else with a similar name.
Entity clarity is the part of GEO that pure SEO advice tends to miss.

### 3. `llms.txt`

A generated plain-Markdown map of the site at `/llms.txt`, built from the same catalogue.

The convention is still emerging and not universally consumed, so the honest framing is: it costs one
generated route and it removes ambiguity for any model that does read it. It is not the load-bearing
part of this strategy, and it should not be sold as one.

What it contains: company facts, licences, every service with its answer, price, response time and
search aliases, key page URLs, and the FAQ answers that contain numbers. What it must never contain:
a claim not on the HTML pages. Since it is generated from `catalog.ts`, that holds by construction.

### 4. Aliases

Every service carries an `aliases` array of how people actually search: "aircon servicing", "AC not
cooling", "false ceiling", "DG set service". These become `alternateName` in the `Service` node and
`keywords` in page metadata.

Retrieval matches against phrasing, and customers do not search using the trade's formal name. This
is cheap and high-leverage.

### 5. Symptom-first content

Each service page has a "what people call us about" section listing symptoms in the customer's words
("water leaking through a ceiling from the apartment above") rather than diagnoses.

This targets the actual long-tail query. Someone with a leak searches the symptom, not "concealed
pipe joint failure".

### 6. Crawlability

- Statically prerendered. Nothing an answer engine needs requires JavaScript.
- FAQ answers use native `<details>`, so the text is in the HTML whether or not the panel is open and
  whether or not JS runs. A JS accordion that renders answers on click reads to a non-executing
  crawler as a list of questions with no answers.
- `robots.txt` explicitly allows GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, PerplexityBot,
  Google-Extended and others.

On that last point: `OAI-SearchBot` and `ChatGPT-User` serve live retrieval for user queries, while
`GPTBot` is the training crawler. A client who wants to be citable but does not want their content in
training data blocks only `GPTBot`. That distinction is documented in
[`robots.ts`](../../apps/web/src/app/robots.ts) because it is easy to get backwards.

## Writing FAQ answers

The FAQs on this site are deliberately specific and occasionally argue against the sale. Examples
shipped in the catalogue:

> **Is an AMC actually cheaper than paying per job?** For most properties, yes, but the honest answer
> is that it depends on your asset age and usage. [...] If your property is new and you have had no
> call-outs in two years, ad-hoc may suit you better, and we will say so.

> **Can you waterproof a bathroom without removing the tiles?** There are surface-applied products
> marketed for this, but they seal grout lines rather than the substrate and typically fail within
> two years.

This is not a stylistic preference. Committed, specific, occasionally self-limiting answers get
quoted; hedged answers that resolve to "contact us for details" do not. A model looking for a
citation needs a claim it can attribute.

## Area pages, and the page count we deliberately did not build

19 area pages ship at `/areas/[slug]`, one per community, each carrying an area-specific answer,
built-environment description, characteristic faults and FAQs.

**We deliberately did not build the 456-page version.** The obvious programmatic-SEO move is one page
per service-and-area combination (24 x 19), and it is a trap:

- Those pages differ only by two substituted nouns. That is the textbook definition of a doorway
  page, and Google demotes them.
- An answer engine will not cite a page that says nothing the service page did not already say, so
  they do not help the GEO goal either.
- The cost is not neutral. A few hundred thin pages dilute crawl budget and drag down the perceived
  quality of the 24 service pages that are genuinely good.

The rule enforced in [`areas.ts`](../../packages/core/src/areas.ts): if an area cannot be given real
`commonIssues` — faults that area produces because of its specific building stock, age or
environment — it does not get a page. It stays a name in the coverage list.

This is the difference between local SEO and local spam, and it is worth holding even when a client
asks for the bigger number.

## What is not done yet

Honest gaps, scheduled in [the roadmap](05-roadmap.md):

- **No blog or case studies.** Both are named in the brief. They need a CMS, which is phase 3.
- **No `Review`/`AggregateRating` markup.** Deliberately omitted: marking up reviews that do not
  exist is fabrication. Add it when there are real reviews to point at.
- **No measurement.** There is no instrumentation telling you whether any of this works. Phase 2
  should add AI-referral tracking, because otherwise this whole document is untested theory.

## Where this document is referenced from

`packages/core/src/catalog.ts` points here, so anyone editing service content finds the content rules
before they write copy that will not get cited.
