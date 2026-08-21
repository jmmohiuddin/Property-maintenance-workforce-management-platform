/**
 * The UAE tax invoice.
 *
 * `INV-3`, `INV-5`, `INV-6`, `INV-9`. This module is the mechanism behind the
 * first line of TRD §10: *a zod schema on the invoice document model; render
 * refuses on a missing mandatory field.* The failure it prevents is the one
 * that is only ever discovered late — non-compliant invoices issued for months,
 * found by an auditor rather than by a test, at AED 2,500 each.
 *
 * ── WHY REFUSAL RATHER THAN A WARNING ───────────────────────────────────────
 *
 * Almost everything else in this system warns. Three things block, and each has
 * a named statutory penalty behind it (TRD §10). This is the fourth kind: not a
 * block on an operator's action, but a refusal to *produce an artefact* that
 * would be wrong. A half-complete tax invoice is worse than no invoice, because
 * once it is emailed it exists, it is in the customer's accounting system, and
 * correcting it needs a credit note and a second document. Refusing to render
 * costs somebody five minutes. Rendering costs a correction cycle and, at
 * audit, a penalty per document.
 *
 * ── WHY SIMPLIFIED IS A VARIANT AND NOT A SECOND DOCUMENT ───────────────────
 *
 * `INV-6` permits a simplified tax invoice where the recipient is not
 * VAT-registered, or is registered and the consideration does not exceed
 * AED 10,000. That route is abolished when e-invoicing applies on 1 July 2027.
 *
 * So it is a *rendering variant of one object*: the same row, the same totals,
 * the same validation, printed with a smaller field set. Modelling it as a
 * second document type would leave a dead discriminator on every historical row
 * and a second code path to delete under deadline pressure in 2027 — and the
 * variant that gets deleted is always the one somebody is still using.
 *
 * ── WHY PINT AE FIELDS ARE VALIDATED NOW ────────────────────────────────────
 *
 * PINT AE (Peppol International Invoice on UBL 2.1) defines roughly 51
 * mandatory fields, and transmission is not required until July 2027. They are
 * checked now anyway, at warning strength rather than refusal strength, because
 * the alternative is discovering in 2027 that eighteen months of invoices are
 * missing a field that cannot be reconstructed — nobody recorded the exchange
 * rate that applied on a date of supply two years ago, and nobody can.
 */

import { z } from "zod";
import { UserFacingError } from "./work";
import { computeTotals, lineTotalMinor, type DocumentTotals, type LineInput } from "./money";

// ── The constants the law fixes ──────────────────────────────────────────────

/** The words Article 59 requires on the face of the document. Not a subtitle. */
export const TAX_INVOICE_TITLE = "Tax Invoice";
export const TAX_CREDIT_NOTE_TITLE = "Tax Credit Note";

/**
 * AED 10,000, in fils.
 *
 * The ceiling below which a simplified invoice is permitted to a VAT-registered
 * recipient. Written in minor units because every comparison against it is made
 * against a total in minor units, and a constant that has to be converted at
 * each use is a constant that will eventually be compared against the wrong
 * scale.
 */
export const SIMPLIFIED_INVOICE_CEILING_MINOR = 1_000_000;

/** A tax invoice must be issued within 14 days of the date of supply. */
export const ISSUANCE_WINDOW_DAYS = 14;

/**
 * The day the alert fires, not the day the deadline falls.
 *
 * Four days of margin, because raising an invoice needs a person who may be on
 * leave, and an alert that arrives on day 14 has already failed.
 */
export const ISSUANCE_ALERT_DAYS = 10;

/**
 * Stated as a number on purpose.
 *
 * "A compliance risk" changes nobody's Tuesday. "AED 2,500 per invoice, and
 * there are three of them" does. The design system requires compliance messages
 * to name the penalty, and this is the string that lets them.
 */
export const LATE_ISSUANCE_PENALTY =
  "Failure to issue a tax invoice within 14 days carries an AED 2,500 administrative penalty, per invoice.";

/** A TRN is fifteen digits. That is the entire format. */
export const TRN_PATTERN = /^[0-9]{15}$/;

export function isValidTrn(value: string | null | undefined): boolean {
  return typeof value === "string" && TRN_PATTERN.test(value);
}

