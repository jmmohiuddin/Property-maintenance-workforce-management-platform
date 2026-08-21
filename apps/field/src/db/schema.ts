/**
 * The local database schema.
 *
 * ── WHY THIS IS PLAIN DATA AND NOT `appSchema()` ───────────────────────────
 *
 * WatermelonDB's `appSchema`/`tableSchema` builders take exactly this shape and
 * return a validated object. Declaring the shape here as plain data, and
 * calling the builders in `watermelon.ts`, buys two things:
 *
 *   1. The schema is in the portable TypeScript project, so `npm run typecheck`
 *      and `npm test` cover it on a machine with no Expo installed - which is
 *      every machine in this repository right now. A schema nobody can compile
 *      is a schema that rots.
 *   2. `test/schema.test.ts` can assert properties across the whole schema -
 *      every table indexed on what it is queried by, every synced table
 *      carrying both timestamps ADR 0004 requires - without a native SQLite.
 *
 * ── WHAT IS STORED, AND THE ONE RULE ───────────────────────────────────────
 *
 * Every table here is either part of the bounded working set (`FLD-2`,
 * working-set.ts) or part of the machinery that gets it there. There is no
 * table for anything the technician has no business holding: no other
 * technician's jobs, no customer book, no prices, no invoices.
 *
 * The rule that runs through all of it: **the record id IS the client id**.
 * WatermelonDB lets a record be created with an explicit id, and using the
 * device-minted ULID for it means a photo can reference its parent job event by
 * primary key before the server has ever seen either. TRD §8.3 calls
 * client-generated ids non-negotiable; this is what non-negotiable looks like
 * in a schema.
 */

export type ColumnType = "string" | "number" | "boolean";

export interface ColumnSchema {
  readonly name: string;
  readonly type: ColumnType;
  readonly isOptional?: boolean;
  readonly isIndexed?: boolean;
}

export interface TableSchema {
  readonly name: string;
  readonly columns: readonly ColumnSchema[];
}

export interface DatabaseSchema {
  readonly version: number;
  readonly tables: readonly TableSchema[];
}

/**
 * Version 1. Bumping this without writing a migration wipes every device -
 * WatermelonDB's default for an unmigratable schema change is to reset the
 * database, which here means deleting a technician's unsynced day. Any change
 * to this number needs a migration in `watermelon.ts` and a note in the report.
 */
export const SCHEMA_VERSION = 1;

/** Both timestamps ADR 0004 requires, on every record captured offline. */
const OFFLINE_STAMP: readonly ColumnSchema[] = [
  { name: "recorded_offline_at", type: "number", isIndexed: true },
  { name: "device_offset_ms_at_capture", type: "number", isOptional: true },
  { name: "server_received_at", type: "number", isOptional: true },
  { name: "monotonic_at", type: "number" },
];

const GEO: readonly ColumnSchema[] = [
  { name: "lat", type: "number", isOptional: true },
  { name: "lng", type: "number", isOptional: true },
  { name: "accuracy_metres", type: "number", isOptional: true },
];

