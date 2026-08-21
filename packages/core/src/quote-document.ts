/**
 * The quotation, as the document it becomes.
 *
 * `QTE-3`. The analogue of `invoice.ts` for the artefact that goes out *before*
 * the work — and deliberately not the same rules, because a quote and a tax
 * invoice fail in different directions.
 *
 * ── WHY THIS WARNS WHERE THE INVOICE REFUSES ────────────────────────────────
 *
 * `assertRenderable` in `invoice.ts` refuses to produce a tax invoice missing
 * a mandatory Article 59 field, because issuing an incomplete one is itself the
 * offence: AED 2,500 per document, and the correction needs a credit note and a
 * second document. Nothing equivalent is true of a quotation. There is no
 * statutory field set for a commercial offer, and a business that cannot quote
 * until its Commercial Register number has been typed into an environment
 * variable is a business that quotes on WhatsApp instead — which is the exact
 * outcome this system exists to replace.
 *
 * So the split is:
 *
 *  * **Refused** — the things that make the document *wrong*: lines that do not
 *    sum to the subtotal, VAT that was not computed on the discounted amount, a
 *    total that does not follow, no lines at all, no supplier name. A quote a
 *    customer can disprove with a calculator costs more credibility than a
 *    missing licence line ever will.
 *
 *  * **Reported, never blocked** — the identity fields `WEB-14` and Cabinet
 *    Resolution 107/2022 Art. 7 want on every document: trade licence,
 *    Commercial Register number, TRN, address. `quoteIdentityGaps()` lists
 *    them so an operator sees the gap, and the template omits each missing one
 *    entirely rather than printing a placeholder.
 *
 * That last part is the rule from `company.ts` and it is absolute here too: an
 * unset value renders as nothing. `DED-000000` on a quotation a customer keeps
 * on file is a false statement about a licence, which is a worse problem than
 * the licence line being absent.
 */

import { z } from "zod";
import { UserFacingError } from "./work";
import { TRN_PATTERN, isValidTrn } from "./invoice";

/** The heading. A quotation is not an invoice and must never read like one. */
export const QUOTE_TITLE = "Quotation";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates on a document are plain calendar dates, as YYYY-MM-DD");

const minorUnits = z
  .number()
  .int("Money is handled in integer minor units — a fractional fil is a bug, not a rounding");

const nonEmpty = (message: string) => z.string().trim().min(1, message);

export const quotePartySchema = z.object({
  name: nonEmpty("Name is required"),
  trn: z.string().regex(TRN_PATTERN, "A TRN is fifteen digits").nullable(),
  address: z.string().trim().min(1).nullable(),
  country: z.string().length(2),
  phone: z.string().trim().min(1).nullable().optional(),
  email: z.string().trim().min(1).nullable().optional(),
  licenceNumber: z.string().trim().min(1).nullable().optional(),
  crNumber: z.string().trim().min(1).nullable().optional(),
});

export const quoteDocumentLineSchema = z.object({
  position: z.number().int().positive(),
  description: nonEmpty("Every line needs a description of the work offered"),
  quantity: nonEmpty("Quantity is required on every line"),
  unit: nonEmpty("Unit is required on every line"),
  unitPriceMinor: minorUnits,
  lineTotalMinor: minorUnits,
  /**
   * An optional line is priced but excluded from the total until the customer
   * asks for it. It is marked on the face of the document because a customer
   * who reads a priced line and assumes it is included has been misled by the
   * layout, and that argument surfaces at invoicing.
   */
  isOptional: z.boolean(),
});

export type QuoteDocumentLine = z.infer<typeof quoteDocumentLineSchema>;
export type QuoteParty = z.infer<typeof quotePartySchema>;

