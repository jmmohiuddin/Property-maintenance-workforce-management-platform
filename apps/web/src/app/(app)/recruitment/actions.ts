"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withTenant } from "@meridian/db";
import {
  approveRequisition,
  cancelScheduledOutcome,
  closeApplication,
  closeRequisition,
  createRequisition,
  hireCandidate,
  markOutcomeSent,
  mergeCandidates,
  moveApplicationStage,
  publishRequisition,
  reconfirmTalentPoolMember,
  reopenApplication,
  withdrawTalentPoolConsent,
  setBlockedOn,
  setVisaStatus,
} from "@meridian/db/domain";
import {
  applicationStatusUrl,
  talentPoolReconfirmSchema,
  talentPoolWithdrawSchema,
} from "@meridian/core";
import { enqueue } from "@meridian/notify";
import { requirePermission } from "@meridian/auth";
import { requireSession } from "@/lib/session";
import { userMessage } from "@/lib/errors";
import type {
  Availability,
  BlockedOn,
  CandidateGrade,
  ContractType,
  VisaStatus,
} from "@meridian/core";

/**
 * Recruitment actions.
 *
 * Every one of them checks its permission here rather than trusting the screen
 * to have hidden the button — a POST can be sent directly, and `recruitment:*`
 * is the permission that gates access to a phone number, a certificate number
 * and a person's employment history.
 *
 * None of them validates a disposition reason, a stage transition or a salary
 * band. Those rules live in `packages/db/src/domain/recruitment.ts`, behind
 * database constraints, because a rule enforced in an action is a rule the next
 * caller — an importer, a bulk action, the field app — does not have.
 */

async function staff() {
  const session = await requireSession();
  return {
    session,
    ctx: {
      tenantId: session.principal.tenantId,
      userId: session.principal.userId,
      actorKind: "user" as const,
    },
  };
}

export interface ActionState {
  error?: string;
  success?: string;
}

// ── Requisitions ────────────────────────────────────────────────────────────

export async function createRequisitionAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { session, ctx } = await staff();
  try {
    requirePermission(session.principal, "recruitment:write");
  } catch {
    return { error: "Your role cannot open a vacancy." };
  }

  const money = (name: string): number | undefined => {
    const raw = String(formData.get(name) ?? "").trim();
    if (!raw) return undefined;
    const value = Number(raw.replace(/,/g, ""));
    return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : undefined;
  };

  const closesRaw = String(formData.get("closesAt") ?? "").trim();

  let requisitionId: string;
  try {
    const result = await withTenant(ctx, (tx) =>
      createRequisition(tx, ctx, {
        title: String(formData.get("title") ?? ""),
        trade: String(formData.get("trade") ?? ""),
        grade: String(formData.get("grade") ?? "technician") as CandidateGrade,
        headcount: Number(formData.get("headcount") ?? 1) || 1,
        contractType: String(formData.get("contractType") ?? "full_time") as ContractType,
        locationCity: String(formData.get("locationCity") ?? "Dubai").trim() || "Dubai",
        locationArea: String(formData.get("locationArea") ?? "").trim() || undefined,
        minExperienceYears: Number(formData.get("minExperienceYears") ?? "") || undefined,
        summary: String(formData.get("summary") ?? "").trim() || undefined,
        responsibilities: String(formData.get("responsibilities") ?? "").trim() || undefined,
        physicalRequirements:
          String(formData.get("physicalRequirements") ?? "").trim() || undefined,
        requiredCertifications: String(formData.get("requiredCertifications") ?? "")
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean),
        salaryBandMinMinor: money("salaryMin"),
        salaryBandMaxMinor: money("salaryMax"),
        closesAt: closesRaw ? new Date(closesRaw) : undefined,
        // `ATS-1`. Empty means nobody was named, which is a state — not a
        // reason to write an empty string into a uuid column.
        hiringManagerUserId: String(formData.get("hiringManagerUserId") ?? "").trim() || undefined,
      }),
    );
    requisitionId = result.requisitionId;
  } catch (error) {
    return { error: userMessage(error, "Could not open the vacancy.", "recruitment") };
  }

  revalidatePath("/recruitment");
  redirect(`/recruitment/${requisitionId}`);
}

