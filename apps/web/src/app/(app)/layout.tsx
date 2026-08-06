import type { Metadata } from "next";

/**
 * Application shell. No marketing header or footer, and noindex throughout -
 * none of this should ever appear in a search result.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <div id="main">{children}</div>;
}