export const quoteDocumentSchema = z
  .object({
    reference: nonEmpty("A quotation must carry its reference"),
    title: nonEmpty("A quotation needs a title"),
    issueDate: isoDate,
    /** The date the offer lapses. Null where none was set. */
    validUntil: isoDate.nullable(),

    supplier: quotePartySchema,
    recipient: quotePartySchema,

    currency: z.string().length(3),

    lines: z.array(quoteDocumentLineSchema).min(1, "A quotation needs at least one line"),

    subtotalMinor: minorUnits,
    discountMinor: minorUnits,
    /** Subtotal less discount. VAT is charged on this, not on the subtotal. */
    taxableMinor: minorUnits,
    taxRateBasisPoints: z.number().int().min(0),
    taxMinor: minorUnits,
    totalMinor: minorUnits,

    /** Scope, inclusions, exclusions and payment terms, as entered. */
    termsText: z.string().nullable(),
    notes: z.string().nullable(),

    /**
     * Where the customer accepts or declines (`POR-8`). Null when the quote is
     * still a draft and has no portal link yet — in which case the document
     * says nothing about accepting, rather than printing a dead URL.
     */
    acceptUrl: z.string().nullable(),
  })
  .superRefine((doc, ctx) => {
    // Only the non-optional lines count towards the money. Including an
    // optional line in the subtotal is the specific error that produces a
    // quotation whose total is higher than the work the customer thinks they
    // asked for, and it is not discovered until they refuse to pay the invoice.
    const lineSum = doc.lines
      .filter((l) => !l.isOptional)
      .reduce((sum, l) => sum + l.lineTotalMinor, 0);

    if (lineSum !== doc.subtotalMinor) {
      ctx.addIssue({
        code: "custom",
        path: ["subtotalMinor"],
        message: `Included lines sum to ${lineSum} minor units but the subtotal says ${doc.subtotalMinor}`,
      });
    }

    if (doc.taxableMinor !== doc.subtotalMinor - doc.discountMinor) {
      ctx.addIssue({
        code: "custom",
        path: ["taxableMinor"],
        message: "The taxable amount must be the subtotal less the discount",
      });
    }

    // The rule this asserts is the one the whole money layer exists to hold:
    // VAT is due on what the customer actually pays. Recomputing it here rather
    // than trusting the stored figure is cheap, and the failure it catches —
    // VAT charged on the pre-discount price — overstates the customer's bill in
    // a way they will notice.
    const expectedTax = Math.round((doc.taxableMinor * doc.taxRateBasisPoints) / 10_000);
    if (doc.taxMinor !== expectedTax) {
      ctx.addIssue({
        code: "custom",
        path: ["taxMinor"],
        message:
          `VAT on ${doc.taxableMinor} minor units at ${doc.taxRateBasisPoints} basis points is ` +
          `${expectedTax}, but the quote says ${doc.taxMinor}. VAT is charged after the discount.`,
      });
    }

    if (doc.totalMinor !== doc.taxableMinor + doc.taxMinor) {
      ctx.addIssue({
        code: "custom",
        path: ["totalMinor"],
        message: "The total must be the taxable amount plus the VAT",
      });
    }

    if (doc.discountMinor < 0 || doc.discountMinor > doc.subtotalMinor) {
      ctx.addIssue({
        code: "custom",
        path: ["discountMinor"],
        message: "A discount cannot be negative or larger than the subtotal",
      });
    }
  });

export type QuoteDocument = z.infer<typeof quoteDocumentSchema>;

export class QuoteNotRenderableError extends UserFacingError {
  constructor(
    readonly reference: string,
    readonly problems: readonly string[],
  ) {
    super(
      `${reference || "This quotation"} cannot be rendered: ${problems.join("; ")}.`,
    );
    this.name = "QuoteNotRenderableError";
  }
}

/**
 * Validate a quotation for rendering, or refuse with every reason at once.
 *
 * Every reason at once, for the same reason `assertRenderable` does it:
 * reporting one fault at a time turns a five-minute correction into an
 * afternoon, and that is how people learn to route around the tool.
 */
export function assertQuoteRenderable(input: unknown): QuoteDocument {
  const parsed = quoteDocumentSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  const reference =
    typeof input === "object" && input !== null && "reference" in input
      ? String((input as { reference: unknown }).reference ?? "")
      : "";

  throw new QuoteNotRenderableError(
    reference,
    parsed.error.issues.map((i) =>
      i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message,
    ),
  );
}

/**
 * Identity fields the law wants on every document but which do not stop this
 * one being produced.
 *
 * Surfaced to an operator; never thrown. Each entry names the environment
 * variable, because "the licence number is missing" sends somebody looking
 * through the admin screen and "COMPANY_CR_NUMBER is not set" does not.
 */
export function quoteIdentityGaps(doc: {
  supplier: {
    trn: string | null;
    address: string | null;
    licenceNumber?: string | null;
    crNumber?: string | null;
  };
}): readonly string[] {
  const gaps: string[] = [];

  if (!doc.supplier.licenceNumber) {
    gaps.push("the trade licence number is not configured (COMPANY_LICENCE_NUMBER)");
  }
  if (!doc.supplier.crNumber) {
    gaps.push(
      "the Commercial Register number is not configured (COMPANY_CR_NUMBER) — " +
        "Cabinet Resolution 107/2022 Art. 7 requires it on all documents",
    );
  }
  if (!isValidTrn(doc.supplier.trn)) {
    gaps.push(
      "the supplier TRN is not configured (COMPANY_TRN) — the quote will show a VAT line with no registration behind it (OPEN-7)",
    );
  }
  if (!doc.supplier.address) {
    gaps.push("the supplier address is not configured (COMPANY_ADDRESS_STREET)");
  }

  return gaps;
}
