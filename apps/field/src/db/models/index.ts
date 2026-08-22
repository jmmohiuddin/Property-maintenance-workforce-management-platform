/**
 * WatermelonDB models.
 *
 * **NOT TYPECHECKED BY THE ROOT GATE** (see tsconfig.json). These are the
 * decorator-annotated classes WatermelonDB needs; the schema they must agree
 * with is `../schema.ts`, which *is* typechecked and tested.
 *
 * The agreement between the two is currently maintained by hand and is the
 * most likely place for a mistake in this workspace: a column added to the
 * schema and not to the model is silently unreadable, and a field decorated
 * with a column name the schema does not have throws only when that record is
 * first read. `test/schema.test.ts` asserts things about the schema; nothing
 * asserts that these classes match it. Generating these from the descriptor
 * would remove the class of bug entirely and is the first thing worth doing to
 * this file.
 */

import { Model } from "@nozbe/watermelondb";
import { field, text, date } from "@nozbe/watermelondb/decorators";

// ── Synced down ─────────────────────────────────────────────────────────────

export class Job extends Model {
  static override table = "jobs";

  @text("server_id") serverId!: string;
  @text("reference") reference!: string;
  @text("title") title!: string;
  @text("description") description?: string;
  @text("status") status!: string;
  @text("priority") priority!: string;
  @text("service_slug") serviceSlug!: string;
  @text("customer_id") customerId!: string;
  @text("property_id") propertyId!: string;
  @text("asset_id") assetId?: string;
  @text("visit_id") visitId?: string;
  @field("scheduled_for") scheduledFor?: number;
  @field("scheduled_end") scheduledEnd?: number;
  @text("reported_fault") reportedFault?: string;
  @field("respond_by_at") respondByAt?: number;
  @field("resolve_by_at") resolveByAt?: number;
  @field("rams_required") ramsRequired!: boolean;
  @field("permit_required") permitRequired!: boolean;
  /** JSON array of PPE codes. Stored as text because SQLite has no array type. */
  @text("required_ppe_codes") requiredPpeCodes!: string;
  @text("rams_template_id") ramsTemplateId?: string;
  /** JSON: absent = never synced, "null" = not completable, "[]" = ready. */
  @text("gaps_json") gapsJson?: string;
  /** ISO timestamp, matching the server's string `baseVersion`. */
  @text("version") version!: string;
  @field("synced_at") syncedAt!: number;
}

export class Customer extends Model {
  static override table = "customers";
  @text("server_id") serverId!: string;
  @text("name") name!: string;
  @text("phone") phone?: string;
  @field("synced_at") syncedAt!: number;
}

export class Property extends Model {
  static override table = "properties";
  @text("server_id") serverId!: string;
  @text("customer_id") customerId!: string;
  @text("name") name!: string;
  @text("address") address!: string;
  @text("unit_label") unitLabel?: string;
  @text("access_instructions") accessInstructions?: string;
  @field("lat") lat?: number;
  @field("lng") lng?: number;
  @field("synced_at") syncedAt!: number;
}

export class Asset extends Model {
  static override table = "assets";
  @text("server_id") serverId!: string;
  @text("property_id") propertyId!: string;
  @text("tag") tag!: string;
  @text("name") name!: string;
  @text("manufacturer") manufacturer?: string;
  @text("model") model?: string;
  @text("serial_number") serialNumber?: string;
  @text("location_note") locationNote?: string;
  @field("synced_at") syncedAt!: number;
}

export class Part extends Model {
  static override table = "parts";
  @text("server_id") serverId!: string;
  @text("sku") sku!: string;
  @text("description") description!: string;
  @text("unit") unit!: string;
  @field("synced_at") syncedAt!: number;
}

export class TaxonomyTerm extends Model {
  static override table = "taxonomy_terms";
  @text("server_id") serverId!: string;
  @text("vocabulary") vocabulary!: string;
  @text("kind") kind?: string;
  @text("code") code!: string;
  @text("label") label!: string;
  @text("description") description?: string;
  @field("requires_return_visit") requiresReturnVisit?: boolean;
  @field("sort_order") sortOrder!: number;
  @field("synced_at") syncedAt!: number;
}

