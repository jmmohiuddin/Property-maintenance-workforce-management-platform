"use server";

import { revalidatePath } from "next/cache";
import {
  withTenant,
  createEmployeeRecord,
  recordEmployeeDocument,
  removeEmployeeDocument,
  recordAccreditation,
  removeAccreditation,
  EMPLOYEE_DOCUMENT_KINDS,
  EMPLOYEE_DOCUMENT_LABEL,
  ACCREDITATION_KINDS,
  recordSubcontractor,
  removeSubcontractor,
  recordSubcontractorWorker,
  verifySubcontractorWorker,
  SUBCONTRACTOR_KINDS,
  SUBCONTRACTOR_STATUSES,
  type EmployeeDocumentKind,
  type AccreditationKind,
  type SubcontractorKind,
  type SubcontractorStatus,
} from "@meridian/db";
import { requireSessionWith } from "@/lib/session";
import { userMessage } from "@/lib/errors";

/**
 * Writes for the workforce compliance register (`HR-5`, `HR-14`).
 *
 * Every one of these re-checks `workforce:write` on the server. The pages hide
 * the forms from a read-only role, but hiding a form is not authorisation — a
 * `curl` with a session cookie never sees the page at all.
 */

export interface WorkforceFormState {
  error?: string;
  ok?: string;
}

/**
 * A calendar day, kept as the string the browser sent.
 *
 * `<input type="date">` submits `YYYY-MM-DD` and the Postgres `date` column
 * stores exactly that. Parsing it into a `Date` in between is the step that
 * introduces a timezone, and a timezone applied to an expiry date is how a
 * permit that lapses on the 1st gets stored as lapsing on the 31st. So: validate
 * the shape, and pass it through untouched.
 */
function calendarDate(value: FormDataEntryValue | null): string | undefined | null {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  // Rejects 2026-02-31 and friends, which match the pattern and are not days.
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) return null;
  return raw;
}

/** `2027-01-23` reads as a database row; `23 Jan 2027` reads as a deadline. */
function readableDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: "Asia/Dubai",
    dateStyle: "medium",
  });
}

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

export async function openEmployeeRecord(
  _prev: WorkforceFormState,
  formData: FormData,
): Promise<WorkforceFormState> {
  const session = await requireSessionWith("workforce:write");

  const fullName = text(formData, "fullName");
  const technicianId = text(formData, "technicianId");
  const employeeNo = text(formData, "employeeNo");

  if (fullName.length < 2) return { error: "Give the employment record a name." };

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        createEmployeeRecord(
          tx,
          { tenantId: session.principal.tenantId },
          {
            fullName,
            ...(technicianId ? { technicianId } : {}),
            ...(employeeNo ? { employeeNo } : {}),
          },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not open the employment record.", "workforce") };
  }

  revalidatePath("/workforce");
  return {
    ok: `${fullName} added to the register. Record their work permit, visa, Emirates ID, medical fitness certificate and health insurance next — until those exist, nothing is checking them.`,
  };
}

