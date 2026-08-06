import Link from "next/link";
import { tenant, groupedServices, areas, telLink } from "@meridian/core";

export function SiteFooter() {
  const groups = groupedServices();

  return (
    <footer className="border-t" style={{ backgroundColor: "var(--surface-sunken)" }}>
      <div className="container-page py-16">
        <div className="grid gap-10 md:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-1">
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden
                className="grid h-8 w-8 place-items-center rounded-sm font-mono text-[15px] font-bold"
                style={{ backgroundColor: "var(--accent)", color: "var(--accent-contrast)" }}
              >
                M
              </span>
              <span className="text-[15px] font-semibold tracking-tight">{tenant.brandName}</span>
            </div>
            <p className="mt-4 text-[14px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              {tenant.legalName}
              <br />
              {tenant.address.street}
              <br />
              {tenant.address.city}, {tenant.address.country}
            </p>
            <div className="mt-5 space-y-1.5 text-[14px]">
              <a href={telLink(tenant.phone)} className="block font-medium tabular-nums">
                {tenant.phone}
              </a>
              <a href={`mailto:${tenant.email}`} className="block" style={{ color: "var(--text-secondary)" }}>
                {tenant.email}
              </a>
            </div>
          </div>

          {groups.slice(0, 3).map((group) => (
            <div key={group.category}>
              <h2 className="text-[13px] font-semibold">{group.category}</h2>
              <ul className="mt-4 space-y-2.5">
                {group.items.map((s) => (
                  <li key={s.slug}>
                    <Link
                      href={`/services/${s.slug}`}
                      className="text-[14px] transition-colors hover:text-[var(--accent)]"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {s.shortName}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 grid gap-10 border-t pt-10 md:grid-cols-3">
          <div>
            <h2 className="text-[13px] font-semibold">More services</h2>
            <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2.5">
              {groups.slice(3).flatMap((g) => g.items).map((s) => (
                <li key={s.slug}>
                  <Link
                    href={`/services/${s.slug}`}
                    className="text-[14px] transition-colors hover:text-[var(--accent)]"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {s.shortName}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2 className="text-[13px] font-semibold">
              <Link href="/areas" className="hover:text-[var(--accent-text)]">
                Areas covered
              </Link>
            </h2>
            <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2.5">
              {areas.slice(0, 10).map((a) => (
                <li key={a.slug}>
                  <Link
                    href={`/areas/${a.slug}`}
                    className="text-[14px] transition-colors hover:text-[var(--accent-text)]"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {a.name}
                  </Link>
                </li>
              ))}
            </ul>
            <Link
              href="/areas"
              className="mt-3 inline-block text-[14px] font-medium"
              style={{ color: "var(--accent-text)" }}
            >
              All {areas.length} areas
            </Link>
          </div>

          <div>
            <h2 className="text-[13px] font-semibold">Accreditation</h2>
            <ul className="mt-4 space-y-2 text-[14px]" style={{ color: "var(--text-secondary)" }}>
              {tenant.certifications.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        </div>

        <div
          className="mt-12 flex flex-col gap-4 border-t pt-8 text-[13px] sm:flex-row sm:items-center sm:justify-between"
          style={{ color: "var(--text-muted)" }}
        >
          <p>
            &copy; {tenant.foundedYear}&ndash;2026 {tenant.legalName}. Trade licence{" "}
            <span className="tabular-nums">{tenant.licences[0]?.ref}</span>.
          </p>
          <nav aria-label="Legal" className="flex flex-wrap gap-x-6 gap-y-2">
            <Link href="/contact">Contact</Link>
            <Link href="/careers">Careers</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
