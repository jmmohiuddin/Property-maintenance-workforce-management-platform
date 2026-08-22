import { check, equal, done } from "./_harness";
import { DATA_CLASS_OF, classifyConflict, needsBaseVersion, preservesLocalCopy } from "../src/sync/conflicts";
import { FIELD_MUTATION_KINDS } from "../src/sync/protocol";

// Every mutation kind the server accepts has a declared data class. The type
// system enforces this at compile time; asserting it here catches a kind added
// with a placeholder.
for (const kind of FIELD_MUTATION_KINDS) {
  check(`${kind} has a declared data class`, typeof DATA_CLASS_OF[kind] === "string");
}

// TRD §8.4: append-only facts cannot conflict, so they carry no baseVersion.
check("an attendance event needs no baseVersion", !needsBaseVersion("attendance/append"));
check("an attachment needs no baseVersion", !needsBaseVersion("job_attachment/append"));
check("a signature needs no baseVersion", !needsBaseVersion("job_signature/record"));
check("a material line needs none - it is an or-set", !needsBaseVersion("job_material/append"));
check("labour needs none - it is entries, summed server-side", !needsBaseVersion("visit_labour/record"));
check("a job note does need one - last-write-wins needs something to lose to", needsBaseVersion("job_note/upsert"));
check("a status transition needs one - the dispatcher may have moved the job", needsBaseVersion("job_status/transition"));
check("an outcome needs one", needsBaseVersion("job_outcome/record"));

// The two same-entity kinds are different data classes. This is why the table
// is keyed by entity/op and not by entity.
equal("appending a material is an additive collection", DATA_CLASS_OF["job_material/append"], "additive_collection");
equal(
  "declaring none is a server-held declaration",
  DATA_CLASS_OF["job_material/declare_none"],
  "server_authoritative",
);

// ── The two reasons the server actually emits ───────────────────────────────

const ended = classifyConflict({
  kind: "job_outcome/record",
  reason: "job_ended_in_office",
  detail: "A completed job card arrived for a job that was cancelled in the office.",
});
equal("a job closed in the office while offline goes to a human", ended.action, "escalate_to_office");
check("and the technician's work is preserved", preservesLocalCopy(ended.action));
check("and they are told not to re-enter it", ended.message.includes("do not re-enter"));

const overwritten = classifyConflict({
  kind: "job_note/upsert",
  reason: "text_overwritten",
  detail: "The technician's version is now the one on file; what it replaced is recorded here.",
});
equal("an overwritten note keeps both versions", overwritten.action, "preserve_local_and_notify");
check("and both are kept locally too", preservesLocalCopy(overwritten.action));
check("and the message says theirs was kept", overwritten.message.includes("kept alongside"));

// ── Idempotency working as designed is not an error ─────────────────────────

const duplicate = classifyConflict({ kind: "attendance/append", reason: "duplicate" });
equal("a duplicate is accepted silently", duplicate.action, "accept_server_silently");

// ── Optimistic concurrency, by data class ───────────────────────────────────

const staleNote = classifyConflict({ kind: "job_note/upsert", reason: "stale_version" });
equal("a stale note keeps the technician's typing", staleNote.action, "preserve_local_and_notify");

const staleStatus = classifyConflict({ kind: "job_status/transition", reason: "stale_version" });
equal("a stale status accepts the server's version", staleStatus.action, "accept_server_and_notify");

const impossible = classifyConflict({ kind: "attendance/append", reason: "stale_version" });
equal("a version conflict on an append-only event escalates", impossible.action, "escalate_to_office");
check("and admits the app cannot explain it", impossible.message.includes("cannot tell why"));

// ── Forward compatibility ───────────────────────────────────────────────────

const unknown = classifyConflict({
  kind: "job_material/append",
  reason: "part_withdrawn_from_catalogue",
  detail: "That part was withdrawn last week. Call the stores.",
});
equal("an unrecognised reason escalates rather than being guessed", unknown.action, "escalate_to_office");
equal("and shows the server's own sentence verbatim", unknown.message, "That part was withdrawn last week. Call the stores.");

const unknownNoDetail = classifyConflict({ kind: "job_material/append", reason: "some_new_rule" });
check("with no detail, the reason code is still shown", unknownNoDetail.message.includes("some_new_rule"));
check(
  "and the technician is told the work is still on the phone",
  unknownNoDetail.message.includes("still on the phone"),
);

// Prefixed reasons classify the same as bare ones.
equal(
  "a reason carrying a suffix still classifies",
  classifyConflict({ kind: "job_note/upsert", reason: "text_overwritten:report" }).action,
  "preserve_local_and_notify",
);

done("conflicts");