export class Certification extends Model {
  static override table = "certifications";
  @text("server_id") serverId!: string;
  @text("scheme") scheme!: string;
  @text("label") label!: string;
  @text("reference") reference?: string;
  @field("expires_on") expiresOn?: number;
  @text("state") state!: string;
  @field("synced_at") syncedAt!: number;
}

// ── Captured on the device ──────────────────────────────────────────────────

export class TimingEventModel extends Model {
  static override table = "timing_events";
  @text("job_id") jobId!: string;
  @text("visit_id") visitId?: string;
  @text("kind") kind!: string;
  @text("pause_reason") pauseReason?: string;
  @text("note") note?: string;
  @date("recorded_offline_at") recordedOfflineAt!: Date;
  @field("device_offset_ms_at_capture") deviceOffsetMsAtCapture?: number;
  @field("server_received_at") serverReceivedAt?: number;
  @field("monotonic_at") monotonicAt!: number;
  @field("lat") lat?: number;
  @field("lng") lng?: number;
  @field("accuracy_metres") accuracyMetres?: number;
}

/** `TECH-8`. See `domain/shift-clock.ts` for why this is a separate table and kind vocabulary from `TimingEventModel` above. */
export class AttendanceEvent extends Model {
  static override table = "attendance_events";
  @text("kind") kind!: string;
  /** `null` is "not evaluated"; never conflated with a real `false`. */
  @field("within_geofence") withinGeofence?: boolean;
  @date("recorded_offline_at") recordedOfflineAt!: Date;
  @field("device_offset_ms_at_capture") deviceOffsetMsAtCapture?: number;
  @field("server_received_at") serverReceivedAt?: number;
  @field("monotonic_at") monotonicAt!: number;
  @field("lat") lat?: number;
  @field("lng") lng?: number;
  @field("accuracy_metres") accuracyMetres?: number;
}

export class JobCardModel extends Model {
  static override table = "job_cards";
  @text("job_id") jobId!: string;
  @text("symptom_code_id") symptomCodeId?: string;
  @text("cause_code_id") causeCodeId?: string;
  @text("remedy_code_id") remedyCodeId?: string;
  @text("diagnosis_note") diagnosisNote?: string;
  @text("work_carried_out") workCarriedOut?: string;
  /** FLD-12. Syncs as the `recommendation` field of job_note/upsert. */
  @text("recommendation") recommendation?: string;
  @text("recommendation_photo_client_id") recommendationPhotoClientId?: string;
  @text("outcome_code") outcomeCode?: string;
  @text("photo_exemption_code") photoExemptionCode?: string;
  @text("photo_exemption_note") photoExemptionNote?: string;
  @field("materials_none_at") materialsNoneAt?: number;
  @text("materials_none_note") materialsNoneNote?: string;
  @field("labour_override_minutes") labourOverrideMinutes?: number;
  @text("labour_override_reason") labourOverrideReason?: string;
  /** JSON array of gap codes from the server's last refusal. */
  @text("last_refusal_gaps") lastRefusalGaps?: string;
  @text("last_refusal_message") lastRefusalMessage?: string;
  @text("base_version") baseVersion?: string;
  @date("recorded_offline_at") recordedOfflineAt!: Date;
  @field("device_offset_ms_at_capture") deviceOffsetMsAtCapture?: number;
  @field("server_received_at") serverReceivedAt?: number;
  @field("monotonic_at") monotonicAt!: number;
}

export class JobMaterial extends Model {
  static override table = "job_materials";
  @text("job_id") jobId!: string;
  @text("sku") sku?: string;
  @text("description") description!: string;
  @text("quantity") quantity!: string;
  @text("unit") unit!: string;
  @text("source") source!: string;
  @text("serial_number") serialNumber?: string;
  @field("needs_office_reconciliation") needsOfficeReconciliation!: boolean;
  @date("recorded_offline_at") recordedOfflineAt!: Date;
  @field("device_offset_ms_at_capture") deviceOffsetMsAtCapture?: number;
  @field("server_received_at") serverReceivedAt?: number;
  @field("monotonic_at") monotonicAt!: number;
}

