import Link from "next/link";
import type { SessionContext } from "@meridian/auth";
import { can } from "@meridian/auth";
import { signOut } from "@/app/(app)/actions";
import { SignOut } from "@phosphor-icons/react/dist/ssr";

/**
 * Authenticated shell.
 *
 * Nav items are filtered by permission. That is a convenience, not a control:
 * every page re-checks with `requireSessionWith`, because hiding a link is not
 * authorisation.
 */
/**
 * Only routes that exist. Reporting is designed and scheduled but not built,
 * and a nav link to a 404 is worse than no link - it tells the user the feature
 * is there and then breaks. Add each entry here as its route lands.
 */
const NAV = [
  // KPI-3. First, because it is the owner's screen and the owner reads it
  // first. `reports:read` keeps it off a dispatcher's and a technician's nav —
  // the card stack carries cash position, revenue against a tax threshold and
  // headcount, and those are not figures every role should meet on the way to
  // the dispatch board.
  { href: "/reports", label: "Reports", permission: "reports:read" },
  { href: "/dispatch", label: "Dispatch", permission: "jobs:read" },
  { href: "/jobs", label: "Jobs", permission: "jobs:read" },
  { href: "/leads", label: "Leads", permission: "customers:read" },
  { href: "/customers", label: "Customers", permission: "customers:read" },
  { href: "/invoices", label: "Invoices", permission: "invoices:read" },
  // M3. The URL is `/amc`, not `/contracts`, and the label is "Contracts".
  // `(marketing)/contracts` already owns `/contracts` — it is a statically
  // generated public page with a canonical URL and a sitemap entry — and two
  // route groups resolving to the same path is a Next build error, not a
  // precedence rule. AMC is what the business calls the thing anyway.
  { href: "/amc", label: "Contracts", permission: "contracts:read" },
  { href: "/technicians", label: "Technicians", permission: "technicians:read" },
  { href: "/workforce", label: "Workforce", permission: "workforce:read" },
  { href: "/recruitment", label: "Recruitment", permission: "recruitment:read" },
  // M10. Beside Workforce and not inside it, because the two answer different
  // questions: `/workforce` is "may this person legally be sent to work today",
  // which is documents and hard blocks; `/hr` is "what does the employment
  // relationship owe, and by when" — wages due on the 1st, contract terms,
  // leave, hours, health cover. One screen holding both would put a leave
  // balance under a lapsed work permit.
  { href: "/hr", label: "HR", permission: "workforce:read" },
  { href: "/admin/users", label: "Users", permission: "users:manage" },
  { href: "/admin/company", label: "Company", permission: "settings:write" },
  // ADM-7. `audit:read`, which `readonly` also holds — this is the screen that
  // gives that role a reason to exist (and what ADM-8 builds on).
  { href: "/admin/audit", label: "Audit", permission: "audit:read" },
] as const;

export function AppShell({
  session,
  active,
  children,
}: {
  session: SessionContext;
  active: string;
  children: React.ReactNode;
}) {
  const visible = NAV.filter((item) => can(session.principal, item.permission));

  return (
    <div className="min-h-[100dvh]" style={{ backgroundColor: "var(--surface)" }}>
      <header className="border-b" style={{ backgroundColor: "var(--surface-raised)" }}>
        <div className="container-page flex h-[60px] items-center justify-between gap-6">
          <div className="flex items-center gap-8">
            <Link href="/dispatch" className="flex items-center gap-2.5 shrink-0">
              <span
                aria-hidden
                className="grid h-7 w-7 place-items-center rounded-sm font-mono text-[13px] font-bold"
                style={{ backgroundColor: "var(--accent)", color: "var(--accent-contrast)" }}
              >
                {session.tenant.brandName.trim().charAt(0).toUpperCase() || "?"}
              </span>
              <span className="text-[14px] font-semibold tracking-tight">{session.tenant.brandName}</span>
            </Link>

            <nav aria-label="Application" className="hidden items-center gap-6 md:flex">
              {visible.map((item) => {
                const isActive = active === item.href.slice(1);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    className="text-[14px] font-medium transition-colors"
                    style={{ color: isActive ? "var(--text-primary)" : "var(--text-secondary)" }}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-4">
            <Link href="/security" className="hidden text-right sm:block">
              <p className="text-[13px] font-medium leading-tight">{session.user.fullName}</p>
              <p
                className="text-[12px] leading-tight"
                style={{
                  color: active === "security" ? "var(--text-secondary)" : "var(--text-muted)",
                }}
              >
                {session.principal.role.replace(/_/g, " ")}
              </p>
            </Link>
            <form action={signOut}>
              <button
                type="submit"
                className="grid h-9 w-9 place-items-center rounded-sm transition-colors"
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

      {children}
    </div>
  );
}
