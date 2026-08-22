import type { MetadataRoute } from "next";
import { services, areas, absoluteUrl } from "@meridian/core";
import { hreflangAlternates, toArabicPath } from "@/lib/i18n";

/**
 * Priorities are relative, not absolute, so they only need to be internally
 * consistent. Service pages sit above the static pages because they are where
 * the commercial-intent queries land.
 *
 * `/ar` entries mirror the English ones they have a counterpart for (see
 * `hasArabicCounterpart` in `@/lib/i18n`) — `/ar/contracts` and
 * `/ar/emergency` do not exist (their English originals currently render no
 * content at all; see the delivery report) and `/ar/quote`, `/ar/careers`
 * were an explicit scope decision, so none of the five appear here in either
 * language variant, matching what actually resolves.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const routes: MetadataRoute.Sitemap = [
    { url: absoluteUrl("/"), changeFrequency: "weekly", priority: 1, alternates: { languages: hreflangAlternates("/") } },
    {
      url: absoluteUrl("/services"),
      changeFrequency: "weekly",
      priority: 0.9,
      alternates: { languages: hreflangAlternates("/services") },
    },
    { url: absoluteUrl("/emergency"), changeFrequency: "monthly", priority: 0.9 },
    { url: absoluteUrl("/rates"), changeFrequency: "weekly", priority: 0.9 },
    { url: absoluteUrl("/contracts"), changeFrequency: "monthly", priority: 0.9 },
    {
      url: absoluteUrl("/areas"),
      changeFrequency: "monthly",
      priority: 0.8,
      alternates: { languages: hreflangAlternates("/areas") },
    },
    { url: absoluteUrl("/quote"), changeFrequency: "monthly", priority: 0.8 },
    {
      url: absoluteUrl("/about"),
      changeFrequency: "yearly",
      priority: 0.5,
      alternates: { languages: hreflangAlternates("/about") },
    },
    {
      url: absoluteUrl("/contact"),
      changeFrequency: "yearly",
      priority: 0.6,
      alternates: { languages: hreflangAlternates("/contact") },
    },
    { url: absoluteUrl("/careers"), changeFrequency: "monthly", priority: 0.4 },
  ];
  // /privacy and /terms are deliberately absent: both are noindex, and listing a
  // noindex URL in a sitemap is a contradictory signal. Same for /ar/privacy
  // and /ar/terms below.
  const staticPages: MetadataRoute.Sitemap = routes.map((p) => ({ ...p, lastModified: now }));

  const servicePages: MetadataRoute.Sitemap = services.map((s) => ({
    url: absoluteUrl(`/services/${s.slug}`),
    lastModified: now,
    changeFrequency: "monthly",
    priority: s.emergency ? 0.9 : 0.8,
    alternates: { languages: hreflangAlternates(`/services/${s.slug}`) },
  }));

  const areaPages: MetadataRoute.Sitemap = areas.map((a) => ({
    url: absoluteUrl(`/areas/${a.slug}`),
    lastModified: now,
    changeFrequency: "monthly",
    priority: 0.7,
    alternates: { languages: hreflangAlternates(`/areas/${a.slug}`) },
  }));

  // ── Arabic ───────────────────────────────────────────────────────────────
  const arStaticPaths = ["/", "/services", "/areas", "/about", "/contact"] as const;
  const arStaticPages: MetadataRoute.Sitemap = arStaticPaths.map((p) => ({
    url: absoluteUrl(toArabicPath(p)),
    lastModified: now,
    changeFrequency: p === "/" || p === "/services" ? "weekly" : "monthly",
    priority: p === "/" ? 1 : p === "/services" ? 0.9 : 0.7,
    alternates: { languages: hreflangAlternates(p) },
  }));

  const arServicePages: MetadataRoute.Sitemap = services.map((s) => ({
    url: absoluteUrl(`/ar/services/${s.slug}`),
    lastModified: now,
    changeFrequency: "monthly",
    priority: s.emergency ? 0.9 : 0.8,
    alternates: { languages: hreflangAlternates(`/services/${s.slug}`) },
  }));

  const arAreaPages: MetadataRoute.Sitemap = areas.map((a) => ({
    url: absoluteUrl(`/ar/areas/${a.slug}`),
    lastModified: now,
    changeFrequency: "monthly",
    priority: 0.7,
    alternates: { languages: hreflangAlternates(`/areas/${a.slug}`) },
  }));

  return [
    ...staticPages,
    ...servicePages,
    ...areaPages,
    ...arStaticPages,
    ...arServicePages,
    ...arAreaPages,
  ];
}
