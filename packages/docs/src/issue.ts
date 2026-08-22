/**
 * Rendering a document once and keeping it.
 *
 * TRD §7.6: *rendered PDFs are written to object storage and the key stored on
 * the record — never re-rendered on demand for a financial document, because
 * the artefact must be stable even if a template changes.* This module is that
 * sentence. Every function here is idempotent: if the record already carries a
 * key, it returns that key and renders nothing.
 *
 * ── WHY THIS IS "MATERIALISE" AND NOT "RENDER" ──────────────────────────────
 *
 * The natural place to call this is the moment a document is issued, and that
 * is what the actions do. But invoices exist that were raised before any of
 * this code did, and there will be issues where the render fails after the
 * invoice has committed — a render must never roll back an invoice, because
 * the invoice is the legal event and the PDF is a copy of it. So these
 * functions are safe to call at any later point: the first caller that finds no
 * artefact produces one, everybody after that gets the same bytes.
 *
 * What that deliberately does *not* mean is re-rendering on every download. The
 * key is written on the row the first time and the row is the authority
 * afterwards, which is what makes the stored SHA-256 mean anything.
 *
 * ── ORDER OF OPERATIONS, AND THE ORPHAN ─────────────────────────────────────
 *
 * The object store is not transactional and the database is. The write order is
 * therefore: render, store the bytes, then update the row. If the transaction
 * fails after the object is written, the object is orphaned — and because
 * rendering is deterministic, the retry produces byte-identical output and
 * finds its own orphan waiting. `store()` below handles that case by adopting
 * the existing object rather than failing on the write-once rule, which is the
 * behaviour that makes a retry converge instead of getting permanently stuck.
 */

import { and, eq, isNull } from "drizzle-orm";
import { getInvoiceDocument, schema, type TenantScopedTx } from "@meridian/db";
import { company, defaultInvoiceVariant, dubaiDateKey, toMinor } from "@meridian/core";
import { objectStore } from "@meridian/files";
import { renderTaxDocument, type RenderedDocument } from "./tax-document";
import { renderQuoteDocument } from "./quote-document";

export interface StoredDocument {
  readonly reference: string;
  readonly storageKey: string;
  readonly sha256: string;
  /** False when the artefact already existed and nothing was rendered. */
  readonly rendered: boolean;
  /** Non-empty means a name on the document lost characters. See `RenderedDocument`. */
  readonly substitutedCharacters: readonly string[];
}

/**
 * Where a document lives.
 *
 * Tenant first, because that is the boundary everything else in this system is
 * organised around and a prefix-scoped credential is the only way an S3 driver
 * will ever be able to enforce it. Year next, because `INV-15` retention is
 * measured in years and a lifecycle rule that has to parse a reference to work
 * out which ones have aged out is a lifecycle rule nobody will write.
 *
 * The reference is the filename, so an operator looking at the bucket sees
 * `sats-inv-2026-0184.pdf` and knows what it is without a database.
 */
export function documentStorageKey(input: {
  tenantId: string;
  kind: "quote" | "tax-invoice" | "tax-credit-note";
  year: string;
  reference: string;
}): string {
  const slug = input.reference.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  return `tenants/${input.tenantId.toLowerCase()}/documents/${input.kind}/${input.year}/${slug}.pdf`;
}

/**
 * Write the bytes, or adopt what is already there.
 *
 * The write-once rule in `packages/files` exists to stop a template change
 * silently replacing an issued document. It is not meant to stop a retry after
 * a failed transaction, and the two are distinguishable: an adopted object with
 * the same hash is the same document. A *different* hash means bytes were
 * stored under this reference by an earlier version of the template — in which
 * case the earlier artefact wins, because it is the one that may already have
 * been sent, and the row is pointed at it.
 */
async function store(key: string, document: RenderedDocument): Promise<string> {
  const objects = objectStore();
  const existing = await objects.head(key);

  if (existing) {
    if (existing.sha256 !== document.sha256) {
      console.warn(
        `[docs] ${key} already holds a different artefact (stored ${existing.sha256}, ` +
          `re-rendered ${document.sha256}). Keeping the stored one — it is the copy that may ` +
          `already have been sent, and an issued document is corrected by a credit note, not by a reprint.`,
      );
    }
    return existing.sha256;
  }

  const written = await objects.put({
    key,
    body: document.bytes,
    declaredContentType: "application/pdf",
  });
  return written.sha256;
}

