/**
 * Tenders: the deadline, and the pack that answers it.
 *
 * `CON-11` and `CON-12`. Everything in this file is pure — the shape of a
 * tender queue's urgency, and the shape of a tender pack that is allowed to be
 * produced — so that a browser can render both without a database and the
 * renderer in `packages/docs` can refuse without one.
 *
 * ── WHY A TENDER IS NOT A LEAD WITH A DIFFERENT NAME ────────────────────────
 *
 * A lead has a stage: new, contacted, qualified, quoted, won. The stage is the
 * organising fact, because what happens next depends on where the conversation
 * got to, and a lead with no activity for three weeks is a lead to chase.
 *
 * A tender has none of that. The Owners Association published a document with a
 * closing date on it; nothing anybody does moves it, nobody can be chased into
 * extending it, and a bid that is complete on the wrong side of it is worth
 * exactly nothing. `CON-11` says so in one sentence — *deadline-driven, not
 * stage-driven, a tender queue sorts by days until deadline, always* — and the
 * consequence runs all the way down: there is no stage column in the schema, no
 * transition table in this file, and no ordering anywhere in the tender code
 * that is not `days until deadline ascending`. An overdue tender sorts to the
 * top and stays there until somebody records what happened to it.
 *
 * ── WHY THE PACK REFUSES ────────────────────────────────────────────────────
 *
 * `CON-12`'s pack is *assembled from the company accreditation register so it
 * is always current*. That clause is the entire requirement. A pack built from
 * copies somebody attached to an email last March is the failure it exists to
 * prevent, and the worst version of that failure is not an omission — it is a
 * lapsed third-party liability certificate submitted as evidence of cover. An
 * Owners Association that spots it disqualifies the bid; one that does not
 * spots it after an incident, which is worse.
 *
 * So `assertTenderPackRenderable` below refuses, by name, on anything expired
 * or missing, in the same shape and for the same reason as `assertRenderable`
 * in `invoice.ts`: every problem at once, because reporting them one at a time
 * turns a five-minute correction into an afternoon and teaches people to route
 * around the tool.
 *
 * The split between refusing and warning is deliberate and it is not "how
 * serious does this feel":
 *
 *   * **Refused** — the pack would make a false statement, or would not be a
 *     pack at all. An expired certificate. A required certificate with no
 *     document behind it. No plant to price. No rates. No scope.
 *   * **Warned** — the pack is true and incomplete, and the reader can see the
 *     gap on the face of it. No ISO certification held. No reference contracts
 *     yet. A certificate that is in date today and lapses before the closing
 *     date. Each of these is printed on the document in words rather than
 *     silently omitted, because the previous build's habit of advertising three
 *     ISO certificates the company does not hold is the exact thing this
 *     register was created to stop.
 */

import { z } from "zod";
import { UserFacingError } from "./work";

// ── The pipeline (CON-11) ────────────────────────────────────────────────────

/**
 * Where the opportunity came from.
 *
 * The four `CON-11` names, and they are four rather than free text because the
 * question the field exists to answer — *which of these channels is worth
 * staffing next budget season* — is asked across rows. The codes are stable;
 * the labels live in the database so a tenant can reword them.
 */
export const TENDER_SOURCE_CODES = [
  "oa_management_company",
  "developer",
  "property_manager",
  "government_esupply",
] as const;

export type TenderSourceCode = (typeof TENDER_SOURCE_CODES)[number];

/**
 * What happened to the bid.
 *
 * Not a stage machine. These are outcomes, and `pending` is the absence of one:
 * a tender is pending from the moment it is recorded until somebody says what
 * became of it, however many times it is edited in between. Whether it has been
 * *submitted* is a separate fact with a date of its own, because "we sent it and
 * have not heard" and "we did not send it" are different states and collapsing
 * them into one column is how a lost bid gets recorded as a missed deadline.
 */
export const TENDER_OUTCOMES = ["pending", "won", "lost", "withdrawn", "no_bid"] as const;

export type TenderOutcome = (typeof TENDER_OUTCOMES)[number];

