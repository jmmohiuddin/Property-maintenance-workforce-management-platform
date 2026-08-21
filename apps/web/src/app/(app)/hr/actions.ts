"use server";

import { revalidatePath } from "next/cache";
import {
  withTenant,
  prepareWageFile,
  confirmWageTransfer,
  currentWageCycle,
  recordContractTerm,
  saveLeaveBalance,
  recordSickLeave,
  recordOvertime,
  recordWorkedDay,
  saveHealthInsurance,
  recordSalaryDeduction,
  recordGratuitySettlement,
  markGratuitySettlementPaid,
  saveOccupationClassification,
} from "@meridian/db";
import {
  toMinor,
  formatMoney,
  formatDay,
  fromDubai,
  addDays,
  HEALTH_PLANS,
  PAY_BAND_LABEL,
  type HealthPlan,
  type PayBand,
} from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { userMessage } from "@/lib/errors";

/**
 * Writes for the employment lifecycle (`HR-4`, `HR-6`, `HR-7`, `HR-8`, `HR-17`).
 *
 * Every one of these re-checks `workforce:write` on the server. The pages hide
 * the forms from a read-only role, but hiding a form is not authorisation — a
 * `curl` with a session cookie never sees the page at all.
 *
 * ── THE ONE THAT IS A REQUIREMENT RATHER THAN A FORM ────────────────────────
 *
 * `recordDeduction` below cannot record a health-insurance premium, and neither
 * can anything else. `HR-6` states it structurally — the premium is
 * employer-funded and "may not be deducted from salary" — so the refusal is a
 * positive list in `packages/core`, a plain-language message from
 * `refuseDeduction`, and a CHECK constraint on `salary_deductions.kind`. This
 * action is the third of those three and the weakest; it exists so the person
 * gets a sentence naming Dubai Law No. 11 of 2013 rather than a constraint
 * violation, not because it is what makes the rule true.
 */

export interface HrFormState {
  error?: string;
  ok?: string;
}

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/**
 * A calendar day, kept as the string the browser sent.
 *
 * Same rule as `workforce/actions.ts`: `<input type="date">` submits
 * `YYYY-MM-DD` and the Postgres `date` column stores exactly that. Parsing it
 * into a `Date` in between introduces a timezone, and a timezone applied to a
 * wage deadline is how a payment made on the 1st gets recorded as made on the
 * 31st — in the direction that says a late payment was on time.
 */
function calendarDate(value: FormDataEntryValue | null): string | undefined | null {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) return null;
  return raw;
}

/**
 * An amount typed by a person, in minor units.
 *
 * `toMinor` on the string, never `Number()` then `* 100`. "1234.56" through a
 * float and back is 123455.99999999999, and rounding that is the arithmetic
 * every money bug in every payroll system starts as.
 */
function amountMinor(value: FormDataEntryValue | null): number | null {
  const raw = String(value ?? "").trim().replace(/,/g, "");
  if (!raw) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  return toMinor(raw);
}

// ── HR-17: the wage cycle ───────────────────────────────────────────────────

/**
 * Produce the wage-file inputs for the live cycle (`HR-17`, due by T-3).
 *
 * Also runs unattended in `/api/cron/compliance` at T-3. Both exist on purpose:
 * the job is the guarantee, and this button is what an accountant presses when
 * they want the numbers before the job would have produced them. Idempotent —
 * it upserts, so pressing it twice changes nothing.
 */
export async function buildWageFile(
  _prev: HrFormState,
  _formData: FormData,
): Promise<HrFormState> {
  const session = await requireSessionWith("workforce:write");

  try {
    const result = await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      async (tx) => {
        const cycle = await currentWageCycle(tx, { tenantId: session.principal.tenantId });
        const file = await prepareWageFile(tx, { tenantId: session.principal.tenantId }, cycle.id);
        return { cycle, file };
      },
    );

    revalidatePath("/hr/payroll");
    revalidatePath("/hr");
    return {
      ok:
        `Wage file inputs built for ${result.cycle.assessment.label}: ${result.file.lines.length} ` +
        `employee${result.file.lines.length === 1 ? "" : "s"}, ${formatMoney(result.file.totalDueMinor)} due by ` +
        `${formatDay(result.cycle.dueOn)}.`,
    };
  } catch (error) {
    return { error: userMessage(error, "Could not build the wage file.", "hr") };
  }
}

