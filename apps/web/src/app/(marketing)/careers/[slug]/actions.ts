"use server";

import { headers } from "next/headers";
import {
  applicationSubmissionSchema,
  applicationStatusUrl,
  tenant,
  CV_MAX_BYTES,
  type CertificateClaim,
} from "@meridian/core";
import { checkRateLimit, resolvePublicTenantId, withTenant } from "@meridian/db";
import {
  RoleClosedError,
  attachCandidateDocument,
  submitApplication,
} from "@meridian/db/domain";
import { MAX_OBJECT_BYTES, objectStore, sniffContentType } from "@meridian/files";

/**
 * The public application (`ATS-3`).
 *
 * ── THE CONSTRAINT THIS FILE WAS WRITTEN AGAINST ────────────────────────────
 *
 * *An applicant applies on a phone in under three minutes and always receives
 * an outcome.* Roughly 60% of applicants abandon on length, so the budget is
 * counted in **typed** fields rather than in fields: name and phone, and
 * nothing else. Everything else on the form is a tap, and everything optional
 * is genuinely optional — a validation error on an optional field is a field
 * that was not optional.
 *
 * ── WHY THIS DOES NOT OPEN A TENANT TRANSACTION ─────────────────────────────
 *
 * The submission goes through `app_public_submit_application`, a single
 * `SECURITY DEFINER` call that does the whole unit of work. The alternative —
 * the pattern the quote form uses — is to resolve the tenant and then run
 * `withTenant()`, which attaches that tenant's full row-level-security scope to
 * an unauthenticated HTTP request for the remainder of its transaction. For a
 * lead that is contained; for a record holding a phone number and certificate
 * numbers it is not the trade to make.
 *
 * The one exception is the CV upload, which does open a tenant transaction —
 * and only after the application has already been written and only to insert
 * one row against a candidate id the function just returned. That is called out
 * where it happens.
 */

/**
 * Three applications per hour from one address.
 *
 * Set from what a real person does. Somebody applying for the plumber role and
 * the handyman role in one sitting is two, and a mistyped phone number costs a
 * retry — so three leaves room and still turns a scripted flood into a trickle.
 * Lower than the quote form's five per ten minutes because an application is a
 * much more expensive row to write and a much less repetitive thing to do.
 */
const APPLY_RATE_LIMIT = 3;
const APPLY_RATE_WINDOW_SECONDS = 3600;

/** Six certificates. More than anybody holds; fewer than a bot will try. */
const MAX_CERTIFICATES = 6;

function clientKey(h: Headers): string {
  // Trusted only because this deployment terminates TLS at a proxy that
  // overwrites it. Behind a different proxy, or none, this is spoofable and the
  // limit is decorative — see the same note on the quote form.
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || h.get("x-real-ip")?.trim() || "unknown";
}

export interface ApplicationFormState {
  status: "idle" | "success" | "error";
  message?: string;
  errors?: Record<string, string>;
  reference?: string;
  statusUrl?: string;
  /** Rendered on the confirmation. The promise, with a date on it. */
  outcomeDueLabel?: string;
  /** Set when a CV was offered and could not be stored. Never fatal. */
  cvNote?: string;
}

/**
 * Pull the repeated certificate rows out of the form data (`ATS-4`).
 *
 * A row counts only when a scheme *and* an expiry are both present. Half a
 * certificate is somebody who started filling one in and changed their mind,
 * and rejecting the whole application over it would lose the applicant to
 * punish a stray keystroke.
 *
 * Expiry is required on a row that exists, and that is the one strictness worth
 * having: it is the field everyone forgets, and the day it matters is the day a
 * dispatch is refused under `HR-9`.
 */
