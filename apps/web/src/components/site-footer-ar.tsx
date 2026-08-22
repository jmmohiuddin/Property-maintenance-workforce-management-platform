import Link from "next/link";
import { tenant, company, groupedServices, areas, telLink } from "@meridian/core";
import { t, categoryLabelAr, serviceShortNameAr, areaNameAr } from "@/lib/i18n";

/**
 * Arabic site footer. Same legal-identity block as `site-footer.tsx` (Cabinet
 * Resolution 107/2022 Art. 7 requires the licence and CR number on every page
 * regardless of language) with translated labels and links into `/ar/*`.
 *
 * Careers has no Arabic page (out of scope this pass — see the delivery
 * report), so that link stays pointed at the English page and says so.
 */
export function SiteFooterAr() {
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
              <span className="text-[15px] font-semibold tracking-tight" dir="ltr">
                {tenant.brandName}
              </span>
            </div>
            <p className="mt-4 text-[14px] leading-relaxed" dir="ltr" style={{ color: "var(--text-secondary)", textAlign: "start" }}>
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
            <div className="mt-5 space-y-1.5 text-[14px]" dir="ltr" style={{ textAlign: "start" }}>
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
              <h2 className="text-[13px] font-semibold">{categoryLabelAr(group.category)}</h2>
              <ul className="mt-4 space-y-2.5">
                {group.items.map((s) => (
                  <li key={s.slug}>
                    <Link
                      href={`/ar/services/${s.slug}`}
                      className="text-[14px] transition-colors hover:text-[var(--accent)]"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {serviceShortNameAr(s.slug, s.shortName)}
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
              <h2 className="text-[13px] font-semibold">{t.nav.moreServices}</h2>
              <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2.5">
                {remaining.map((s) => (
                  <li key={s.slug}>
                    <Link
                      href={`/ar/services/${s.slug}`}
                      className="text-[14px] transition-colors hover:text-[var(--accent)]"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {serviceShortNameAr(s.slug, s.shortName)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <h2 className="text-[13px] font-semibold">
              <Link href="/ar/areas" className="hover:text-[var(--accent-text)]">
                {t.nav.areasCovered}
              </Link>
            </h2>
            <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2.5">
              {areas.map((a) => (
                <li key={a.slug}>
                  <Link
                    href={`/ar/areas/${a.slug}`}
                    className="text-[14px] transition-colors hover:text-[var(--accent-text)]"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {areaNameAr(a.slug, a.name)}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div
          className="mt-12 flex flex-col gap-4 border-t pt-8 text-[13px] sm:flex-row sm:items-start sm:justify-between"
          style={{ color: "var(--text-muted)" }}
        >
          <div className="space-y-1">
            <p dir="ltr" style={{ textAlign: "start" }}>
              &copy; 2026 {tenant.legalName}.
            </p>
            <p className="flex flex-wrap gap-x-4 gap-y-1" dir="ltr" style={{ textAlign: "start" }}>
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
          <nav aria-label={t.nav.legalNav} className="flex flex-wrap gap-x-6 gap-y-2">
            <Link href="/ar/contact">{t.nav.contact}</Link>
            <Link href="/careers">{t.nav.careers} (EN)</Link>
            <Link href="/ar/privacy">{t.nav.privacy}</Link>
            <Link href="/ar/terms">{t.nav.terms}</Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
