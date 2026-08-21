import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { tenant, absoluteUrl, assertPublishableIdentity } from "@meridian/core";
import "./globals.css";

/**
 * Root layout. Deliberately minimal: html, body, fonts and the skip link.
 *
 * Chrome differs between the two route groups - (marketing) has the public
 * header and footer, (app) has the authenticated shell - so neither belongs
 * here. Organization JSON-LD moved into (marketing) for the same reason: the
 * operational app has no business emitting marketing structured data.
 */

const sans = Geist({ subsets: ["latin"], variable: "--font-geist-sans", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(absoluteUrl("/")),
  title: {
    default: `${tenant.brandName} | Property Maintenance & Facility Management in ${tenant.address.city}`,
    template: `%s | ${tenant.brandName}`,
  },
  description: tenant.elevatorAnswer,
  applicationName: tenant.brandName,
  authors: [{ name: tenant.legalName }],
  creator: tenant.legalName,
  publisher: tenant.legalName,
  formatDetection: { telephone: true, address: true, email: true },
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: tenant.brandName,
    locale: "en_AE",
    url: absoluteUrl("/"),
    title: `${tenant.brandName} | Property Maintenance & Facility Management`,
    description: tenant.elevatorAnswer,
  },
  twitter: { card: "summary_large_image", title: tenant.brandName, description: tenant.elevatorAnswer },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-snippet": -1, "max-image-preview": "large" },
  },
  category: "Facility Management",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f8fa" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0e12" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Refuses to boot in production while any identity value is still a
  // placeholder, and warns loudly everywhere else. Placed in the root layout so
  // it runs on the first render of any page, rather than waiting for someone to
  // scroll to a footer and notice a licence number of all zeros.
  //
  // The previous build shipped exactly that and nothing caught it, because
  // nothing was checking. See packages/core/src/company.ts.
  assertPublishableIdentity();

  return (
    <html lang="en-AE" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:px-4 focus:py-2"
          style={{ backgroundColor: "var(--accent)", color: "var(--accent-contrast)" }}
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
