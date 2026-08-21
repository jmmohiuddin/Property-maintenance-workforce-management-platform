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
  type EmployeeDocumentKind,
  type AccreditationKind,
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