export const TENDER_OUTCOME_LABEL: Readonly<Record<TenderOutcome, string>> = {
  pending: "Awaiting decision",
  won: "Won",
  lost: "Lost",
  withdrawn: "Withdrawn",
  no_bid: "No bid",
};

/** The outcomes that close a tender. A closed tender leaves the queue. */
export const CLOSED_TENDER_OUTCOMES: readonly TenderOutcome[] = ["won", "lost", "withdrawn", "no_bid"];

export function isClosedOutcome(outcome: string): boolean {
  return (CLOSED_TENDER_OUTCOMES as readonly string[]).includes(outcome);
}

/**
 * How a deadline reads, given how many days are left.
 *
 * `daysRemaining` is always computed by Postgres as `date - current_date`,
 * never in JavaScript — see `domain/tenders.ts` for why. This function only
 * bands the number it is given.
 *
 * The bands are the working reality of a UAE tender: a bid needs a priced
 * schedule of rates, a site walk and a full evidence pack, and none of that is
 * assembled in three days. So `critical` starts at seven rather than at one —
 * a queue that only turns red on the last day is a queue that reports failures
 * rather than preventing them.
 */
export type TenderUrgency = "overdue" | "critical" | "soon" | "ahead";

export function tenderUrgency(daysRemaining: number): TenderUrgency {
  if (daysRemaining < 0) return "overdue";
  if (daysRemaining <= 7) return "critical";
  if (daysRemaining <= 21) return "soon";
  return "ahead";
}

/** The deadline in words. `-3` is "closed 3 days ago", not "in -3 days". */
export function tenderDeadlineNote(daysRemaining: number): string {
  if (daysRemaining < 0) {
    const days = Math.abs(daysRemaining);
    return `Closed ${days} day${days === 1 ? "" : "s"} ago`;
  }
  if (daysRemaining === 0) return "Closes today";
  if (daysRemaining === 1) return "Closes tomorrow";
  return `${daysRemaining} days left`;
}

// ── The pack (CON-12) ────────────────────────────────────────────────────────

/**
 * The accreditation kinds a tender pack will not go out without.
 *
 * Every one of these is named in `CON-12` and every one of them is a document
 * an Owners Association's evaluator physically looks for. The trade licence
 * proves the company exists and is licensed for the scope; DEWA enrolment is a
 * hard gate on anything touching supply, meters, circuits or main boards;
 * third-party liability and workmen's compensation are what the OA's own
 * insurer asks about before letting a contractor on site.
 *
 * ISO certificates are deliberately **not** here. `CON-12` lists them, and a
 * company may legitimately hold none — the previous build's answer to that was
 * to advertise three it did not hold. So a missing ISO certificate is stated on
 * the document in words and never invented, which is `HR-14`'s rule applied to
 * the one artefact where breaking it is most tempting.
 */
export const REQUIRED_PACK_ACCREDITATIONS = [
  "trade_licence",
  "dewa_enrolment",
  "liability_insurance",
  "workmen_comp",
] as const;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates on a document are plain calendar dates, as YYYY-MM-DD");

const minorUnits = z
  .number()
  .int("Money is handled in integer minor units — a fractional fil is a bug, not a rounding");

const nonEmpty = (message: string) => z.string().trim().min(1, message);

export const tenderPackPartySchema = z.object({
  name: nonEmpty("The supplier name is required — a tender pack with no bidder on it is not a bid"),
  trn: z.string().trim().min(1).nullable(),
  address: z.string().trim().min(1).nullable(),
  phone: z.string().trim().min(1).nullable(),
  email: z.string().trim().min(1).nullable(),
  licenceNumber: z.string().trim().min(1).nullable(),
  crNumber: z.string().trim().min(1).nullable(),
});

/**
 * One line of the per-asset PPM schedule.
 *
 * Read from the asset register (`CON-13`), never typed. This is the half of the
 * pack that an evaluator scores: a bidder who can list every chiller, FCU, pump
 * and board in the building with its make, model and service interval is a
 * bidder who has surveyed the site, and one who submits "HVAC maintenance —
 * quarterly" has not.
 */
