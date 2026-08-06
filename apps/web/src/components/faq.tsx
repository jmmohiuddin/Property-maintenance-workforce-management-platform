import type { Faq } from "@meridian/core";

/**
 * Native details/summary rather than a JS accordion.
 *
 * The answer text is in the HTML whether or not the panel is open and whether
 * or not JavaScript runs, which is the whole point: an FAQ that only renders
 * its answers after a click is an FAQ that non-executing crawlers read as a
 * list of questions with no answers.
 */
export function FaqList({ faqs, className = "" }: { faqs: readonly Faq[]; className?: string }) {
  return (
    <div className={`divide-y border-y ${className}`}>
      {faqs.map((faq) => (
        <details key={faq.q} className="group py-5">
          <summary className="flex cursor-pointer list-none items-start justify-between gap-6 text-[16px] font-medium md:text-[17px]">
            {faq.q}
            <span
              aria-hidden
              className="mt-1 shrink-0 font-mono text-[18px] leading-none transition-transform duration-200 group-open:rotate-45"
              style={{ color: "var(--accent)" }}
            >
              +
            </span>
          </summary>
          <p className="prose-body mt-3 text-[15px]">{faq.a}</p>
        </details>
      ))}
    </div>
  );
}