export async function saveEmployeeDocument(
  _prev: WorkforceFormState,
  formData: FormData,
): Promise<WorkforceFormState> {
  const session = await requireSessionWith("workforce:write");

  const employeeId = text(formData, "employeeId");
  const kind = text(formData, "kind") as EmployeeDocumentKind;
  const referenceNo = text(formData, "referenceNo");
  const note = text(formData, "note");
  const issuedAt = calendarDate(formData.get("issuedAt"));
  const expiresAt = calendarDate(formData.get("expiresAt"));

  if (!employeeId) return { error: "Missing employment record." };
  if (!EMPLOYEE_DOCUMENT_KINDS.includes(kind)) return { error: "Choose a document type." };
  if (issuedAt === null) return { error: "The issue date is not a real date." };
  if (expiresAt === null) return { error: "The expiry date is not a real date." };
  if (issuedAt && expiresAt && expiresAt <= issuedAt) {
    return { error: "The expiry date must be after the issue date." };
  }

  // An expiry is the only field on this form that does anything. Saving a work
  // permit with the date left blank produces a record that looks complete on
  // the board and can never block a dispatch, which is worse than no record at
  // all — a gap is at least counted.
  if (!expiresAt) {
    return {
      error: `Record the expiry date. Without one, this ${EMPLOYEE_DOCUMENT_LABEL[kind].toLowerCase()} will never trigger a warning or a block.`,
    };
  }

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        recordEmployeeDocument(
          tx,
          { tenantId: session.principal.tenantId },
          {
            employeeId,
            kind,
            expiresAt,
            ...(issuedAt ? { issuedAt } : {}),
            ...(referenceNo ? { referenceNo } : {}),
            ...(note ? { note } : {}),
          },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not record the document.", "workforce") };
  }

  revalidatePath(`/workforce/${employeeId}`);
  revalidatePath("/workforce");
  // The assign panel reads the same block list, so a renewal recorded here has
  // to clear the block there in the same request rather than at the next deploy.
  revalidatePath("/dispatch");
  return { ok: `${EMPLOYEE_DOCUMENT_LABEL[kind]} recorded, expiring ${readableDay(expiresAt)}.` };
}

export async function withdrawEmployeeDocument(
  _prev: WorkforceFormState,
  formData: FormData,
): Promise<WorkforceFormState> {
  const session = await requireSessionWith("workforce:write");

  const documentId = text(formData, "documentId");
  const employeeId = text(formData, "employeeId");
  if (!documentId) return { error: "Missing document." };

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) => removeEmployeeDocument(tx, documentId),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not withdraw the document.", "workforce") };
  }

  revalidatePath(`/workforce/${employeeId}`);
  revalidatePath("/workforce");
  revalidatePath("/dispatch");
  return { ok: "Document withdrawn. It stays on file for the retention period." };
}

export async function saveAccreditation(
  _prev: WorkforceFormState,
  formData: FormData,
): Promise<WorkforceFormState> {
  const session = await requireSessionWith("workforce:write");

  const kind = text(formData, "kind") as AccreditationKind;
  const name = text(formData, "name");
  const referenceNo = text(formData, "referenceNo");
  const issuingBody = text(formData, "issuingBody");
  const grade = text(formData, "grade");
  const issuedAt = calendarDate(formData.get("issuedAt"));
  const expiresAt = calendarDate(formData.get("expiresAt"));

  if (!ACCREDITATION_KINDS.includes(kind)) return { error: "Choose an accreditation type." };
  if (name.length < 2) return { error: "Give the accreditation a name." };
  if (issuedAt === null) return { error: "The issue date is not a real date." };
  if (expiresAt === null) return { error: "The expiry date is not a real date." };
  if (!expiresAt) {
    return { error: "Record the expiry date. An accreditation with no expiry is one nobody renews." };
  }
  if (issuedAt && expiresAt <= issuedAt) {
    return { error: "The expiry date must be after the issue date." };
  }

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        recordAccreditation(
          tx,
          { tenantId: session.principal.tenantId },
          {
            kind,
            name,
            expiresAt,
            ...(issuedAt ? { issuedAt } : {}),
            ...(referenceNo ? { referenceNo } : {}),
            ...(issuingBody ? { issuingBody } : {}),
            ...(grade ? { grade } : {}),
          },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not record the accreditation.", "workforce") };
  }

  revalidatePath("/workforce/accreditations");
  revalidatePath("/workforce");
  return { ok: `${name} recorded, expiring ${readableDay(expiresAt)}.` };
}

export async function withdrawAccreditation(
  _prev: WorkforceFormState,
  formData: FormData,
): Promise<WorkforceFormState> {
  const session = await requireSessionWith("workforce:write");

  const accreditationId = text(formData, "accreditationId");
  if (!accreditationId) return { error: "Missing accreditation." };

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) => removeAccreditation(tx, accreditationId),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not withdraw the accreditation.", "workforce") };
  }

  revalidatePath("/workforce/accreditations");
  revalidatePath("/workforce");
  return { ok: "Accreditation withdrawn." };
}