/**
 * The tax invoice (`INV-3`, `INV-6`).
 *
 * Reads the document through the same query the invoice screen uses, so what is
 * rendered is what is displayed. `assertRenderable` inside `renderTaxDocument`
 * is the gate: an invoice missing a mandatory Article 59 field throws
 * `InvoiceNotRenderableError` here and no artefact is produced. That is the
 * intended outcome — issuing an incomplete tax invoice is the AED 2,500
 * failure, and refusing costs somebody five minutes.
 */
export async function materialiseInvoiceDocument(
  tx: TenantScopedTx,
  invoiceId: string,
): Promise<StoredDocument> {
  const detail = await getInvoiceDocument(tx, invoiceId);
  if (!detail) throw new Error("Invoice not found in this tenant");

  const existing = await tx
    .select({ key: schema.invoices.pdfStorageKey, sha: schema.invoices.pdfSha256 })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoiceId))
    .limit(1);

  const already = existing[0];
  if (already?.key && already.sha) {
    return {
      reference: detail.document.reference,
      storageKey: already.key,
      sha256: already.sha,
      rendered: false,
      substitutedCharacters: [],
    };
  }

  const document = await renderTaxDocument(detail.document, { variant: detail.variant });
  const key = documentStorageKey({
    tenantId: await tenantIdOf(tx, invoiceId, "invoice"),
    kind: detail.document.documentType === "tax_credit_note" ? "tax-credit-note" : "tax-invoice",
    year: (detail.document.issueDate ?? "0000").slice(0, 4),
    reference: detail.document.reference,
  });

  const sha256 = await store(key, document);

  // Guarded on the key still being null. Two operators opening the invoice at
  // the same moment would otherwise race, and the second write would hit the
  // write-once trigger from 0010 and fail an action that had done nothing
  // wrong. The guard turns that into a no-op.
  await tx
    .update(schema.invoices)
    .set({ pdfStorageKey: key, pdfSha256: sha256, pdfRenderedAt: new Date() })
    .where(and(eq(schema.invoices.id, invoiceId), isNull(schema.invoices.pdfStorageKey)));

  return {
    reference: detail.document.reference,
    storageKey: key,
    sha256,
    rendered: true,
    substitutedCharacters: document.substitutedCharacters,
  };
}

/**
 * The tenant a row belongs to.
 *
 * Read rather than taken from the caller's context on purpose. The key is a
 * storage path and it is the only thing separating one tenant's documents from
 * another's in the bucket; deriving it from the row that is actually being
 * rendered means a mismatched context cannot file a document under the wrong
 * tenant. The read is already inside the tenant boundary, so it returns nothing
 * for a row belonging to somebody else.
 */
async function tenantIdOf(
  tx: TenantScopedTx,
  id: string,
  kind: "invoice" | "quote" | "credit_note",
): Promise<string> {
  const rows =
    kind === "invoice"
      ? await tx
          .select({ tenantId: schema.invoices.tenantId })
          .from(schema.invoices)
          .where(eq(schema.invoices.id, id))
          .limit(1)
      : kind === "quote"
        ? await tx
            .select({ tenantId: schema.quotes.tenantId })
            .from(schema.quotes)
            .where(eq(schema.quotes.id, id))
            .limit(1)
        : await tx
            .select({ tenantId: schema.creditNotes.tenantId })
            .from(schema.creditNotes)
            .where(eq(schema.creditNotes.id, id))
            .limit(1);

  const tenantId = rows[0]?.tenantId;
  if (!tenantId) throw new Error("Document not found in this tenant");
  return tenantId;
}

/**
 * The tax credit note (`INV-7`).
 *
 * Its own query rather than a reuse of the invoice one: a credit note has its
 * own series, its own supplier snapshot and a mandatory reference to the
 * invoice it corrects (Article 60), and forcing it through a function shaped
 * for invoices would mean inventing values for the fields it does not have.
 *
 * It is rendered by the *same* template, from the same schema, discriminated by
 * `documentType`. That is the part that matters and it is preserved.
 */
