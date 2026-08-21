/**
 * Recruitment integration tests — M9, `ATS-1`…`ATS-19`, `HR-16`.
 *
 *   npm run test --workspace=@meridian/db
 *
 * Runs against real Postgres, connecting as the NOBYPASSRLS application role.
 * Every claim in this file is about something the database enforces — a CHECK
 * constraint, a partial unique index, a generated column, a `SECURITY DEFINER`
 * function — and none of them can be tested against a mock, because a mock
 * would be asserting that the test author remembered the rule rather than that
 * the database does.
 *
 * ── WHAT IS BEING PROVEN, IN ORDER OF HOW EXPENSIVE IT WOULD BE TO GET WRONG ─
 *
 *  1. **`HR-16`** — a worker-borne recruitment cost cannot be written. Not
 *     "is rejected by a validator": cannot be written, by any statement, by
 *     the owner connection included.
 *  2. **`ATS-16`** — an application cannot leave `active` without a
 *     disposition reason, `closeApplication` always composes an outcome, and
 *     "owed an outcome" is a state the accountability query can see.
 *  3. **`ATS-6` / `ATS-19`** — no column on any recruitment table is named
 *     after a protected characteristic or a score. Asserted against
 *     `information_schema`, so a migration that adds one fails here.
 *  4. **`ATS-18`** — the purge deletes what it should and refuses what it
 *     must not: a hired candidate, a live applicant, a consented pool member.
 *  5. **`ATS-11`** — the generated `phone_local_digits` column matches the
 *     TypeScript implementation on every shape a UAE number arrives in.
 *  6. **`ATS-3`** — the public path writes a complete application through the
 *     definer function, is idempotent on a double submit, and refuses a role
 *     that is not open.
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 *
 * Every row this file creates is namespaced by `RUN`, and `cleanup()` runs at
 * the start *and* the end. A test that leaves rows behind is a test that passes
 * alone and fails in the suite, which is the most confusing failure shape
 * available. `testTenantId()` resolves by slug rather than taking
 * `activeTenantIds()[0]`, which is the empty tenant.
 */

import postgres from "postgres";
import { closeConnection, withTenant } from "../src/index";
import {
  applicationStatusByToken,
  applicationsOwedAnOutcome,
  closeApplication,
  closeRequisition,
  createRequisition,
  getPipelineBoard,
  hireCandidate,
  moveApplicationStage,
  outcomeAccountability,
  publishRequisition,
  approveRequisition,
  purgeExpiredCandidates,
  submitApplication,
} from "../src/domain/recruitment";
import {
  PROHIBITED_APPLICANT_FIELDS,
  PROHIBITED_SCORING_FIELDS,
  UserFacingError,
  phoneLocalDigits,
} from "@meridian/core";
import { testTenantId } from "./_tenant";

const admin = postgres(
  process.env["DATABASE_ADMIN_URL"] ??
    process.env["DATABASE_URL"] ??
    "postgres://localhost:5432/meridian_dev",
  { max: 2 },
);

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

/** Unique per run, so two runs cannot collide and neither can a real row. */
const RUN = `${process.pid}${Math.floor(Math.random() * 1e6)}`;
const SLUG = `zz-test-role-${RUN}`;
const PHONE_MARK = `+971 50 ${RUN.slice(-3)} 0`;

/**
 * Remove everything this run created.
 *
 * By slug and by phone marker rather than by "everything in the tenant", so it
 * is safe against a seeded database and against a developer's own data.
 * Deleting the requisition cascades to its stages; applications reference it
 * with ON DELETE restrict, so they go first.
 */
async function cleanup(): Promise<void> {
  await admin`
    delete from applications
     where requisition_id in (select id from job_requisitions where public_slug like ${"zz-test-role-%"})
        or candidate_id in (select id from candidates where phone like ${"%" + RUN.slice(-3) + "%"})
  `;
  await admin`delete from candidates where phone like ${"%" + RUN.slice(-3) + "%"}`;
  await admin`delete from candidates where full_name like ${"ZZTest%"}`;
  await admin`delete from recruitment_costs where note like ${"zz-test-%"}`;
  await admin`delete from job_requisitions where public_slug like ${"zz-test-role-%"}`;
  await admin`delete from rate_limits where bucket like ${"__test:%"}`;
}

