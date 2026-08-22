import Link from "next/link";
import { tenant, telLink } from "@meridian/core";
import { PhoneCall, List } from "@phosphor-icons/react/dist/ssr";
import { LanguageSwitcher } from "@/components/language-switcher";

/**
 * Single-line desktop nav, 68px tall. Five items is the ceiling before labels
 * start wrapping at 1024px, so secondary pages live in the footer instead.
 *
 * Mobile falls back to a details/summary disclosure rather than a JS drawer:
 * it works without hydration, which matters because the emergency number needs
 * to be reachable even on a bad connection in a stairwell.
 */
const NAV = [
  { href: "/services", label: "Services" },
  { href: "/rates", label: "Rates" },
  { href: "/contracts", label: "Contracts & AMC" },
  { href: "/emergency", label: "Emergency" },
  { href: "/about", label: "About" },
] as const;

export function SiteHeader() {
  return (
    <header
      className="sticky top-0 z-40 border-b backdrop-blur"
      style={{ backgroundColor: "color-mix(in srgb, var(--surface) 88%, transparent)" }}
    >
      <div className="container-page flex h-[68px] items-center justify-between gap-6">
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <span
            aria-hidden
            className="grid h-8 w-8 place-items-center rounded-sm font-mono text-[15px] font-bold"
            style={{ backgroundColor: "var(--accent)", color: "var(--accent-contrast)" }}
          >
            S
          </span>
          <span className="text-[15px] font-semibold tracking-tight">{tenant.brandName}</span>
        </Link>

        <nav aria-label="Primary" className="hidden lg:flex items-center gap-7">
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
            locale="en"
            className="hidden lg:inline text-[14px] font-medium transition-colors hover:text-[var(--accent)]"
          />
          <a
            href={telLink(tenant.emergencyPhone)}
            className="hidden sm:inline-flex items-center gap-2 text-[14px] font-semibold tabular-nums"
            style={{ color: "var(--text-primary)" }}
          >
            <PhoneCall size={17} weight="fill" style={{ color: "var(--accent)" }} />
            {tenant.emergencyPhone}
          </a>
          <Link href="/quote" className="btn btn-primary !py-2.5 !px-4 text-[14px]">
            Get a quote
          </Link>
          <details className="lg:hidden relative">
            <summary
              className="grid h-9 w-9 cursor-pointer place-items-center rounded-sm list-none"
              style={{ boxShadow: "inset 0 0 0 1px var(--border-strong)" }}
              aria-label="Open menu"
            >
              <List size={18} />
            </summary>
            <nav
              aria-label="Mobile"
              className="absolute right-0 top-11 w-56 rounded border p-2 shadow-lg"
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
              <LanguageSwitcher
                locale="en"
                className="block rounded-sm px-3 py-2.5 text-[15px] font-medium"
              />
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}
