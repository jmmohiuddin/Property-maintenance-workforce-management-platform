import type { MetadataRoute } from "next";
import { services, areas, absoluteUrl } from "@meridian/core";

/**
 * Priorities are relative, not absolute, so they only need to be internally
 * consistent. Service pages sit above the static pages because they are where
 * the commercial-intent queries land.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const routes: MetadataRoute.Sitemap = [
    { url: absoluteUrl("/"), changeFrequency: "weekly", priority: 1 },
    { url: absoluteUrl("/services"), changeFrequency: "weekly", priority: 0.9 },
    { url: absoluteUrl("/emergency"), changeFrequency: "monthly", priority: 0.9 },
    { url: absoluteUrl("/contracts"), changeFrequency: "monthly", priority: 0.9 },
    { url: absoluteUrl("/areas"), changeFrequency: "monthly", priority: 0.8 },
    { url: absoluteUrl("/industries"), changeFrequency: "monthly", priority: 0.7 },
    { url: absoluteUrl("/quote"), changeFrequency: "monthly", priority: 0.8 },
    { url: absoluteUrl("/about"), changeFrequency: "yearly", priority: 0.5 },
    { url: absoluteUrl("/contact"), changeFrequency: "yearly", priority: 0.6 },
    { url: absoluteUrl("/careers"), changeFrequency: "monthly", priority: 0.4 },
  ];
  // /privacy and /terms are deliberately absent: both are noindex, and listing a
  // noindex URL in a sitemap is a contradictory signal.
  const staticPages: MetadataRoute.Sitemap = routes.map((p) => ({ ...p, lastModified: now }));

  const servicePages: MetadataRoute.Sitemap = services.map((s) => ({
    url: absoluteUrl(`/services/${s.slug}`),
    lastModified: now,
    changeFrequency: "monthly",
    priority: s.emergency ? 0.9 : 0.8,
  }));

  const areaPages: MetadataRoute.Sitemap = areas.map((a) => ({
    url: absoluteUrl(`/areas/${a.slug}`),
    lastModified: now,
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  return [...staticPages, ...servicePages, ...areaPages];
}