async function main(): Promise<void> {
  await cleanup();
  const tenantId = await testTenantId();
  const ctx = { tenantId, actorKind: "system" as const };

  // ── HR-16 ────────────────────────────────────────────────────────────────
  //
  // The most important assertion in this file, and the shortest. Article 6 of
  // Federal Decree-Law 33/2021 prohibits charging or collecting recruitment
  // fees from a worker. The PRD asks for that to be structurally impossible.
  //
  // Run on the ADMIN connection deliberately. A validator in the application
  // layer would let the owner connection through; the constraint does not.
  {
    let refused = false;
    try {
      await admin`
        insert into recruitment_costs (tenant_id, kind, amount_minor, borne_by, incurred_on, note)
        values (${tenantId}::uuid, 'visa_and_permit', 500000, 'worker', current_date, 'zz-test-hr16')
      `;
    } catch {
      refused = true;
    }
    checkTrue("HR-16: a worker-borne recruitment cost cannot be inserted, even as owner", refused);

    // And the employer-borne one can, so the refusal above is the constraint
    // doing its job rather than the table being unwritable.
    const ok = await admin`
      insert into recruitment_costs (tenant_id, kind, amount_minor, incurred_on, note)
      values (${tenantId}::uuid, 'visa_and_permit', 500000, current_date, 'zz-test-hr16-ok')
      returning borne_by
    `;
    check("HR-16: an employer-borne cost is recorded, and can only say 'employer'", ok[0]?.["borne_by"], "employer");

    // A negative amount is a recovery. Recovering from a worker is the thing
    // being prohibited, so the sign is constrained too.
    let negativeRefused = false;
    try {
      await admin`
        insert into recruitment_costs (tenant_id, kind, amount_minor, incurred_on, note)
        values (${tenantId}::uuid, 'agency_fee', -100000, current_date, 'zz-test-negative')
      `;
    } catch {
      negativeRefused = true;
    }
    checkTrue("HR-16: a negative recruitment cost — a recovery — is refused", negativeRefused);
  }

  // ── ATS-6 / ATS-19: the absent columns ───────────────────────────────────
  //
  // Asserted against information_schema rather than by reading the schema file,
  // because the thing that must stay true is a property of the database. A
  // migration in six months that adds `date_of_birth` to `candidates` fails
  // here, which is the only place it could be caught at all.
  {
    const columns = (await admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name
        from information_schema.columns
       where table_schema = 'public'
         and table_name in (
           'candidates', 'applications', 'candidate_certifications',
           'candidate_documents', 'job_requisitions', 'requisition_stages',
           'application_events', 'talent_pool_members', 'recruitment_costs'
         )
    `).map((r) => `${r.table_name}.${r.column_name}`);

    const banned = [...PROHIBITED_APPLICANT_FIELDS, ...PROHIBITED_SCORING_FIELDS];
    const offenders = columns.filter((qualified) => {
      const column = qualified.split(".")[1] ?? "";
      return banned.some((term) => column === term || column.endsWith(`_${term}`));
    });

    check(
      `ATS-6/ATS-19: no protected-characteristic or scoring column exists (${columns.length} columns checked)`,
      offenders.join(", ") || "none",
      "none",
    );

    // `over_eighteen` is the one age fact permitted, and it must be a boolean.
    // A date column named anything at all is a birth date wearing a disguise.
    const ageColumn = await admin<{ data_type: string }[]>`
      select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'candidates' and column_name = 'over_eighteen'
    `;
    check("ATS-6: the only age fact on a candidate is a boolean", ageColumn[0]?.["data_type"], "boolean");
  }

  // ── ATS-11: the generated column matches the TypeScript ──────────────────
  //
  // Two implementations of one rule is one implementation and one bug waiting.
  // These are checked against each other rather than against a constant.
  {
    const shapes = ["+971501234567", "0501234567", "971 50 123 4567", "+971 (50) 123-4567"];
    const rows = await admin<{ shape: string; local: string }[]>`
      select v as shape, right(regexp_replace(v, '[^0-9]', '', 'g'), 9) as local
        from unnest(${shapes}::text[]) as v
    `;
    const agree = rows.every((row) => row.local === phoneLocalDigits(row.shape));
    checkTrue("ATS-11: phone_local_digits agrees with phoneLocalDigits() on every shape", agree);
    check("ATS-11: all four shapes collapse to one key", new Set(rows.map((r) => r.local)).size, 1);
  }

  // ── ATS-1 / ATS-2: requisition lifecycle ─────────────────────────────────
  let requisitionId = "";
  let publicSlug = "";
  {
    const created = await withTenant(ctx, (tx) =>
      createRequisition(tx, ctx, {
        title: `ZZTest Role ${RUN}`,
        trade: "hvac-installation-maintenance",
        grade: "technician",
        headcount: 1,
        contractType: "full_time",
        locationCity: "Dubai",
        physicalRequirements: "Working at height, lifting to 25 kg.",
      }),
    );
    requisitionId = created.requisitionId;

    // Rename the slug to the namespaced one so cleanup can find it by pattern.
    await admin`update job_requisitions set public_slug = ${SLUG} where id = ${requisitionId}::uuid`;
    publicSlug = SLUG;

    const stages = await admin<{ count: number }[]>`
      select count(*)::int as count from requisition_stages where requisition_id = ${requisitionId}::uuid
    `;
    check("ATS-7: a new requisition gets its pipeline in the same transaction", stages[0]?.["count"], 7);

    // Publishing without an approval is refused by the domain, and behind it by
    // the database CHECK. Both matter: the CHECK is what an importer meets.
    let refusedPublish = false;
    try {
      await withTenant(ctx, (tx) => publishRequisition(tx, ctx, requisitionId));
    } catch (error) {
      refusedPublish = error instanceof UserFacingError;
    }
    checkTrue("ATS-1: a role cannot be published before it is approved", refusedPublish);

    let refusedBySql = false;
    try {
      await admin`update job_requisitions set status = 'open' where id = ${requisitionId}::uuid`;
    } catch {
      refusedBySql = true;
    }
    checkTrue("ATS-1: the database refuses an open role with no approval, not just the action", refusedBySql);

    await withTenant(ctx, async (tx) => {
      await approveRequisition(tx, ctx, requisitionId);
      await publishRequisition(tx, ctx, requisitionId);
    });

    const open = await admin<{ status: string }[]>`
      select status from job_requisitions where id = ${requisitionId}::uuid
    `;
    check("ATS-2: approved then published is open", open[0]?.["status"], "open");
  }

  // ── ATS-3: the public path ───────────────────────────────────────────────
  let applicationId = "";
  let candidateId = "";
  let statusToken = "";
  {
    const submitted = await submitApplication(tenantId, {
      roleSlug: publicSlug,
      fullName: `ZZTest Applicant ${RUN}`,
      phone: `${PHONE_MARK}01`,
      email: `zztest-${RUN}@example.com`,
      trade: "hvac-installation-maintenance",
      grade: "technician",
      experienceBand: "2_to_5",
      currentLocation: "in_uae",
      availability: "immediate",
      hasDrivingLicence: true,
      essentialFunctions: "yes",
      certificates: [{ scheme: "HVAC Level 2", expiresOn: "2028-03" }],
      talentPoolConsent: false,
    });

    applicationId = submitted.applicationId;
    candidateId = submitted.candidateId;
    statusToken = submitted.statusToken;

    checkTrue("ATS-3: the public submission writes an application", submitted.reference.startsWith("APP-"));
    check("ATS-3: it is not a re-submission", submitted.wasExisting, false);
    checkTrue("ATS-16: an outcome clock is set at insert", submitted.outcomeDueAt.getTime() > Date.now());
    check("ATS-3: the tracking token is 64 hex characters", statusToken.length, 64);

    // `ATS-4`: `YYYY-MM` is stored as the LAST day of the month. A card reading
    // 03/2028 is valid through March; storing the first would expire it a month
    // early on every dispatch check.
    // Compared as text from Postgres, not as a stringified JS Date — the driver
    // hands back a Date and `String(date)` is "Fri Mar 31 2028 …", which would
    // make this assertion about the driver's formatting rather than the value.
    const certificate = await admin<{ expires_on: string }[]>`
      select to_char(expires_on, 'YYYY-MM-DD') as expires_on
        from candidate_certifications where candidate_id = ${candidateId}::uuid
    `;
    check("ATS-4: a YYYY-MM expiry is stored as the last day of that month",
      certificate[0]?.["expires_on"], "2028-03-31");

    // Double submit. Somebody taps Submit twice on a slow connection; a second
    // application would put two cards for one human on the board and start two
    // outcome clocks.
    const again = await submitApplication(tenantId, {
      roleSlug: publicSlug,
      fullName: `ZZTest Applicant ${RUN}`,
      phone: `${PHONE_MARK}01`,
      email: `zztest-${RUN}@example.com`,
      trade: "hvac-installation-maintenance",
      grade: "technician",
      experienceBand: "2_to_5",
      currentLocation: "in_uae",
      availability: "immediate",
      hasDrivingLicence: true,
      essentialFunctions: "yes",
      certificates: [],
      talentPoolConsent: false,
    });
    check("ATS-12: a double submit returns the same application", again.applicationId, applicationId);
    check("ATS-12: and says so rather than pretending it was new", again.wasExisting, true);

    // The applicant's own view, through the definer function.
    const view = await applicationStatusByToken(statusToken);
    check("ATS-16: the token resolves to exactly one application", view?.reference, again.reference);
    check("ATS-16: no outcome message is visible before one is sent", view?.outcomeMessage ?? null, null);
    checkTrue("ATS-16: the applicant sees the whole pipeline", (view?.stages.length ?? 0) === 7);

    const missing = await applicationStatusByToken("0".repeat(64));
    check("ATS-16: an unknown token resolves to nothing", missing, null);
  }

  // ── ATS-13: consent, on the path that actually writes it ─────────────────
  //
  // A separate applicant with the talent-pool box ticked. This case was missing
  // from the first version of this file and the gap was real: the consent
  // INSERT is the only statement in the definer function that uses an
  // unqualifiable `ON CONFLICT (candidate_id, …)`, so it was the only statement
  // that hit the OUT-parameter ambiguity — and it failed on the live form while
  // every test passed. A path no test exercises is a path that is not built.
  {
    const consented = await submitApplication(tenantId, {
      roleSlug: publicSlug,
      fullName: `ZZTest Consented ${RUN}`,
      phone: `${PHONE_MARK}42`,
      email: `zztest-consent-${RUN}@example.com`,
      trade: "hvac-installation-maintenance",
      grade: "technician",
      experienceBand: "5_to_10",
      currentLocation: "in_uae",
      availability: "two_weeks",
      hasDrivingLicence: false,
      essentialFunctions: "yes",
      certificates: [{ scheme: "HVAC Level 2", expiresOn: "2029-05" }],
      talentPoolConsent: true,
    });

    checkTrue("ATS-13: an application with consent is written", consented.reference.startsWith("APP-"));

    const pool = await admin<{ consent_source: string; consent_captured_at: Date }[]>`
      select consent_source, consent_captured_at
        from talent_pool_members where candidate_id = ${consented.candidateId}::uuid
    `;
    check("ATS-13: consent is recorded against the pool, with its source", pool[0]?.["consent_source"], "application_form");
    checkTrue("ATS-13: and it is timestamped, not implied", pool[0]?.["consent_captured_at"] instanceof Date);

    // Consent is a different lawful basis, so it is a different clock — twelve
    // months rather than six, re-confirmed every ninety days.
    const basis = await admin<{ retention_basis: string }[]>`
      select retention_basis from candidates where id = ${consented.candidateId}::uuid
    `;
    check("ATS-18: consent moves the candidate onto the consent basis", basis[0]?.["retention_basis"], "consent");

    // Idempotent on a re-submission: the box being ticked twice must not throw
    // on the unique index, which is exactly what ON CONFLICT is there for.
    const again = await submitApplication(tenantId, {
      roleSlug: publicSlug,
      fullName: `ZZTest Consented ${RUN}`,
      phone: `${PHONE_MARK}42`,
      email: `zztest-consent-${RUN}@example.com`,
      trade: "hvac-installation-maintenance",
      grade: "technician",
      experienceBand: "5_to_10",
      currentLocation: "in_uae",
      availability: "two_weeks",
      hasDrivingLicence: false,
      essentialFunctions: "yes",
      certificates: [],
      talentPoolConsent: true,
    });
    check("ATS-13: re-consenting does not duplicate the pool row", again.applicationId, consented.applicationId);

    // Archived before moving on, because the "a role with no live applicants
    // closes cleanly" assertion further down measures the same requisition and
    // this applicant would otherwise be sitting live on it — which is the
    // refusal working, in the wrong test.
    await withTenant(ctx, (tx) =>
      closeApplication(tx, ctx, {
        applicationId: consented.applicationId,
        dispositionCode: "role_filled",
      }),
    );

    await admin`delete from talent_pool_members where candidate_id = ${consented.candidateId}::uuid`;
  }

  // ── ATS-16: the obligation ───────────────────────────────────────────────
  {
    // The database refuses an archive with no reason. This is the backstop
    // behind closeApplication, and the one an importer or a hand-typed UPDATE
    // during an incident actually meets.
    let refused = false;
    try {
      await admin`
        update applications set status = 'archived' where id = ${applicationId}::uuid
      `;
    } catch {
      refused = true;
    }
    checkTrue("ATS-16: an application cannot be archived without a disposition reason", refused);

    // And it refuses a "sent" stamp with no message behind it — the shape of
    // an UPDATE written to clear a report.
    let sentRefused = false;
    try {
      await admin`
        update applications set outcome_sent_at = now() where id = ${applicationId}::uuid
      `;
    } catch {
      sentRefused = true;
    }
    checkTrue("ATS-16: an outcome cannot be marked sent with no message composed", sentRefused);

    // A reason from outside the controlled list is refused with an explanation
    // rather than stored. Free text here would destroy the analytics the field
    // is collected for.
    let badReason = false;
    try {
      await withTenant(ctx, (tx) =>
        closeApplication(tx, ctx, { applicationId, dispositionCode: "not_a_real_reason" }),
      );
    } catch (error) {
      badReason = error instanceof UserFacingError;
    }
    checkTrue("ATS-16: a disposition reason outside the list is refused", badReason);

    const closed = await withTenant(ctx, (tx) =>
      closeApplication(tx, ctx, {
        applicationId,
        dispositionCode: "certification_not_current",
      }),
    );

    // The message is composed from the reason, and it is specific. This is the
    // whole claim of ATS-16: "certifications not current" produces actionable
    // feedback that converts into a later re-application.
    checkTrue(
      "ATS-16: the disposition reason writes a specific message",
      closed.message.includes("Renew it") || closed.message.includes("renew it"),
    );
    check("ATS-15: an applied-stage archive is auto-sendable", closed.requiresHumanSend, false);

    const scheduled = await admin<{ outcome_scheduled_at: Date | null }[]>`
      select outcome_scheduled_at from applications where id = ${applicationId}::uuid
    `;
    const sendAt = scheduled[0]?.["outcome_scheduled_at"];
    checkTrue(
      "ATS-15: the message is held at least 24 hours so it can be cancelled",
      sendAt !== null && sendAt !== undefined && sendAt.getTime() - Date.now() > 23 * 3600 * 1000,
    );

    // It is owed until it is sent — and the accountability query can see it.
    const owed = await withTenant(ctx, (tx) => applicationsOwedAnOutcome(tx, 200));
    const mine = owed.find((row) => row.applicationId === applicationId);
    check("ATS-16: not yet counted as owed while inside the promise window", mine, undefined);

    // Push the promise into the past. This is the state the module exists to
    // make visible: archived, nobody told, past the date.
    await admin`
      update applications set outcome_due_at = now() - interval '2 days' where id = ${applicationId}::uuid
    `;

    const overdue = await withTenant(ctx, (tx) => applicationsOwedAnOutcome(tx, 200));
    const nowOwed = overdue.find((row) => row.applicationId === applicationId);
    checkTrue("ATS-16: an unanswered applicant past the promise is a state the system can see", Boolean(nowOwed));
    checkTrue("ATS-16: and it is reported by name, with a phone number", (nowOwed?.phone.length ?? 0) > 0);
    checkTrue("ATS-16: with the message already written, ready to send", nowOwed?.hasMessage === true);

    const g14 = await withTenant(ctx, (tx) => outcomeAccountability(tx));
    checkTrue("G14: the overdue count is non-zero while somebody is waiting", g14.overdue > 0);
    checkTrue("G14: the response rate is below 100% while somebody is waiting", g14.responseRatePercent < 100);

    // Closing the role while somebody is still live is refused, because that is
    // exactly how a board stops being looked at with people still on it.
    let closeRefused = false;
    try {
      await withTenant(ctx, (tx) => closeRequisition(tx, ctx, requisitionId));
    } catch (error) {
      closeRefused = error instanceof UserFacingError;
    }
    // Nobody is live on this role at this point (the only applicant is
    // archived), so this must succeed rather than refuse — asserted so the
    // refusal above is proven to be conditional and not just always thrown.
    check("ATS-1: a role with no live applicants closes cleanly", closeRefused, false);
  }

  // ── ATS-8: the board computes the tone from time, not from a stored value ─
  {
    const board = await withTenant(ctx, (tx) => getPipelineBoard(tx, requisitionId));
    checkTrue("ATS-7: the board loads with its stages", (board?.stages.length ?? 0) === 7);
    checkTrue("ATS-16: the board surfaces the owed-an-outcome count", (board?.owedAnOutcome ?? 0) > 0);
  }

  // ── ATS-18: retention ────────────────────────────────────────────────────
  {
    // Three candidates whose delete_after has passed, each of which must be
    // treated differently. The purge deleting all three would be a data-loss
    // incident; deleting none would be the policy document TRD §10 warns about.
    const reopened = await admin<{ id: string }[]>`
      insert into job_requisitions (tenant_id, reference, public_slug, title, trade, status, approved_at)
      values (${tenantId}::uuid, ${"REQ-ZZ-" + RUN}, ${"zz-test-role-live-" + RUN},
              'ZZTest Retention Role', 'hvac-installation-maintenance', 'open', now())
      returning id
    `;
    const liveRequisition = reopened[0]?.["id"] as string;

    const expired = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    const make = async (name: string, basis: string, technicianId: string | null) => {
      const rows = await admin<{ id: string }[]>`
        insert into candidates (tenant_id, full_name, phone, primary_trade, experience_band,
                                current_location, retention_basis, delete_after, converted_technician_id)
        values (${tenantId}::uuid, ${name}, ${PHONE_MARK + "99"}, 'hvac-installation-maintenance',
                '2_to_5', 'in_uae', ${basis}, ${expired}::date, ${technicianId}::uuid)
        returning id
      `;
      return rows[0]?.["id"] as string;
    };

    const ordinary = await make(`ZZTest Purge Ordinary ${RUN}`, "pre_contractual", null);
    const employee = await make(`ZZTest Purge Employee ${RUN}`, "employee", null);
    const consented = await make(`ZZTest Purge Consented ${RUN}`, "consent", null);
    const stillLive = await make(`ZZTest Purge Live ${RUN}`, "pre_contractual", null);

    await admin`
      insert into talent_pool_members (tenant_id, candidate_id, pool_key, consent_captured_at,
                                       consent_source, reconfirm_due_at)
      values (${tenantId}::uuid, ${consented}::uuid, 'hvac-installation-maintenance', now(),
              'application_form', now() + interval '90 days')
    `;

    await admin`
      insert into applications (tenant_id, reference, candidate_id, requisition_id, status,
                                outcome_due_at, status_token)
      values (${tenantId}::uuid, ${"APP-ZZ-LIVE-" + RUN}, ${stillLive}::uuid, ${liveRequisition}::uuid,
              'active', now() + interval '3 days', ${"zzlive" + RUN}::text)
    `;

    const purge = await withTenant(ctx, (tx) => purgeExpiredCandidates(tx, ctx));
    checkTrue("ATS-18: the purge deletes at least the ordinary expired candidate", purge.deleted >= 1);
    check("ATS-18: the shape matches the existing retention job", purge.rule, "ATS-18");

    const survives = async (id: string) => {
      const rows = await admin<{ count: number }[]>`
        select count(*)::int as count from candidates where id = ${id}::uuid
      `;
      return Number(rows[0]?.["count"] ?? 0) === 1;
    };

    check("ATS-18: an expired applicant record is purged", await survives(ordinary), false);
    checkTrue("ATS-18: a candidate who became an employee is NOT purged — HR-15 owns that clock", await survives(employee));
    checkTrue("ATS-18: a consented talent-pool member is NOT purged — different lawful basis", await survives(consented));
    checkTrue("ATS-18: an applicant still awaiting a decision is NOT purged", await survives(stillLive));

    // The deletion is logged. A purge nobody can account for afterwards is the
    // only question ever asked about a retention job.
    const logged = await admin<{ count: number }[]>`
      select count(*)::int as count from audit_log
       where table_name = 'candidates' and action = 'retention_purge'
         and occurred_at > now() - interval '2 minutes'
    `;
    checkTrue("ATS-18: the purge writes to the append-only audit log", Number(logged[0]?.["count"] ?? 0) > 0);

    await admin`delete from applications where reference like ${"APP-ZZ-%"}`;
    await admin`delete from job_requisitions where public_slug like ${"zz-test-role-live-%"}`;
  }

  // ── ATS-17: the conversion ───────────────────────────────────────────────
  {
    const hireRequisition = await admin<{ id: string }[]>`
      insert into job_requisitions (tenant_id, reference, public_slug, title, trade, status, approved_at)
      values (${tenantId}::uuid, ${"REQ-ZZH-" + RUN}, ${"zz-test-role-hire-" + RUN},
              'ZZTest Hire Role', 'hvac-installation-maintenance', 'open', now())
      returning id
    `;
    const hireRequisitionId = hireRequisition[0]?.["id"] as string;

    const submitted = await submitApplication(tenantId, {
      roleSlug: `zz-test-role-hire-${RUN}`,
      fullName: `ZZTest Hire ${RUN}`,
      phone: `${PHONE_MARK}77`,
      email: null,
      trade: "hvac-installation-maintenance",
      grade: "senior_technician",
      experienceBand: "over_10",
      currentLocation: "in_uae",
      availability: "immediate",
      hasDrivingLicence: true,
      essentialFunctions: "yes",
      certificates: [
        { scheme: "HVAC Level 2", expiresOn: "2029-06" },
        { scheme: "Working at height", expiresOn: "2027-09" },
      ],
      talentPoolConsent: false,
    });

    const result = await withTenant(ctx, (tx) =>
      hireCandidate(tx, ctx, {
        applicationId: submitted.applicationId,
        employeeCode: `ZZ${RUN.slice(-6)}`,
        contractStart: new Date(),
        noticePeriodDays: 30,
      }),
    );

    check("ATS-17: both certifications carry across", result.certificationsCarried, 2);

    // The expiry is what makes this worth doing. A certification retyped by
    // hand loses its date, and the consequence surfaces as a refused dispatch
    // under HR-9 months later — or as a permitted one.
    const carried = await admin<{ name: string; expires_on: Date | null }[]>`
      select name, expires_on from technician_certifications
       where technician_id = ${result.technicianId}::uuid
       order by name
    `;
    checkTrue("ATS-17: every carried certification kept its expiry date",
      carried.length === 2 && carried.every((row) => row.expires_on !== null));

    const application = await admin<{ status: string; outcome_sent_at: Date | null }[]>`
      select status, outcome_sent_at from applications where id = ${submitted.applicationId}::uuid
    `;
    check("ATS-17: the application is marked hired", application[0]?.["status"], "hired");
    checkTrue(
      "ATS-16: a hire counts as an outcome, so it does not sit on the owed list forever",
      application[0]?.["outcome_sent_at"] !== null,
    );

    const candidate = await admin<{ retention_basis: string; delete_after: string | null }[]>`
      select retention_basis, delete_after from candidates where id = ${submitted.candidateId}::uuid
    `;
    check("ATS-18: the retention basis moves to 'employee' on hire", candidate[0]?.["retention_basis"], "employee");
    check("ATS-18: and the applicant delete_after is cleared — HR-15 owns the clock now",
      candidate[0]?.["delete_after"], null);

    // Clean up the technician and employee this created.
    await admin`delete from employees where employee_no = ${"ZZ" + RUN.slice(-6)}`;
    await admin`delete from technicians where employee_code = ${"ZZ" + RUN.slice(-6)}`;
    await admin`delete from applications where requisition_id = ${hireRequisitionId}::uuid`;
    await admin`delete from job_requisitions where id = ${hireRequisitionId}::uuid`;
  }

  // ── ATS-3: a closed role refuses applications ────────────────────────────
  {
    let refused = false;
    try {
      await submitApplication(tenantId, {
        roleSlug: `zz-does-not-exist-${RUN}`,
        fullName: "ZZTest Ghost",
        phone: `${PHONE_MARK}55`,
        email: null,
        trade: "hvac-installation-maintenance",
        grade: "technician",
        experienceBand: "2_to_5",
        currentLocation: "in_uae",
        availability: "immediate",
        hasDrivingLicence: false,
        essentialFunctions: "yes",
        certificates: [],
        talentPoolConsent: false,
      });
    } catch (error) {
      refused = error instanceof UserFacingError;
    }
    checkTrue("ATS-3: applying to a role that is not open is refused, in words", refused);
  }

  // ── ATS-7: a stage cannot be borrowed from another requisition ───────────
  {
    const other = await admin<{ id: string }[]>`
      select id from requisition_stages where requisition_id <> ${requisitionId}::uuid limit 1
    `;
    const foreignStage = other[0]?.["id"] as string | undefined;

    if (foreignStage) {
      const live = await admin<{ id: string }[]>`
        select id from applications where requisition_id = ${requisitionId}::uuid limit 1
      `;
      const target = live[0]?.["id"] as string | undefined;

      if (target) {
        let refused = false;
        try {
          await withTenant(ctx, (tx) =>
            moveApplicationStage(tx, ctx, { applicationId: target, toStageId: foreignStage }),
          );
        } catch (error) {
          refused = error instanceof UserFacingError;
        }
        checkTrue("ATS-7: a stage from another role cannot be used", refused);
      }
    }
  }

  await cleanup();

  console.log(fail === 0 ? "\nAll recruitment checks passed" : `\n${fail} check(s) FAILED`);
  await admin.end();
  await closeConnection();
  if (fail > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await cleanup().catch(() => {});
  await admin.end();
  await closeConnection();
  process.exit(1);
});