/**
 * Record that the WPS transfer happened, and for how much.
 *
 * The amount is asked for rather than assumed equal to the total due, because
 * 85% is the compliance line and a partial transfer is a real state that must
 * be assessed against it rather than rounded up to "paid". A cycle recorded as
 * settled when 60% went out is the one an establishment finds out about when
 * its work permits stop being issued.
 */
export async function confirmTransfer(
  _prev: HrFormState,
  formData: FormData,
): Promise<HrFormState> {
  const session = await requireSessionWith("workforce:write");

  const cycleId = text(formData, "cycleId");
  const reference = text(formData, "transferReference");
  const transferred = amountMinor(formData.get("transferred"));
  const confirmedOn = calendarDate(formData.get("confirmedOn"));

  if (!cycleId) return { error: "Missing wage cycle." };
  if (transferred === null) return { error: "Enter the amount transferred, as a number." };
  if (!reference) {
    return {
      error:
        "Record the bank or SIF reference. A transfer with no reference is an assertion, and it is the first thing an inspection asks for evidence of.",
    };
  }
  if (confirmedOn === null) return { error: "The transfer date is not a real date." };

  try {
    const cycle = await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        confirmWageTransfer(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            cycleId,
            transferredMinor: transferred,
            transferReference: reference,
            ...(confirmedOn ? { confirmedOn } : {}),
          },
        ),
    );

    revalidatePath("/hr/payroll");
    revalidatePath("/hr");

    // The result is reported, not assumed. An 84% transfer is recorded and is
    // still a violation, and this message is where that gets said rather than
    // being discovered from an escalation email the next morning.
    return cycle.assessment.meetsThreshold
      ? { ok: `${cycle.assessment.label} recorded as transferred. ${cycle.assessment.headline}` }
      : {
          error:
            `Recorded — but this cycle is still non-compliant. ${cycle.assessment.consequence} ` +
            `Transfer the shortfall of ${formatMoney(cycle.assessment.shortfallMinor)} and record it again.`,
        };
  } catch (error) {
    return { error: userMessage(error, "Could not record the transfer.", "hr") };
  }
}

// ── HR-4: contract terms ────────────────────────────────────────────────────

export async function saveContractTerm(
  _prev: HrFormState,
  formData: FormData,
): Promise<HrFormState> {
  const session = await requireSessionWith("workforce:write");

  const employeeId = text(formData, "employeeId");
  const startsOn = calendarDate(formData.get("startsOn"));
  const endsOn = calendarDate(formData.get("endsOn"));
  const probationEndsOn = calendarDate(formData.get("probationEndsOn"));
  const noticeRaw = text(formData, "noticePeriodDays");
  const basic = amountMinor(formData.get("basicSalary"));
  const workingPattern = text(formData, "workingPattern");

  if (!employeeId) return { error: "Missing employment record." };
  if (startsOn === null) return { error: "The start date is not a real date." };
  if (!startsOn) return { error: "Record the start date." };
  if (endsOn === null) return { error: "The end date is not a real date." };
  if (!endsOn) {
    return {
      error:
        "Record the end date. UAE private-sector contracts are fixed-term only, and a term with no end date cannot auto-renew, cannot be given notice against, and cannot be proved to an inspector.",
    };
  }
  if (probationEndsOn === null) return { error: "The probation end date is not a real date." };

  const noticePeriodDays = noticeRaw === "" ? 30 : Number(noticeRaw);
  if (!Number.isInteger(noticePeriodDays) || noticePeriodDays < 30 || noticePeriodDays > 90) {
    return {
      error:
        "Notice must be between 30 and 90 days. Outside that range the clause is unenforceable, and in practice it is the employer's notice that fails.",
    };
  }

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        recordContractTerm(
          tx,
          { tenantId: session.principal.tenantId },
          {
            employeeId,
            startsOn,
            endsOn,
            probationEndsOn: probationEndsOn ?? null,
            noticePeriodDays,
            basicSalaryMinor: basic,
            workingPattern: workingPattern || null,
            origin: "signed",
          },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not record the contract term.", "hr") };
  }

  revalidatePath(`/workforce/${employeeId}`);
  revalidatePath("/hr");
  return { ok: `Contract recorded, running to ${formatDay(endsOn)}.` };
}

// ── HR-7: leave ─────────────────────────────────────────────────────────────