export const FIELD_SCHEMA: DatabaseSchema = {
  version: SCHEMA_VERSION,
  tables: [
    // ── Synced down: the bounded working set ──────────────────────────────
    {
      name: "jobs",
      columns: [
        { name: "server_id", type: "string", isIndexed: true },
        { name: "reference", type: "string" },
        { name: "title", type: "string" },
        { name: "description", type: "string", isOptional: true },
        { name: "status", type: "string", isIndexed: true },
        { name: "priority", type: "string", isIndexed: true },
        { name: "service_slug", type: "string" },
        { name: "customer_id", type: "string", isIndexed: true },
        { name: "property_id", type: "string", isIndexed: true },
        { name: "asset_id", type: "string", isOptional: true },
        { name: "visit_id", type: "string", isOptional: true },
        // The list screen's only query: mine, ordered by window (`FLD-1`).
        { name: "scheduled_for", type: "number", isOptional: true, isIndexed: true },
        { name: "scheduled_end", type: "number", isOptional: true },
        { name: "reported_fault", type: "string", isOptional: true },
        { name: "respond_by_at", type: "number", isOptional: true },
        { name: "resolve_by_at", type: "number", isOptional: true },
        // `FLD-4`. Set by the server; the device never infers a permit rule.
        { name: "rams_required", type: "boolean" },
        { name: "permit_required", type: "boolean" },
        { name: "required_ppe_codes", type: "string" },
        { name: "rams_template_id", type: "string", isOptional: true },
        /**
         * `FieldJob.gaps`, server-computed (`JOB-15`). **Three states, stored
         * as three states:** the column absent means this job has never synced
         * and the device has never been told; `"null"` means completion is not
         * on the table; `"[]"` means the server says the card is complete.
         *
         * Stored as JSON text rather than as a boolean "ready" flag, because a
         * flag would throw away which conditions are outstanding - which is the
         * whole reason the server sends a list rather than a verdict.
         */
        { name: "gaps_json", type: "string", isOptional: true },
        // Optimistic concurrency for the server-authoritative class (§8.4).
        // A string, not an integer: the server's `FieldMutation.baseVersion`
        // is an ISO timestamp, and storing it as a number here would force a
        // lossy conversion on every send.
        { name: "version", type: "string" },
        { name: "synced_at", type: "number" },
      ],
    },
    {
      name: "customers",
      columns: [
        { name: "server_id", type: "string", isIndexed: true },
        { name: "name", type: "string" },
        { name: "phone", type: "string", isOptional: true },
        { name: "synced_at", type: "number" },
      ],
    },
    {
      name: "properties",
      columns: [
        { name: "server_id", type: "string", isIndexed: true },
        { name: "customer_id", type: "string", isIndexed: true },
        { name: "name", type: "string" },
        { name: "address", type: "string" },
        { name: "unit_label", type: "string", isOptional: true },
        // The single most useful offline field on the whole screen: how to get
        // in at 07:00 when nobody answers the phone.
        { name: "access_instructions", type: "string", isOptional: true },
        { name: "lat", type: "number", isOptional: true },
        { name: "lng", type: "number", isOptional: true },
        { name: "synced_at", type: "number" },
      ],
    },
    {
      name: "assets",
      columns: [
        { name: "server_id", type: "string", isIndexed: true },
        { name: "property_id", type: "string", isIndexed: true },
        { name: "tag", type: "string", isIndexed: true },
        { name: "name", type: "string" },
        { name: "manufacturer", type: "string", isOptional: true },
        { name: "model", type: "string", isOptional: true },
        { name: "serial_number", type: "string", isOptional: true },
        { name: "location_note", type: "string", isOptional: true },
        { name: "synced_at", type: "number" },
      ],
    },
    /**
     * **This table is currently always empty, and that is not a bug here.**
     *
     * `GET /api/field/v1/sync` returns the parts catalogue in
     * `notYetAvailable`: no parts/SKU table exists server-side, and
     * `rate_card_items` prices work rather than parts. The materials screen
     * therefore falls back to free text flagged for office reconciliation.
     *
     * The table is kept rather than deleted because the fallback is meant to be
     * temporary, and a schema change that has to migrate a technician's device
     * is more expensive than four unused columns. If the catalogue is still
     * absent when this app ships, delete it - an empty table that looks like a
     * feature is exactly the kind of lie this codebase is trying not to tell.
     */
    {
      name: "parts",
      columns: [
        { name: "server_id", type: "string", isIndexed: true },
        { name: "sku", type: "string", isIndexed: true },
        { name: "description", type: "string" },
        { name: "unit", type: "string" },
        // Deliberately no price column. Prices are online-only
        // (working-set.ts) so the device cannot quote a stale number.
        { name: "synced_at", type: "number" },
      ],
    },
    {
      name: "taxonomy_terms",
      columns: [
        { name: "server_id", type: "string", isIndexed: true },
        /**
         * The server's own payload keys, so the two cannot drift:
         * "faultCodes" | "outcomeCodes" | "photoExemptionReasons" | "rateCard",
         * from `FieldSyncPage.taxonomies`.
         *
         * The exemption reasons are rows of `job_photo_exemption_reasons`, read
         * by `listPhotoExemptionReasons(tx)` - five seeded per tenant. The
         * device holds no vocabulary of its own: a reason code that this app
         * invented is a reason the server would refuse, offline, with no way
         * for the technician to find out until they get signal.
         */
        { name: "vocabulary", type: "string", isIndexed: true },
        // For fault codes: "symptom" | "cause" | "remedy". Null otherwise.
        { name: "kind", type: "string", isOptional: true, isIndexed: true },
        { name: "code", type: "string" },
        { name: "label", type: "string" },
        { name: "description", type: "string", isOptional: true },
        { name: "requires_return_visit", type: "boolean", isOptional: true },
        { name: "sort_order", type: "number" },
        { name: "synced_at", type: "number" },
      ],
    },
    {
      name: "certifications",
      columns: [
        { name: "server_id", type: "string", isIndexed: true },
        { name: "scheme", type: "string" },
        { name: "label", type: "string" },
        { name: "reference", type: "string", isOptional: true },
        { name: "expires_on", type: "number", isOptional: true, isIndexed: true },
        // Computed server-side AND re-derivable on device from `expires_on`
        // via certState() in @meridian/core, so an expiry that passes at
        // midnight while the phone is offline still shows as expired.
        { name: "state", type: "string" },
        { name: "synced_at", type: "number" },
      ],
    },

    // ── Captured on the device ────────────────────────────────────────────
    {
      name: "timing_events",
      columns: [
        { name: "job_id", type: "string", isIndexed: true },
        { name: "visit_id", type: "string", isOptional: true },
        { name: "kind", type: "string" },
        { name: "pause_reason", type: "string", isOptional: true },
        { name: "note", type: "string", isOptional: true },
        ...OFFLINE_STAMP,
        ...GEO,
      ],
    },
    {
      name: "job_cards",
      columns: [
        { name: "job_id", type: "string", isIndexed: true },
        { name: "symptom_code_id", type: "string", isOptional: true },
        { name: "cause_code_id", type: "string", isOptional: true },
        { name: "remedy_code_id", type: "string", isOptional: true },
        { name: "diagnosis_note", type: "string", isOptional: true },
        { name: "work_carried_out", type: "string", isOptional: true },
        /**
         * `FLD-12`. A field of `job_note/upsert`, not a mutation of its own -
         * the server has no recommendation entity. It lived in its own table
         * here until the API contract was read properly; a capture surface with
         * no sync path loses a technician's work silently, and for `FLD-12`
         * that means losing the highest-value field on the form.
         */
        { name: "recommendation", type: "string", isOptional: true },
        /**
         * The *local* photo's client id, held here until the capture-and-
         * upload pipeline (not built in this session — see the note at the
         * top of `JobCardScreen.tsx`) resolves it to a server `uploadId`.
         * `job_note/upsert` now has a field for the resolved id -
         * `recommendationUploadId` in `sync/payloads.ts` - which the server
         * files as the sixth `job_attachments.kind`, `photo_recommendation`
         * (`0034`). Keeping the client id locally is what lets the
         * association survive the gap between a technician picking a photo
         * and that photo finishing its upload.
         */
        { name: "recommendation_photo_client_id", type: "string", isOptional: true },
        { name: "outcome_code", type: "string", isOptional: true },
        { name: "photo_exemption_code", type: "string", isOptional: true },
        { name: "photo_exemption_note", type: "string", isOptional: true },
        // `JOB-15`'s "explicitly none". Null is "nobody filled it in".
        { name: "materials_none_at", type: "number", isOptional: true },
        { name: "materials_none_note", type: "string", isOptional: true },
        { name: "labour_override_minutes", type: "number", isOptional: true },
        { name: "labour_override_reason", type: "string", isOptional: true },
        // The server's last refusal, kept so the checklist survives a restart.
        // JSON array of gap codes; absent when the refusal was not the JOB-15
        // gate. Absent is not empty - an empty list would mean nothing is
        // missing, which is never true of a refused completion.
        { name: "last_refusal_gaps", type: "string", isOptional: true },
        { name: "last_refusal_message", type: "string", isOptional: true },
        { name: "base_version", type: "string", isOptional: true },
        ...OFFLINE_STAMP,
      ],
    },
    {
      name: "job_materials",
      columns: [
        { name: "job_id", type: "string", isIndexed: true },
        { name: "sku", type: "string", isOptional: true },
        { name: "description", type: "string" },
        { name: "quantity", type: "string" },
        { name: "unit", type: "string" },
        { name: "source", type: "string" },
        { name: "serial_number", type: "string", isOptional: true },
        { name: "needs_office_reconciliation", type: "boolean" },
        ...OFFLINE_STAMP,
      ],
    },
    {
      name: "job_photos",
      columns: [
        { name: "job_id", type: "string", isIndexed: true },
        { name: "role", type: "string", isIndexed: true },
        { name: "local_uri", type: "string" },
        { name: "original_uri", type: "string", isOptional: true },
        { name: "thumbnail_uri", type: "string", isOptional: true },
        { name: "byte_size", type: "number" },
        { name: "sha256", type: "string", isOptional: true },
        { name: "caption", type: "string", isOptional: true },
        // The job event this photograph evidences. TRD §8.3: the completion
        // must never arrive before the evidence it cites.
        { name: "depends_on_client_id", type: "string", isOptional: true },
        { name: "upload_state", type: "string", isIndexed: true },
        /**
         * The server's upload id, from `POST /uploads/init`. **This, not a
         * storage key, is what the attachment mutation cites.**
         *
         * No `storage_key` column exists and none should: the server never
         * returns one (`SEC-8`, a key is not a link), and taking a key from a
         * payload let a handset file an attachment pointing at any object in
         * the tenant. The upload row is what ties the bytes to this job and
         * this technician.
         */
        { name: "upload_id", type: "string", isOptional: true },
        { name: "client_upload_id", type: "string", isOptional: true },
        /** JSON array. Server-recounted at each init, never incremented here. */
        { name: "received_chunks", type: "string", isOptional: true },
        { name: "chunk_size", type: "number", isOptional: true },
        /** "pending" until the server's virus scan clears it. Never assumed. */
        { name: "scan_status", type: "string", isOptional: true },
        { name: "upload_now_override", type: "boolean" },
        ...OFFLINE_STAMP,
        ...GEO,
      ],
    },
    {
      name: "job_signoffs",
      columns: [
        { name: "job_id", type: "string", isIndexed: true },
        { name: "visit_id", type: "string", isOptional: true },
        { name: "signed_by_name", type: "string" },
        { name: "signed_by_role", type: "string", isOptional: true },
        { name: "signed_by_email", type: "string", isOptional: true },
        // Vector strokes, JSON. `FLD-15`: points only, no timing or pressure.
        /** Cites the upload, for the same reason job_photos does. */
        { name: "upload_id", type: "string", isOptional: true },
        { name: "strokes_json", type: "string" },
        { name: "aspect_ratio", type: "number" },
        { name: "consent_version", type: "string" },
        { name: "consent_text", type: "string" },
        // `FLD-14`. The evidential anchor.
        { name: "sheet_digest", type: "string" },
        { name: "sheet_canonical", type: "string" },
        { name: "technician_id", type: "string" },
        { name: "app_version", type: "string" },
        { name: "satisfaction_rating", type: "number", isOptional: true },
        { name: "comments", type: "string", isOptional: true },
        ...OFFLINE_STAMP,
        ...GEO,
      ],
    },
    {
      name: "job_unsigned_attestations",
      columns: [
        { name: "job_id", type: "string", isIndexed: true },
        { name: "reason", type: "string" },
        { name: "note", type: "string" },
        { name: "attested_by_supervisor_id", type: "string", isOptional: true },
        ...OFFLINE_STAMP,
      ],
    },
    /**
     * ── TWO TABLES THAT USED TO BE HERE, AND WHY THEY ARE NOT ──────────────
     *
     * `job_recommendations` and `job_amendments` were both capture surfaces
     * with no sync path, which is the worst thing a local database can hold: a
     * technician fills one in, the app says it is saved, and nothing ever
     * carries it to the office.
     *
     * The recommendation had a server home all along - it is the
     * `recommendation` field of `job_note/upsert` - so it moved onto
     * `job_cards` above and syncs with the note.
     *
     * Amendments have no server route at all. `FLD-14` requires them - after
     * signature the record locks and corrections are new linked amendments -
     * and `FIELD_MUTATION_KINDS` has nothing that expresses one. Rather than
     * offer a screen that writes to a dead end, the app has no amendment
     * capture, `isLocked()` in `domain/signature.ts` refuses the edit, and the
     * technician is told to call the office. That is a real gap and it is
     * visible, which is the whole difference.
     */

    // ── The outbox (TRD §8.3) ─────────────────────────────────────────────
    {
      name: "outbox",
      columns: [
        { name: "entity", type: "string", isIndexed: true },
        { name: "op", type: "string" },
        { name: "job_id", type: "string", isOptional: true, isIndexed: true },
        { name: "payload_json", type: "string" },
        { name: "base_version", type: "string", isOptional: true },
        { name: "depends_on_client_id", type: "string", isOptional: true, isIndexed: true },
        { name: "created_at_device", type: "number" },
        { name: "created_monotonic", type: "number", isIndexed: true },
        { name: "attempt_count", type: "number" },
        { name: "next_attempt_after", type: "number" },
        // The drain query is `WHERE status = 'pending'`; without this index it
        // scans a table that holds a week of a busy technician's work.
        { name: "status", type: "string", isIndexed: true },
        { name: "last_error", type: "string", isOptional: true },
        // JSON array, on a `refused` row only. See job_cards.last_refusal_gaps.
        { name: "refusal_gaps", type: "string", isOptional: true },
        { name: "server_received_at", type: "number", isOptional: true },
      ],
    },

    // ── Device state ──────────────────────────────────────────────────────
    /**
     * Key/value, holding: the pull cursor (`nextCursor` from the last sync),
     * the device token's expiry, the last measured clock skew, and the last
     * successful sync time. A table rather than four columns on nothing,
     * because the set of things worth remembering across launches grows and a
     * schema migration to add one of them would risk a technician's data.
     */
    {
      name: "sync_state",
      columns: [
        { name: "key", type: "string", isIndexed: true },
        { name: "value", type: "string" },
        { name: "updated_at", type: "number" },
      ],
    },
  ],
};

// ── Assertions the tests use ────────────────────────────────────────────────

/** Tables holding records the technician captured, which must carry both clocks. */
export const OFFLINE_CAPTURED_TABLES: readonly string[] = [
  "timing_events",
  "job_cards",
  "job_materials",
  "job_photos",
  "job_signoffs",
  "job_unsigned_attestations",
];

export function tableNames(schema: DatabaseSchema = FIELD_SCHEMA): readonly string[] {
  return schema.tables.map((t) => t.name);
}

export function tableByName(name: string, schema: DatabaseSchema = FIELD_SCHEMA): TableSchema | null {
  return schema.tables.find((t) => t.name === name) ?? null;
}

export function columnNames(table: TableSchema): readonly string[] {
  return table.columns.map((c) => c.name);
}
