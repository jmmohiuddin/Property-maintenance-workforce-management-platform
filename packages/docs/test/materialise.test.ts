/**
 * Render once, store, keep the key — against a real database.
 *
 * `render.test.ts` proves the template. This proves the part `TD-14` was
 * actually about: that `pdf_storage_key` stops being a column nothing writes,
 * that the row and the object agree, and that the artefact cannot be replaced
 * afterwards.
 *
 *   npm run test --workspace=@meridian/docs
 *
 * Requires the same environment as the `@meridian/db` tests: schema and RLS
 * applied, `npm run db:seed` run. It writes its documents to a temporary
 * directory and removes everything it created.
 *
 * Run with `--env-file-if-exists=../../.env`, which the package script does.
 * The reason is a real ordering problem rather than convenience: `company` in
 * `@meridian/core` reads its environment once, at import. `@meridian/db` loads
 * the root `.env` lazily, when the first query opens a connection — by which
 * time the identity has already been fixed as unset, and every invoice this
 * test raises would carry a null TRN and be refused by `assertRenderable`. Next
 * loads the file before any module runs, so the application does not have this
 * problem; a plain script does. `--env-file` is the same guarantee for a script.
 */

import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  withTenant,
  schema,
  createInvoiceFromJob,
  createQuote,
  issueCreditNote,
  closeConnection,
} from "@meridian/db";
import {
  materialiseInvoiceDocument,
  materialiseQuoteDocument,
  materialiseCreditNoteDocument,
} from "@meridian/docs";
import { objectStore } from "@meridian/files";
import { company } from "@meridian/core";
import { pdfText } from "./pdf-text";

// Set at module scope, which is early enough: `objectStore()` reads the
// environment when it is first *called*, not when it is imported. A test that
// wrote into the developer's real store would leave documents behind that the
// write-once rule then refuses to overwrite.
const ROOT = mkdtempSync(join(tmpdir(), "meridian-docs-"));
process.env["FILES_LOCAL_ROOT"] = ROOT;

const TENANT = "11111111-1111-4111-8111-111111111111";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}

function contains(label: string, haystack: string, needle: string): void {
  const ok = haystack.includes(needle);
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — "${needle}" is not on the document`}`);
}

