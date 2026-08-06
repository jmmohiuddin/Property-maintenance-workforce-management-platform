/**
 * Renders a schema.org graph into the document.
 *
 * Server-rendered on purpose: many AI crawlers do not execute JavaScript, so
 * structured data injected after hydration is structured data they never see.
 */
export function JsonLd({ json }: { json: string }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