/**
 * UN/ECE Recommendation 20 unit codes, keyed by the units this catalogue uses.
 *
 * PINT AE will not accept "m2" or "ea"; it wants `MTK` and `H87`. The
 * human-readable unit stays on the line because that is what the customer
 * reads — this is what the accredited service provider reads. Mapping now,
 * while somebody still knows what "visit" meant, is much cheaper than mapping
 * eighteen months of historical lines in 2027.
 */
export const UNIT_CODE: Readonly<Record<string, string>> = {
  ea: "H87", // piece
  each: "H87",
  item: "H87",
  visit: "H87",
  job: "H87",
  unit: "H87",
  hr: "HUR",
  hour: "HUR",
  hours: "HUR",
  h: "HUR",
  day: "DAY",
  days: "DAY",
  month: "MON",
  m: "MTR",
  m2: "MTK",
  sqm: "MTK",
  m3: "MTQ",
  kg: "KGM",
  l: "LTR",
  lot: "LO",
  set: "SET",
  pack: "PK",
};

/**
 * The PINT AE code for a unit, or null when there is no honest mapping.
 *
 * Null rather than a fallback of `H87`. Guessing "piece" for a unit nobody
 * mapped produces a document that passes validation and states something
 * untrue about the quantity, which is the failure this whole module exists to
 * avoid. A null shows up in the readiness check and gets a real answer.
 */
export function unitCodeFor(unit: string): string | null {
  return UNIT_CODE[unit.trim().toLowerCase()] ?? null;
}

// ── Exact apportionment of a document-level discount and its VAT ─────────────

export interface ApportionedLine {
  /** quantity x unit price, before any share of the document discount. */
  readonly lineTotalMinor: number;
  /** This line's share of the document-level discount. */
  readonly discountMinor: number;
  /** Tax-exclusive amount after that share. */
  readonly netMinor: number;
  /** Article 59 requires this per line, in AED. */
  readonly taxMinor: number;
}

/**
 * Split an integer amount across weights so the parts sum to it exactly.
 *
 * Largest-remainder, with the leftover fils going to the lines with the largest
 * fractional claim and ties broken by position so the result is deterministic.
 * Rounding each line independently would leave the sum of the lines a fil or
 * two away from the document total — and an invoice whose lines do not add up
 * to its total is one an accountant refuses, correctly.
 *
 * The arithmetic is integer throughout: `Math.floor((amount * w) / total)` with
 * an integer remainder, rather than flooring a float that may sit at
 * `49.999999999999996` when the true value is 50.
 */
function allocate(amountMinor: number, weights: readonly number[]): number[] {
  const out = weights.map(() => 0);
  if (out.length === 0 || amountMinor === 0) return out;

  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight <= 0) {
    // Nothing to weigh by — a document of entirely zero-valued lines with a
    // discount on it. Put the whole amount on the first line rather than
    // dropping it, so the parts still sum to the total.
    out[0] = amountMinor;
    return out;
  }

  const remainders: { index: number; remainder: number }[] = [];
  let allocated = 0;

  for (let i = 0; i < weights.length; i++) {
    const numerator = amountMinor * (weights[i] ?? 0);
    const share = Math.floor(numerator / totalWeight);
    out[i] = share;
    allocated += share;
    remainders.push({ index: i, remainder: numerator - share * totalWeight });
  }

  remainders.sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  let leftover = amountMinor - allocated;
  for (let k = 0; k < remainders.length && leftover > 0; k++) {
    const slot = remainders[k];
    if (!slot) continue;
    out[slot.index] = (out[slot.index] ?? 0) + 1;
    leftover--;
  }

  return out;
}

/**
 * Per-line net and tax amounts that sum exactly to the document totals.
 *
 * `computeTotals` gives the document numbers and stays the single source of
 * truth for them — this function does not recompute the total, it distributes
 * it. VAT is applied after the discount here for the same reason it is there:
 * VAT is due on what the customer actually pays.
 *
 * The invariants, which the tests assert to the fil:
 *   sum(lineTotal)  === subtotal
 *   sum(discount)   === document discount
 *   sum(net)        === subtotal - discount
 *   sum(tax)        === document tax
 */
