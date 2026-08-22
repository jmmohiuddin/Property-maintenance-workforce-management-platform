import Link from "next/link";
import { tenant, company, groupedServices, areas, telLink } from "@meridian/core";

/**
 * Site footer.
 *
 * `WEB-14` lives here. Cabinet Resolution No. 107 of 2022, Article 7 obliges
 * the establishment to display its Commercial Register number on its website
 * and in all documents and printed material — so the licence and CR block is
 * not a trust flourish, it is a legal requirement with a specific home.
 *
 * Everything identifying is rendered conditionally. An unset value produces no
 * element at all, never a dash and never a placeholder. The previous footer
 * printed `tenant.licences[0]?.ref`, which resolved to `DED-000000` — a licence
 * number that does not exist, displayed as though it did, on every page of a
 * live site.
 *
 * The "Accreditation" column is gone with it. It listed three ISO certificates
 * and an insurance figure the company does not hold. `HR-14` builds a real
 * accreditation register with documents and expiry dates; when an entry there
 * has a certificate on file, this column comes back reading from it.
 */
export function SiteFooter() {
  const groups = groupedServices();
  const primaryGroups = groups.slice(0, 3);
  const remaining = groups.slice(3).flatMap((g) => g.items);
  const phoneHref = telLink(tenant.phone);

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
                S
              </span>
              <span className="text-[15px] font-semibold tracking-tight">{tenant.brandName}</span>
            </div>
            <p className="mt-4 text-[14px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              {tenant.legalName}
              {tenant.address.street ? (
                <>
                  <br />
                  {tenant.address.street}
                </>
              ) : null}
              <br />
              {tenant.address.city}, {tenant.address.country}
            </p>
            <div className="mt-5 space-y-1.5 text-[14px]">
              {phoneHref ? (
                <a href={phoneHref} className="block font-medium tabular-nums">
                  {tenant.phone}
                </a>
              ) : null}
              {tenant.email ? (
                <a href={`mailto:${tenant.email}`} className="block" style={{ color: "var(--text-secondary)" }}>
                  {tenant.email}
                </a>
              ) : null}
            </div>
          </div>

          {primaryGroups.map((group) => (
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

        <div className="mt-12 grid gap-10 border-t pt-10 md:grid-cols-2">
          {remaining.length > 0 ? (
            <div>
              <h2 className="text-[13px] font-semibold">More services</h2>
              <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2.5">
                {remaining.map((s) => (
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
          ) : null}

          <div>
            <h2 className="text-[13px] font-semibold">
              <Link href="/areas" className="hover:text-[var(--accent-text)]">
                Areas covered
              </Link>
            </h2>
            <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2.5">
              {areas.map((a) => (
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
          </div>
        </div>

        {/*
          The legal identity block. Each line appears only when the value is
          configured — a footer that says "TRN —" is worse than one that says
          nothing, because it looks like a fact.
        */}
        <div
          className="mt-12 flex flex-col gap-4 border-t pt-8 text-[13px] sm:flex-row sm:items-start sm:justify-between"
          style={{ color: "var(--text-muted)" }}
        >
          <div className="space-y-1">
            <p>&copy; 2026 {tenant.legalName}.</p>
            <p className="flex flex-wrap gap-x-4 gap-y-1">
              {company.licenceNumber ? (
                <span>
                  {company.licenceIssuer} licence{" "}
                  <span className="tabular-nums font-medium">{company.licenceNumber}</span>
                </span>
              ) : null}
              {company.crNumber ? (
                <span>
                  Commercial Register <span className="tabular-nums font-medium">{company.crNumber}</span>
                </span>
              ) : null}
              {company.trn ? (
                <span>
                  TRN <span className="tabular-nums font-medium">{company.trn}</span>
                </span>
              ) : null}
            </p>
          </div>
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
