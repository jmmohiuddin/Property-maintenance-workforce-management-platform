import type { Metadata } from "next";
import { tenant, graph, webPageSchema, breadcrumbSchema } from "@meridian/core";
import { JsonLd } from "@/components/json-ld";
import { LegalPage, LegalSection, ReviewBanner } from "@/components/legal";
import { PendingTranslationNotice } from "@/components/pending-translation";
import { hreflangAlternates } from "@/lib/i18n";

const DESCRIPTION_AR = `الشروط التي تقدّم بموجبها ${tenant.legalName} خدمات الصيانة.`;

export const metadata: Metadata = {
  title: "الشروط والأحكام",
  description: DESCRIPTION_AR,
  alternates: { canonical: "/ar/terms", languages: hreflangAlternates("/terms") },
  robots: { index: false, follow: true },
};

/**
 * Same reasoning as `/ar/privacy`: a legal document with warranty periods,
 * liability and cancellation terms is not a page to guess a translation of.
 * English body, Arabic notice and governing-language clause above it.
 */
export default function TermsPageAr() {
  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            path: "/terms",
            name: "الشروط والأحكام",
            description: DESCRIPTION_AR,
            inLanguage: "ar-AE",
          }),
          breadcrumbSchema([
            { name: "الرئيسية", path: "/ar" },
            { name: "الشروط", path: "/ar/terms" },
          ]),
        )}
      />

      <div className="container-page pt-14 md:pt-20">
        <div className="max-w-3xl">
          <h1 className="text-4xl font-semibold md:text-5xl">الشروط والأحكام</h1>
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
        <LegalPage title="Terms of Service" updated="6 August 2026">
          <ReviewBanner />

          <LegalSection title="Who these terms are between">
            <p>
              These terms apply between you and {tenant.legalName}, trading as {tenant.brandName},
              registered in {tenant.address.city}, {tenant.address.country}. They apply whenever we quote
              for or carry out work for you, unless a signed contract between us says otherwise, in which
              case that contract takes precedence.
            </p>
          </LegalSection>

          <LegalSection title="Quotations">
            <ul>
              <li>Quotations are valid for 30 days from issue unless the quotation states otherwise.</li>
              <li>
                Quotations are itemised, and anything not covered is listed as an exclusion on the
                quotation itself rather than added later.
              </li>
              <li>
                Where work uncovers something the survey could not reasonably have found, we stop and
                issue a revised quotation. We do not proceed and invoice you for the difference.
              </li>
              <li>Prices exclude VAT unless stated. VAT is shown separately on the invoice.</li>
            </ul>
          </LegalSection>

          <LegalSection title="Call-outs and pricing">
            <ul>
              <li>
                A standard call-out covers attendance and the first 30 minutes of labour. Emergency
                call-outs cover attendance and the first hour.
              </li>
              <li>There is no night, weekend or public holiday surcharge on the call-out fee.</li>
              <li>Where we cannot resolve the fault and carry out no work, there is no charge.</li>
              <li>
                Materials and any labour beyond the included period are quoted to you and require your
                approval before we proceed.
              </li>
            </ul>
          </LegalSection>

          <LegalSection title="Access and safety">
            <ul>
              <li>
                You are responsible for providing safe access to the property at the agreed time,
                including any building permissions, escorts or parking access required.
              </li>
              <li>
                Where we attend and cannot gain access, we may charge the call-out fee. We will always
                contact you before leaving.
              </li>
              <li>
                Our technicians will stop work and report to you if they find a condition that is unsafe
                to work on. We will not proceed with work we consider unsafe.
              </li>
            </ul>
          </LegalSection>

          <LegalSection title="Payment">
            <ul>
              <li>Ad-hoc work is payable on completion unless you hold an account with agreed terms.</li>
              <li>Account customers are invoiced on the terms stated on the invoice, typically 30 days.</li>
              <li>Contract fees are payable on the billing frequency stated in the contract.</li>
              <li>
                We may suspend further work on overdue accounts. We will tell you before doing so, and we
                will not suspend attendance at a genuine emergency on that basis.
              </li>
            </ul>
          </LegalSection>

          <LegalSection title="Our workmanship warranty">
            <ul>
              <li>
                We warrant our workmanship for 90 days from completion on general repairs. Where a longer
                period applies, it is stated on the quotation. Waterproofing carries a workmanship
                warranty of up to 10 years, conditional on the substrate and drainage falls being sound,
                both of which we assess before quoting.
              </li>
              <li>
                Parts and materials carry their manufacturer's warranty. We pass that through and will
                handle the claim on your behalf.
              </li>
              <li>
                The warranty does not cover damage caused by misuse, third-party work after ours, or
                conditions we identified in writing and you chose not to address.
              </li>
              <li>If our work fails within the warranty period, we return and put it right at no charge.</li>
            </ul>
          </LegalSection>

          <LegalSection title="Annual maintenance contracts">
            <ul>
              <li>
                What a contract covers and what it excludes is set out on the contract itself. Exclusions
                are listed plainly, not buried.
              </li>
              <li>
                Contracts do not cover parts and materials, major plant replacement, or damage caused by
                misuse or third parties, unless the contract states otherwise.
              </li>
              <li>
                Contracts transfer to a new address within our service areas at no charge, or to a new
                owner of the same property. Unused preventive visits carry over.
              </li>
              <li>Where a contract auto-renews, that is stated on the contract along with the notice period.</li>
            </ul>
          </LegalSection>

          <LegalSection title="Liability">
            <p>
              We are responsible for damage caused by our own negligence. Current insurance certificates,
              including public liability and workmen&apos;s compensation cover, are provided on request and
              with any tender or contract submission.
            </p>
            <p>
              We are not responsible for pre-existing defects we did not cause, for consequential loss such
              as loss of business or rental income, or for failures of equipment we did not install or
              maintain. Nothing in these terms limits liability where the law does not permit it to be
              limited.
            </p>
          </LegalSection>

          <LegalSection title="Cancellation">
            <p>
              You may cancel or reschedule a booked appointment at no charge up to 4 hours before the
              agreed time. Later than that, we may charge the call-out fee, because the slot and the
              technician are already committed.
            </p>
          </LegalSection>

          <LegalSection title="Complaints">
            <p>
              Contact <a href={`mailto:${tenant.email}`}>{tenant.email}</a> or call {tenant.phone}. We
              acknowledge complaints within one working day and aim to resolve them within five. If you
              are not satisfied with the outcome, you can ask for it to be escalated to a director.
            </p>
          </LegalSection>

          <LegalSection title="Governing law">
            <p>
              These terms are governed by the laws of the United Arab Emirates and the Emirate of{" "}
              {tenant.address.region}, and are subject to the exclusive jurisdiction of its courts.
            </p>
          </LegalSection>
        </LegalPage>
      </div>
    </>
  );
}
