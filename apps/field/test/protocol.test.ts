import { check, equal, deepEqual, done } from "./_harness";
import {
  DEVICE_TOKEN_HEADER_LEGACY,
  FIELD_MUTATION_KINDS,
  MAX_BATCH,
  MUTATIONS_PATH,
  MUTATION_ENTITIES,
  ProtocolError,
  SYNC_PATH,
  isKnownMutationKind,
  mutationKind,
  parseErrorEnvelope,
  parseMutationResponse,
  parseRegisterResponse,
  parseSyncResponse,
} from "../src/sync/protocol";

// ── The paths and headers the real routes use ───────────────────────────────

equal("the sync path matches the route", SYNC_PATH, "/api/field/v1/sync");
equal("and the mutations path", MUTATIONS_PATH, "/api/field/v1/mutations");
// Both work server-side; Bearer is the form to keep, and it is what client.ts
// sends. The legacy header is a constant nothing uses.
equal("the legacy device-token header is still named correctly", DEVICE_TOKEN_HEADER_LEGACY, "x-field-device-token");
equal("the batch cap matches MAX_BATCH in the route", MAX_BATCH, 200);

// ── The closed mutation vocabulary ──────────────────────────────────────────

check("the entity vocabulary has no duplicates", new Set(MUTATION_ENTITIES).size === MUTATION_ENTITIES.length);
check("the kind vocabulary has no duplicates", new Set(FIELD_MUTATION_KINDS).size === FIELD_MUTATION_KINDS.length);
equal("kinds are entity/op", mutationKind("job_material", "append"), "job_material/append");
check("a kind the server accepts is recognised", isKnownMutationKind("job_material", "declare_none"));
check("one it does not is refused before it is queued", !isKnownMutationKind("job_material", "delete"));
check("and an invented entity/op pair is refused", !isKnownMutationKind("job_status", "append"));

// Every entity appears in at least one kind, or it is dead vocabulary.
for (const entity of MUTATION_ENTITIES) {
  check(
    `${entity} appears in the kind list`,
    FIELD_MUTATION_KINDS.some((kind) => kind.startsWith(`${entity}/`)),
  );
}

// ── Sync responses ──────────────────────────────────────────────────────────

const minimal = parseSyncResponse({ serverTime: "2026-08-21T09:00:00.000Z", nextCursor: "c1" });
deepEqual("a delta that changed nothing parses with empty collections", minimal.jobs, []);
equal("and carries the cursor", minimal.nextCursor, "c1");
equal("and the server time, which is what the clock reading needs", minimal.serverTime, "2026-08-21T09:00:00.000Z");
// Absent scope is NOT an empty membership list. `[]` means "you have nothing
// assigned, empty the phone"; absent means the server said nothing about
// membership and the device must keep what it holds. Defaulting one to the
// other evicts a technician's whole working set on a missing key.
equal("absent scope stays absent, never an empty membership list", minimal.scope, undefined);
deepEqual(
  "and an explicitly empty scope is still a real, empty answer",
  parseSyncResponse({ serverTime: "2026-08-21T09:00:00.000Z", nextCursor: "c1", scope: { jobIds: [] } }).scope
    ?.jobIds,
  [],
);

// Null taxonomies mean "unchanged, keep what you have" - NOT empty. Defaulting
// them to {} would blank the technician's fault-code picker, which is the
// server's own stated reason for the distinction.
equal("absent taxonomies parse as null, never as empty", minimal.taxonomies, null);

const withTaxonomies = parseSyncResponse({
  serverTime: "2026-08-21T09:00:00.000Z",
  nextCursor: "c2",
  taxonomies: { faultCodes: [{ id: "f1", code: "NO_COOL" }], outcomeCodes: [], photoExemptionReasons: [], rateCard: [] },
});
equal("a taxonomy refresh comes through", withTaxonomies.taxonomies?.faultCodes.length, 1);

// Unknown columns pass through rather than failing the sync.
const withUnknownColumns = parseSyncResponse({
  serverTime: "2026-08-21T09:00:00.000Z",
  nextCursor: "c3",
  jobs: [{ id: "j1", reference: "JOB-1", some_column_added_next_year: true }],
  scope: { jobIds: ["j1"] },
});
equal("a job with a column this build has never seen still syncs", withUnknownColumns.jobs.length, 1);
equal("and the unknown value is kept", withUnknownColumns.jobs[0]?.["some_column_added_next_year"], true);
deepEqual("the scope names what the device may keep", withUnknownColumns.scope?.jobIds, ["j1"]);

