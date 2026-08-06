import type { MetadataRoute } from "next";
import { absoluteUrl } from "@meridian/core";

/**
 * AI crawlers are explicitly allowed.
 *
 * This is a deliberate business decision, not an oversight: the point of the
 * AEO/GEO work in this codebase is to be cited by answer engines, and blocking
 * GPTBot / ClaudeBot / PerplexityBot while optimising for them is the single
 * most common way sites quietly undo that work. Blocking them is a one-line
 * change here if the client ever wants it.
 *
 * Note that OAI-SearchBot and ChatGPT-User are separate from GPTBot: the first
 * two serve live retrieval for user queries, GPTBot is the training crawler.
 * A client who wants citations but not training data blocks only GPTBot.
 */
const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "Bingbot",
  "CCBot",
  "meta-externalagent",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Nothing here is secret; these are simply not useful in an index.
        disallow: ["/api/", "/_next/static/chunks/"],
      },
      ...AI_CRAWLERS.map((userAgent) => ({ userAgent, allow: "/" })),
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
    host: absoluteUrl("/"),
  };
}
