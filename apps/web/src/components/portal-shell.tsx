import Link from "next/link";
import type { SessionContext } from "@meridian/auth";
import { tenant, telLink } from "@meridian/core";
import { signOut } from "@/app/(app)/actions";
import { SignOut, PhoneCall } from "@phosphor-icons/react/dist/ssr";

/**
 * Customer portal chrome.
 *
 * Deliberately different from the staff shell: no navigation into operational
 * screens, and the emergency number is always visible. A customer in the portal
 * at 2am should not have to find the contact page.
 */
export function PortalShell({
  session,
  active,
  children,
}: {
  session: SessionContext;
  active: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-[100dvh]" style={{ backgroundColor: "var(--surface)" }}>
      <header className="border-b" style={{ backgroundColor: "var(--surface-raised)" }}>
        <div className="container-page flex h-[60px] items-center justify-between gap-6">
          <Link href="/portal" className="flex items-center gap-2.5 shrink-0">
            <span
              aria-hidden
              className="grid h-7 w-7 place-items-center rounded-sm font-mono text-[13px] font-bold"
              style={{ backgroundColor: "var(--accent)", color: "var(--accent-contrast)" }}
            >
              M
            </span>
            <span className="text-[14px] font-semibold tracking-tight">{session.tenant.brandName}</span>
          </Link>

          <div className="flex items-center gap-4">
            {/*
              POR-3, POR-4 and POR-5 each add a screen, and a screen with no
              way to reach it is not shipped. Rendered as a scrolling row rather
              than wrapping: POR-10's users are on phones, and a header that
              grows to two lines pushes the content below the fold on every
              page.
            */}
            <nav className="-mx-1 flex items-center gap-4 overflow-x-auto px-1">
              {[
                { href: "/portal/requests", label: "Requests", key: "requests" },
                { href: "/portal/invoices", label: "Invoices", key: "invoices" },
                { href: "/portal/notifications", label: "Notifications", key: "notifications" },
                { href: "/portal/request", label: "Raise a request", key: "request" },
              ].map((item) => (
                <Link
                  key={item.key}
                  href={item.href}
                  className="shrink-0 text-[14px] font-medium"
                  style={{
                    color: active === item.key ? "var(--text-primary)" : "var(--text-secondary)",
                  }}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <a
              href={telLink(tenant.emergencyPhone)}
              className="hidden items-center gap-2 text-[13px] font-semibold tabular-nums sm:inline-flex"
            >
              <PhoneCall size={15} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
              {tenant.emergencyPhone}
            </a>
            <Link href="/security" className="hidden text-right sm:block">
              <p className="text-[13px] font-medium leading-tight">{session.user.fullName}</p>
              <p
                className="text-[12px] leading-tight"
                style={{
                  color: active === "security" ? "var(--text-secondary)" : "var(--text-muted)",
                }}
              >
                Customer
              </p>
            </Link>
            <form action={signOut}>
              <button
                type="submit"
                className="grid h-9 w-9 place-items-center rounded-sm"
                style={{ boxShadow: "inset 0 0 0 1px var(--border-strong)" }}
                aria-label="Sign out"
                title="Sign out"
              >
                <SignOut size={16} aria-hidden />
              </button>
            </form>
          </div>
        </div>
      </header>

      <main id="main" data-active={active}>
        {children}
      </main>
    </div>
  );
}
