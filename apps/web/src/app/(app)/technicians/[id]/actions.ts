"use server";

import { revalidatePath } from "next/cache";
import {
  withTenant,
  upsertSkill,
  removeSkill,
  addCertification,
  removeCertification,
} from "@meridian/db";
import { getService } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { userMessage } from "@/lib/errors";

export interface WorkforceState {
  error?: string;
  ok?: string;
}

/** A date input gives "YYYY-MM-DD"; treat it as a Dubai-local calendar day. */
function parseDate(value: FormDataEntryValue | null): Date | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const parsed = new Date(`${raw}T00:00:00+04:00`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export async function saveSkill(
  _prev: WorkforceState,
  formData: FormData,
): Promise<WorkforceState> {
  const session = await requireSessionWith("technicians:write");

  const technicianId = String(formData.get("technicianId") ?? "");
  const serviceSlug = String(formData.get("serviceSlug") ?? "");
  const proficiency = Number(formData.get("proficiency") ?? 3);

  if (!technicianId) return { error: "Missing technician." };
  if (!getService(serviceSlug)) return { error: "Choose a service from the catalogue." };
  if (!Number.isInteger(proficiency) || proficiency < 1 || proficiency > 5) {
    return { error: "Proficiency must be 1 to 5." };
  }

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        upsertSkill(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          { technicianId, serviceSlug, proficiency },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not save the skill.", "technicians") };
  }

  revalidatePath(`/technicians/${technicianId}`);
  revalidatePath("/technicians");
  return { ok: `${getService(serviceSlug)?.shortName ?? serviceSlug} signed off.` };
}

export async function deleteSkill(
  _prev: WorkforceState,
  formData: FormData,
): Promise<WorkforceState> {
  const session = await requireSessionWith("technicians:write");

  const skillId = String(formData.get("skillId") ?? "");
  const technicianId = String(formData.get("technicianId") ?? "");
  if (!skillId) return { error: "Missing skill." };

  await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    (tx) => removeSkill(tx, skillId),
  );

  revalidatePath(`/technicians/${technicianId}`);
  revalidatePath("/technicians");
  return { ok: "Skill withdrawn." };
}

export async function saveCertification(
  _prev: WorkforceState,
  formData: FormData,
): Promise<WorkforceState> {
  const session = await requireSessionWith("technicians:write");

  const technicianId = String(formData.get("technicianId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const issuer = String(formData.get("issuer") ?? "").trim();
  const reference = String(formData.get("reference") ?? "").trim();
  const issuedOn = parseDate(formData.get("issuedOn"));
  const expiresOn = parseDate(formData.get("expiresOn"));
  const requiredForServices = formData
    .getAll("requiredFor")
    .map(String)
    .filter((slug) => getService(slug));

  if (!technicianId) return { error: "Missing technician." };
  if (name.length < 2) return { error: "Give the certification a name." };
  if (issuedOn && expiresOn && expiresOn <= issuedOn) {
    return { error: "The expiry date must be after the issue date." };
  }

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        addCertification(
          tx,
          { tenantId: session.principal.tenantId },
          {
            technicianId,
            name,
            issuer: issuer || undefined,
            reference: reference || undefined,
            issuedOn,
            expiresOn,
            requiredForServices,
          },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not record the certification.", "technicians") };
  }

  revalidatePath(`/technicians/${technicianId}`);
  revalidatePath("/technicians");
  return { ok: `${name} recorded.` };
}

export async function deleteCertification(
  _prev: WorkforceState,
  formData: FormData,
): Promise<WorkforceState> {
  const session = await requireSessionWith("technicians:write");

  const certificationId = String(formData.get("certificationId") ?? "");
  const technicianId = String(formData.get("technicianId") ?? "");
  if (!certificationId) return { error: "Missing certification." };

  await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    (tx) => removeCertification(tx, certificationId),
  );

  revalidatePath(`/technicians/${technicianId}`);
  revalidatePath("/technicians");
  return { ok: "Certification removed." };
}
