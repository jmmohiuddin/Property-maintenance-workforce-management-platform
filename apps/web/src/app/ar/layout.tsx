import { Noto_Sans_Arabic } from "next/font/google";
import { graph, organizationSchema, websiteSchema } from "@meridian/core";
import { SiteHeaderAr } from "@/components/site-header-ar";
import { SiteFooterAr } from "@/components/site-footer-ar";
import { JsonLd } from "@/components/json-ld";
import { ELEVATOR_ANSWER_AR } from "@/lib/i18n";

const arabic = Noto_Sans_Arabic({
  subsets: ["arabic"],
  variable: "--font-arabic",
  display: "swap",
});

/**
 * Arabic public site chrome — the RTL sibling of `(marketing)/layout.tsx`.
 *
 * `dir="rtl"` and `lang="ar"` are set here, on this wrapper `<div>`, rather
 * than on `<html>`. The reason is structural, not a shortcut: `<html>` is
 * declared once, in the shared root layout at `apps/web/src/app/layout.tsx`,
 * which also wraps `(app)` and `(portal)` — both English-only, both outside
 * this work's territory, both being edited by other agents in this session.
 * Next 16.3's `next/root-params` (see `next/root-params` docs, "Multiple root
 * layouts") is the documented way to let one branch of the route tree own its
 * own `<html>` with a locale param while sibling branches keep theirs — but
 * using it here means giving `(app)` and `(portal)` their own root layouts
 * too, since only one `<html>` can exist per render and the shared one has to
 * go. That is real, mechanical, low-behavioural-risk work, but it is not
 * marketing/components/core work, and it is exactly the kind of cross-cutting
 * change that should not land from a session with three other agents mid-edit
 * in those two directories. Left as the concrete next step — see the delivery
 * report.
 *
 * What this costs in practice: `document.documentElement.lang` stays
 * `"en-AE"` on `/ar` pages. Visual RTL mirroring, and `lang`/`dir` on the
 * content itself (which is what assistive technology actually reads for
 * pronunciation — nested `lang`/`dir` is honoured per the HTML spec, it is
 * only the whole-document defaults that are not ideal here), are both
 * correct. `hreflang` alternates (`@/lib/i18n`'s `hreflangAlternates`) do not
 * depend on `<html lang>` at all, so search-engine language targeting is
 * unaffected.
 */
export default function ArabicMarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div dir="rtl" lang="ar" className={arabic.variable}>
      <JsonLd
        json={graph(
          organizationSchema({ description: ELEVATOR_ANSWER_AR }),
          websiteSchema({ description: ELEVATOR_ANSWER_AR, inLanguage: "ar-AE" }),
        )}
      />
      <SiteHeaderAr />
      <main id="main">{children}</main>
      <SiteFooterAr />
    </div>
  );
}
