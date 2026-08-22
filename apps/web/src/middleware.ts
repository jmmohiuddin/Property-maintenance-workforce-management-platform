import { NextResponse, type NextRequest } from "next/server";

/**
 * Content Security Policy.
 *
 * `SEC-2` / `WEB-9`, closing `TD-6`. The site ships HSTS, `nosniff`,
 * frame-options, a referrer policy and a permissions policy — and no CSP at
 * all, which is the one header that turns an injected `<script>` from a
 * compromise into a blocked request.
 *
 * ── WHY THERE ARE TWO POLICIES ──────────────────────────────────────────────
 *
 * The TRD asks for "CSP with nonces" and no `unsafe-inline`. That is exactly
 * right for the authenticated app, and it is not achievable on the marketing
 * pages. The reason is worth writing down rather than discovering later:
 *
 *   * `(app)` and `(portal)` are `force-dynamic`. Their HTML is produced per
 *     request, Next reads the nonce from the CSP header at render time and
 *     stamps it onto its own inline bootstrap scripts, and the nonce is
 *     unguessable. A nonce works, and this is where it matters most — these are
 *     the pages behind a session.
 *
 *   * `(marketing)` is statically generated at build time, deliberately: AI
 *     crawlers do not execute JavaScript, so the answer has to be in the HTML.
 *     A statically generated page cannot carry a per-request nonce. Baking one
 *     in at build time would mean every visitor receives the *same* nonce,
 *     printed in the page an attacker is reading — which is not a weaker
 *     control, it is a decorative one. And a per-request nonce in the header
 *     would simply not match the build-time HTML, blocking Next's own hydration
 *     scripts and breaking the page.
 *
 * So the marketing policy accepts `'unsafe-inline'` for scripts and keeps every
 * other restriction: no external script hosts, no `eval`, no plugins, no
 * framing, no foreign form targets. That still blocks the entire class of
 * attack where injected markup pulls code from another origin. It does not
 * block a pure inline injection — and the defence against that on those pages
 * is that they render no user-supplied content except through React's escaping.
 *
 * The alternative — making the marketing pages dynamic so they can be nonced —
 * would trade the product's primary discovery strategy for a marginal gain on
 * the pages that hold no session and no data. That is the wrong trade, and it
 * is recorded here as a decision rather than left as an accident.
 *
 * ── ROLL-OUT ────────────────────────────────────────────────────────────────
 *
 * Set `CSP_REPORT_ONLY=1` to emit `Content-Security-Policy-Report-Only`
 * instead. Run that way for a week, watch for violations, then remove the
 * variable. Shipping a strict CSP straight to enforce is how a policy gets
 * reverted in a hurry and never re-applied.
 */

export const config = {
  // Static assets and images are served with their own content type, cannot
  // execute, and do not need a policy. Running per-request work for them is
  // pure cost on the hottest paths the CDN serves.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt|xml|woff|woff2)$).*)",
  ],
};

/**
 * The statically generated marketing pages — and *only* those.
 *
 * ── WHY THIS LIST IS THE STATIC ONE AND NOT THE DYNAMIC ONE ─────────────────
 *
 * This was written the other way round first: an allow-list of dynamic
 * prefixes, with everything else falling through to the marketing policy. That
 * is a fail-open default, and it failed. By the time it was noticed, nine
 * authenticated surfaces had been added by five people and none of them were on
 * the list — `/workforce`, `/amc`, `/reports`, `/hr`, `/quotes`,
 * `/recruitment`, and, worst of the set, `/forgot-password`, `/reset-password`
 * and `/invite`, which are the three pages where a password is typed. Every one
 * of them was silently being served `'unsafe-inline'`. Nobody did anything
 * wrong; the default did.
 *
 * Inverted, the two failure modes swap places, and that is the entire point:
 *
 *   * Forget to add a new **app** route: it gets the strict nonce'd policy,
 *     which is correct, and nothing happens.
 *   * Forget to add a new **marketing** route: its build-time HTML meets a
 *     per-request nonce, Next's bootstrap scripts are blocked, and the page
 *     visibly breaks in development the first time anyone loads it.
 *
 * A CSP hole is invisible until it is exploited. A broken marketing page is
 * obvious in thirty seconds. Fail towards the one you will notice.
 *
 * The root `/` is matched exactly rather than by prefix — a `startsWith("/")`
 * test is true of every path on the site.
 */
