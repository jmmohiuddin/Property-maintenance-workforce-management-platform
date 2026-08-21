import { check, equal, done } from "./_harness";
import {
  FIELD_SCHEMA,
  OFFLINE_CAPTURED_TABLES,
  SCHEMA_VERSION,
  columnNames,
  tableByName,
  tableNames,
} from "../src/db/schema";

equal("the schema declares a version", FIELD_SCHEMA.version, SCHEMA_VERSION);
check("and has tables", FIELD_SCHEMA.tables.length > 0);

// No duplicate table names - WatermelonDB would silently take the last one.
const names = tableNames();
equal("table names are unique", new Set(names).size, names.length);

for (const table of FIELD_SCHEMA.tables) {
  const columns = columnNames(table);
  check(`${table.name} has unique column names`, new Set(columns).size === columns.length);
  check(`${table.name} does not redeclare the implicit id`, !columns.includes("id"));
}

// ── ADR 0004's two-clock rule, enforced across the schema ───────────────────
//
// This is the assertion worth having. It is easy to add a new captured entity
// and forget one of the two timestamps, and the loss is invisible until a
// report is wrong months later.

for (const name of OFFLINE_CAPTURED_TABLES) {
  const table = tableByName(name);
  check(`${name} exists`, table !== null);
  if (!table) continue;
  const columns = columnNames(table);
  check(`${name} carries the device timestamp`, columns.includes("recorded_offline_at"));
  check(`${name} carries the server receipt time`, columns.includes("server_received_at"));
  check(`${name} carries a monotonic ordering reading`, columns.includes("monotonic_at"));

  const serverReceived = table.columns.find((c) => c.name === "server_received_at");
  check(`${name}'s server receipt time is optional - null until acknowledged`, serverReceived?.isOptional === true);
}

const jobs0 = tableByName("jobs");

// ── The outbox has what the drain planner reads ─────────────────────────────

const outbox = tableByName("outbox");
check("the outbox exists", outbox !== null);
if (outbox) {
  const columns = columnNames(outbox);
  for (const required of [
    "entity",
    "op",
    "job_id",
    "payload_json",
    "base_version",
    "depends_on_client_id",
    "created_monotonic",
    "attempt_count",
    "next_attempt_after",
    "status",
    "last_error",
  ]) {
    check(`the outbox has ${required}`, columns.includes(required));
  }
  const status = outbox.columns.find((c) => c.name === "status");
  check("the outbox status is indexed - it is the drain query's predicate", status?.isIndexed === true);
  const monotonic = outbox.columns.find((c) => c.name === "created_monotonic");
  check("and the ordering key is indexed", monotonic?.isIndexed === true);
}

// ── JOB-15's three states survive storage ───────────────────────────────────
//
// The gaps come from the server. Storing them as a boolean "ready" flag would
// throw away which conditions are outstanding; making the column non-optional
// would lose the difference between "never synced" and "not completable".

if (jobs0) {
  const gaps = jobs0.columns.find((c) => c.name === "gaps_json");
  check("jobs carry the server-computed JOB-15 gaps", gaps !== undefined);
  check("as text, so the list survives rather than a verdict", gaps?.type === "string");
  check("and optional, so 'never synced' is representable", gaps?.isOptional === true);
  check("the device stores no locally-computed readiness flag", !columnNames(jobs0).includes("is_complete"));
  check("nor a local gap computation", !columnNames(jobs0).includes("local_gaps"));
}

const card = tableByName("job_cards");
if (card) {
  const refusal = card.columns.find((c) => c.name === "last_refusal_gaps");
  check("a refused card keeps the server's gap list across a restart", refusal?.isOptional === true);
}

const outbox2 = tableByName("outbox");
if (outbox2) {
  const gaps = outbox2.columns.find((c) => c.name === "refusal_gaps");
  check("a refused outbox row keeps its gaps, so the queued write can be corrected", gaps !== undefined);
  check("optional, because absent is not empty", gaps?.isOptional === true);
}

// ── The bounded working set, and nothing beyond it ──────────────────────────

for (const required of ["jobs", "customers", "properties", "assets", "parts", "taxonomy_terms", "certifications"]) {
  check(`the working set includes ${required}`, names.includes(required));
}

for (const forbidden of ["invoices", "quotes", "contracts", "leads", "employees", "payroll", "rate_card_items"]) {
  check(`the device holds no ${forbidden} table`, !names.includes(forbidden));
}

// ── No capture surface without a sync path ──────────────────────────────────
//
// A table the technician can write to and nothing can carry to the office is
// worse than a missing feature: the app says "saved" and the work is lost.

for (const deadEnd of ["job_recommendations", "job_amendments"]) {
  check(`no ${deadEnd} table - it had no server mutation to sync through`, !names.includes(deadEnd));
}
const cards = tableByName("job_cards");
check(
  "the recommendation lives on the job card, which syncs as job_note/upsert",
  cards !== null && columnNames(cards).includes("recommendation"),
);

// ── SEC-8: a key is not a link, and the device never holds one ──────────────

const photos = tableByName("job_photos");
if (photos) {
  const columns = columnNames(photos);
  check("a photo cites the server's upload id", columns.includes("upload_id"));
  check("and holds no storage key - the server never returns one", !columns.includes("storage_key"));
  check("the scan status is stored so nothing presents an unscanned photo as cleared",
    columns.includes("scan_status"));
  check("and the server-declared chunk size, so resumption indexes correctly",
    columns.includes("chunk_size"));
}

// Prices are online-only, so the parts table must not carry one.
const parts = tableByName("parts");
check("the cached parts catalogue holds no price", parts !== null && !columnNames(parts).includes("price"));
check("nor a unit price", parts !== null && !columnNames(parts).includes("unit_price"));

// ── FLD-15: no biometric stroke data on the device ─────────────────────────

const signoffs = tableByName("job_signoffs");
check("the signoff table exists", signoffs !== null);
if (signoffs) {
  const columns = columnNames(signoffs);
  for (const biometric of ["stroke_timings", "pressure", "velocity", "stroke_dynamics", "tilt"]) {
    check(`no ${biometric} column - FLD-15 forbids stroke-dynamics data`, !columns.includes(biometric));
  }
  check("the sheet digest is stored - FLD-14's evidential anchor", columns.includes("sheet_digest"));
  check("a signature cites an upload, not a storage key", columns.includes("upload_id"));
  check("and holds no storage key", !columns.includes("storage_key"));
  check("and the exact canonical text that was hashed", columns.includes("sheet_canonical"));
  check("with the consent version", columns.includes("consent_version"));
  check("and the app build that rendered it", columns.includes("app_version"));
}

// ── The list screen's query must be indexed ────────────────────────────────

const jobs = tableByName("jobs");
if (jobs) {
  const scheduled = jobs.columns.find((c) => c.name === "scheduled_for");
  check("jobs are indexed by their scheduled window - FLD-1's only query", scheduled?.isIndexed === true);
  const status = jobs.columns.find((c) => c.name === "status");
  check("and by status", status?.isIndexed === true);
  check("jobs carry a version for the server-authoritative class", columnNames(jobs).includes("version"));
  check("and the safety-gate requirements come from the server", columnNames(jobs).includes("permit_required"));
}

done("schema");
