import { check, equal, deepEqual, done } from "./_harness";
import {
  WORKING_SET,
  evictionDecision,
  isJobInWorkingSet,
  isSyncedOffline,
  nextDay,
  offlineAvailability,
  type WorkingSetJob,
} from "../src/domain/working-set";

const TODAY = "2026-08-21";

function job(overrides: Partial<WorkingSetJob> = {}): WorkingSetJob {
  return {
    id: "job-1",
    assignedTechnicianId: "tech-1",
    status: "scheduled",
    scheduledFor: `${TODAY}T09:00:00.000Z`,
    ...overrides,
  };
}

check("today's job is on the device", isJobInWorkingSet(job(), "tech-1", TODAY));
check("tomorrow's job is too", isJobInWorkingSet(job({ scheduledFor: "2026-08-22T09:00:00.000Z" }), "tech-1", TODAY));
// Next week's *scheduled* job IS in the set - `scheduled` is an open status,
// so §8.2's second clause catches it. See the note on isJobInWorkingSet: this
// is the specification read literally, and it is flagged rather than narrowed.
check(
  "next week's scheduled job is held, because scheduled is an open status",
  isJobInWorkingSet(job({ scheduledFor: "2026-08-28T09:00:00.000Z" }), "tech-1", TODAY),
);
// A non-open job outside the window is not.
check(
  "next week's cancelled job is not held",
  !isJobInWorkingSet(job({ status: "cancelled", scheduledFor: "2026-08-28T09:00:00.000Z" }), "tech-1", TODAY),
);
check(
  "but a draft job scheduled for tomorrow is, on the date clause alone",
  isJobInWorkingSet(job({ status: "draft", scheduledFor: "2026-08-22T09:00:00.000Z" }), "tech-1", TODAY),
);

// The clause that stops the app being useless: Friday's half-done job on Monday.
check(
  "an open job from last week stays on the device",
  isJobInWorkingSet(job({ status: "paused", scheduledFor: "2026-08-14T09:00:00.000Z" }), "tech-1", TODAY),
);
check(
  "a closed job from last week does not",
  !isJobInWorkingSet(job({ status: "closed", scheduledFor: "2026-08-14T09:00:00.000Z" }), "tech-1", TODAY),
);
check(
  "an open job with no date at all is still theirs to do",
  isJobInWorkingSet(job({ status: "triaged", scheduledFor: null }), "tech-1", TODAY),
);
check(
  "a closed job with no date is not",
  !isJobInWorkingSet(job({ status: "closed", scheduledFor: null }), "tech-1", TODAY),
);

// FLD-19 and the privacy boundary: never another technician's work.
check(
  "another technician's job is never on this device",
  !isJobInWorkingSet(job({ assignedTechnicianId: "tech-2" }), "tech-1", TODAY),
);
check("nor is an unassigned one", !isJobInWorkingSet(job({ assignedTechnicianId: null }), "tech-1", TODAY));

equal("the day boundary rolls over a month end", nextDay("2026-08-31"), "2026-09-01");
equal("and a year end", nextDay("2026-12-31"), "2027-01-01");

// ── The honest empty state (FLD-2) ──────────────────────────────────────────

for (const entry of WORKING_SET) {
  check(`${entry.resource} is declared available offline`, isSyncedOffline(entry.resource));
  const availability = offlineAvailability(entry.resource);
  check(`${entry.resource} carries a stated bound`, availability.kind === "available" && availability.bound.length > 0);
}

const invoices = offlineAvailability("invoice");
equal("invoices are online-only", invoices.kind, "online_only");
check(
  "and the message tells the technician what to do, not what failed",
  invoices.kind === "online_only" && invoices.message.includes("Connect"),
);

const prices = offlineAvailability("price_list");
check(
  "prices tell the technician the office prices it",
  prices.kind === "online_only" && prices.message.includes("the office prices it"),
);

const others = offlineAvailability("other_technician_job");
check(
  "another technician's work is refused for the right reason",
  others.kind === "online_only" && others.message.includes("only see jobs assigned to you"),
);

// ── Eviction (ADR 0004's stated storage risk) ───────────────────────────────

const unsynced = evictionDecision(
  { jobId: "j", status: "closed", completedLocalDate: "2026-01-01", hasUnsyncedWork: true },
  TODAY,
);
check("a job with unsynced work is never evicted, however old", !unsynced.evict);
check("and the reason says why", unsynced.reason.includes("not reached the server"));

const old = evictionDecision(
  { jobId: "j", status: "closed", completedLocalDate: "2026-07-01", hasUnsyncedWork: false },
  TODAY,
);
check("a fully synced job finished 51 days ago is evicted", old.evict);

const recent = evictionDecision(
  { jobId: "j", status: "closed", completedLocalDate: "2026-08-10", hasUnsyncedWork: false },
  TODAY,
);
check("one finished 11 days ago is kept", !recent.evict);

const stillOpen = evictionDecision(
  { jobId: "j", status: "on_site", completedLocalDate: null, hasUnsyncedWork: false },
  TODAY,
);
check("an open job is never evicted", !stillOpen.evict);
equal("and says so plainly", stillOpen.reason, "Still open.");

// The boundary itself: exactly 30 days out is evicted, 29 is not.
check(
  "the 30-day boundary evicts on the day",
  evictionDecision(
    { jobId: "j", status: "closed", completedLocalDate: "2026-07-22", hasUnsyncedWork: false },
    TODAY,
  ).evict,
);
check(
  "and keeps the day before",
  !evictionDecision(
    { jobId: "j", status: "closed", completedLocalDate: "2026-07-23", hasUnsyncedWork: false },
    TODAY,
  ).evict,
);

deepEqual(
  "the declared working set is exactly what the server's FIELD_WORKING_SET sends",
  WORKING_SET.map((e) => e.resource),
  [
    "job",
    "customer",
    "property",
    "asset",
    "fault_code",
    "outcome_code",
    "photo_exemption_reasons",
    "rate_card",
    "certification",
  ],
);

// ── Three outcomes, not two ─────────────────────────────────────────────────
//
// "Connect and it will load" and "this does not exist yet" are different
// instructions. Telling a technician to find signal for a parts catalogue that
// no table backs sends them outside for nothing.

const parts = offlineAvailability("part");
equal("the parts catalogue is not online-only - it does not exist", parts.kind, "not_yet_built");
check(
  "and the message tells them what to do instead",
  parts.kind === "not_yet_built" && parts.message.includes("Type the part description"),
);
check("so it is not claimed as synced", !isSyncedOffline("part"));

const ppe = offlineAvailability("ppe_template");
equal("PPE templates are not built either", ppe.kind, "not_yet_built");
const rams = offlineAvailability("rams_template");
equal("nor are RAMS", rams.kind, "not_yet_built");

done("working-set");