const STATIC_MARKETING_PREFIXES = [
  "/about",
  "/areas",
  "/ar",
  "/careers",
  "/contact",
  "/contracts",
  "/emergency",
  "/privacy",
  "/quote",
  "/services",
  "/terms",
] as const;

function isStaticMarketing(pathname: string): boolean {
  if (pathname === "/") return true;

  return STATIC_MARKETING_PREFIXES.some(
    // Exact match or a real path segment. A bare `startsWith` would hand the
    // marketing policy to `/quotes/{id}/document`, because `/quote` is a
    // prefix of `/quotes` — which is precisely the staff quotation surface
    // this function exists to keep on the strict policy.
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** Paths whose HTML is produced per request and can therefore carry a nonce. */
function isDynamicSurface(pathname: string): boolean {
  return !isStaticMarketing(pathname);
}

function buildPolicy(options: { nonce: string | null; isDev: boolean }): string {
  const { nonce, isDev } = options;

  // 'strict-dynamic' lets a nonced script load the chunks it needs without
  // every chunk URL being listed. Browsers that honour it ignore the host
  // allow-list beside it; browsers that do not fall back to that list, which is
  // why both are present.
  //
  // 'unsafe-eval' in development only — the dev server's fast refresh requires
  // it, and shipping it would hand back most of what the nonce takes away.
  const scriptSrc = nonce
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https:${isDev ? " 'unsafe-eval'" : ""}`
    : `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`;

  const directives = [
    "default-src 'self'",
    scriptSrc,

    // Tailwind v4 and `next/font` both emit inline <style>. Style injection is
    // a defacement risk rather than a code-execution one, and nonced styles
    // would mean threading the nonce through the font loader and the Tailwind
    // runtime. The trade is deliberate; it is recorded so the next reader knows
    // it was weighed rather than missed.
    "style-src 'self' 'unsafe-inline'",

    // next/font self-hosts its faces at build time, so no font host is needed
    // at runtime. data: covers inlined subsets.
    "font-src 'self' data:",

    // No external image hosts. The picsum.photos placeholders were removed by
    // WEB-3 in the same change that added this policy, so the directive gets to
    // be strict from the start rather than carrying an exception nobody
    // remembers to close. `blob:` is the self-generated QR SVG on MFA enrolment.
    "img-src 'self' data: blob:",

    "connect-src 'self'",

    // Nothing here uses plugins. An empty object-src is the cheapest directive
    // in CSP and closes an old, still-exploited class of injection.
    "object-src 'none'",

    // A <base> rewritten by an injection redirects every relative URL on the
    // page — including server-action form targets.
    "base-uri 'self'",
    "form-action 'self'",

    // This site is never framed. X-Frame-Options says the same for older
    // browsers; both stay, because different code paths read them.
    "frame-ancestors 'none'",
    "frame-src 'none'",

    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ];

  // Not in development: the dev server is plain HTTP and upgrading every
  // request breaks it outright.
  if (!isDev) directives.push("upgrade-insecure-requests");

  return directives.join("; ");
}

export function middleware(request: NextRequest): NextResponse {
  const isDev = process.env.NODE_ENV === "development";
  const dynamicSurface = isDynamicSurface(request.nextUrl.pathname);

  // 256 bits of randomness, base64. `crypto` here is the Web Crypto global —
  // the middleware runs in the edge runtime, where `node:crypto` does not
  // exist.
  const nonce = dynamicSurface
    ? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")
    : null;

  const policy = buildPolicy({ nonce, isDev });

  const forwarded = new Headers(request.headers);
  if (nonce) {
    // Both headers, and both are load-bearing.
    //
    // Next finds the nonce by parsing `nonce-{value}` out of the
    // Content-Security-Policy header **on the request** — that is how it knows
    // what to stamp onto its own inline bootstrap scripts. Setting only
    // `x-nonce` produces a policy whose nonce matches nothing Next emits, and
    // the page loads with every script blocked. `x-nonce` is the separate,
    // documented way a server component reads the value for a script of its
    // own.
    forwarded.set("Content-Security-Policy", policy);
    forwarded.set("x-nonce", nonce);
  }

  const response = NextResponse.next({ request: { headers: forwarded } });

  const header =
    process.env["CSP_REPORT_ONLY"] === "1"
      ? "Content-Security-Policy-Report-Only"
      : "Content-Security-Policy";

  response.headers.set(header, policy);

  return response;
}