export async function materialiseCreditNoteDocument(
  tx: TenantScopedTx,
  creditNoteId: string,
): Promise<StoredDocument> {
  const rows = await tx
    .select({
      id: schema.creditNotes.id,
      reference: schema.creditNotes.reference,
      invoiceReference: schema.invoices.reference,
      reason: schema.creditNotes.reason,
      reasonDetail: schema.creditNotes.reasonDetail,
      issuedOn: schema.creditNotes.issuedOn,
      supplyDate: schema.creditNotes.supplyDate,
      subtotal: schema.creditNotes.subtotal,
      discountAmount: schema.creditNotes.discountAmount,
      taxableAmount: schema.creditNotes.taxableAmount,
      taxRateBasisPoints: schema.creditNotes.taxRateBasisPoints,
      taxAmount: schema.creditNotes.taxAmount,
      total: schema.creditNotes.total,
      currency: schema.creditNotes.currency,
      sourceCurrency: schema.creditNotes.sourceCurrency,
      exchangeRate: schema.creditNotes.exchangeRate,
      supplierName: schema.creditNotes.supplierName,
      supplierTrn: schema.creditNotes.supplierTrn,
      supplierAddress: schema.creditNotes.supplierAddress,
      supplierLicenceNumber: schema.creditNotes.supplierLicenceNumber,
      supplierCrNumber: schema.creditNotes.supplierCrNumber,
      supplierPhone: schema.creditNotes.supplierPhone,
      supplierEmail: schema.creditNotes.supplierEmail,
      supplierCountry: schema.creditNotes.supplierCountry,
      recipientName: schema.creditNotes.recipientName,
      recipientTrn: schema.creditNotes.recipientTrn,
      recipientAddress: schema.creditNotes.recipientAddress,
      recipientCountry: schema.creditNotes.recipientCountry,
      pdfStorageKey: schema.creditNotes.pdfStorageKey,
      pdfSha256: schema.creditNotes.pdfSha256,
    })
    .from(schema.creditNotes)
    .innerJoin(schema.invoices, eq(schema.invoices.id, schema.creditNotes.invoiceId))
    .where(eq(schema.creditNotes.id, creditNoteId))
    .limit(1);

  const note = rows[0];
  if (!note) throw new Error("Credit note not found in this tenant");

  if (note.pdfStorageKey && note.pdfSha256) {
    return {
      reference: note.reference,
      storageKey: note.pdfStorageKey,
      sha256: note.pdfSha256,
      rendered: false,
      substitutedCharacters: [],
    };
  }

  const lineRows = await tx
    .select({
      position: schema.creditNoteLines.position,
      description: schema.creditNoteLines.description,
      quantity: schema.creditNoteLines.quantity,
      unit: schema.creditNoteLines.unit,
      unitCode: schema.creditNoteLines.unitCode,
      unitPrice: schema.creditNoteLines.unitPrice,
      lineTotal: schema.creditNoteLines.lineTotal,
      discountAmount: schema.creditNoteLines.discountAmount,
      netAmount: schema.creditNoteLines.netAmount,
      taxRateBasisPoints: schema.creditNoteLines.taxRateBasisPoints,
      taxAmount: schema.creditNoteLines.taxAmount,
      taxCategoryCode: schema.creditNoteLines.taxCategoryCode,
    })
    .from(schema.creditNoteLines)
    .where(eq(schema.creditNoteLines.creditNoteId, creditNoteId))
    .orderBy(schema.creditNoteLines.position);

  const document = await renderTaxDocument(
    {
      documentType: "tax_credit_note",
      reference: note.reference,
      issueDate: note.issuedOn ? dubaiDateKey(note.issuedOn) : null,
      supplyDate: note.supplyDate,
      dueDate: null,
      supplier: {
        name: note.supplierName,
        trn: note.supplierTrn,
        address: note.supplierAddress,
        country: note.supplierCountry,
        phone: note.supplierPhone,
        email: note.supplierEmail,
        licenceNumber: note.supplierLicenceNumber,
        crNumber: note.supplierCrNumber,
      },
      recipient: {
        name: note.recipientName,
        trn: note.recipientTrn,
        address: note.recipientAddress,
        country: note.recipientCountry,
      },
      currency: note.currency,
      sourceCurrency: note.sourceCurrency,
      exchangeRate: note.exchangeRate,
      lines: lineRows.map((l) => ({
        position: l.position,
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        unitCode: l.unitCode,
        unitPriceMinor: toMinor(l.unitPrice),
        lineTotalMinor: toMinor(l.lineTotal),
        discountMinor: toMinor(l.discountAmount),
        netMinor: toMinor(l.netAmount),
        taxRateBasisPoints: l.taxRateBasisPoints,
        taxMinor: toMinor(l.taxAmount),
        taxCategoryCode: l.taxCategoryCode,
      })),
      subtotalMinor: toMinor(note.subtotal),
      discountMinor: toMinor(note.discountAmount),
      taxableMinor: toMinor(note.taxableAmount),
      taxRateBasisPoints: note.taxRateBasisPoints,
      taxMinor: toMinor(note.taxAmount),
      totalMinor: toMinor(note.total),
      creditedInvoiceReference: note.invoiceReference,
      // Article 60 wants the cause on the face of the document. The detail is
      // preferred where an operator wrote one, because "Correction" alone
      // answers an auditor's question with a category rather than a reason.
      creditReason: note.reasonDetail?.trim() || CREDIT_REASON_TEXT[note.reason] || note.reason,
    },
    // The same variant as the invoice it corrects, decided by the same rule
    // (`defaultInvoiceVariant`) from the same recipient TRN.
    //
    // Forcing the full form here looks defensible — the recipient has to
    // reverse an input-tax claim, so give them everything — and it is wrong.
    // An unregistered recipient has no input tax to reverse and no address on
    // the invoice, so a full credit note would be refused by `assertRenderable`
    // for a missing recipient address. The document that cannot be produced is
    // the one correcting output tax already declared, and the deadline for
    // issuing it is fourteen days (`INV-7`).
    { variant: defaultInvoiceVariant(note.recipientTrn) },
  );

  const key = documentStorageKey({
    tenantId: await tenantIdOf(tx, creditNoteId, "credit_note"),
    kind: "tax-credit-note",
    year: (note.issuedOn ? dubaiDateKey(note.issuedOn) : "0000").slice(0, 4),
    reference: note.reference,
  });

  const sha256 = await store(key, document);

  await tx
    .update(schema.creditNotes)
    .set({ pdfStorageKey: key, pdfSha256: sha256, pdfRenderedAt: new Date() })
    .where(and(eq(schema.creditNotes.id, creditNoteId), isNull(schema.creditNotes.pdfStorageKey)));

  return {
    reference: note.reference,
    storageKey: key,
    sha256,
    rendered: true,
    substitutedCharacters: document.substitutedCharacters,
  };
}

