import { Translate } from "@phosphor-icons/react/dist/ssr";

/**
 * Marks a block of content on an `/ar` page as not yet translated.
 *
 * Deliberately visible rather than a code comment, on the same principle as
 * `<ReviewBanner>` in `components/legal.tsx`: shipping an unreviewed Arabic
 * rendering of licensed-activity wording or legal text while implying it has
 * been checked is worse than showing the English original honestly labelled.
 * See `apps/web/src/lib/i18n.ts` for exactly which content this applies to and
 * why.
 *
 * The wrapped content itself must carry `dir="ltr" lang="en"` — this banner
 * only announces it, it does not set direction on its sibling.
 */
export function PendingTranslationNotice({ dense = false }: { dense?: boolean }) {
  return (
    <div
      className={`flex items-start gap-3 rounded text-[13px] leading-relaxed ${dense ? "p-4" : "p-5"}`}
      style={{ backgroundColor: "var(--accent-wash)", color: "var(--text-primary)" }}
      role="note"
    >
      <Translate
        size={17}
        weight="fill"
        aria-hidden
        className="mt-0.5 shrink-0"
        style={{ color: "var(--accent-text)" }}
      />
      <span>
        <strong>بانتظار الترجمة.</strong> المحتوى أدناه يتضمن تفاصيل فنية أو قانونية دقيقة (مثل نص الترخيص أو
        بنود العقد)، وهو معروض حاليًا بالإنجليزية فقط ريثما تتم مراجعته وترجمته رسميًا من قِبل مختص، لتفادي أي
        ترجمة غير دقيقة لمعلومات لها أثر قانوني أو ترخيصي.
      </span>
    </div>
  );
}
