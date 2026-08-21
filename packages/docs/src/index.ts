/**
 * Document rendering.
 *
 * `packages/docs` produces the artefacts that leave the building: the
 * quotation (`QTE-3`), the full and simplified tax invoices (`INV-3`,
 * `INV-6`) and the tax credit note (`INV-7`). Read `layout.ts` first for why
 * this is a PDF writer rather than headless Chromium, and `issue.ts` for why a
 * financial document is rendered once and then kept.
 *
 * Still to build here, and deliberately not stubbed: the job sheet (`FLD-14`),
 * the statement of account (`INV-13`) and the Arabic bilingual layout variant
 * (`INV-14`). The tender pack (`CON-12`) is in `tender-pack.ts`, and it is the
 * one document here assembled from several renders — see its header.
 */

export * from "./tokens";
export * from "./format";
export { Canvas } from "./layout";
export * from "./blocks";
export * from "./tax-document";
export * from "./quote-document";
export * from "./issue";
export * from "./tender-pack";