export async function saveLeaveAdjustment(
  _prev: HrFormState,
  formData: FormData,
): Promise<HrFormState> {
  const session = await requireSessionWith("workforce:write");

  const employeeId = text(formData, "employeeId");
  const leaveYearStart = calendarDate(formData.get("leaveYearStart"));
  const carried = Number(text(formData, "carriedOverDays") || "0");
  const adjustment = Number(text(formData, "adjustmentDays") || "0");
  const reason = text(formData, "reason");

  if (!employeeId) return { error: "Missing employment record." };
  if (leaveYearStart === null) return { error: "The leave year start is not a real date." };
  if (!leaveYearStart) return { error: "Choose the leave year this applies to." };
  if (!Number.isInteger(carried) || !Number.isInteger(adjustment)) {
    return { error: "Leave is counted in whole calendar days." };
  }
  if (adjustment !== 0 && !reason) {
    return {
      error:
        "Give a reason for the adjustment. Leave adjustments are challenged at termination, and one with no stated reason is indistinguishable from a mistake by then.",
    };
  }

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        saveLeaveBalance(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          { employeeId, leaveYearStart, carriedOverDays: carried, adjustmentDays: adjustment, reason },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not save the leave balance.", "hr") };
  }

  revalidatePath(`/workforce/${employeeId}`);
  revalidatePath("/hr");
  return { ok: "Leave balance saved." };
}

/**
 * Record an absence as sick leave (`HR-7`).
 *
 * The staging is not asked for and cannot be typed in. Which days are at full
 * pay, which at half and which unpaid depends on what the rest of the leave
 * year already holds, and a field that let somebody state it would let them
 * state fifteen days of full pay for the second time in a year — which is the
 * mistake this feature exists to prevent, not one it should offer.
 */
export async function saveSickLeave(_prev: HrFormState, formData: FormData): Promise<HrFormState> {
  const session = await requireSessionWith("workforce:write");

  const employeeId = text(formData, "employeeId");
  const startsOn = calendarDate(formData.get("startsOn"));
  const endsOn = calendarDate(formData.get("endsOn"));
  const reason = text(formData, "reason");

  if (!employeeId) return { error: "Missing employment record." };
  if (startsOn === null) return { error: "The first day of the absence is not a real date." };
  if (!startsOn) return { error: "Record the first day of the absence." };
  if (endsOn === null) return { error: "The last day of the absence is not a real date." };
  if (!endsOn) return { error: "Record the last day of the absence." };

  try {
    const result = await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        recordSickLeave(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          { employeeId, startsOn, endsOn, ...(reason ? { reason } : {}) },
        ),
    );

    revalidatePath(`/workforce/${employeeId}`);
    revalidatePath("/hr");

    // The staged split, said back. Somebody recording a twenty-day absence
    // needs to see that five of those days are at half pay before they leave
    // the page, not when payroll is questioned two months later.
    const period = result.year?.periods.find((p) => p.id === result.id);
    return {
      ok:
        `${result.days} day${result.days === 1 ? "" : "s"} recorded as sick leave. ` +
        (period ? `${period.explanation} ` : "") +
        "Sick leave is a separate entitlement — it does not come out of annual leave.",
    };
  } catch (error) {
    return { error: userMessage(error, "Could not record the sick leave.", "hr") };
  }
}

// ── HR-8: overtime ──────────────────────────────────────────────────────────