export class JobPhoto extends Model {
  static override table = "job_photos";
  @text("job_id") jobId!: string;
  @text("role") role!: string;
  @text("local_uri") localUri!: string;
  @text("original_uri") originalUri?: string;
  @text("thumbnail_uri") thumbnailUri?: string;
  @field("byte_size") byteSize!: number;
  @text("sha256") sha256?: string;
  @text("caption") caption?: string;
  @text("depends_on_client_id") dependsOnClientId?: string;
  @text("upload_state") uploadState!: string;
  /** The server's upload id. What the attachment mutation cites - not a key. */
  @text("upload_id") uploadId?: string;
  @text("client_upload_id") clientUploadId?: string;
  /** JSON array of chunk indices the server has confirmed. */
  @text("received_chunks") receivedChunks?: string;
  @field("chunk_size") chunkSize?: number;
  @text("scan_status") scanStatus?: string;
  @field("upload_now_override") uploadNowOverride!: boolean;
  @date("recorded_offline_at") recordedOfflineAt!: Date;
  @field("device_offset_ms_at_capture") deviceOffsetMsAtCapture?: number;
  @field("server_received_at") serverReceivedAt?: number;
  @field("monotonic_at") monotonicAt!: number;
  @field("lat") lat?: number;
  @field("lng") lng?: number;
  @field("accuracy_metres") accuracyMetres?: number;
}

export class JobSignoff extends Model {
  static override table = "job_signoffs";
  @text("job_id") jobId!: string;
  @text("visit_id") visitId?: string;
  @text("signed_by_name") signedByName!: string;
  @text("signed_by_role") signedByRole?: string;
  @text("signed_by_email") signedByEmail?: string;
  @text("upload_id") uploadId?: string;
  @text("strokes_json") strokesJson!: string;
  @field("aspect_ratio") aspectRatio!: number;
  @text("consent_version") consentVersion!: string;
  @text("consent_text") consentText!: string;
  @text("sheet_digest") sheetDigest!: string;
  @text("sheet_canonical") sheetCanonical!: string;
  @text("technician_id") technicianId!: string;
  @text("app_version") appVersion!: string;
  @field("satisfaction_rating") satisfactionRating?: number;
  @text("comments") comments?: string;
  @date("recorded_offline_at") recordedOfflineAt!: Date;
  @field("device_offset_ms_at_capture") deviceOffsetMsAtCapture?: number;
  @field("server_received_at") serverReceivedAt?: number;
  @field("monotonic_at") monotonicAt!: number;
  @field("lat") lat?: number;
  @field("lng") lng?: number;
  @field("accuracy_metres") accuracyMetres?: number;
}

export class JobUnsignedAttestation extends Model {
  static override table = "job_unsigned_attestations";
  @text("job_id") jobId!: string;
  @text("reason") reason!: string;
  @text("note") note!: string;
  @text("attested_by_supervisor_id") attestedBySupervisorId?: string;
  @date("recorded_offline_at") recordedOfflineAt!: Date;
  @field("device_offset_ms_at_capture") deviceOffsetMsAtCapture?: number;
  @field("server_received_at") serverReceivedAt?: number;
  @field("monotonic_at") monotonicAt!: number;
}

// ── Machinery ───────────────────────────────────────────────────────────────

export class Outbox extends Model {
  static override table = "outbox";
  @text("entity") entity!: string;
  @text("op") op!: string;
  @text("job_id") jobId?: string;
  @text("payload_json") payloadJson!: string;
  @text("base_version") baseVersion?: string;
  @text("depends_on_client_id") dependsOnClientId?: string;
  @field("created_at_device") createdAtDevice!: number;
  @field("created_monotonic") createdMonotonic!: number;
  @field("attempt_count") attemptCount!: number;
  @field("next_attempt_after") nextAttemptAfter!: number;
  @text("status") status!: string;
  @text("last_error") lastError?: string;
  /** JSON array of JOB-15 gap codes, on a `refused` row only. */
  @text("refusal_gaps") refusalGaps?: string;
  @field("server_received_at") serverReceivedAt?: number;
}

export class SyncState extends Model {
  static override table = "sync_state";
  @text("key") key!: string;
  @text("value") value!: string;
  @field("updated_at") updatedAt!: number;
}
