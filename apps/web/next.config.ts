import type { NextConfig } from "next";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Load the monorepo-root .env.
 *
 * Next only reads .env from its own project directory and does not walk up, so
 * without this the app would need a duplicate .env in apps/web - two files
 * holding the same database credentials, which drift. Existing environment
 * variables always win, so a real deployment's injected config is never
 * overwritten by a stray local file.
 */
function loadRootEnv(): void {
  const path = resolve(process.cwd(), "../../.env");
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    process.env[key] ??= value;
  }
}

loadRootEnv();

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Self-contained server build for Docker/VPS deployment. Vercel ignores this
  // and keeps doing its own thing, so one config serves both targets.
  output: "standalone",
  // The monorepo root, so file tracing includes the workspace packages
  // (@meridian/core, db, auth, notify) in the standalone output.
  outputFileTracingRoot: resolve(__dirname, "../../"),
  // The marketing site is statically rendered. AI crawlers frequently do not
  // execute JavaScript, so anything they need to read has to exist in the HTML
  // response, not be hydrated in.
  transpilePackages: [
    "@meridian/core",
    "@meridian/auth",
    "@meridian/db",
    "@meridian/notify",
    "@meridian/files",
    "@meridian/docs",
  ],
  // Native module; must not be bundled into the server build.
  serverExternalPackages: ["@node-rs/argon2", "postgres"],
  images: {
    formats: ["image/avif", "image/webp"],
    // No remote patterns. The picsum.photos placeholders are gone (WEB-3), and
    // an empty allow-list is the correct default: a remote host added here is
    // a host the site will fetch from on every page view, and it must also be
    // added to `img-src` in src/middleware.ts or the browser will block it.
    remotePatterns: [],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
      {
        // llms.txt is a plain-text contract for AI crawlers; caching it hard
        // costs nothing and it is requested often once a site is indexed.
        source: "/llms.txt",
        headers: [{ key: "Cache-Control", value: "public, max-age=3600, s-maxage=86400" }],
      },
    ];
  },
};

export default config;