export function apportionLines(input: {
  lines: readonly LineInput[];
  discountMinor?: number | undefined;
  taxRateBasisPoints: number;
}): { readonly lines: readonly ApportionedLine[]; readonly totals: DocumentTotals } {
  const totals = computeTotals({
    lines: input.lines,
    discountMinor: input.discountMinor ?? 0,
    taxRateBasisPoints: input.taxRateBasisPoints,
  });

  const lineTotals = input.lines.map((l) => lineTotalMinor(l));
  const discounts = allocate(totals.discountMinor, lineTotals);
  const nets = lineTotals.map((t, i) => t - (discounts[i] ?? 0));
  const taxes = allocate(totals.taxMinor, nets);

  return {
    lines: lineTotals.map((lineTotal, i) => ({
      lineTotalMinor: lineTotal,
      discountMinor: discounts[i] ?? 0,
      netMinor: nets[i] ?? 0,
      taxMinor: taxes[i] ?? 0,
    })),
    totals,
  };
}

// ── Full versus simplified (INV-6) ───────────────────────────────────────────

export type InvoiceVariant = "full" | "simplified";

/**
 * Is a simplified invoice permitted for this recipient and this amount?
 *
 * The rule, exactly as `INV-6` states it: permitted where the recipient is not
 * VAT-registered, **or** the recipient is registered and the consideration does
 * not exceed AED 10,000.
 */
export function simplifiedInvoicePermitted(input: {
  recipientTrn: string | null;
  totalMinor: number;
}): boolean {
  if (!isValidTrn(input.recipientTrn)) return true;
  return input.totalMinor <= SIMPLIFIED_INVOICE_CEILING_MINOR;
}

/**
 * Which variant to render when nobody has chosen.
 *
 * A VAT-registered recipient gets the full invoice even where the simplified
 * one would be permitted, and the reason is commercial rather than legal: the
 * recipient recovers input tax against it, and a simplified invoice does not
 * carry their TRN. Sending a registered customer a document they cannot use is
 * a phone call and a reissue.
 *
 * Simplified is therefore what an unregistered recipient gets — the villa
 * owner, the individual — where there is no TRN to print and the fuller
 * document buys nobody anything.
 */
export function defaultInvoiceVariant(recipientTrn: string | null): InvoiceVariant {
  return isValidTrn(recipientTrn) ? "full" : "simplified";
}

/** Why the chosen variant is the right one, for the compliance panel. */
export function variantRationale(input: {
  variant: InvoiceVariant;
  recipientTrn: string | null;
  totalMinor: number;
}): string {
  if (input.variant === "full") {
    return isValidTrn(input.recipientTrn)
      ? "Full tax invoice — the recipient is VAT-registered and recovers input tax against it."
      : "Full tax invoice — the recipient is not VAT-registered, so no recipient TRN is shown.";
  }
  return isValidTrn(input.recipientTrn)
    ? "Simplified tax invoice — permitted because the consideration does not exceed AED 10,000. This route is abolished when e-invoicing applies on 1 July 2027."
    : "Simplified tax invoice — permitted because the recipient is not VAT-registered. This route is abolished when e-invoicing applies on 1 July 2027.";
}

// ── The document model ───────────────────────────────────────────────────────

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates on a document are plain calendar dates, as YYYY-MM-DD");

const minorUnits = z
  .number()
  .int("Money is handled in integer minor units — a fractional fil is a bug, not a rounding");

const nonEmpty = (message: string) => z.string().trim().min(1, message);

export const documentPartySchema = z.object({
  name: nonEmpty("Name is required"),
  /** Null is legitimate for a recipient who is not registered. */
  trn: z.string().regex(TRN_PATTERN, "A TRN is fifteen digits").nullable(),
  address: z.string().trim().min(1).nullable(),
  /** ISO 3166-1 alpha-2. PINT AE requires the country on both parties. */
  country: z.string().length(2),
  phone: z.string().trim().min(1).nullable().optional(),
  email: z.string().trim().min(1).nullable().optional(),
  /** Supplier only: DET licence and Commercial Register, required on every
   *  document by Cabinet Resolution 107/2022 Art. 7 and `WEB-14`. */
  licenceNumber: z.string().trim().min(1).nullable().optional(),
  crNumber: z.string().trim().min(1).nullable().optional(),
});

