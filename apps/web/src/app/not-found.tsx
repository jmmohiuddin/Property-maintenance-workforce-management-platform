import Link from "next/link";
import { tenant, groupedServices, telLink } from "@meridian/core";
import { PhoneCall } from "@phosphor-icons/react/dist/ssr";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

/**
 * A 404 on this site is disproportionately likely to be someone with an urgent
 * problem following a stale link or a mistyped URL. The priority is therefore
 * getting them to a phone number, not apologising decoratively.
 */
export default function NotFound() {
  const groups = groupedServices();

  // Renders the public chrome explicitly. A root not-found sits outside every
  // route group, so it inherits the (marketing) layout from neither.
  return (
    <>
      <SiteHeader />
      <main id="main" className="container-page py-20 md:py-28">
      <div className="max-w-2xl">
        <p className="font-mono text-[13px] font-medium tracking-[0.16em]" style={{ color: "var(--accent-text)" }}>
          404
        </p>
        <h1 className="mt-4 text-4xl font-semibold md:text-5xl">This page does not exist</h1>
        <p className="prose-body mt-6 text-[17px]">
          The link may be out of date. If you have an emergency, do not spend time looking for the
          right page: call the line below and it will be answered.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <a href={telLink(tenant.emergencyPhone)} className="btn btn-primary">
            <PhoneCall size={17} weight="fill" aria-hidden />
            {tenant.emergencyPhone}
          </a>
          <Link href="/" className="btn btn-secondary">
            Go to the homepage
          </Link>
        </div>
      </div>

      <div className="mt-16 border-t pt-10">
        <h2 className="text-[15px] font-semibold">All services</h2>
        <div className="mt-6 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((group) => (
            <div key={group.category}>
              <h3 className="text-[13px] font-semibold">{group.category}</h3>
              <ul className="mt-3 space-y-2">
                {group.items.map((s) => (
                  <li key={s.slug}>
                    <Link
                      href={`/services/${s.slug}`}
                      className="text-[14px] transition-colors hover:text-[var(--accent-text)]"
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
      </div>
      </main>
      <SiteFooter />
    </>
  );
}