function certificatesFrom(formData: FormData): {
  certificates: CertificateClaim[];
  incomplete: number;
} {
  const certificates: CertificateClaim[] = [];
  let incomplete = 0;

  for (let i = 0; i < MAX_CERTIFICATES; i++) {
    const scheme = String(formData.get(`cert_${i}_scheme`) ?? "").trim();
    const expiresOn = String(formData.get(`cert_${i}_expires`) ?? "").trim();
    if (!scheme && !expiresOn) continue;

    if (!scheme || !/^\d{4}-(0[1-9]|1[0-2])$/.test(expiresOn)) {
      incomplete += 1;
      continue;
    }

    certificates.push({
      scheme: scheme.slice(0, 120),
      certificateNo: String(formData.get(`cert_${i}_number`) ?? "").trim().slice(0, 80),
      level: "",
      issuingBody: String(formData.get(`cert_${i}_body`) ?? "").trim().slice(0, 160),
      expiresOn,
    });
  }

  return { certificates, incomplete };
}

/**
 * Store the CV, if one was attached (`ATS-9`).
 *
 * Everything here fails soft and returns a note instead of throwing. The
 * application has already been recorded by the time this runs, and losing a
 * submitted application because a file could not be stored would be the worst
 * possible trade: `ATS-3` makes the CV optional precisely because many good
 * tradespeople do not have one.
 *
 * The type is sniffed from the bytes by `packages/files`, never taken from the
 * browser, and that allowlist deliberately excludes SVG and HTML. It also
 * excludes `.doc`, `.docx`, `.rtf` and `.txt`, which `ATS-9` names — those
 * formats have no reliable magic bytes and adding them would mean weakening the
 * sniffer, which is not a trade worth making for a field that is optional
 * anyway. The form says "PDF or a photo", which is what this workforce sends.
 */
async function storeCv(
  tenantId: string,
  candidateId: string,
  applicationId: string,
  file: File | null,
): Promise<string | undefined> {
  if (!file || file.size === 0) return undefined;

  if (file.size > CV_MAX_BYTES || file.size > MAX_OBJECT_BYTES) {
    return "Your CV was too large to attach, so we have recorded your application without it. Everything you typed has been saved.";
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const contentType = sniffContentType(bytes);

    if (!contentType) {
      return "We could not read that file, so we have recorded your application without it. You have told us enough — send a PDF or a photo later if you want to.";
    }

    const key = `candidates/${candidateId}/cv-${applicationId}.${contentType.split("/")[1]}`;
    const stored = await objectStore().put({ key, body: bytes, declaredContentType: contentType });

    /*
     * The one tenant-scoped transaction on this path, and it is deliberately
     * the narrowest possible: one INSERT, against a candidate id the definer
     * function just returned, after the application is already safely written.
     */
    await withTenant({ tenantId, actorKind: "customer" }, (tx) =>
      attachCandidateDocument(
        tx,
        { tenantId, actorKind: "customer" },
        {
          candidateId,
          applicationId,
          kind: "cv",
          storageKey: stored.key,
          filename: file.name.slice(0, 200),
          contentType: stored.contentType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          /*
           * `ATS-9` requires asynchronous virus scanning and gates downloads on
           * the result. No scanner is contracted for this deployment (the TRD
           * lists it as an external dependency), so the honest value is
           * `skipped` — "nobody scanned this" — rather than `pending`, which
           * would claim a scan is in flight that will never complete and would
           * leave every CV permanently undownloadable with no explanation.
           *
           * The recruitment screens label every `skipped` file as not scanned,
           * and no flagged file is ever attached to outbound staff email.
           */
          scanStatus: "skipped",
        },
      ),
    );

    return undefined;
  } catch (error) {
    console.error("[careers] could not store the CV; the application was still recorded", error);
    return "We could not attach your CV, but your application has been recorded and nothing you typed was lost.";
  }
}