export async function approveRequisitionAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { session, ctx } = await staff();
  try {
    requirePermission(session.principal, "recruitment:write");
  } catch {
    return { error: "Your role cannot approve a vacancy." };
  }

  const requisitionId = String(formData.get("requisitionId") ?? "");
  try {
    await withTenant(ctx, (tx) => approveRequisition(tx, ctx, requisitionId));
  } catch (error) {
    return { error: userMessage(error, "Could not approve this vacancy.", "recruitment") };
  }

  revalidatePath(`/recruitment/${requisitionId}`);
  return { success: "Approved. It can now be published to the careers site." };
}

export async function publishRequisitionAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { session, ctx } = await staff();
  try {
    requirePermission(session.principal, "recruitment:write");
  } catch {
    return { error: "Your role cannot publish a vacancy." };
  }

  const requisitionId = String(formData.get("requisitionId") ?? "");
  try {
    await withTenant(ctx, (tx) => publishRequisition(tx, ctx, requisitionId));
  } catch (error) {
    return { error: userMessage(error, "Could not publish this vacancy.", "recruitment") };
  }

  revalidatePath(`/recruitment/${requisitionId}`);
  revalidatePath("/careers");
  return { success: "Live on the careers site, with JobPosting structured data." };
}

export async function closeRequisitionAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { session, ctx } = await staff();
  try {
    requirePermission(session.principal, "recruitment:write");
  } catch {
    return { error: "Your role cannot close a vacancy." };
  }

  const requisitionId = String(formData.get("requisitionId") ?? "");
  const status = String(formData.get("closeStatus") ?? "filled") === "cancelled"
    ? ("cancelled" as const)
    : ("filled" as const);

  try {
    await withTenant(ctx, (tx) => closeRequisition(tx, ctx, requisitionId, status));
  } catch (error) {
    // The domain refuses while anyone is still live, and says how many. That
    // message is the whole point — closing a role with eleven people in
    // Screening is how eleven people never hear anything.
    return { error: userMessage(error, "Could not close this vacancy.", "recruitment") };
  }

  revalidatePath("/recruitment");
  revalidatePath(`/recruitment/${requisitionId}`);
  revalidatePath("/careers");
  return { success: "Closed, and removed from the careers site." };
}

// ── Pipeline ────────────────────────────────────────────────────────────────

export async function moveStageAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { session, ctx } = await staff();
  try {
    requirePermission(session.principal, "recruitment:write");
  } catch {
    return { error: "Your role cannot move candidates through the pipeline." };
  }

  const applicationId = String(formData.get("applicationId") ?? "");
  try {
    await withTenant(ctx, (tx) =>
      moveApplicationStage(tx, ctx, {
        applicationId,
        toStageId: String(formData.get("toStageId") ?? ""),
        note: String(formData.get("note") ?? "").trim() || undefined,
      }),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not move this candidate.", "recruitment") };
  }

  revalidatePath(`/recruitment/candidate/${applicationId}`);
  revalidatePath("/recruitment");
  return { success: "Moved." };
}

export async function setBlockedOnAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { session, ctx } = await staff();
  try {
    requirePermission(session.principal, "recruitment:write");
  } catch {
    return { error: "Your role cannot update this." };
  }

  const applicationId = String(formData.get("applicationId") ?? "");
  try {
    await withTenant(ctx, (tx) =>
      setBlockedOn(tx, ctx, {
        applicationId,
        blockedOn: String(formData.get("blockedOn") ?? "none") as BlockedOn,
        note: String(formData.get("blockedNote") ?? "").trim() || undefined,
      }),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not update this.", "recruitment") };
  }

  revalidatePath(`/recruitment/candidate/${applicationId}`);
  revalidatePath("/recruitment");
  return { success: "Recorded. The candidate's own page shows the same thing." };
}