// A missing serverTime is fatal: without it there is no clock reading and no
// way to stamp a receipt time, which is the whole two-clock discipline.
let noServerTime = false;
try {
  parseSyncResponse({ nextCursor: "c1" });
} catch (error) {
  noServerTime = error instanceof ProtocolError;
}
check("a response with no serverTime is refused as a protocol error", noServerTime);

// ── Mutation responses ──────────────────────────────────────────────────────

const empty = parseMutationResponse({ serverTime: "2026-08-21T09:00:00.000Z" });
deepEqual("an empty batch response parses", empty.accepted, []);
deepEqual("with all four lists empty", [empty.conflicts, empty.rejected, empty.deferred], [[], [], []]);
equal("and a null skew when the server did not measure one", empty.clockSkewMs, null);

const mixed = parseMutationResponse({
  accepted: [{ clientId: "a", serverReceivedAt: "2026-08-21T09:00:01.000Z", serverId: "srv-1", result: {} }],
  conflicts: [{ clientId: "b", reason: "job_ended_in_office", serverState: { status: "cancelled" }, detail: "Cancelled." }],
  rejected: [{ clientId: "c", message: "Retired code." }],
  deferred: [{ clientId: "d", dependsOn: "a" }],
  serverTime: "2026-08-21T09:00:02.000Z",
  clockSkewMs: -1200,
});
equal("all four verdicts arrive in one response", mixed.accepted.length + mixed.conflicts.length + mixed.rejected.length + mixed.deferred.length, 4);
equal("the conflict carries the server's state so the screen can show it", (mixed.conflicts[0]?.serverState as { status: string }).status, "cancelled");
equal("and the sentence written for the technician", mixed.conflicts[0]?.detail, "Cancelled.");
equal("the server's own skew measurement comes through", mixed.clockSkewMs, -1200);

equal("an acceptance carries its own server receipt time", mixed.accepted[0]?.serverReceivedAt, "2026-08-21T09:00:01.000Z");
equal("and the row id where the effect produced one", mixed.accepted[0]?.serverId, "srv-1");

// Without it there is no authoritative timestamp and the device would fall
// back to its own clock while believing it was reading the server's.
let noReceipt = false;
try {
  parseMutationResponse({ accepted: [{ clientId: "a" }], serverTime: "2026-08-21T09:00:00.000Z" });
} catch (error) {
  noReceipt = error instanceof ProtocolError;
}
check("an acceptance with no serverReceivedAt is refused", noReceipt);

// A conflict with no `detail` is refused: the screen has nothing to show, and
// a blank refusal is the silent failure FLD-17 exists to prevent.
let noDetail = false;
try {
  parseMutationResponse({
    conflicts: [{ clientId: "b", reason: "x" }],
    serverTime: "2026-08-21T09:00:00.000Z",
  });
} catch (error) {
  noDetail = error instanceof ProtocolError;
}
check("a conflict with no detail is refused as a protocol error", noDetail);

// ── Token rotation ──────────────────────────────────────────────────────────

const rotated = parseMutationResponse({
  serverTime: "2026-08-21T09:00:00.000Z",
  deviceToken: { token: "new-token", expiresAt: "2026-09-21T09:00:00.000Z" },
});
equal("a rotated device token comes back in the body", rotated.deviceToken?.token, "new-token");
check("with an expiry", typeof rotated.deviceToken?.expiresAt === "string");

const registration = parseRegisterResponse({
  device: { id: "d1", technicianId: "t1" },
  deviceToken: { token: "first-token", expiresAt: "2026-09-21T09:00:00.000Z" },
  serverTime: "2026-08-21T09:00:00.000Z",
});
equal("registration hands over the token exactly once", registration.deviceToken.token, "first-token");

// ── The error envelope ──────────────────────────────────────────────────────

const revoked = parseErrorEnvelope({
  error: { code: "device_revoked", message: "This device has been signed out for security." },
});
equal("an error envelope yields its code", revoked.code, "device_revoked");
equal("and its message", revoked.message, "This device has been signed out for security.");

const garbage = parseErrorEnvelope("<html>502 Bad Gateway</html>");
equal("a proxy's HTML error page does not crash the client", garbage.code, "unknown");
check("and still yields something to show", garbage.message.length > 0);

// The error names the endpoint, so a technician's screenshot is diagnosable.
try {
  parseMutationResponse({});
} catch (error) {
  check("the protocol error names the path", error instanceof ProtocolError && error.path === MUTATIONS_PATH);
  check(
    "and reads as a sentence about the office, not a stack trace",
    error instanceof ProtocolError && error.message.startsWith("The office sent"),
  );
}

done("protocol");