export async function submitApplicationForm(
  _prev: ApplicationFormState,
  formData: FormData,
): Promise<ApplicationFormState> {
  const { certificates, incomplete } = certificatesFrom(formData);

  const raw = {
    roleSlug: String(formData.get("roleSlug") ?? ""),
    fullName: String(formData.get("fullName") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    email: String(formData.get("email") ?? ""),
    trade: String(formData.get("trade") ?? ""),
    grade: String(formData.get("grade") ?? ""),
    experienceBand: String(formData.get("experienceBand") ?? ""),
    currentLocation: String(formData.get("currentLocation") ?? ""),
    availability: String(formData.get("availability") ?? ""),
    hasDrivingLicence: formData.get("hasDrivingLicence") === "on",
    essentialFunctions: String(formData.get("essentialFunctions") ?? ""),
    overEighteen: formData.get("overEighteen") === "on",
    certificates,
    talentPoolConsent: formData.get("talentPoolConsent") === "on",
    company: String(formData.get("company") ?? ""),
  };

  // Honeypot. Return the success *shape* so a bot learns nothing from the
  // difference, but with no reference — there is nothing to track.
  if (raw.company !== "") {
    return { status: "success", reference: "APP-000000" };
  }

  const parsed = applicationSubmissionSchema.safeParse(raw);

  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form");
      errors[key] ??= issue.message;
    }
    return {
      status: "error",
      message: "Almost there — please check the highlighted answers.",
      errors,
    };
  }

  if (incomplete > 0) {
    // Refused rather than silently dropped, and refused *here* rather than
    // inside the schema so the rest of the form is already known to be valid
    // and nothing the applicant typed is lost on the way back.
    return {
      status: "error",
      message:
        "One of your certificates is missing its expiry date. That date is the one we cannot work without — an expired ticket stops you being sent to site — so please add it, or clear the certificate and carry on.",
      errors: { certificates: "Add the expiry month and year, or clear the row." },
    };
  }

  const slug = process.env["PUBLIC_TENANT_SLUG"];
  if (!slug) {
    console.error("[careers] PUBLIC_TENANT_SLUG is not set; cannot record this application");
    return {
      status: "error",
      message: `Something went wrong on our side — this is not you. Please call ${tenant.phone} and we will take your details over the phone.`,
    };
  }

  const h = await headers();

  // Counted after validation, exactly as the quote form does it: validation
  // costs no I/O, so a flood of junk never reaches the database, and somebody
  // who mistyped their phone number does not spend an attempt on it.
  const limit = await checkRateLimit({
    bucket: `apply:${clientKey(h)}`,
    limit: APPLY_RATE_LIMIT,
    windowSeconds: APPLY_RATE_WINDOW_SECONDS,
  });

  if (!limit.allowed) {
    return {
      status: "error",
      // No counts and no window. Somebody probing the limit learns nothing, and
      // a real person who has genuinely applied three times in an hour needs a
      // phone number rather than arithmetic.
      message: `We have already received several applications from you. If you need to change something, call ${tenant.phone} and we will sort it out.`,
    };
  }

  try {
    const tenantId = await resolvePublicTenantId(slug);
    if (!tenantId) throw new Error(`No active tenant with slug "${slug}"`);

    const result = await submitApplication(tenantId, {
      roleSlug: parsed.data.roleSlug,
      fullName: parsed.data.fullName,
      phone: parsed.data.phone,
      email: parsed.data.email || null,
      trade: parsed.data.trade,
      grade: parsed.data.grade,
      experienceBand: parsed.data.experienceBand,
      currentLocation: parsed.data.currentLocation,
      availability: parsed.data.availability,
      hasDrivingLicence: parsed.data.hasDrivingLicence,
      essentialFunctions: parsed.data.essentialFunctions,
      certificates: parsed.data.certificates,
      talentPoolConsent: parsed.data.talentPoolConsent,
      source: "careers_site",
    });

    const cv = formData.get("cv");
    const cvNote = await storeCv(
      tenantId,
      result.candidateId,
      result.applicationId,
      cv instanceof File ? cv : null,
    );

    return {
      status: "success",
      reference: result.reference,
      statusUrl: applicationStatusUrl(result.statusToken),
      outcomeDueLabel: result.outcomeDueAt.toLocaleDateString("en-GB", {
        timeZone: "Asia/Dubai",
        weekday: "long",
        day: "numeric",
        month: "long",
      }),
      ...(cvNote ? { cvNote } : {}),
    };
  } catch (error) {
    if (error instanceof RoleClosedError) {
      return { status: "error", message: error.message };
    }
    console.error("[careers] application submission failed", error);
    return {
      status: "error",
      message: `Something went wrong on our side — this is not you. Please call ${tenant.phone} or message us on WhatsApp and we will take your details.`,
    };
  }
}