export async function setVisaStatusAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { session, ctx } = await staff();
  try {
    requirePermission(session.principal, "recruitment:write");
  } catch {
    return { error: "Your role cannot record this." };
  }

  const applicationId = String(formData.get("applicationId") ?? "");
  try {
    await withTenant(ctx, (tx) =>
      setVisaStatus(tx, ctx, {
        candidateId: String(formData.get("candidateId") ?? ""),
        visaStatus: String(formData.get("visaStatus") ?? "") as VisaStatus,
        currentSponsor: String(formData.get("visaCurrentSponsor") ?? "").trim() || undefined,
      }),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not record the visa status.", "recruitment") };
  }

  revalidatePath(`/recruitment/candidate/${applicationId}`);
  return { success: "Recorded, for permit and timeline planning only." };
}

/**
 * Archive, which always schedules an outcome (`ATS-16`).
 *
 * There is no "send message" checkbox in this form data and there is no
 * parameter for one in `closeApplication`. The wireframe draws the checkbox as
 * ticked and required; a required checkbox is still a checkbox, and this is
 * what makes it a fact.
 */
export async function archiveApplicationAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { session, ctx } = await staff();
  try {
    requirePermission(session.principal, "recruitment:write");
  } catch {
    return { error: "Your role cannot archive an application." };
  }

  const applicationId = String(formData.get("applicationId") ?? "");

  try {
    const result = await withTenant(ctx, (tx) =>
      closeApplication(tx, ctx, {
        applicationId,
        dispositionCode: String(formData.get("dispositionCode") ?? ""),
        note: String(formData.get("note") ?? "").trim() || undefined,
        addToTalentPool: formData.get("addToTalentPool") === "on",
      }),
    );

    revalidatePath(`/recruitment/candidate/${applicationId}`);
    revalidatePath("/recruitment");

    return {
      success: result.requiresHumanSend
        ? "Archived. The message is written and waiting for you to send it — an automated rejection is not permitted after a human has spoken to this candidate (ATS-15)."
        : `Archived. The message goes out in 24 hours and can be cancelled until then.`,
    };
  } catch (error) {
    return { error: userMessage(error, "Could not archive this application.", "recruitment") };
  }
}

/** `ATS-15`. Uses the window; does not discharge the obligation. */
export async function cancelOutcomeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { session, ctx } = await staff();
  try {
    requirePermission(session.principal, "recruitment:write");
  } catch {
    return { error: "Your role cannot cancel a message." };
  }

  const applicationId = String(formData.get("applicationId") ?? "");
  try {
    await withTenant(ctx, (tx) => cancelScheduledOutcome(tx, ctx, applicationId));
  } catch (error) {
    return { error: userMessage(error, "Could not cancel that message.", "recruitment") };
  }

  revalidatePath(`/recruitment/candidate/${applicationId}`);
  return {
    success:
      "Cancelled. This application still owes the candidate an outcome and stays on the owed list until one is sent.",
  };
}

/**
 * Send a composed outcome now (`ATS-15`).
 *
 * The path for everything past Screening, where an automated send is not
 * permitted. The message was written when the decision was made, so this is a
 * person reading it and pressing send rather than a person writing a rejection
 * from scratch at the end of a long week — which is the version that does not
 * happen.
 */
export async function sendOutcomeNowAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { session, ctx } = await staff();
  try {
    requirePermission(session.principal, "recruitment:write");
  } catch {
    return { error: "Your role cannot send this." };
  }

  const applicationId = String(formData.get("applicationId") ?? "");
  const email = String(formData.get("candidateEmail") ?? "").trim();
  const firstName = String(formData.get("candidateFirstName") ?? "").trim();
  const roleTitle = String(formData.get("roleTitle") ?? "").trim();
  const reference = String(formData.get("reference") ?? "").trim();
  const message = String(formData.get("outcomeMessage") ?? "").trim();
  const statusToken = String(formData.get("statusToken") ?? "").trim();

  if (!message) {
    return { error: "There is no message to send. Archive the application with a reason first." };
  }
  if (!email) {
    // Said plainly rather than silently marking it sent. This applicant gave a
    // phone number and no email, and no SMS transport exists (ATS-14 asks for
    // that channel first). Stamping "sent" here would make the accountability
    // report lie, which is the one thing it cannot do.
    return {
      error:
        "This candidate gave a phone number and no email address, and no SMS or WhatsApp transport is configured. Call them, then record the outcome — do not mark it sent until somebody has actually told them.",
    };
  }

  try {
    await withTenant(ctx, async (tx) => {
      const queued = await enqueue(tx, ctx, {
        channel: "email",
        template: "application_outcome",
        to: email,
        subject: { table: "applications", id: applicationId },
        payload: {
          candidateFirstName: firstName,
          roleTitle,
          applicationReference: reference,
          message,
          statusUrl: applicationStatusUrl(statusToken),
        },
      });

      await markOutcomeSent(tx, ctx, {
        applicationId,
        channel: "email",
        notificationId: "notificationId" in queued ? queued.notificationId : undefined,
      });
    });
  } catch (error) {
    return { error: userMessage(error, "Could not send that message.", "recruitment") };
  }

  revalidatePath(`/recruitment/candidate/${applicationId}`);
  revalidatePath("/recruitment");
  return { success: "Sent. This applicant has now been told." };
}