export const documentLineSchema = z.object({
  position: z.number().int().positive(),
  description: nonEmpty("Every line needs a description of the service supplied"),
  /** Decimal string — quantities carry three decimals (m², hours). */
  quantity: nonEmpty("Quantity is required on every line"),
  unit: nonEmpty("Unit is required on every line"),
  /** Null until somebody maps this unit. Warned on, not refused — see §PINT. */
  unitCode: z.string().min(1).nullable(),
  unitPriceMinor: minorUnits,
  lineTotalMinor: minorUnits,
  discountMinor: minorUnits,
  netMinor: minorUnits,
  taxRateBasisPoints: z.number().int().min(0),
  taxMinor: minorUnits,
  taxCategoryCode: nonEmpty("Tax category is required"),
  jobReference: z.string().nullable().optional(),
});

export type DocumentLine = z.infer<typeof documentLineSchema>;
export type DocumentParty = z.infer<typeof documentPartySchema>;

/**
 * Everything that appears on a tax invoice or a tax credit note.
 *
 * One schema for both, discriminated by `documentType`, because they carry the
 * same Article 59 field set and differ only in their title, their series and
 * the credit note's mandatory reference to the invoice it corrects. Two schemas
 * would be two places to add a field PINT AE turns out to require.
 */
export const taxDocumentSchema = z
  .object({
    documentType: z.enum(["tax_invoice", "tax_credit_note"]),
    reference: nonEmpty("A tax invoice must carry its sequential number"),
    issueDate: isoDate,
    /** Article 59 requires this alongside the issue date where they differ. */
    supplyDate: isoDate,
    dueDate: isoDate.nullable().optional(),

    supplier: documentPartySchema,
    recipient: documentPartySchema,

    currency: z.string().length(3),
    /** Both or neither: half of an exchange-rate disclosure reads as an omission. */
    sourceCurrency: z.string().length(3).nullable(),
    exchangeRate: z.string().min(1).nullable(),

    lines: z.array(documentLineSchema).min(1, "A tax invoice needs at least one line"),

    subtotalMinor: minorUnits,
    discountMinor: minorUnits,
    taxableMinor: minorUnits,
    taxRateBasisPoints: z.number().int().min(0),
    taxMinor: minorUnits,
    totalMinor: minorUnits,

    /** Credit notes only. Article 60 requires the reference to the original. */
    creditedInvoiceReference: z.string().nullable().optional(),
    creditReason: z.string().nullable().optional(),
  })
  .superRefine((doc, ctx) => {
    // The arithmetic is checked, not trusted. These totals are stored on the
    // row and could have been written by any code path; a document whose lines
    // do not add up to its total is one a customer disputes and an auditor
    // flags, and the cheapest place to catch it is before it is a PDF.
    const lineSum = doc.lines.reduce((s, l) => s + l.lineTotalMinor, 0);
    if (lineSum !== doc.subtotalMinor) {
      ctx.addIssue({
        code: "custom",
        path: ["subtotalMinor"],
        message: `Lines sum to ${lineSum} minor units but the subtotal says ${doc.subtotalMinor}`,
      });
    }

    if (doc.taxableMinor !== doc.subtotalMinor - doc.discountMinor) {
      ctx.addIssue({
        code: "custom",
        path: ["taxableMinor"],
        message: "The taxable amount must be the subtotal less the discount — VAT is due on what the customer pays",
      });
    }

    const lineTax = doc.lines.reduce((s, l) => s + l.taxMinor, 0);
    if (lineTax !== doc.taxMinor) {
      ctx.addIssue({
        code: "custom",
        path: ["taxMinor"],
        message: `Per-line tax sums to ${lineTax} minor units but the document tax says ${doc.taxMinor}`,
      });
    }

    if (doc.totalMinor !== doc.taxableMinor + doc.taxMinor) {
      ctx.addIssue({
        code: "custom",
        path: ["totalMinor"],
        message: "The total must be the taxable amount plus the tax",
      });
    }

    if ((doc.sourceCurrency === null) !== (doc.exchangeRate === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["exchangeRate"],
        message:
          "Article 59 requires the exchange rate where an amount originates in another currency — give both the currency and the rate, or neither",
      });
    }

    if (doc.documentType === "tax_credit_note") {
      if (!doc.creditedInvoiceReference) {
        ctx.addIssue({
          code: "custom",
          path: ["creditedInvoiceReference"],
          message: "A tax credit note must reference the invoice it corrects",
        });
      }
      if (!doc.creditReason) {
        ctx.addIssue({
          code: "custom",
          path: ["creditReason"],
          message: "A tax credit note must record why output tax was reduced",
        });
      }
    }
  });

