import Link from "next/link";
import { tenant, telLink } from "@meridian/core";
import { PhoneCall, List } from "@phosphor-icons/react/dist/ssr";
import { LanguageSwitcher } from "@/components/language-switcher";
import { t } from "@/lib/i18n";

/**
 * Arabic site header. A translated, RTL-aware sibling of `site-header.tsx`
 * rather than the same component with a `locale` prop — the two navigation
 * lists point at different route trees (`/ar/*` vs unprefixed) and English
 * pages that have no Arabic counterpart (`/contracts`, `/emergency`) are
 * simply not offered here rather than linking to something that doesn't
 * exist. Positioning uses `start-0`/`end-0` (inset-inline) instead of
 * `left-0`/`right-0` so the mobile menu opens on the correct side under
 * `dir="rtl"`.
 */
const NAV = [
  { href: "/ar/services", label: t.nav.services },
  { href: "/ar/areas", label: t.nav.areas },
  { href: "/ar/about", label: t.nav.about },
] as const;

export function SiteHeaderAr() {
  return (
    <header
      className="sticky top-0 z-40 border-b backdrop-blur"
      style={{ backgroundColor: "color-mix(in srgb, var(--surface) 88%, transparent)" }}
    >
      <div className="container-page flex h-[68px] items-center justify-between gap-6">
        <Link href="/ar" className="flex items-center gap-2.5 shrink-0">
          <span
            aria-hidden
            className="grid h-8 w-8 place-items-center rounded-sm font-mono text-[15px] font-bold"
            style={{ backgroundColor: "var(--accent)", color: "var(--accent-contrast)" }}
          >
            S
          </span>
          <span className="text-[15px] font-semibold tracking-tight" dir="ltr">
            {tenant.brandName}
          </span>
        </Link>

        <nav aria-label={t.nav.primaryNav} className="hidden lg:flex items-center gap-7">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-[14px] font-medium transition-colors hover:text-[var(--accent)]"
              style={{ color: "var(--text-secondary)" }}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <LanguageSwitcher
            locale="ar"
            className="hidden lg:inline text-[14px] font-medium transition-colors hover:text-[var(--accent)]"
          />
          <a
            href={telLink(tenant.emergencyPhone)}
            className="hidden sm:inline-flex items-center gap-2 text-[14px] font-semibold tabular-nums"
            style={{ color: "var(--text-primary)" }}
            dir="ltr"
          >
            <PhoneCall size={17} weight="fill" style={{ color: "var(--accent)" }} />
            {tenant.emergencyPhone}
          </a>
          {/*
            No `/ar/quote` — the quote form is out of scope for this pass (see
            the delivery report), so the header CTA goes to the contact page
            rather than a route that does not exist. Labelled "Contact us"
            rather than "Get a quote" for the same reason.
          */}
          <Link href="/ar/contact" className="btn btn-primary !py-2.5 !px-4 text-[14px]">
            {t.nav.contact}
          </Link>
          <details className="lg:hidden relative">
            <summary
              className="grid h-9 w-9 cursor-pointer place-items-center rounded-sm list-none"
              style={{ boxShadow: "inset 0 0 0 1px var(--border-strong)" }}
              aria-label={t.nav.openMenu}
            >
              <List size={18} />
            </summary>
            <nav
              aria-label={t.nav.mobileNav}
              className="absolute end-0 top-11 w-56 rounded border p-2 shadow-lg"
              style={{ backgroundColor: "var(--surface-raised)" }}
            >
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="block rounded-sm px-3 py-2.5 text-[15px] font-medium"
                >
                  {item.label}
                </Link>
              ))}
              <LanguageSwitcher locale="ar" className="block rounded-sm px-3 py-2.5 text-[15px] font-medium" />
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}