export async function reopenApplicationAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { session, ctx } = await staff();
  try {
    requirePermission(session.principal, "recruitment:write");
  } catch {
    return { error: "Your role cannot reopen an application." };
  }

  const applicationId = String(formData.get("applicationId") ?? "");
  try {
    await withTenant(ctx, (tx) => reopenApplication(tx, ctx, applicationId));
  } catch (error) {
    return { error: userMessage(error, "Could not reopen this application.", "recruitment") };
  }

  revalidatePath(`/recruitment/candidate/${applicationId}`);
  revalidatePath("/recruitment");
  return { success: "Reopened." };
}

export async function mergeCandidatesAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { session, ctx } = await staff();
  try {
    requirePermission(session.principal, "recruitment:write");
  } catch {
    return { error: "Your role cannot merge candidate records." };
  }

  const applicationId = String(formData.get("applicationId") ?? "");
  try {
    const result = await withTenant(ctx, (tx) =>
      mergeCandidates(tx, ctx, {
        survivorId: String(formData.get("survivorId") ?? ""),
        mergedId: String(formData.get("mergedId") ?? ""),
      }),
    );
    revalidatePath(`/recruitment/candidate/${applicationId}`);
    return {
      success: `Merged. ${result.applicationsMoved} application(s) moved across; nothing was deleted.`,
    };
  } catch (error) {
    return { error: userMessage(error, "Could not merge those records.", "recruitment") };
  }
}

// ── Talent pool (`ATS-13`) ──────────────────────────────────────────────────

/**
 * Re-confirm a pool member's consent.
 *
 * ── WHY THIS IS A BUTTON A PERSON PRESSES ───────────────────────────────────
 *
 * The consent clock was being set on the way in and alerted on when it ran out,
 * and nothing could ever stop it — there was no path in the product that wrote
 * `reconfirmed_at`. So the pool could only accumulate overdue members, and a
 * list that only grows is a list that gets ignored, which leaves the details
 * held past the consent that justified holding them.
 *
 * It is deliberately one row at a time and deliberately manual. The fact being
 * recorded is that somebody spoke to this person and they said yes; a "confirm
 * all" button would record that fact about people nobody called.
 *
 * No message is enqueued. The conversation already happened — that is what is
 * being written down — so there is nothing to send and nothing to schedule.
 */
export async function reconfirmPoolMemberAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = talentPoolReconfirmSchema.safeParse({
    candidateId: String(formData.get("candidateId") ?? ""),
    poolKey: String(formData.get("poolKey") ?? ""),
    note: String(formData.get("note") ?? ""),
  });
  if (!parsed.success) {
    return { error: "That re-confirmation was not complete enough to record." };
  }

  const { session, ctx } = await staff();
  try {
    requirePermission(session.principal, "recruitment:write");
  } catch {
    return { error: "Your role cannot re-confirm a pool member." };
  }

  let result: { fullName: string; nextDueAt: Date };
  try {
    result = await withTenant(ctx, (tx) =>
      reconfirmTalentPoolMember(tx, ctx, {
        candidateId: parsed.data.candidateId,
        poolKey: parsed.data.poolKey,
        note: parsed.data.note || undefined,
      }),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not record that re-confirmation.", "recruitment") };
  }

  revalidatePath("/recruitment/pool");
  revalidatePath("/recruitment");

  return {
    success: `${result.fullName} re-confirmed. Due again ${result.nextDueAt.toLocaleDateString("en-GB", {
      timeZone: "Asia/Dubai",
      day: "numeric",
      month: "short",
      year: "numeric",
    })}.`,
  };
}