export type TaxDocument = z.infer<typeof taxDocumentSchema>;

/** The title that must appear on the face of the document. */
export function documentTitle(documentType: TaxDocument["documentType"]): string {
  return documentType === "tax_credit_note" ? TAX_CREDIT_NOTE_TITLE : TAX_INVOICE_TITLE;
}

/**
 * The same document before anything has been proved about it.
 *
 * The database hands back a row whose Article 59 fields may be null — an
 * invoice raised before this module existed, or one whose supplier TRN was
 * never configured. `assertRenderable` refuses those; the compliance panel has
 * to *show* them, which it cannot do from a type that insists they are present.
 *
 * So the draft is the wide type and `TaxDocument` is what survives validation.
 * A parsed document is assignable to a draft, which is what lets one checklist
 * function serve both the screen and the renderer.
 */
export interface TaxDocumentDraft {
  readonly documentType: "tax_invoice" | "tax_credit_note";
  readonly reference: string;
  readonly issueDate: string | null;
  readonly supplyDate: string | null;
  readonly dueDate?: string | null;
  readonly supplier: {
    readonly name: string | null;
    readonly trn: string | null;
    readonly address: string | null;
    readonly country: string;
    readonly phone?: string | null;
    readonly email?: string | null;
    readonly licenceNumber?: string | null;
    readonly crNumber?: string | null;
  };
  readonly recipient: {
    readonly name: string | null;
    readonly trn: string | null;
    readonly address: string | null;
    readonly country: string;
  };
  readonly currency: string;
  readonly sourceCurrency: string | null;
  readonly exchangeRate: string | null;
  readonly lines: readonly {
    readonly position: number;
    readonly description: string;
    readonly quantity: string;
    readonly unit: string;
    readonly unitCode: string | null;
    readonly unitPriceMinor: number;
    readonly lineTotalMinor: number;
    readonly discountMinor: number | null;
    readonly netMinor: number | null;
    readonly taxRateBasisPoints: number | null;
    readonly taxMinor: number | null;
    readonly taxCategoryCode: string;
    readonly jobReference?: string | null;
  }[];
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly taxableMinor: number;
  readonly taxRateBasisPoints: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly creditedInvoiceReference?: string | null;
  readonly creditReason?: string | null;
}

// ── The refusal ──────────────────────────────────────────────────────────────

export class InvoiceNotRenderableError extends UserFacingError {
  constructor(
    readonly reference: string,
    readonly problems: readonly string[],
  ) {
    super(
      `${reference || "This document"} cannot be rendered as a tax invoice: ` +
        `${problems.join("; ")}. ` +
        `Issuing an incomplete tax invoice is an Article 59 failure carrying AED 2,500 per document.`,
    );
    this.name = "InvoiceNotRenderableError";
  }
}

/**
 * Fields the *variant* makes mandatory, on top of the structural schema.
 *
 * A full invoice must identify the recipient and, where they are registered,
 * carry their TRN — that is what lets them recover input tax. A simplified
 * invoice's field set is shorter by design (`INV-6`): the words "Tax Invoice",
 * the supplier's name, address and TRN, the date of issue, a description, the
 * total consideration and the tax amount. Requiring the recipient's address on
 * a walk-in villa job would make the simplified route unusable, which is the
 * opposite of what it is for.
 */
