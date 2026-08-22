import type { Metadata } from "next";
import { tenant, graph, webPageSchema, breadcrumbSchema } from "@meridian/core";
import { JsonLd } from "@/components/json-ld";
import { LegalPage, LegalSection, ReviewBanner } from "@/components/legal";
import { PendingTranslationNotice } from "@/components/pending-translation";
import { hreflangAlternates } from "@/lib/i18n";

const DESCRIPTION_AR = `كيف تجمع ${tenant.legalName} البيانات الشخصية وتستخدمها وتحميها.`;

export const metadata: Metadata = {
  title: "سياسة الخصوصية",
  description: DESCRIPTION_AR,
  alternates: { canonical: "/ar/privacy", languages: hreflangAlternates("/privacy") },
  robots: { index: false, follow: true },
};

/**
 * Arabic route, English body. This is a legal document — data-retention
 * periods, what gets deleted on request, security commitments — and it
 * already carries `<ReviewBanner>` on the English page saying it has not been
 * reviewed by a UAE-qualified lawyer. Translating an unreviewed legal
 * document into a second unreviewed language compounds the risk rather than
 * spreading it. See `PendingTranslationNotice` / `@/lib/i18n` for the same
 * reasoning applied throughout `/ar`.
 */
export default function PrivacyPageAr() {
  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            path: "/privacy",
            name: "سياسة الخصوصية",
            description: DESCRIPTION_AR,
            inLanguage: "ar-AE",
          }),
          breadcrumbSchema([
            { name: "الرئيسية", path: "/ar" },
            { name: "الخصوصية", path: "/ar/privacy" },
          ]),
        )}
      />

      <div className="container-page pt-14 md:pt-20">
        <div className="max-w-3xl">
          <h1 className="text-4xl font-semibold md:text-5xl">سياسة الخصوصية</h1>
          <p className="mt-4 text-[15px]" style={{ color: "var(--text-secondary)" }}>
            هذه صفحة قانونية، ونصها الكامل أدناه لا يزال بالإنجليزية — وهي النسخة المعتمدة — ريثما تُراجع من
            قِبل مستشار قانوني وتُترجم رسميًا. عند وجود أي تعارض بين نسخة عربية مستقبلية وهذا النص الإنجليزي،
            يُعتمد النص الإنجليزي.
          </p>
          <div className="mt-6">
            <PendingTranslationNotice />
          </div>
        </div>
      </div>

      <div dir="ltr" lang="en">
        <LegalPage title="Privacy Policy" updated="6 August 2026">
          <ReviewBanner />

          <LegalSection title="Who we are">
            <p>
              {tenant.legalName} ({tenant.brandName}) provides property maintenance and facility
              management services in the United Arab Emirates. Our registered address is{" "}
              {tenant.address.street}, {tenant.address.city}, {tenant.address.country}. For any question
              about this policy or your data, contact <a href={`mailto:${tenant.email}`}>{tenant.email}</a>.
            </p>
          </LegalSection>

          <LegalSection title="What we collect">
            <p>We collect only what we need to quote for and carry out work:</p>
            <ul>
              <li>
                <strong>Contact details</strong> you give us: name, phone number, email address.
              </li>
              <li>
                <strong>Property details</strong>: address, area, property type, and access instructions
                you choose to share.
              </li>
              <li>
                <strong>Service records</strong>: descriptions of the fault, work carried out, materials
                used, and photographs taken before and after work at your property.
              </li>
              <li>
                <strong>Signatures</strong> captured on completion of work, recorded with the time and
                location of signing.
              </li>
              <li>
                <strong>Billing information</strong> where we invoice you. We do not store full card
                numbers; payments are processed by a payment provider.
              </li>
            </ul>
            <p>
              We do not use tracking or advertising cookies on this website, and we do not build
              behavioural profiles of visitors.
            </p>
          </LegalSection>

          <LegalSection title="Photographs taken at your property">
            <p>
              Before-and-after photographs are part of a job record: they evidence the condition we found
              and the work we did, which protects both of us in a dispute or an insurance claim. They are
              visible to the technician who took them, our operations team, and you.
            </p>
            <p>
              We will not use photographs of your property for marketing, case studies or any public
              purpose without asking you separately and in writing first.
            </p>
          </LegalSection>

          <LegalSection title="Why we use it">
            <ul>
              <li>To respond to your enquiry and prepare a quotation.</li>
              <li>To schedule, dispatch and carry out the work.</li>
              <li>To keep a record of work carried out, which we are required to retain.</li>
              <li>To invoice you and collect payment.</li>
              <li>To contact you about a contract you hold with us, including renewal.</li>
            </ul>
            <p>
              We do not sell personal data. We do not share it with third parties for their own marketing.
            </p>
          </LegalSection>

          <LegalSection title="Who we share it with">
            <p>
              Only where necessary to do the work: the technician attending your property; a specialist
              subcontractor where a job requires a trade we do not hold in-house, in which case we tell
              you; our payment provider; and our accountants and auditors. Where the law or a competent
              authority requires disclosure, we comply.
            </p>
          </LegalSection>

          <LegalSection title="How long we keep it">
            <ul>
              <li>
                <strong>Job records, quotations and invoices</strong>: retained as required for tax and
                audit purposes, and because disputes and insurance claims can arise years later.
              </li>
              <li>
                <strong>Job photographs and signatures</strong>: retained with the job record.
              </li>
              <li>
                <strong>Enquiries that do not become jobs</strong>: deleted within 24 months.
              </li>
            </ul>
          </LegalSection>

          <LegalSection title="Your choices">
            <p>
              You can ask us for a copy of the personal data we hold about you, ask us to correct it, or
              ask us to delete it. Email <a href={`mailto:${tenant.email}`}>{tenant.email}</a>.
            </p>
            <p>
              One limit worth stating plainly: we cannot delete financial records we are required to keep.
              Where you ask for deletion, we erase your contact details, correspondence and photographs of
              your property, and retain the transaction record with personal fields removed.
            </p>
          </LegalSection>

          <LegalSection title="Security">
            <p>
              Data is encrypted in transit and at rest. Access is limited to staff who need it for their
              role, and every access to a customer record is logged. Files such as photographs and
              signatures are stored privately and served only through time-limited links.
            </p>
          </LegalSection>
        </LegalPage>
      </div>
    </>
  );
}