/**
 * Withdraw a pool consent (`ATS-13`).
 *
 * The other half of the same cycle, and the half nothing in the product could
 * do at all: `consent_withdrawn_at` was read by the pool list, both alerts and
 * the retention purge, and written by nothing.
 *
 * It is on this screen rather than behind an administrator, because the request
 * arrives as "take me off your list" on a phone call to whoever is working the
 * pool that morning, and a right that requires a support ticket is a right with
 * a queue in front of it.
 */
export async function withdrawPoolConsentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = talentPoolWithdrawSchema.safeParse({
    candidateId: String(formData.get("candidateId") ?? ""),
    poolKey: String(formData.get("poolKey") ?? ""),
    reason: String(formData.get("reason") ?? ""),
  });
  if (!parsed.success) {
    return { error: "That withdrawal was not complete enough to record." };
  }

  const { session, ctx } = await staff();
  try {
    requirePermission(session.principal, "recruitment:write");
  } catch {
    return { error: "Your role cannot withdraw a pool consent." };
  }

  let result: { fullName: string; retentionBasis: string; remainingPools: number };
  try {
    result = await withTenant(ctx, (tx) =>
      withdrawTalentPoolConsent(tx, ctx, {
        candidateId: parsed.data.candidateId,
        poolKey: parsed.data.poolKey,
        reason: parsed.data.reason || undefined,
      }),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not record that withdrawal.", "recruitment") };
  }

  revalidatePath("/recruitment/pool");
  revalidatePath("/recruitment");

  return {
    success:
      `${result.fullName} removed from this pool.` +
      (result.remainingPools > 0
        ? ` They are still in ${result.remainingPools} other pool(s), so their details stay on the consent clock.`
        : " No consent remains, so their record is back on the six-month applicant clock and the nightly purge will delete it on time."),
  };
}

/**
 * Hire (`ATS-17`).
 *
 * Note what this action does **not** collect: a fee, a bond, a repayment, a
 * visa cost to recover. `HR-16` prohibits recovering recruitment costs from a
 * worker, and there is no field here, no argument in `hireCandidate` and no
 * column in the schema through which one could be recorded.
 */
export async function hireAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { session, ctx } = await staff();
  try {
    requirePermission(session.principal, "recruitment:write");
    // A hire creates a technician record, so it needs that permission too. The
    // person filling a vacancy and the person who may create staff records
    // should be the same person, and this is where that is checked.
    requirePermission(session.principal, "technicians:write");
  } catch {
    return { error: "Your role cannot convert a candidate to an employee." };
  }

  const applicationId = String(formData.get("applicationId") ?? "");
  const date = (name: string): Date | undefined => {
    const raw = String(formData.get(name) ?? "").trim();
    return raw ? new Date(raw) : undefined;
  };
  const contractStart = date("contractStart");
  if (!contractStart) return { error: "Give the contract a start date." };

  const salaryRaw = String(formData.get("basicSalary") ?? "").trim();
  const basicSalaryMinor = salaryRaw
    ? Math.round(Number(salaryRaw.replace(/,/g, "")) * 100)
    : undefined;

  try {
    const result = await withTenant(ctx, (tx) =>
      hireCandidate(tx, ctx, {
        applicationId,
        employeeCode: String(formData.get("employeeCode") ?? ""),
        contractStart,
        contractEnd: date("contractEnd"),
        probationEnd: date("probationEnd"),
        noticePeriodDays: Number(formData.get("noticePeriodDays") ?? 30) || 30,
        basicSalaryMinor,
        baseCity: String(formData.get("baseCity") ?? "").trim() || undefined,
      }),
    );

    revalidatePath(`/recruitment/candidate/${applicationId}`);
    revalidatePath("/recruitment");
    revalidatePath("/technicians");
    revalidatePath("/workforce");

    return {
      success:
        `Hired. ${result.certificationsCarried} certification(s) carried across with their expiry dates — nothing re-keyed. ` +
        result.notice,
    };
  } catch (error) {
    return { error: userMessage(error, "Could not complete the hire.", "recruitment") };
  }
}
