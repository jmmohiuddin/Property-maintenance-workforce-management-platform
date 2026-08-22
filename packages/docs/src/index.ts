/**
 * Document rendering.
 *
 * `packages/docs` produces the artefacts that leave the building: the
 * quotation (`QTE-3`), the full and simplified tax invoices (`INV-3`,
 * `INV-6`) and the tax credit note (`INV-7`). Read `layout.ts` first for why
 * this is a PDF writer rather than headless Chromium, and `issue.ts` for why a
 * financial document is rendered once and then kept.
 *
 * The signed job sheet (`FLD-14`) is `job-sheet.ts` — the render and the
 * canonicalisation whose digest is what a signature is actually given to — and
 * `job-sheet-seal.ts`, which is the snapshot, the lock and the customer's copy.
 * Read the first of those before the second.
 *
 * The statement of account (`INV-13`) is `statement.ts` — a report about
 * documents rather than a document in its own right, which is why it has no
 * sequential number and is not stored write-once; read its header for how it
 * differs from the portal's own statement screen.
 *
 * Still to build here, and deliberately not stubbed: the Arabic bilingual
 * layout variant (`INV-14`). The tender
 * pack (`CON-12`) is in `tender-pack.ts`, and it is the one document here
 * assembled from several renders — see its header.
 */

export * from "./tokens";
export * from "./format";
export { Canvas } from "./layout";
export * from "./blocks";
export * from "./tax-document";
export * from "./statement";
export * from "./quote-document";
export * from "./issue";
export * from "./tender-pack";
export * from "./job-sheet";
export * from "./job-sheet-seal";