export const packAssetSchema = z.object({
  propertyName: nonEmpty("Every asset line belongs to a property"),
  tag: nonEmpty("Every asset carries its register tag"),
  name: nonEmpty("Every asset carries its name"),
  category: nonEmpty("Every asset carries its kind"),
  manufacturer: z.string().trim().min(1).nullable(),
  model: z.string().trim().min(1).nullable(),
  serialNumber: z.string().trim().min(1).nullable(),
  location: z.string().trim().min(1).nullable(),
  installedOn: isoDate.nullable(),
  /** Days between planned visits. Null where the register has no interval. */
  ppmIntervalDays: z.number().int().positive().nullable(),
});

/** One line of the priced schedule of rates, as it stood on the pack date. */
export const packRateSchema = z.object({
  code: nonEmpty("Every rate carries its code"),
  label: nonEmpty("Every rate carries its description"),
  unit: nonEmpty("Every rate is priced per something"),
  rateBandLabel: nonEmpty("Every rate names the band it applies in"),
  unitPriceMinor: minorUnits,
  minQuantity: z.string().trim().min(1).nullable(),
  notes: z.string().trim().min(1).nullable(),
});

/**
 * One accreditation, as the register holds it today.
 *
 * `expiresOn` is a calendar day and stays a string end to end. Round-tripping
 * it through a JS `Date` shifts it by the reader's UTC offset, and in Dubai
 * that shift runs in one direction: an expired certificate reads as still valid
 * for the first four hours of every day. On a tender pack that is the single
 * most expensive direction for the error to run, which is why the expiry
 * comparison below is a string comparison against the pinned pack date and not
 * a date comparison at all.
 */
export const packAccreditationSchema = z.object({
  kind: nonEmpty("Every accreditation carries its kind"),
  kindLabel: nonEmpty("Every accreditation carries a readable kind"),
  name: nonEmpty("Every accreditation carries its name"),
  referenceNo: z.string().trim().min(1).nullable(),
  issuingBody: z.string().trim().min(1).nullable(),
  grade: z.string().trim().min(1).nullable(),
  issuedOn: isoDate.nullable(),
  expiresOn: isoDate.nullable(),
  /** True when there is a scan in object storage behind the row. */
  hasDocument: z.boolean(),
  /** The stored artefact's hash, so the pack can name what it attached. */
  documentSha256: z.string().trim().min(1).nullable(),
});

/** A contract offered as a reference. Live rows, never a testimonial. */
export const packReferenceContractSchema = z.object({
  reference: nonEmpty("Every reference contract carries its number"),
  customerName: nonEmpty("Every reference contract names the client"),
  kindLabel: nonEmpty("Every reference contract names what it covers"),
  startsOn: isoDate,
  endsOn: isoDate,
  annualValueMinor: minorUnits,
  propertyCount: z.number().int().min(0),
  statusLabel: nonEmpty("Every reference contract names its state"),
});

export const packPropertySchema = z.object({
  name: nonEmpty("Every property in scope carries its name"),
  addressLine: nonEmpty("Every property in scope carries its address"),
  area: z.string().trim().min(1).nullable(),
  city: nonEmpty("Every property in scope carries its city"),
  typeLabel: nonEmpty("Every property in scope carries its type"),
});