// ── HR-19: subcontractors and manpower suppliers ────────────────────────────

/**
 * Add or amend a subcontractor (`HR-19`).
 *
 * Sits on the workforce board rather than on `/hr` because it answers the
 * workforce board's question — "may this person legally be on our site today" —
 * about the people this company does not employ. Responsibility for site
 * compliance does not transfer with the work.
 */
export async function saveSubcontractor(
  _prev: WorkforceFormState,
  formData: FormData,
): Promise<WorkforceFormState> {
  const session = await requireSessionWith("workforce:write");

  const id = text(formData, "id");
  const name = text(formData, "name");
  const kind = text(formData, "kind");
  const status = text(formData, "status");

  if (name.length < 2) return { error: "Name the subcontractor." };
  if (!(SUBCONTRACTOR_KINDS as readonly string[]).includes(kind)) {
    return { error: "Choose whether this is a subcontractor or a manpower supplier." };
  }
  if (status && !(SUBCONTRACTOR_STATUSES as readonly string[]).includes(status)) {
    return { error: "That is not one of the register's statuses." };
  }

  const tradeLicenceExpiresOn = calendarDate(formData.get("tradeLicenceExpiresOn"));
  const liabilityExpiresOn = calendarDate(formData.get("liabilityExpiresOn"));
  const workmenCompExpiresOn = calendarDate(formData.get("workmenCompExpiresOn"));
  if (tradeLicenceExpiresOn === null) return { error: "The trade licence expiry is not a real date." };
  if (liabilityExpiresOn === null) return { error: "The liability policy expiry is not a real date." };
  if (workmenCompExpiresOn === null) return { error: "The workmen's compensation expiry is not a real date." };

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        recordSubcontractor(
          tx,
          { tenantId: session.principal.tenantId },
          {
            ...(id ? { id } : {}),
            name,
            kind: kind as SubcontractorKind,
            tradeSlug: text(formData, "tradeSlug") || null,
            contactName: text(formData, "contactName") || null,
            contactPhone: text(formData, "contactPhone") || null,
            contactEmail: text(formData, "contactEmail") || null,
            tradeLicenceNo: text(formData, "tradeLicenceNo") || null,
            tradeLicenceExpiresOn: tradeLicenceExpiresOn ?? null,
            liabilityInsurer: text(formData, "liabilityInsurer") || null,
            liabilityPolicyNo: text(formData, "liabilityPolicyNo") || null,
            liabilityExpiresOn: liabilityExpiresOn ?? null,
            workmenCompInsurer: text(formData, "workmenCompInsurer") || null,
            workmenCompPolicyNo: text(formData, "workmenCompPolicyNo") || null,
            workmenCompExpiresOn: workmenCompExpiresOn ?? null,
            approvalReference: text(formData, "approvalReference") || null,
            taxRegistrationNumber: text(formData, "taxRegistrationNumber") || null,
            // Three parallel field arrays, one row per accreditation. The
            // domain layer drops anything with no name, so a blank spare row
            // costs nothing and does not need trimming here.
            accreditations: formData
              .getAll("accreditationName")
              .map((name, i) => ({
                name: String(name ?? "").trim(),
                issuer: String(formData.getAll("accreditationIssuer")[i] ?? "").trim() || null,
                expiresOn: (() => {
                  const raw = String(formData.getAll("accreditationExpiresOn")[i] ?? "").trim();
                  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
                })(),
              }))
              .filter((a) => a.name.length > 0),
            status: (status || "provisional") as SubcontractorStatus,
          },
        ),
    );

    revalidatePath("/workforce/subcontractors");
    revalidatePath("/hr");
    return { ok: `${name} saved to the register.` };
  } catch (error) {
    return { error: userMessage(error, "Could not save the subcontractor.", "workforce") };
  }
}