/** Prose for the stored reason code, where nobody wrote a detail. */
const CREDIT_REASON_TEXT: Readonly<Record<string, string>> = {
  return: "Goods or services returned.",
  discount: "A discount agreed after the invoice was issued.",
  cancellation: "The supply was cancelled.",
  correction: "A correction to the original invoice.",
};

/**
 * The quotation (`QTE-3`).
 *
 * Unlike the tax documents, a quote carries no identity snapshot on its row —
 * it is a commercial offer, not a legal record of a taxable supply, and the
 * table has never held one. The supplier is therefore read from live
 * configuration at the moment of render, and then frozen by the act of storing
 * the artefact: the quote a customer accepted keeps showing the licence number
 * that was on it when they accepted, because those bytes are what is kept.
 */
export async function materialiseQuoteDocument(
  tx: TenantScopedTx,
  quoteId: string,
  options?: { acceptUrl?: string | null },
): Promise<StoredDocument> {
  const rows = await tx
    .select({
      id: schema.quotes.id,
      reference: schema.quotes.reference,
      title: schema.quotes.title,
      status: schema.quotes.status,
      subtotal: schema.quotes.subtotal,
      discountAmount: schema.quotes.discountAmount,
      taxRateBasisPoints: schema.quotes.taxRateBasisPoints,
      taxAmount: schema.quotes.taxAmount,
      total: schema.quotes.total,
      currency: schema.quotes.currency,
      validUntil: schema.quotes.validUntil,
      termsText: schema.quotes.termsText,
      notes: schema.quotes.notes,
      createdAt: schema.quotes.createdAt,
      sentAt: schema.quotes.sentAt,
      pdfStorageKey: schema.quotes.pdfStorageKey,
      pdfSha256: schema.quotes.pdfSha256,
      customerName: schema.customers.name,
      customerAddress: schema.customers.billingAddress,
    })
    .from(schema.quotes)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.quotes.customerId))
    .where(eq(schema.quotes.id, quoteId))
    .limit(1);

  const quote = rows[0];
  if (!quote) throw new Error("Quote not found in this tenant");

  if (quote.pdfStorageKey && quote.pdfSha256) {
    return {
      reference: quote.reference,
      storageKey: quote.pdfStorageKey,
      sha256: quote.pdfSha256,
      rendered: false,
      substitutedCharacters: [],
    };
  }

  const lineRows = await tx
    .select({
      position: schema.quoteLines.position,
      description: schema.quoteLines.description,
      quantity: schema.quoteLines.quantity,
      unit: schema.quoteLines.unit,
      unitPrice: schema.quoteLines.unitPrice,
      lineTotal: schema.quoteLines.lineTotal,
      isOptional: schema.quoteLines.isOptional,
    })
    .from(schema.quoteLines)
    .where(eq(schema.quoteLines.quoteId, quoteId))
    .orderBy(schema.quoteLines.position);

  // The issue date is when the quote went to the customer, falling back to when
  // it was drafted. It is also the PDF's pinned timestamp, so the same quote
  // always renders to the same bytes.
  const issueDate = dubaiDateKey(quote.sentAt ?? quote.createdAt);

  const subtotalMinor = toMinor(quote.subtotal);
  const discountMinor = toMinor(quote.discountAmount);

  const document = await renderQuoteDocument({
    reference: quote.reference,
    title: quote.title,
    issueDate,
    validUntil: quote.validUntil ? dubaiDateKey(quote.validUntil) : null,
    supplier: {
      name: company.legalName,
      trn: company.trn,
      // Assembled here rather than stored, and each part omitted when unset —
      // `company.ts`'s rule. A quote with no street line reads as incomplete;
      // one with a placeholder street line reads as a lie.
      address: [company.address.street, company.address.city, company.address.country]
        .filter(Boolean)
        .join(", "),
      country: company.address.countryCode,
      phone: company.phone,
      email: company.email,
      licenceNumber: company.licenceNumber,
      crNumber: company.crNumber,
    },
    recipient: {
      name: quote.customerName,
      trn: null,
      address: quote.customerAddress,
      country: "AE",
    },
    currency: quote.currency,
    lines: lineRows.map((l) => ({
      position: l.position,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unitPriceMinor: toMinor(l.unitPrice),
      lineTotalMinor: toMinor(l.lineTotal),
      isOptional: l.isOptional,
    })),
    subtotalMinor,
    discountMinor,
    taxableMinor: subtotalMinor - discountMinor,
    taxRateBasisPoints: quote.taxRateBasisPoints,
    taxMinor: toMinor(quote.taxAmount),
    totalMinor: toMinor(quote.total),
    termsText: quote.termsText,
    notes: quote.notes,
    acceptUrl: options?.acceptUrl ?? null,
  });

  const key = documentStorageKey({
    tenantId: await tenantIdOf(tx, quoteId, "quote"),
    kind: "quote",
    year: issueDate.slice(0, 4),
    reference: quote.reference,
  });

  const sha256 = await store(key, document);

  await tx
    .update(schema.quotes)
    .set({ pdfStorageKey: key, pdfSha256: sha256, pdfRenderedAt: new Date() })
    .where(and(eq(schema.quotes.id, quoteId), isNull(schema.quotes.pdfStorageKey)));

  return {
    reference: quote.reference,
    storageKey: key,
    sha256,
    rendered: true,
    substitutedCharacters: document.substitutedCharacters,
  };
}