export const tenderPackDocumentSchema = z
  .object({
    reference: nonEmpty("A tender pack must carry its reference"),
    title: nonEmpty("A tender pack needs a title"),

    /**
     * The business date the pack is pinned to.
     *
     * Not the wall clock. `packages/docs` writes this into the PDF's creation
     * and modification dates, and the stored SHA-256 is only evidence of what
     * was submitted if the same pack renders to the same bytes. It is also the
     * date every expiry in this document is judged against, so "current" means
     * one thing throughout.
     */
    preparedOn: isoDate,

    issuingBody: nonEmpty("A tender is issued by somebody — name them"),
    opportunitySourceLabel: nonEmpty("A tender pack names the channel it came through"),
    portalReference: z.string().trim().min(1).nullable(),
    budgetCycle: z.string().trim().min(1).nullable(),
    submissionDeadline: isoDate,
    decisionDate: isoDate.nullable(),

    supplier: tenderPackPartySchema,

    scopeOfWork: nonEmpty(
      "The scope of work is empty — a tender pack without one is a price with nothing attached to it",
    ),

    properties: z
      .array(packPropertySchema)
      .min(1, "A tender pack names the buildings it is priced for; this one names none"),

    assets: z
      .array(packAssetSchema)
      .min(
        1,
        "The per-asset PPM schedule would be empty — no plant is registered at the properties in " +
          "scope, so there is nothing to price and nothing for an evaluator to score (CON-13)",
      ),

    rates: z
      .array(packRateSchema)
      .min(
        1,
        "The priced schedule of rates would be empty — no rate card line is in effect on the pack " +
          "date, so the pack would quote nothing",
      ),

    accreditations: z.array(packAccreditationSchema),

    referenceContracts: z.array(packReferenceContractSchema),

    currency: z.string().length(3),
    bidValueMinor: minorUnits.nullable(),
  })
  .superRefine((doc, ctx) => {
    const problem = (path: string, message: string): void => {
      ctx.addIssue({ code: "custom", path: [path], message });
    };

    // A pack that cannot be submitted must not be produced as though it could.
    // The deadline is the one fact about a tender that nothing negotiates.
    if (doc.submissionDeadline < doc.preparedOn) {
      problem(
        "submissionDeadline",
        `the submission deadline was ${doc.submissionDeadline} and this pack is dated ` +
          `${doc.preparedOn} — the tender has closed, so there is nothing to submit this to`,
      );
    }

    if (doc.decisionDate && doc.decisionDate < doc.submissionDeadline) {
      problem(
        "decisionDate",
        `the decision date ${doc.decisionDate} is before the submission deadline ` +
          `${doc.submissionDeadline}, so one of the two was entered wrong`,
      );
    }

    // ── The register, checked against the pack's own date ──────────────────
    //
    // String comparison on `YYYY-MM-DD`. It sorts lexicographically in calendar
    // order, needs no timezone, and cannot move a boundary the way `new Date()`
    // does. See the note on `packAccreditationSchema`.
    for (const kind of REQUIRED_PACK_ACCREDITATIONS) {
      const held = doc.accreditations.filter((a) => a.kind === kind);

      if (held.length === 0) {
        problem(
          "accreditations",
          `${LABEL_FOR_REQUIRED[kind]} is not in the company accreditation register (HR-14), and ` +
            `CON-12 requires it in the pack — record it at /workforce/accreditations, with its ` +
            `certificate, before this pack can be built`,
        );
        continue;
      }

      // The most recent one wins. A company that renewed its licence in June
      // holds two rows; the pack must attach June's.
      const current = held.filter((a) => !a.expiresOn || a.expiresOn >= doc.preparedOn);

      if (current.length === 0) {
        const latest = held.reduce((a, b) => ((a.expiresOn ?? "") > (b.expiresOn ?? "") ? a : b));
        problem(
          "accreditations",
          `${LABEL_FOR_REQUIRED[kind]} expired on ${latest.expiresOn} — a tender pack containing a ` +
            `lapsed certificate is worse than one that refuses to build, so this one refuses. ` +
            `Record the renewal against ${latest.name}`,
        );
        continue;
      }

      if (!current.some((a) => a.hasDocument)) {
        problem(
          "accreditations",
          `${LABEL_FOR_REQUIRED[kind]} is recorded but has no certificate attached — CON-12's pack ` +
            `is the evidence, not the claim, so the scan has to be on the register row`,
        );
      }
    }

    // An expired certificate never goes in, required or not. An ISO 9001 that
    // lapsed in March is not evidence of anything, and attaching it invites the
    // evaluator to check the others.
    for (const a of doc.accreditations) {
      if (a.expiresOn && a.expiresOn < doc.preparedOn) {
        problem(
          "accreditations",
          `${a.name} expired on ${a.expiresOn} and is still marked for inclusion — withdraw it or ` +
            `record its renewal; it will not be attached to a pack in this state`,
        );
      }
    }
  });

