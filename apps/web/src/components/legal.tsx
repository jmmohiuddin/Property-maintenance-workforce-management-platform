import { Warning } from "@phosphor-icons/react/dist/ssr";

/**
 * Shared shell for legal pages. These are read rarely and skimmed when they are,
 * so the layout optimises for scanability over density: a narrow measure, clear
 * section headings, and no marketing furniture.
 */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <div className="container-page py-14 md:py-20">
      <div className="max-w-3xl">
        <h1 className="text-4xl font-semibold md:text-5xl">{title}</h1>
        <p className="mt-4 text-[14px]" style={{ color: "var(--text-muted)" }}>
          Last updated {updated}
        </p>
        <div className="mt-12 space-y-12">{children}</div>
      </div>
    </div>
  );
}

export function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-semibold tracking-tight md:text-2xl">{title}</h2>
      <div className="legal-prose mt-4">{children}</div>
    </section>
  );
}

/**
 * Deliberately visible rather than a code comment.
 *
 * These documents were drafted to be honest and readable, not to be legally
 * sufficient in the UAE. Shipping unreviewed legal text while implying it has
 * been checked is worse than shipping nothing, so the page says so out loud
 * until a lawyer signs it off. Remove this component once that has happened.
 */
export function ReviewBanner() {
  return (
    <div
      className="flex items-start gap-3 rounded p-5 text-[14px] leading-relaxed"
      style={{ backgroundColor: "var(--accent-wash)", color: "var(--text-primary)" }}
      role="note"
    >
      <Warning
        size={18}
        weight="fill"
        aria-hidden
        className="mt-0.5 shrink-0"
        style={{ color: "var(--accent-text)" }}
      />
      <span>
        <strong>Pending legal review.</strong> This document describes our intended practice in plain
        language. It has not yet been reviewed by a UAE-qualified lawyer and should not be relied on as
        a final legal instrument. See the launch checklist before publishing.
      </span>
    </div>
  );
}