export async function saveOvertime(_prev: HrFormState, formData: FormData): Promise<HrFormState> {
  const session = await requireSessionWith("workforce:write");

  const employeeId = text(formData, "employeeId");
  const workedOn = calendarDate(formData.get("workedOn"));
  const band = text(formData, "band") as PayBand;
  const minutes = Number(text(formData, "minutes") || "0");
  const restDayCompensation = text(formData, "restDayCompensation");
  const substituteDayOn = calendarDate(formData.get("substituteDayOn"));
  const note = text(formData, "note");

  if (!employeeId) return { error: "Missing employment record." };
  if (workedOn === null) return { error: "The date worked is not a real date." };
  if (!workedOn) return { error: "Record the date the hours were worked." };
  if (!(band in PAY_BAND_LABEL)) return { error: "Choose a rate band." };
  if (!Number.isInteger(minutes) || minutes <= 0) return { error: "Record the minutes worked." };
  if (substituteDayOn === null) return { error: "The substitute day is not a real date." };

  try {
    const result = await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        recordOvertime(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            employeeId,
            workedOn,
            band,
            minutes,
            ...(restDayCompensation === "substitute_day" || restDayCompensation === "premium_pay"
              ? { restDayCompensation }
              : {}),
            ...(substituteDayOn ? { substituteDayOn } : {}),
            source: "manual",
            ...(note ? { note } : {}),
          },
        ),
    );

    revalidatePath(`/workforce/${employeeId}`);
    revalidatePath("/hr");

    const recorded = `${(minutes / 60).toFixed(1)} hours recorded at ${PAY_BAND_LABEL[band]} — ${formatMoney(result.amountMinor)}.`;

    // The 48-hour week, at the moment the hours are entered rather than on a
    // report somebody reads next month. Reported either way: a week that is
    // still inside the maximum is worth seeing too, because the number is a
    // floor and the person entering it is the one who knows what is missing.
    return result.weekly.withinLimit
      ? { ok: `${recorded} ${result.weekly.detail}` }
      : { error: `Recorded — and this week is now over the statutory maximum. ${result.weekly.detail}` };
  } catch (error) {
    return { error: userMessage(error, "Could not record the overtime.", "hr") };
  }
}

/**
 * A whole worked day, from its start and end (`HR-8`).
 *
 * ── WHY THE SPLIT IS NOT A FIELD ON THIS FORM ───────────────────────────────
 *
 * Because the split is the part that is easy to get wrong in the expensive
 * direction. A shift from 20:00 to 04:00 is eight hours, all of it ordinary
 * time, and none of it earns the +50% night premium — the statutory day is
 * worked first and only what follows it is overtime. Classified on the clock it
 * looks like six hours at +50%. So the times are asked for and
 * `splitWorkedWindow` decides the bands, including the Ramadan reduction that
 * shortens the ordinary day to six hours.
 */
export async function saveWorkedDay(_prev: HrFormState, formData: FormData): Promise<HrFormState> {
  const session = await requireSessionWith("workforce:write");

  const employeeId = text(formData, "employeeId");
  const workedOn = calendarDate(formData.get("workedOn"));
  const startAt = text(formData, "startAt");
  const endAt = text(formData, "endAt");
  const breakRaw = text(formData, "breakMinutes");
  const isRestDay = text(formData, "isRestDay") === "on";
  const note = text(formData, "note");

  if (!employeeId) return { error: "Missing employment record." };
  if (workedOn === null) return { error: "The date worked is not a real date." };
  if (!workedOn) return { error: "Record the date the day was worked." };

  const start = minuteOfDay(startAt);
  const end = minuteOfDay(endAt);
  if (start === null || end === null) return { error: "Record the start and end times, as HH:MM." };

  const breakMinutes = breakRaw === "" ? 0 : Number(breakRaw);
  if (!Number.isInteger(breakMinutes) || breakMinutes < 0) {
    return { error: "The unpaid break is a whole number of minutes." };
  }

  // A shift that ends at or before it starts ended the following day — 20:00
  // to 04:00 is the ordinary night shift, not an eight-hour negative.
  const [y, m, d] = workedOn.split("-").map(Number) as [number, number, number];
  const endDay = end <= start ? addDays(workedOn, 1) : workedOn;
  const [ey, em, ed] = endDay.split("-").map(Number) as [number, number, number];

  try {
    const result = await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        recordWorkedDay(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            employeeId,
            workedOn,
            start: fromDubai(y, m, d, start),
            end: fromDubai(ey, em, ed, end),
            breakMinutes,
            isRestDay,
            ...(note ? { note } : {}),
          },
        ),
    );

    revalidatePath(`/workforce/${employeeId}`);
    revalidatePath("/hr");

    const hours = (minutes: number) => (minutes / 60).toFixed(1);
    const bands = [
      result.split.standardMinutes > 0 ? `${hours(result.split.standardMinutes)}h ordinary` : null,
      result.split.overtimeMinutes > 0 ? `${hours(result.split.overtimeMinutes)}h at +25%` : null,
      result.split.nightMinutes > 0 ? `${hours(result.split.nightMinutes)}h at +50% (night)` : null,
      result.split.restDayMinutes > 0 ? `${hours(result.split.restDayMinutes)}h rest-day work` : null,
    ].filter((part): part is string => part !== null);

    const summary =
      `${hours(result.split.totalMinutes)} hours on ${formatDay(result.workedOn)}: ${bands.join(", ")}. ` +
      `${formatMoney(result.totalMinor)} of it is overtime pay on top of the salary. ` +
      (result.bandsCleared.length > 0
        ? `The ${result.bandsCleared.join(" and ")} band${result.bandsCleared.length === 1 ? "" : "s"} previously recorded for this day ${result.bandsCleared.length === 1 ? "was" : "were"} withdrawn. `
        : "") +
      result.weekly.detail;

    return result.warnings.length > 0
      ? { error: `Recorded. ${result.warnings.join(" ")} ${summary}` }
      : { ok: summary };
  } catch (error) {
    return { error: userMessage(error, "Could not record the worked day.", "hr") };
  }
}