function variantProblems(doc: TaxDocument, variant: InvoiceVariant): string[] {
  const problems: string[] = [];

  // Required on both variants. Without the supplier's TRN the document is not a
  // tax invoice at all — it is a request for payment.
  if (!isValidTrn(doc.supplier.trn)) {
    problems.push("the supplier's 15-digit TRN is not configured (COMPANY_TRN — see OPEN-7)");
  }
  if (!doc.supplier.address) {
    problems.push("the supplier's address is not configured (COMPANY_ADDRESS_STREET)");
  }

  if (variant === "full") {
    if (!doc.recipient.name) problems.push("the recipient's name is missing");
    if (!doc.recipient.address) problems.push("the recipient's address is missing");
    // Not "the TRN is missing": an unregistered recipient legitimately has
    // none, and Article 59 asks for it only where the recipient is registered.
    if (doc.recipient.trn !== null && !isValidTrn(doc.recipient.trn)) {
      problems.push("the recipient's TRN is not fifteen digits");
    }
  }

  // Per-line tax amounts are not checked here: the structural schema already
  // refuses a line whose `taxMinor` is null, which is what a pre-0007 invoice
  // line maps to. Repeating it would report the same fault twice.

  if (
    variant === "simplified" &&
    !simplifiedInvoicePermitted({ recipientTrn: doc.recipient.trn, totalMinor: doc.totalMinor })
  ) {
    problems.push(
      "a simplified invoice is not permitted here: the recipient is VAT-registered and the consideration exceeds AED 10,000",
    );
  }

  return problems;
}

export interface RenderableDocument {
  readonly document: TaxDocument;
  readonly variant: InvoiceVariant;
  readonly title: string;
}

/**
 * Validate a document for rendering, or refuse with every reason at once.
 *
 * Every reason at once matters. Reporting the first missing field means the
 * operator fixes it, re-renders, and is told about the second — which is how a
 * five-minute correction becomes an afternoon and how people learn to route
 * around the tool.
 */
export function assertRenderable(
  input: unknown,
  options?: { variant?: InvoiceVariant },
): RenderableDocument {
  const parsed = taxDocumentSchema.safeParse(input);

  if (!parsed.success) {
    const reference =
      typeof input === "object" && input !== null && "reference" in input
        ? String((input as { reference: unknown }).reference ?? "")
        : "";
    const problems = parsed.error.issues.map((i) =>
      i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message,
    );
    throw new InvoiceNotRenderableError(reference, problems);
  }

  const doc = parsed.data;
  const variant = options?.variant ?? defaultInvoiceVariant(doc.recipient.trn);
  const problems = variantProblems(doc, variant);
  if (problems.length > 0) throw new InvoiceNotRenderableError(doc.reference, problems);

  return { document: doc, variant, title: documentTitle(doc.documentType) };
}

/** Non-throwing form, for a screen that wants to show what is wrong. */
export function renderableProblems(
  input: unknown,
  options?: { variant?: InvoiceVariant },
): readonly string[] {
  try {
    assertRenderable(input, options);
    return [];
  } catch (error) {
    return error instanceof InvoiceNotRenderableError ? error.problems : ["unexpected validation failure"];
  }
}

// ── The 14-day issuance clock (INV-5) ────────────────────────────────────────

export type IssuanceState = "within_window" | "approaching" | "breached";

export interface IssuanceClock {
  readonly daysSinceSupply: number;
  readonly daysRemaining: number;
  /** ISO date. The last day an invoice may lawfully be issued. */
  readonly deadline: string;
  readonly state: IssuanceState;
  readonly penalty: string | null;
}

