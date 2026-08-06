import { graph, organizationSchema, websiteSchema } from "@meridian/core";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { JsonLd } from "@/components/json-ld";

/**
 * Public site chrome. Everything under this group is statically prerendered and
 * crawlable; nothing here requires a session.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Organization and WebSite are emitted once for the whole public site.
          Page-level graphs reference them by @id rather than repeating them. */}
      <JsonLd json={graph(organizationSchema(), websiteSchema())} />
      <SiteHeader />
      <main id="main">{children}</main>
      <SiteFooter />
    </>
  );
}
