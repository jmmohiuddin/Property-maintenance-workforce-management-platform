# ADR 0006: Content Security Policy — nonces on dynamic routes, not on static ones

**Status:** Accepted · **Date:** 2026-08-21 · **Implements:** `SEC-2`, `WEB-9` · **Closes:** `TD-6`

## Context

The site shipped HSTS, `nosniff`, `X-Frame-Options`, a referrer policy and a permissions policy —
and no Content Security Policy at all. CSP is the header that turns an injected `<script>` from a
compromise into a blocked request, so its absence was the largest single gap in an otherwise
above-norm security posture.

The Technical Requirements Document asks for "Content Security Policy with nonced JSON-LD" and no
`unsafe-inline`. That is the right target. It is not achievable uniformly across this application,
and the reason is structural rather than a matter of effort.

Next.js applies a nonce to its own inline bootstrap scripts by parsing `nonce-{value}` out of the
`Content-Security-Policy` header **on the request**, at render time. That works only where the HTML
is produced per request. Our two surfaces differ exactly on that point:

- `(app)` and `(portal)` are `force-dynamic`. Rendered per request, so a per-request nonce reaches
  both the header and the markup, and it is unguessable.
- `(marketing)` is statically generated at build time — deliberately, because AI crawlers do not
  execute JavaScript and the answer has to be in the HTML. This is the product's primary discovery
  strategy (ADR 0001).

A statically generated page cannot carry a per-request nonce. Two things follow, and both are
disqualifying:

1. A nonce baked in at build time is identical for every visitor and printed in the page an attacker
   is already reading. That is not a weaker control, it is a decorative one.
2. A per-request nonce in the header would not match the build-time HTML at all, so the browser
   would block Next's own hydration scripts and the page would break.

## Decision

**Two policies, selected by route.**

Dynamic surfaces — everything under `/api`, `/portal`, and the authenticated app routes — receive
`script-src 'self' 'nonce-{random}' 'strict-dynamic'`, with 256 bits of per-request randomness. No
`unsafe-inline`.

Static marketing pages receive `script-src 'self' 'unsafe-inline'` and every other restriction
unchanged: no external script hosts, no `eval`, `object-src 'none'`, `base-uri 'self'`,
`form-action 'self'`, `frame-ancestors 'none'`.

Both policies are emitted from `apps/web/src/middleware.ts`. `CSP_REPORT_ONLY=1` switches the header
to `Content-Security-Policy-Report-Only` for a staged roll-out.

## Consequences

**What the marketing policy still buys.** It blocks the entire class of attack where injected markup
pulls code from another origin, plus `eval`, plugin content, base-tag rewriting, foreign form
targets and framing. What it does not block is a pure inline injection on those specific pages. The
defence there is that they render no user-supplied content except through React's escaping, and they
hold no session and no data.

**Why not make the marketing pages dynamic so they can be nonced.** That trades the product's
primary discovery strategy — complete HTML for crawlers, served from a CDN — for a marginal gain on
the pages with the least to lose. It is the wrong trade, and it is recorded here as a decision
rather than left to be re-discovered as an accident.

**JSON-LD is not nonced, and does not need to be.** A `<script type="application/ld+json">` block is
a data block, not executable script; browsers do not evaluate it and do not apply `script-src` to
it. The requirement's phrasing anticipated a problem that does not arise.

**Styles remain `unsafe-inline`.** Tailwind v4 and `next/font` both emit inline `<style>`. Nonced
styles would mean threading the nonce through the font loader and the Tailwind runtime; style
injection is a defacement risk rather than a code-execution one. Deliberate, and revisitable.

**A closed exception.** `img-src` allows no external hosts, because `WEB-3` removed the
`picsum.photos` placeholders in the same change that added this policy. Adding a remote image host
in future means editing both `next.config.ts` and this policy — if only one is edited, the browser
blocks the image, which is the correct direction for that mistake to fail.

## Revisit when

A build-time hashing step becomes practical for the static pages' inline scripts, or Next gains
first-class nonce support for statically generated output. Either would let the marketing policy
drop `unsafe-inline` without giving up static rendering.