/** `"20:00"` → 1200. Null for anything that is not a time of day. */
function minuteOfDay(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

// ── HR-6: health insurance ──────────────────────────────────────────────────

/**
 * Record health cover. There is no premium-deduction path out of this form.
 *
 * The premium field records an **employer cost**. It is not a deduction and
 * cannot become one: `salary_deductions.kind` has a CHECK constraint whose
 * positive list contains no insurance value at all.
 */
export async function saveInsurance(_prev: HrFormState, formData: FormData): Promise<HrFormState> {
  const session = await requireSessionWith("workforce:write");

  const employeeId = text(formData, "employeeId");
  const plan = text(formData, "plan") as HealthPlan;
  const insurer = text(formData, "insurer");
  const policyNo = text(formData, "policyNo");
  const premium = amountMinor(formData.get("premium"));

  if (!employeeId) return { error: "Missing employment record." };
  if (!HEALTH_PLANS.includes(plan)) return { error: "Choose a plan tier." };
  if (!insurer) {
    return { error: "Name the insurer. A policy nobody can name is a policy nobody can claim against." };
  }

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        saveHealthInsurance(
          tx,
          { tenantId: session.principal.tenantId },
          { employeeId, plan, insurer, ...(policyNo ? { policyNo } : {}), premiumMinor: premium },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not record the health cover.", "hr") };
  }

  revalidatePath(`/workforce/${employeeId}`);
  revalidatePath("/hr");
  return {
    ok:
      "Health cover recorded as an employer cost. The expiry lives on the health insurance document, " +
      "which is the one that blocks a dispatch when it lapses.",
  };
}

/**
 * Record a salary deduction — or refuse it, naming the statute.
 *
 * The refusal is the interesting path. `refuseDeduction` in `packages/core`
 * returns the sentence; `userMessage` passes it through. "Invalid value" would
 * teach nobody anything and would get the amount recorded under a different
 * label ten seconds later.
 */
export async function recordDeduction(
  _prev: HrFormState,
  formData: FormData,
): Promise<HrFormState> {
  const session = await requireSessionWith("workforce:write");

  const employeeId = text(formData, "employeeId");
  const kind = text(formData, "kind");
  const amount = amountMinor(formData.get("amount"));
  const reason = text(formData, "reason");
  const appliesOn = calendarDate(formData.get("appliesOn"));

  if (!employeeId) return { error: "Missing employment record." };
  if (!kind) return { error: "Choose a deduction type." };
  if (amount === null || amount <= 0) return { error: "Enter the amount, as a number." };
  if (!reason) {
    return {
      error:
        "State the reason. A reduction of a protected wage with no stated reason is indistinguishable from an unlawful one when it is challenged, and MOHRE decisions bind under AED 50,000.",
    };
  }
  if (appliesOn === null) return { error: "The date is not a real date." };

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        recordSalaryDeduction(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          { employeeId, kind, amountMinor: amount, reason, ...(appliesOn ? { appliesOn } : {}) },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not record the deduction.", "hr") };
  }

  revalidatePath(`/workforce/${employeeId}`);
  return { ok: `${formatMoney(amount)} recorded against the next wage cycle.` };
}

// ── HR-13: the end-of-service settlement ────────────────────────────────────

/**
 * Record an end-of-service settlement (`HR-13`).
 *
 * ── WHY THERE IS NO AMOUNT FIELD ON THIS FORM ───────────────────────────────
 *
 * Deliberately the opposite decision from `confirmTransfer` above, which asks
 * for the amount because a partial WPS transfer is a real state that has to be
 * measured against the 85% line. Nothing of the kind is true here. The gratuity
 * figure is not an observation of what a bank did — it is the arithmetic in
 * Article 51, and the whole reason `HR-13` exists is that the arithmetic is
 * unforgiving and nobody does it the same way twice: 21 days for five years
 * then 30, basic salary only, capped at two years' *total* wages.
 *
 * An amount field would make that computation optional, and the first person in
 * a hurry would type the number from a spreadsheet. So the server computes it
 * from the employee's own service dates and salary, and the only thing this
 * form supplies is the termination date — a fact only a human knows.
 */
export async function settleGratuity(_prev: HrFormState, formData: FormData): Promise<HrFormState> {
  const session = await requireSessionWith("workforce:write");

  const employeeId = text(formData, "employeeId");
  const terminatedOn = calendarDate(formData.get("terminatedOn"));

  if (!employeeId) return { error: "Missing employee." };
  if (terminatedOn === null) return { error: "The termination date is not a real date." };
  if (terminatedOn === undefined) return { error: "Enter the termination date. The 14-day clock runs from it." };

  try {
    const result = await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        recordGratuitySettlement(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          { employeeId, terminatedOn },
        ),
    );

    revalidatePath("/hr/gratuity");
    revalidatePath("/hr");
    return {
      ok:
        `Settlement recorded: ${formatMoney(result.amountMinor)}, payable with all other end-of-service ` +
        `dues by ${formatDay(result.dueOn)} — 14 days from termination.`,
    };
  } catch (error) {
    return { error: userMessage(error, "Could not record the settlement.", "hr") };
  }
}

