"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { toArabicPath, toEnglishPath } from "@/lib/i18n";

/**
 * Deep-linking language switcher.
 *
 * A client component so it can read the current path with `usePathname()` and
 * compute the exact counterpart page (`/services/plumbing-sanitary` ↔
 * `/ar/services/plumbing-sanitary`), rather than always sending the visitor
 * back to a locale's homepage. This runs after hydration in the browser, so it
 * does not force the page itself into dynamic rendering — the marketing pages
 * stay statically generated.
 *
 * Falls back to the locale's homepage when the current page has no
 * counterpart (`/contracts`, `/emergency`, `/quote`, `/careers/*` — see
 * `hasArabicCounterpart` in `@/lib/i18n`) rather than linking to a 404.
 */
export function LanguageSwitcher({ locale, className }: { locale: "en" | "ar"; className?: string }) {
  const pathname = usePathname() ?? "/";
  const href = locale === "en" ? toArabicPath(pathname) : toEnglishPath(pathname);

  return (
    <Link
      href={href}
      className={className}
      lang={locale === "en" ? "ar" : "en"}
      dir={locale === "en" ? "rtl" : "ltr"}
    >
      {locale === "en" ? "العربية" : "English"}
    </Link>
  );
}