/** Whole days between two plain calendar dates. No timezone, no partial day. */
export function daysBetweenDates(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function addDaysToDate(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Where a supply sits against the 14-day rule.
 *
 * `asOf` is the date the invoice was issued, or today for one that has not
 * been. Day counting is done on plain calendar dates rather than by
 * subtracting timestamps: a supply at 18:00 and a check at 09:00 fourteen
 * days later is fourteen days late, not thirteen and a bit, and flooring a
 * millisecond difference is how an alert quietly fires a day after it mattered.
 */
export function issuanceClock(supplyDate: string, asOf: string): IssuanceClock {
  const daysSinceSupply = daysBetweenDates(supplyDate, asOf);
  const deadline = addDaysToDate(supplyDate, ISSUANCE_WINDOW_DAYS);
  const daysRemaining = ISSUANCE_WINDOW_DAYS - daysSinceSupply;

  const state: IssuanceState =
    daysSinceSupply > ISSUANCE_WINDOW_DAYS
      ? "breached"
      : daysSinceSupply >= ISSUANCE_ALERT_DAYS
        ? "approaching"
        : "within_window";

  return {
    daysSinceSupply,
    daysRemaining,
    deadline,
    state,
    penalty: state === "within_window" ? null : LATE_ISSUANCE_PENALTY,
  };
}

// ── The compliance checklist the invoice screen shows (wireframes §7.1) ──────

export type ChecklistState = "ok" | "missing" | "pending";

export interface ChecklistItem {
  readonly key: string;
  readonly label: string;
  readonly state: ChecklistState;
  /** One line of why, shown under the label when it is not simply satisfied. */
  readonly detail: string | null;
}

/**
 * Every Article 59 obligation, shown as met or not met.
 *
 * This is the same field set `assertRenderable` refuses on, rendered as a list
 * rather than thrown as an error. The screen is where somebody notices that the
 * company TRN was never configured — before a customer does.
 *
 * `pending` is a third state and it is not a failure: PINT AE readiness is
 * genuinely not required until 1 July 2027, and colouring it red would train
 * people to ignore the red items that are.
 */
export function complianceChecklist(
  doc: TaxDocumentDraft,
  context: {
    variant: InvoiceVariant;
    /** From the gap report. `null` when it has not been run. */
    sequenceGapBefore?: boolean | null;
    /** Today, or the issue date for an issued document. ISO date. */
    asOf: string;
  },
): readonly ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const push = (key: string, label: string, ok: boolean, detail: string | null = null): void => {
    items.push({ key, label, state: ok ? "ok" : "missing", detail: ok ? null : detail });
  };

  push("title", `"${documentTitle(doc.documentType)}" shown on the document`, true);

  push(
    "supplier_trn",
    "Supplier TRN",
    isValidTrn(doc.supplier.trn),
    "COMPANY_TRN is not set. Without it this document is a request for payment, not a tax invoice.",
  );

  push(
    "supplier_address",
    "Supplier name and address",
    Boolean(doc.supplier.name && doc.supplier.address),
    "COMPANY_ADDRESS_STREET is not set.",
  );

  if (context.variant === "full") {
    push(
      "recipient",
      "Recipient name, address and TRN",
      Boolean(doc.recipient.name && doc.recipient.address),
      "A full tax invoice must identify the recipient.",
    );
  } else {
    items.push({
      key: "recipient",
      label: "Recipient details not required",
      state: "ok",
      detail: variantRationale({
        variant: "simplified",
        recipientTrn: doc.recipient.trn,
        totalMinor: doc.totalMinor,
      }),
    });
  }

  const gapKnown = context.sequenceGapBefore !== null && context.sequenceGapBefore !== undefined;
  items.push({
    key: "sequence",
    label: "Sequential number, no gap",
    state: !gapKnown ? "pending" : context.sequenceGapBefore ? "missing" : "ok",
    detail: !gapKnown
      ? "Gap report has not been run for this series."
      : context.sequenceGapBefore
        ? "There is a gap in the issued series before this number. Gaps are an FTA audit flag."
        : null,
  });

  push(
    "dates",
    "Issue date and date of supply",
    Boolean(doc.issueDate && doc.supplyDate),
    "The date of supply was never recorded, so the 14-day clock cannot be evidenced.",
  );

  const linesPriced = doc.lines.every(
    (l) => Number.isInteger(l.taxMinor) && Number.isInteger(l.netMinor),
  );
  push(
    "line_amounts",
    "Per-line quantity, unit price, tax rate and tax amount in AED",
    linesPriced,
    "One or more lines predate per-line tax capture and cannot be rendered as a tax invoice.",
  );

  push(
    "licence",
    "Trade licence and Commercial Register number",
    Boolean(doc.supplier.licenceNumber && doc.supplier.crNumber),
    doc.supplier.licenceNumber
      ? "COMPANY_CR_NUMBER is not set. Cabinet Resolution 107/2022 Art. 7 requires it on all documents."
      : "The trade licence number is not configured.",
  );

  // The window is measured against the date of supply, so a document without
  // one fails this check rather than silently passing it. An invoice that
  // cannot evidence when the supply happened cannot evidence that it was issued
  // in time either, and that is the AED 2,500 question.
  const clock = doc.supplyDate ? issuanceClock(doc.supplyDate, doc.issueDate ?? context.asOf) : null;

  if (clock === null) {
    items.push({
      key: "issuance_window",
      label: "14-day issuance window",
      state: "missing",
      detail: `No date of supply was recorded, so there is nothing to measure the window against. ${LATE_ISSUANCE_PENALTY}`,
    });
  } else {
    items.push({
      key: "issuance_window",
      label:
        clock.daysSinceSupply === 0
          ? "Issued on the date of supply"
          : `Issued ${clock.daysSinceSupply} day${clock.daysSinceSupply === 1 ? "" : "s"} after supply`,
      state: clock.state === "breached" ? "missing" : "ok",
      detail:
        clock.state === "breached"
          ? `The 14-day limit was exceeded. ${LATE_ISSUANCE_PENALTY}`
          : `14-day limit — INV-5. Deadline ${clock.deadline}.`,
    });
  }

  // Deliberately never reads as "ready". This checks seven fields; PINT AE has
  // roughly fifty mandatory ones and the full list has not been reconciled
  // against the specification. Telling an accountant a document is
  // transmissible on the strength of seven fields would be an unevidenced
  // claim on a compliance screen — the same failure mode as the marketing
  // statistics this branch removed, in the place it would do most damage.
  const pintGaps = pintAeKnownFieldGaps(doc);
  items.push({
    key: "pint_ae",
    label: "E-invoicing fields (partial check)",
    state: "pending",
    detail:
      pintGaps.length === 0
        ? "The e-invoicing fields modelled so far are populated. This is NOT a full PINT AE " +
          "conformance check — the complete mandatory field set has not been reconciled against " +
          "the specification, and only the chosen Accredited Service Provider's validator can " +
          "confirm transmissibility. Required from 1 July 2027 (INV-9, INV-10)."
        : `Missing from the fields modelled so far: ${pintGaps.join("; ")}. ` +
          "Not a full PINT AE conformance check.",
  });

  return items;
}

/**
 * The PINT AE fields this system knows about and can check today.
 *
 * ── READ THE NAME CAREFULLY ─────────────────────────────────────────────────
 *
 * This is NOT a readiness check, and an empty result does NOT mean a document
 * is transmissible. PINT AE defines on the order of fifty mandatory fields for
 * a standard tax invoice. The list below is **seven**, chosen because they are
 * the ones already modelled here — it was assembled from the PRD's summary and
 * from what the schema happens to carry, not from the published specification.
 * Nobody has yet checked it against the authoritative field set.
 *
 * An earlier version of this function was called `pintAeReadiness` and its
 * checklist entry told the operator "Ready for ASP transmission from 1 July
 * 2027" whenever these seven were populated. That is exactly the kind of
 * plausible, unevidenced assurance `WEB-2` spent this whole branch deleting
 * from the marketing pages, reintroduced on the screen an accountant reads. A
 * compliance checklist that says "ready" when nobody has verified readiness is
 * worse than one that says nothing, because it is believed.
 *
 * What is genuinely true and worth doing now: these fields are cheap to capture
 * today and unrecoverable in 2027, so capturing them early is right. The claim
 * about what capturing them achieves is the part that has to be honest.
 *
 * Before 1 July 2027 somebody must reconcile this against the published PINT AE
 * specification, via the Accredited Service Provider chosen under `OPEN-6` —
 * the ASP's own validator is the only authority that matters, and the deadline
 * to appoint one is 31 March 2027.
 */
export function pintAeKnownFieldGaps(doc: TaxDocumentDraft): readonly string[] {
  const problems: string[] = [];

  if (!isValidTrn(doc.supplier.trn)) problems.push("supplier TRN");
  if (!doc.supplier.address) problems.push("supplier address");
  if (doc.supplier.country.length !== 2) problems.push("supplier country code");
  if (!doc.recipient.name) problems.push("recipient name");
  if (doc.recipient.country.length !== 2) problems.push("recipient country code");

  const unmapped = doc.lines.filter((l) => !l.unitCode).map((l) => l.position);
  if (unmapped.length > 0) {
    problems.push(`UN/ECE unit code on line${unmapped.length === 1 ? "" : "s"} ${unmapped.join(", ")}`);
  }

  const untaxed = doc.lines.filter((l) => !l.taxCategoryCode).map((l) => l.position);
  if (untaxed.length > 0) {
    problems.push(`tax category on line${untaxed.length === 1 ? "" : "s"} ${untaxed.join(", ")}`);
  }

  return problems;
}