/** Mark a settlement as paid, with the reference that makes it evidence. */
export async function payGratuity(_prev: HrFormState, formData: FormData): Promise<HrFormState> {
  const session = await requireSessionWith("workforce:write");

  const settlementId = text(formData, "settlementId");
  const reference = text(formData, "reference");
  const paidOn = calendarDate(formData.get("paidOn"));

  if (!settlementId) return { error: "Missing settlement." };
  if (paidOn === null) return { error: "The payment date is not a real date." };
  if (paidOn === undefined) return { error: "Enter the date the payment was made." };
  if (!reference) {
    return {
      error:
        "Record the bank or WPS reference. A settlement marked paid with nothing behind it is worth nothing in a labour claim, and the limitation period is two years from termination.",
    };
  }

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) => markGratuitySettlementPaid(tx, { settlementId, paidOn, reference }),
    );

    revalidatePath("/hr/gratuity");
    revalidatePath("/hr");
    return { ok: `Settlement recorded as paid on ${formatDay(paidOn)}, reference ${reference}.` };
  } catch (error) {
    return { error: userMessage(error, "Could not record the payment.", "hr") };
  }
}

// ── HR-18: the two facts the skilled test needs ─────────────────────────────

/**
 * Record an employee's ISCO occupational group and certificate answer (`HR-18`).
 *
 * ── WHY BOTH FIELDS HAVE AN EXPLICIT "NOT RECORDED" OPTION ──────────────────
 *
 * Because the alternative is a select that defaults to something. A defaulted
 * ISCO group is indistinguishable from one somebody chose, and it silently
 * answers the question that decides whether an employee is in the Emiratisation
 * denominator. Unanswered is a real state, it is visible in the skilled range
 * as an upper bound above the lower one, and it is recoverable; a wrong answer
 * is none of those things.
 */
export async function classifyOccupation(_prev: HrFormState, formData: FormData): Promise<HrFormState> {
  const session = await requireSessionWith("workforce:write");

  const employeeId = text(formData, "employeeId");
  const rawGroup = text(formData, "iscoMajorGroup");
  const rawCertificate = text(formData, "postSecondaryCertificate");

  if (!employeeId) return { error: "Missing employee." };

  const iscoMajorGroup = rawGroup === "" ? null : Number(rawGroup);
  if (iscoMajorGroup !== null && !Number.isInteger(iscoMajorGroup)) {
    return { error: "The ISCO occupational major group is a whole number from 1 to 9." };
  }
  const postSecondaryCertificate =
    rawCertificate === "yes" ? true : rawCertificate === "no" ? false : null;

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) => saveOccupationClassification(tx, { employeeId, iscoMajorGroup, postSecondaryCertificate }),
    );

    revalidatePath("/hr/emiratisation");
    revalidatePath("/hr");
    return { ok: "Occupational classification saved." };
  } catch (error) {
    return { error: userMessage(error, "Could not save the classification.", "hr") };
  }
}