async function main(): Promise<void> {
  const ctx = { tenantId: TENANT };

  const job = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ id: schema.jobs.id, reference: schema.jobs.reference })
      .from(schema.jobs)
      .where(eq(schema.jobs.reference, "JOB-2026-00014"));
    return rows[0];
  });

  if (!job) throw new Error("Seed data missing. Run `npm run db:seed` first.");

  // ── An invoice raised the way the application raises one ──────────────────
  //
  // Not a hand-built fixture: this goes through `createInvoiceFromJob`, so the
  // supplier snapshot, the date of supply taken from the customer's signature,
  // and the per-line apportionment of the discount are all the real ones.
  const invoice = await withTenant(ctx, (tx) =>
    createInvoiceFromJob(tx, ctx, {
      jobId: job.id,
      lines: [
        { description: "Marble floor honing", quantity: "180", unit: "m2", unitPrice: "22.00" },
        { description: "Lift car interior clean", quantity: "4", unit: "ea", unitPrice: "150.00" },
      ],
      discount: "160.00",
    }),
  );

  const first = await withTenant(ctx, (tx) => materialiseInvoiceDocument(tx, invoice.invoiceId));
  check("the first call renders", first.rendered, true);
  check("the reference is the invoice's", first.reference, invoice.reference);

  const row = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        key: schema.invoices.pdfStorageKey,
        sha: schema.invoices.pdfSha256,
        at: schema.invoices.pdfRenderedAt,
      })
      .from(schema.invoices)
      .where(eq(schema.invoices.id, invoice.invoiceId));
    return rows[0];
  });

  // TD-14 in one assertion.
  check("pdf_storage_key is written", row?.key, first.storageKey);
  check("pdf_sha256 is written", row?.sha, first.sha256);
  check("pdf_rendered_at is written", row?.at instanceof Date, true);
  check(
    "the key is under this tenant",
    first.storageKey.startsWith(`tenants/${TENANT}/documents/tax-invoice/`),
    true,
  );

  // ── Never re-rendered on demand (TRD §7.6) ────────────────────────────────
  const second = await withTenant(ctx, (tx) => materialiseInvoiceDocument(tx, invoice.invoiceId));
  check("the second call renders nothing", second.rendered, false);
  check("and returns the same key", second.storageKey, first.storageKey);
  check("and the same hash", second.sha256, first.sha256);

  // ── The stored bytes are the document, and they are what the hash covers ──
  const stored = await objectStore().get(first.storageKey);
  check("the object is in the store", stored !== null, true);
  check("its recorded hash matches the row", stored?.object.sha256, first.sha256);
  check("it is stored as a PDF", stored?.object.contentType, "application/pdf");

  const text = pdfText(stored?.body ?? new Uint8Array());

  contains("the words Article 59 requires", text, "Tax Invoice");
  contains("the sequential reference", text, invoice.reference);
  // The licence is on the row because `createInvoiceFromJob` snapshot it, and
  // on the page because the letterhead prints it. Both halves matter.
  contains("the trade licence", text, company.licenceNumber ?? "930137");
  contains("per-line amount in AED", text, "AED 3,960.00");
  contains("the other line, in AED", text, "AED 600.00");
  contains("the subtotal", text, "AED 4,560.00");
  contains("the discount", text, "AED -160.00");
  // 4,560.00 - 160.00 = 4,400.00, and 5% of that is 220.00. VAT taken before
  // the discount would be 228.00 — this pair of assertions is the ordering.
  contains("VAT charged on the discounted amount", text, "VAT 5% of AED 4,400.00");
  contains("the VAT amount", text, "AED 220.00");
  contains("the total", text, "AED 4,620.00");

  const supplyDate = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ supplyDate: schema.invoices.supplyDate })
      .from(schema.invoices)
      .where(eq(schema.invoices.id, invoice.invoiceId));
    return rows[0]?.supplyDate ?? null;
  });
  // Article 59 wants the date of supply, and `INV-5`'s 14-day clock is measured
  // from it. Formatted the way the document formats it, from the value that is
  // actually on the row.
  const [year, month, day] = (supplyDate ?? "").split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  contains("the date of supply", text, `${day} ${months[Number(month) - 1]} ${year}`);

  // ── OPS-6: the artefact cannot be re-pointed ──────────────────────────────
  //
  // Enforced by a trigger rather than by convention, because the thing it
  // protects against is a well-meant "re-render them all, the template is
  // fixed" script run over invoices that are already in a tax return.
  let immutable = false;
  try {
    await withTenant(ctx, (tx) =>
      tx
        .update(schema.invoices)
        .set({ pdfStorageKey: "tenants/x/documents/tax-invoice/2026/forged.pdf" })
        .where(eq(schema.invoices.id, invoice.invoiceId)),
    );
  } catch {
    immutable = true;
  }
  check("a stored document cannot be replaced", immutable, true);

  // ── The tax credit note (INV-7) ───────────────────────────────────────────
  //
  // Its own series, its own artefact, and the same template — discriminated by
  // `documentType`, never a second one. Article 60 requires the reference to the
  // invoice it corrects, so that is what is checked on the face of it.
  const credit = await withTenant(ctx, (tx) =>
    issueCreditNote(
      tx,
      ctx,
      {
        invoiceId: invoice.invoiceId,
        reason: "correction",
        reasonDetail: "Two lift cars were billed that were not cleaned.",
        lines: [
          { description: "Lift car interior clean", quantity: "2", unit: "ea", unitPrice: "150.00" },
        ],
      },
    ),
  );

  const creditDocument = await withTenant(ctx, (tx) =>
    materialiseCreditNoteDocument(tx, credit.creditNoteId),
  );

  const creditRow = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ key: schema.creditNotes.pdfStorageKey, sha: schema.creditNotes.pdfSha256 })
      .from(schema.creditNotes)
      .where(eq(schema.creditNotes.id, credit.creditNoteId));
    return rows[0];
  });

  check("credit_notes.pdf_storage_key is written", creditRow?.key, creditDocument.storageKey);
  check("credit_notes.pdf_sha256 is written", creditRow?.sha, creditDocument.sha256);
  check(
    "and it is filed under its own kind, not with the invoices",
    creditDocument.storageKey.includes("/documents/tax-credit-note/"),
    true,
  );

  const storedCredit = await objectStore().get(creditDocument.storageKey);
  const creditText = pdfText(storedCredit?.body ?? new Uint8Array());

  contains("the credit note's own title", creditText, "Tax Credit Note");
  contains("its own sequential series", creditText, credit.reference);
  contains("Article 60's reference to the original", creditText, invoice.reference);
  contains("why output tax was reduced", creditText, "were not cleaned");
  contains("it is labelled a credit, not a charge", creditText, "Total credited");
  contains("the amount credited", creditText, "AED 315.00");

  const creditAgain = await withTenant(ctx, (tx) =>
    materialiseCreditNoteDocument(tx, credit.creditNoteId),
  );
  check("a credit note is not re-rendered either", creditAgain.rendered, false);
  check("and keeps its hash", creditAgain.sha256, creditDocument.sha256);

  // ── The quotation (QTE-3) ─────────────────────────────────────────────────
  const quote = await withTenant(ctx, (tx) =>
    createQuote(tx, ctx, {
      jobId: job.id,
      title: "Facade panel replacement, north elevation",
      lines: [
        { description: "Panel supply and fix", quantity: "12", unit: "ea", unitPrice: "340.00" },
      ],
    }),
  );

  const quoteDocument = await withTenant(ctx, (tx) =>
    materialiseQuoteDocument(tx, quote.quoteId, {
      acceptUrl: `https://example.ae/portal/quotes/${quote.quoteId}`,
    }),
  );

  const quoteRow = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ key: schema.quotes.pdfStorageKey, sha: schema.quotes.pdfSha256 })
      .from(schema.quotes)
      .where(eq(schema.quotes.id, quote.quoteId));
    return rows[0];
  });

  // The column added by 0010, populated. The other half of `DB-2`.
  check("quotes.pdf_storage_key is written", quoteRow?.key, quoteDocument.storageKey);
  check("quotes.pdf_sha256 is written", quoteRow?.sha, quoteDocument.sha256);

  const storedQuote = await objectStore().get(quoteDocument.storageKey);
  const quoteText = pdfText(storedQuote?.body ?? new Uint8Array());

  contains("the quotation heading", quoteText, "QUOTATION");
  contains("the quote reference", quoteText, quote.reference);
  contains("the trade licence on a quote too", quoteText, company.licenceNumber ?? "930137");
  contains("the total", quoteText, "AED 4,284.00");
  contains("the portal accept link", quoteText, `/portal/quotes/${quote.quoteId}`);

  const quoteAgain = await withTenant(ctx, (tx) => materialiseQuoteDocument(tx, quote.quoteId));
  check("a quotation is not re-rendered either", quoteAgain.rendered, false);
  check("and keeps its hash", quoteAgain.sha256, quoteDocument.sha256);

  // ── Clean up ──────────────────────────────────────────────────────────────
  await withTenant(ctx, async (tx) => {
    await tx
      .delete(schema.creditNoteLines)
      .where(eq(schema.creditNoteLines.creditNoteId, credit.creditNoteId));
    await tx.delete(schema.creditNotes).where(eq(schema.creditNotes.id, credit.creditNoteId));
    await tx.delete(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoice.invoiceId));
    await tx.delete(schema.invoices).where(eq(schema.invoices.id, invoice.invoiceId));
    await tx.delete(schema.quoteLines).where(eq(schema.quoteLines.quoteId, quote.quoteId));
    await tx.delete(schema.quotes).where(eq(schema.quotes.id, quote.quoteId));
  });

  console.log(fail === 0 ? "\nall document storage checks passed" : `\n${fail} FAILED`);
  await closeConnection();
  await rm(ROOT, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error: unknown) => {
  console.error(error);
  await closeConnection();
  await rm(ROOT, { recursive: true, force: true });
  process.exit(1);
});
