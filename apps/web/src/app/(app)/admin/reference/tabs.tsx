import Link from "next/link";

/**
 * Navigation across the reference-data screens (`ADM-10`).
 *
 * One list, shown identically on every one of them, because the failure this
 * prevents is not a navigation problem: an administrator who never discovers
 * that fault codes are editable will not ask for them to be edited, and the
 * taxonomy stays at whatever it was seeded with.
 */

export function ReferenceTabs({ active }: { active: string }) {
  const tabs: readonly { href: string; label: string }[] = [
    { href: "/admin/reference", label: "Working calendar" },
    { href: "/admin/reference/dispositions", label: "Lost and dormant reasons" },
    { href: "/admin/reference/fault-codes", label: "Fault codes" },
    { href: "/admin/reference/outcomes", label: "Job outcomes" },
    { href: "/admin/reference/rate-card", label: "Rate card" },
  ];

  return (
    <nav aria-label="Reference data" className="mt-6 border-b">
      <ul className="flex flex-wrap gap-x-6 gap-y-1">
        {tabs.map((tab) => {
          const isActive = tab.href === active;
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={isActive ? "page" : undefined}
                className="-mb-px inline-block border-b-2 py-2.5 text-[14px] font-medium"
                style={{
                  borderColor: isActive ? "var(--accent)" : "transparent",
                  color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                }}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