/** Withdraw a subcontractor from the register. Soft delete. */
export async function withdrawSubcontractor(
  _prev: WorkforceFormState,
  formData: FormData,
): Promise<WorkforceFormState> {
  const session = await requireSessionWith("workforce:write");

  const id = text(formData, "id");
  if (!id) return { error: "Missing subcontractor." };

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) => removeSubcontractor(tx, id),
    );
    revalidatePath("/workforce/subcontractors");
    revalidatePath("/hr");
    return { ok: "Withdrawn from the register." };
  } catch (error) {
    return { error: userMessage(error, "Could not withdraw that subcontractor.", "workforce") };
  }
}

/**
 * Record a supplied worker, and the verification of their permit (`HR-19`).
 *
 * One form, both facts. A separate "verify" step produces a register full of
 * workers with a permit number, an expiry date and nobody's name against them —
 * which is precisely the state that looks like compliance and is not. Whoever
 * enters the row is the person who saw the card, so the checkbox defaults to
 * checked and unticking it is the deliberate act.
 */
export async function saveSubcontractorWorker(
  _prev: WorkforceFormState,
  formData: FormData,
): Promise<WorkforceFormState> {
  const session = await requireSessionWith("workforce:write");

  const subcontractorId = text(formData, "subcontractorId");
  const fullName = text(formData, "fullName");
  if (!subcontractorId) return { error: "Missing subcontractor." };
  if (fullName.length < 2) return { error: "Name the worker." };

  const workPermitExpiresOn = calendarDate(formData.get("workPermitExpiresOn"));
  if (workPermitExpiresOn === null) return { error: "The work permit expiry is not a real date." };

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        recordSubcontractorWorker(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            subcontractorId,
            fullName,
            tradeSlug: text(formData, "tradeSlug") || null,
            workPermitNo: text(formData, "workPermitNo") || null,
            workPermitExpiresOn: workPermitExpiresOn ?? null,
            verified: text(formData, "verified") === "on",
          },
        ),
    );

    revalidatePath("/workforce/subcontractors");
    revalidatePath("/hr");
    return workPermitExpiresOn
      ? { ok: `${fullName} recorded, permit expiring ${readableDay(workPermitExpiresOn)}.` }
      : {
          ok:
            `${fullName} recorded — but with no permit expiry, so nothing is counting down to it. ` +
            `Deploying a worker without a valid permit carries AED 100,000 to AED 1,000,000 under Article 60, ` +
            `and responsibility does not transfer with the work.`,
        };
  } catch (error) {
    return { error: userMessage(error, "Could not record the worker.", "workforce") };
  }
}

/** Re-verify one supplied worker's permit, or stand them down (`HR-19`). */
export async function reverifySubcontractorWorker(
  _prev: WorkforceFormState,
  formData: FormData,
): Promise<WorkforceFormState> {
  const session = await requireSessionWith("workforce:write");

  const workerId = text(formData, "workerId");
  if (!workerId) return { error: "Missing worker." };

  const standDown = text(formData, "standDown") === "on";
  const workPermitExpiresOn = calendarDate(formData.get("workPermitExpiresOn"));
  if (workPermitExpiresOn === null) return { error: "The work permit expiry is not a real date." };

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        verifySubcontractorWorker(
          tx,
          { userId: session.principal.userId },
          {
            workerId,
            ...(standDown ? { isActive: false } : {}),
            ...(workPermitExpiresOn !== undefined ? { workPermitExpiresOn } : {}),
            ...(text(formData, "workPermitNo") ? { workPermitNo: text(formData, "workPermitNo") } : {}),
          },
        ),
    );

    revalidatePath("/workforce/subcontractors");
    revalidatePath("/hr");
    return standDown
      ? { ok: "Stood down. The permit is no longer counted against this supplier." }
      : { ok: "Permit re-verified, with your name against it." };
  } catch (error) {
    return { error: userMessage(error, "Could not update that worker.", "workforce") };
  }
}