export type TenderPackDocument = z.infer<typeof tenderPackDocumentSchema>;
export type PackAccreditation = z.infer<typeof packAccreditationSchema>;
export type PackAsset = z.infer<typeof packAssetSchema>;
export type PackRate = z.infer<typeof packRateSchema>;
export type PackReferenceContract = z.infer<typeof packReferenceContractSchema>;
export type PackProperty = z.infer<typeof packPropertySchema>;

/** Readable names for the four the pack will not go without. */
const LABEL_FOR_REQUIRED: Readonly<Record<(typeof REQUIRED_PACK_ACCREDITATIONS)[number], string>> = {
  trade_licence: "The trade licence",
  dewa_enrolment: "DEWA contractor enrolment",
  liability_insurance: "Third-party liability insurance",
  workmen_comp: "Workmen's compensation cover",
};

export class TenderPackNotRenderableError extends UserFacingError {
  constructor(
    readonly reference: string,
    readonly problems: readonly string[],
  ) {
    super(
      `${reference || "This tender pack"} cannot be assembled: ${problems.join("; ")}.`,
    );
    this.name = "TenderPackNotRenderableError";
  }
}

/**
 * Validate a tender pack for assembly, or refuse with every reason at once.
 *
 * The refusal is the feature. It is the difference between an evaluator finding
 * a lapsed insurance certificate in the submission and an operator finding it
 * on their own screen with four days left to renew.
 */
export function assertTenderPackRenderable(input: unknown): TenderPackDocument {
  const parsed = tenderPackDocumentSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  const reference =
    typeof input === "object" && input !== null && "reference" in input
      ? String((input as { reference: unknown }).reference ?? "")
      : "";

  // De-duplicated: the required-kind loop and the expired-anything loop can
  // both reach the same certificate, and telling somebody about it twice makes
  // the list look longer than the work.
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const issue of parsed.error.issues) {
    const text = issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
    if (seen.has(text)) continue;
    seen.add(text);
    problems.push(text);
  }

  throw new TenderPackNotRenderableError(reference, problems);
}

/**
 * What is true, incomplete, and printed rather than hidden.
 *
 * Never thrown. Each of these appears on the face of the document as a sentence
 * and is handed back to the caller so the screen can show it before anybody
 * clicks submit. The rule they all serve is the one `HR-14` was written for: a
 * gap is stated, never filled in with something plausible.
 */
export function tenderPackWarnings(doc: TenderPackDocument): readonly string[] {
  const warnings: string[] = [];

  for (const a of doc.accreditations) {
    if (!a.expiresOn) {
      warnings.push(
        `${a.name} has no expiry date on the register, so nothing is counting down to its renewal.`,
      );
      continue;
    }
    if (a.expiresOn < doc.submissionDeadline) {
      warnings.push(
        `${a.name} expires on ${a.expiresOn}, before this tender closes on ${doc.submissionDeadline}. ` +
          `It is in date today and the evaluator will read the expiry.`,
      );
    }
  }

  if (!doc.accreditations.some((a) => a.kind === "iso_cert")) {
    warnings.push(
      "No ISO certification is recorded, so the pack states that plainly rather than claiming one.",
    );
  }

  if (doc.referenceContracts.length === 0) {
    warnings.push(
      "No reference contracts are recorded, so the pack says so. RERA's three-bid process weighs " +
        "them, and an empty section is better read than an invented one.",
    );
  }

  if (!doc.supplier.trn) {
    warnings.push("The supplier TRN is not configured, so the pack carries no VAT registration.");
  }

  return warnings;
}

/**
 * How many planned visits a year an interval works out at.
 *
 * The evaluator's arithmetic, done once here rather than in the template, so
 * the screen and the document cannot disagree about it. 90 days is 4 visits and
 * 30 days is 12; anything that does not divide is rounded down, because
 * promising 5 visits on a 75-day interval is promising a visit that will not
 * happen.
 */
export function visitsPerYear(ppmIntervalDays: number | null): number | null {
  if (!ppmIntervalDays || ppmIntervalDays <= 0) return null;
  return Math.floor(365 / ppmIntervalDays);
}
