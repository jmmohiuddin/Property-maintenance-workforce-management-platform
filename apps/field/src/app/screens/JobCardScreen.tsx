/**
 * The digital job card - the point of the whole application.
 *
 * `FLD-6` fault capture, `FLD-7` photos, `FLD-9` materials, `FLD-10` labour,
 * `FLD-11` outcome, `FLD-12` recommendations, and the `JOB-15` completion gate.
 *
 * ── THE CHECKLIST COMES FROM THE SERVER ────────────────────────────────────
 *
 * `job.gapsJson` is `FieldJob.gaps`, computed by `getJobCard(tx, jobId)` - the
 * same call the web job-card panel renders. This screen does not work out what
 * is missing and is not allowed to: one rule, one implementation.
 * `packages/db/src/domain/jobcard.ts` puts it as *"a checklist computed
 * separately from the check is a checklist that eventually says 'ready' about
 * a job the server refuses."*
 *
 * Three states, three renderings, and the third is the one that is easy to get
 * wrong: a job that has never synced shows **neither** a checklist nor a live
 * complete button, because the device has not been told and guessing either way
 * would be the device deciding.
 *
 * When a completion is refused, `lastRefusal` holds the fresh list the server
 * sent back with the rejection, and the queued write stays in the outbox as
 * `refused` so the technician can correct the card rather than re-enter it.
 *
 * ── WHAT IS REAL HERE NOW, AND HOW ───────────────────────────────────────
 *
 * Every control below writes to the local database first and, where the
 * capture has its own mutation, queues that mutation into the outbox in the
 * same transaction - never straight to the network (`db/watermelon.ts`'s
 * `writeWithOutbox` / `writeCardMutation`). "Take a photo" is the one
 * exception worth naming: its `job_attachment/append` mutation cannot exist
 * until the photograph has an `uploadId`, so the capture is saved locally and
 * instantly, and `app/upload-runner.ts` files the mutation once the upload
 * (a real network operation) completes - see that file's header for why that
 * is a real asymmetry and not a shortcut.
 *
 * `symptomCodeId` / `causeCodeId` / `remedyCodeId` and `outcomeCode` are set
 * on the job card immediately when chosen (a local fact, no mutation of its
 * own - `domain/outcome-entry.ts` explains why there is no such mutation) and
 * are only sent to the office when "Record outcome" is pressed, which is the
 * one control here that can complete the job.
 *
 * NOT RENDERED IN THIS SESSION - see the note at the top of App.tsx. It
 * compiles under `npm run typecheck:native`; nothing about its layout, its
 * touch targets or its scroll behaviour has been seen.
 */

import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Database } from "@nozbe/watermelondb";
import { Q } from "@nozbe/watermelondb";

import { theme } from "../theme";
import type { Job, JobCardModel, JobMaterial, JobPhoto, TaxonomyTerm, TimingEventModel } from "../../db/models";
import {
  canDeclareNoMaterials,
  completionReadiness,
  interpretRefusal,
  isMaterialSource,
  isPhotoRole,
  MATERIAL_SOURCES,
  MATERIAL_SOURCE_LABEL,
  PHOTO_ROLE_LABEL,
  type FaultCodeKind,
  type JobCardDraft,
} from "../../domain/job-card";
import {
  deriveLabour,
  isLabourRecorded,
  labourToRecord,
  startWorkRefusal,
  TIMING_EVENT_LABEL,
  type TimingEvent,
} from "../../domain/attendance";
import { formatDuration } from "@meridian/core";
import { systemClock, stampOffline, type OfflineStamp } from "../../domain/clock";
import { newClientId } from "../../domain/ids";
import { appendMaterial, declareNoMaterials, recordOutcome, type MutationSpec } from "../../sync/payloads";
import {
  writeWithOutbox,
  writeCardMutation,
  updateJobCard,
  createJobPhotoRecord,
  type OutboxWrite,
} from "../../db/watermelon";
import {
  EMPTY_MATERIAL_ENTRY,
  MATERIAL_ENTRY_ERROR_MESSAGE,
  validateMaterialEntry,
  type MaterialEntryDraft,
} from "../../domain/material-entry";
import {
  EMPTY_FAULT_CODE_SELECTION,
  OUTCOME_SUBMIT_ERROR_MESSAGE,
  validateOutcomeDraft,
  withFaultCode,
  type FaultCodeChoice,
  type FaultCodeSelection,
} from "../../domain/outcome-entry";
import { CameraCaptureScreen, type CapturedPhotoResult } from "./CameraCaptureScreen";

const FAULT_KINDS: readonly FaultCodeKind[] = ["symptom", "cause", "remedy"];
const FAULT_KIND_LABEL: Readonly<Record<FaultCodeKind, string>> = {
  symptom: "Symptom",
  cause: "Cause",
  remedy: "Remedy",
};

export function JobCardScreen({
  database,
  jobId,
  onBack,
  onSign,
}: {
  database: Database;
  jobId: string;
  onBack: () => void;
  onSign: () => void;
}): React.JSX.Element {
  const [job, setJob] = useState<Job | null>(null);
  const [card, setCard] = useState<JobCardModel | null>(null);
  const [photos, setPhotos] = useState<JobPhoto[]>([]);
  const [materials, setMaterials] = useState<JobMaterial[]>([]);
  const [events, setEvents] = useState<TimingEventModel[]>([]);
  const [faultTerms, setFaultTerms] = useState<TaxonomyTerm[]>([]);
  const [outcomeTerms, setOutcomeTerms] = useState<TaxonomyTerm[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const [cameraOpen, setCameraOpen] = useState(false);
  const [showMaterialForm, setShowMaterialForm] = useState(false);
  const [materialDraft, setMaterialDraft] = useState<MaterialEntryDraft>(EMPTY_MATERIAL_ENTRY);
  const [materialErrors, setMaterialErrors] = useState<readonly string[]>([]);
  const [outcomeNote, setOutcomeNote] = useState("");
  const [outcomeError, setOutcomeError] = useState<string | null>(null);

  useEffect(() => {
    const subscriptions = [
      database.get<Job>("jobs").findAndObserve(jobId).subscribe(setJob),
      database
        .get<JobCardModel>("job_cards")
        .query(Q.where("job_id", jobId))
        .observe()
        .subscribe((rows) => setCard(rows[0] ?? null)),
      database.get<JobPhoto>("job_photos").query(Q.where("job_id", jobId)).observe().subscribe(setPhotos),
      database.get<JobMaterial>("job_materials").query(Q.where("job_id", jobId)).observe().subscribe(setMaterials),
      database
        .get<TimingEventModel>("timing_events")
        .query(Q.where("job_id", jobId))
        .observe()
        .subscribe(setEvents),
      database
        .get<TaxonomyTerm>("taxonomy_terms")
        .query(Q.where("vocabulary", "faultCodes"))
        .observe()
        .subscribe(setFaultTerms),
      database
        .get<TaxonomyTerm>("taxonomy_terms")
        .query(Q.where("vocabulary", "outcomeCodes"))
        .observe()
        .subscribe(setOutcomeTerms),
    ];
    return () => subscriptions.forEach((s) => s.unsubscribe());
  }, [database, jobId]);

  const labour = useMemo(() => deriveLabour(events.map(toTimingEvent)), [events]);

  const faultByKind = useMemo(() => {
    const groups: Record<FaultCodeKind, TaxonomyTerm[]> = { symptom: [], cause: [], remedy: [] };
    for (const term of faultTerms) {
      if (term.kind === "symptom" || term.kind === "cause" || term.kind === "remedy") groups[term.kind].push(term);
    }
    return groups;
  }, [faultTerms]);

  const faultSelection: FaultCodeSelection = useMemo(() => {
    function findChoice(id: string | undefined): FaultCodeChoice | null {
      if (!id) return null;
      const term = faultTerms.find((t) => t.id === id);
      return term && (term.kind === "symptom" || term.kind === "cause" || term.kind === "remedy")
        ? { id: term.id, kind: term.kind, code: term.code, label: term.label }
        : null;
    }
    return {
      symptom: findChoice(card?.symptomCodeId),
      cause: findChoice(card?.causeCodeId),
      remedy: findChoice(card?.remedyCodeId),
    };
  }, [faultTerms, card]);

  const draft: JobCardDraft | null = useMemo(() => {
    if (!job) return null;
    return {
      jobId,
      fault: {
        reportedFault: job.reportedFault ?? null,
        symptom: null,
        cause: null,
        remedy: null,
        diagnosisNote: card?.diagnosisNote ?? null,
      },
      workCarriedOut: card?.workCarriedOut ?? null,
      // `JobPhoto.role` is a `@text` column, so WatermelonDB hands back a plain
      // `string`. This used to be `photo.role as never` — the same assertion
      // `material.source` carried until `FLD-9` showed what it costs: the
      // compiler being told to stop objecting at precisely the seam where the
      // device's vocabulary meets the server's. It is a real narrowing now,
      // through `core`'s own predicate, and an unreadable role becomes `null`
      // rather than being guessed. A photograph with no readable role has no
      // destination `job_attachments.kind`, so it cannot be filed — see
      // `CapturedPhoto.role`.
      photos: photos.map((photo) => ({
        clientId: photo.id,
        jobId,
        role: isPhotoRole(photo.role) ? photo.role : null,
        localUri: photo.localUri,
        originalUri: photo.originalUri ?? null,
        thumbnailUri: photo.thumbnailUri ?? null,
        stamp: {
          recordedOfflineAt: photo.recordedOfflineAt.toISOString(),
          monotonicAt: photo.monotonicAt,
          deviceOffsetMsAtCapture: photo.deviceOffsetMsAtCapture ?? null,
          serverReceivedAt: photo.serverReceivedAt ? new Date(photo.serverReceivedAt).toISOString() : null,
        },
        capturedLat: photo.lat ?? null,
        capturedLng: photo.lng ?? null,
        caption: photo.caption ?? null,
        uploadState: photo.uploadState as never,
        // Both null until the upload has been opened and the server has
        // scanned it. `scanStatus` is deliberately not defaulted to anything
        // that reads as cleared - see `CapturedPhoto`.
        uploadId: photo.uploadId ?? null,
        scanStatus: photo.scanStatus ?? null,
      })),
      photoExemptionCode: card?.photoExemptionCode ?? null,
      photoExemptionNote: card?.photoExemptionNote ?? null,
      // `JobMaterial.source` is a `@text` column, so WatermelonDB hands back a
      // plain `string` - the local schema constrains nothing. This used to be
      // `material.source as never`, which is the compiler being told to stop
      // objecting at precisely the seam that broke: an assertion that every row
      // in this device's SQLite holds one of three values, with nothing
      // anywhere enforcing it. The server does enforce it now (a CHECK
      // constraint, and `isMaterialSource` in `recordJobMaterial`), so an
      // unrecognised value is not a display problem - it is a mutation the
      // office refuses.
      //
      // So it is checked with the office's own predicate rather than asserted.
      // An unreadable provenance becomes `null` - never a guessed default - and
      // the line is flagged for the office, which is what that flag is for.
      materials: materials.map((material) => ({
        clientId: material.id,
        sku: material.sku ?? null,
        description: material.description,
        quantity: material.quantity,
        unit: material.unit,
        source: isMaterialSource(material.source) ? material.source : null,
        serialNumber: material.serialNumber ?? null,
        needsOfficeReconciliation:
          material.needsOfficeReconciliation || !isMaterialSource(material.source),
      })),
      materialsDeclaredNone: card?.materialsNoneAt
        ? { at: new Date(card.materialsNoneAt).toISOString(), note: card.materialsNoneNote ?? null }
        : null,
      labour,
      labourOverride:
        card?.labourOverrideMinutes !== undefined && card.labourOverrideReason
          ? { workMinutes: card.labourOverrideMinutes, reason: card.labourOverrideReason }
          : null,
      outcomeCode: card?.outcomeCode ?? null,
      recommendation: null,
    };
  }, [job, card, photos, materials, labour, jobId]);

  // ── Write paths - every one offline-first, none of them awaiting the network ──

  function outboxWrite(spec: MutationSpec, stamp: OfflineStamp): OutboxWrite {
    return {
      clientId: newClientId(),
      entity: spec.entity,
      op: spec.op,
      jobId: spec.jobId,
      payload: spec.payload,
      baseVersion: spec.baseVersion,
      dependsOnClientId: spec.dependsOnClientId,
      createdAt: stamp.recordedOfflineAt,
      createdMonotonic: stamp.monotonicAt,
    };
  }

  async function chooseFaultCode(choice: FaultCodeChoice): Promise<void> {
    const next = withFaultCode(faultSelection, choice);
    const stamp = stampOffline(systemClock, null);
    await updateJobCard(database, jobId, stamp, (cardDraft) => {
      cardDraft.symptomCodeId = next.symptom?.id ?? undefined;
      cardDraft.causeCodeId = next.cause?.id ?? undefined;
      cardDraft.remedyCodeId = next.remedy?.id ?? undefined;
    });
  }

  async function submitMaterial(): Promise<void> {
    const result = validateMaterialEntry(materialDraft);
    if (!result.ok) {
      setMaterialErrors(result.errors.map((e) => MATERIAL_ENTRY_ERROR_MESSAGE[e]));
      return;
    }
    setMaterialErrors([]);
    const spec = appendMaterial({ jobId, ...result.value });
    const stamp = stampOffline(systemClock, null);
    try {
      await writeWithOutbox<JobMaterial>(database, "job_materials", outboxWrite(spec, stamp), (materialDraftRow) => {
        materialDraftRow.jobId = jobId;
        materialDraftRow.sku = result.value.sku ?? undefined;
        materialDraftRow.description = result.value.description;
        materialDraftRow.quantity = result.value.quantity;
        materialDraftRow.unit = result.value.unit;
        materialDraftRow.source = result.value.source;
        materialDraftRow.serialNumber = result.value.serialNumber ?? undefined;
        materialDraftRow.needsOfficeReconciliation = false;
        materialDraftRow.recordedOfflineAt = new Date(stamp.recordedOfflineAt);
        materialDraftRow.deviceOffsetMsAtCapture = stamp.deviceOffsetMsAtCapture ?? undefined;
        materialDraftRow.monotonicAt = stamp.monotonicAt;
      });
      setMaterialDraft(EMPTY_MATERIAL_ENTRY);
      setShowMaterialForm(false);
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "That part could not be saved on this phone.");
    }
  }

  async function declareNoParts(): Promise<void> {
    const spec = declareNoMaterials({ jobId });
    const stamp = stampOffline(systemClock, null);
    try {
      await writeCardMutation(database, jobId, stamp, outboxWrite(spec, stamp), (cardDraft) => {
        cardDraft.materialsNoneAt = Date.now();
      });
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "That could not be recorded on this phone.");
    }
  }

  async function submitOutcome(): Promise<void> {
    const result = validateOutcomeDraft({
      outcomeCode: card?.outcomeCode ?? null,
      outcomeLabel: null,
      fault: faultSelection,
      note: outcomeNote,
    });
    if (!result.ok) {
      setOutcomeError(result.errors.map((e) => OUTCOME_SUBMIT_ERROR_MESSAGE[e]).join(" "));
      return;
    }
    setOutcomeError(null);
    const spec = recordOutcome({ jobId, baseVersion: job?.version ?? null, ...result.value });
    const stamp = stampOffline(systemClock, null);
    try {
      await writeCardMutation(database, jobId, stamp, outboxWrite(spec, stamp), () => {
        // `outcomeCode` and the fault code ids are already on the card from
        // `chooseFaultCode` / the outcome picker below - this write only adds
        // the outbox row that sends them.
      });
      setOutcomeNote("");
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The outcome could not be recorded on this phone.");
    }
  }

  async function handleCaptured(result: CapturedPhotoResult): Promise<void> {
    const stamp = stampOffline(systemClock, null);
    try {
      await createJobPhotoRecord(database, {
        clientId: newClientId(),
        jobId,
        role: result.role,
        localUri: result.localUri,
        originalUri: result.originalUri,
        byteSize: result.byteSize,
        caption: null,
        dependsOnClientId: null,
        stamp,
        geo: result.geo,
      });
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "That photo could not be saved on this phone.");
    } finally {
      setCameraOpen(false);
    }
  }

  if (cameraOpen) {
    return (
      <CameraCaptureScreen onCaptured={(result) => void handleCaptured(result)} onCancel={() => setCameraOpen(false)} />
    );
  }

  if (!job || !draft) return <View style={styles.screen} />;

  // The server's answer, not ours. `undefined` when this job has never synced;
  // `null` when completion is not on the table; `[]` when it is ready.
  const serverGaps = job.gapsJson === undefined ? undefined : (JSON.parse(job.gapsJson) as string[] | null);
  const readiness = completionReadiness(serverGaps);

  const lastRefusal = card?.lastRefusalMessage
    ? interpretRefusal({
        clientId: card.id,
        message: card.lastRefusalMessage,
        ...(card.lastRefusalGaps ? { gaps: JSON.parse(card.lastRefusalGaps) as string[] } : {}),
      })
    : null;

  const labourRecord = labourToRecord(labour, draft.labourOverride);

  const lastEvent = events[events.length - 1];
  const safetyRefusal = startWorkRefusal(
    {
      ramsRequired: job.ramsRequired,
      requiredPpeCodes: JSON.parse(job.requiredPpeCodes || "[]") as string[],
      permitRequired: job.permitRequired,
    },
    // The acknowledgement UI is not built; nothing has been acknowledged, so
    // the gate is shut. That is the correct failure direction for a safety
    // gate and it is why the button below is disabled rather than hidden.
    { ramsVersion: null, ramsAcknowledgedAt: null, ppeConfirmed: [], ppeAcknowledgedAt: null, permitReference: null },
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Pressable onPress={onBack} style={styles.back} accessibilityRole="button">
        <Text style={styles.backText}>← Jobs</Text>
      </Pressable>

      <Text style={styles.title}>{job.title}</Text>
      <Text style={styles.reference}>{job.reference}</Text>

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      {/* The server's refusal, above the local checklist and never overruled. */}
      {lastRefusal ? (
        <View style={styles.refusal}>
          <Text style={styles.refusalTitle}>The office refused this completion</Text>
          {lastRefusal.messages.map((message) => (
            <Text key={message} style={styles.refusalBody}>
              {message}
            </Text>
          ))}
          {lastRefusal.unknown.length > 0 ? (
            <Text style={styles.refusalUnknown}>
              This version of the app does not recognise: {lastRefusal.unknown.join(", ")}. Call the office.
            </Text>
          ) : null}
          <Text style={styles.refusalBody}>
            What you recorded is still on this phone. Fix what is listed and send it again — do not re-enter it.
          </Text>
        </View>
      ) : null}

      <Section title="Reported fault">
        <Text style={styles.body}>{job.reportedFault ?? "Nothing recorded by the office."}</Text>
      </Section>

      <Section title="What you found">
        <TextInput
          style={styles.input}
          multiline
          placeholder="Diagnosis"
          placeholderTextColor={theme.colour.textMuted}
          defaultValue={card?.diagnosisNote ?? ""}
          editable={false}
        />
        {FAULT_KINDS.map((kind) => (
          <View key={kind} style={styles.faultGroup}>
            <Text style={styles.faultKindLabel}>{FAULT_KIND_LABEL[kind]}</Text>
            <View style={styles.chips}>
              {faultByKind[kind].length === 0 ? (
                <Text style={styles.muted}>Not synced to this phone yet.</Text>
              ) : (
                faultByKind[kind].map((term) => (
                  <Pressable
                    key={term.id}
                    onPress={() => void chooseFaultCode({ id: term.id, kind, code: term.code, label: term.label })}
                    style={[styles.chip, faultSelection[kind]?.id === term.id && styles.chipSelected]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: faultSelection[kind]?.id === term.id }}
                  >
                    <Text style={styles.chipText}>{term.label}</Text>
                  </Pressable>
                ))
              )}
            </View>
          </View>
        ))}
      </Section>

      <Section title="What you did">
        <TextInput
          style={styles.input}
          multiline
          placeholder="Work carried out"
          placeholderTextColor={theme.colour.textMuted}
          defaultValue={card?.workCarriedOut ?? ""}
          editable={false}
        />
      </Section>

      <Section title={`Photos (${photos.length})`}>
        <Text style={styles.muted}>
          {photos.length === 0
            ? "None yet. At least one 'after' photo is required, or a recorded reason why there isn't one."
            : photos
                .map((p) => (isPhotoRole(p.role) ? PHOTO_ROLE_LABEL[p.role] : "Role not recognised"))
                .join(", ")}
        </Text>
        <Pressable style={styles.outline} onPress={() => setCameraOpen(true)} accessibilityRole="button">
          <Text style={styles.outlineText}>Take a photo</Text>
        </Pressable>
      </Section>

      <Section title={`Materials (${materials.length})`}>
        {materials.length === 0 ? (
          <Text style={styles.muted}>None recorded. Record what you used, or that you used none.</Text>
        ) : (
          materials.map((material) => (
            <Text key={material.id} style={styles.body}>
              {material.quantity} {material.unit} · {material.description}
              {material.needsOfficeReconciliation ? "  (office to check)" : ""}
            </Text>
          ))
        )}

        {showMaterialForm ? (
          <View style={styles.form}>
            <TextInput
              style={styles.input}
              placeholder="What is the part? (typed - no parts catalogue is on this phone yet)"
              placeholderTextColor={theme.colour.textMuted}
              value={materialDraft.description}
              onChangeText={(text) => setMaterialDraft((d) => ({ ...d, description: text }))}
            />
            <TextInput
              style={styles.input}
              placeholder="Quantity"
              placeholderTextColor={theme.colour.textMuted}
              keyboardType="decimal-pad"
              value={materialDraft.quantity}
              onChangeText={(text) => setMaterialDraft((d) => ({ ...d, quantity: text }))}
            />
            <TextInput
              style={styles.input}
              placeholder="Unit (ea, m, litre...)"
              placeholderTextColor={theme.colour.textMuted}
              value={materialDraft.unit}
              onChangeText={(text) => setMaterialDraft((d) => ({ ...d, unit: text }))}
            />
            <TextInput
              style={styles.input}
              placeholder="SKU (optional)"
              placeholderTextColor={theme.colour.textMuted}
              value={materialDraft.sku}
              onChangeText={(text) => setMaterialDraft((d) => ({ ...d, sku: text }))}
            />
            <TextInput
              style={styles.input}
              placeholder="Serial number (optional)"
              placeholderTextColor={theme.colour.textMuted}
              value={materialDraft.serialNumber}
              onChangeText={(text) => setMaterialDraft((d) => ({ ...d, serialNumber: text }))}
            />
            <Text style={styles.faultKindLabel}>Where did it come from?</Text>
            <View style={styles.chips}>
              {MATERIAL_SOURCES.map((source) => (
                <Pressable
                  key={source}
                  onPress={() => setMaterialDraft((d) => ({ ...d, source }))}
                  style={[styles.chip, materialDraft.source === source && styles.chipSelected]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: materialDraft.source === source }}
                >
                  <Text style={styles.chipText}>{MATERIAL_SOURCE_LABEL[source]}</Text>
                </Pressable>
              ))}
            </View>
            {materialErrors.map((message) => (
              <Text key={message} style={styles.warning}>
                {message}
              </Text>
            ))}
            <Pressable style={styles.primary} onPress={() => void submitMaterial()} accessibilityRole="button">
              <Text style={styles.primaryText}>Add part</Text>
            </Pressable>
            <Pressable
              style={styles.secondary}
              onPress={() => {
                setShowMaterialForm(false);
                setMaterialErrors([]);
              }}
              accessibilityRole="button"
            >
              <Text style={styles.secondaryText}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable style={styles.outline} onPress={() => setShowMaterialForm(true)} accessibilityRole="button">
            <Text style={styles.outlineText}>Scan or add a part</Text>
          </Pressable>
        )}

        {canDeclareNoMaterials(draft) ? (
          <Pressable style={styles.outline} onPress={() => void declareNoParts()} accessibilityRole="button">
            <Text style={styles.outlineText}>Record that you used no parts</Text>
          </Pressable>
        ) : draft.materialsDeclaredNone ? (
          <Text style={styles.muted}>You recorded that no parts were used.</Text>
        ) : null}
      </Section>

      <Section title="Time">
        <Text style={styles.body}>Travel {formatDuration(labour.travelMinutes)}</Text>
        <Text style={styles.body}>On the tools {formatDuration(labour.workMinutes)}</Text>
        {labour.pausedMinutes > 0 ? (
          <Text style={styles.muted}>Paused {formatDuration(labour.pausedMinutes)}</Text>
        ) : null}
        <Text style={styles.muted}>
          {isLabourRecorded(labourRecord)
            ? labourRecord.source === "override"
              ? `You recorded ${labourRecord.workMinutes} minutes: ${labourRecord.overrideReason}`
              : labourRecord.workMinutes === 0
                ? "Recorded as no time on the tools. That is a real answer for a visit you could not start."
                : "Derived from your timing events."
            : "Not recorded yet — leave site to close the visit off, or enter the time yourself."}
        </Text>
        <Text style={styles.muted}>
          Last event: {lastEvent ? TIMING_EVENT_LABEL[lastEvent.kind as never] : "none recorded"}
        </Text>
        {safetyRefusal ? <Text style={styles.warning}>{safetyRefusal}</Text> : null}
      </Section>

      <Section title="Outcome">
        <Text style={styles.body}>
          {card?.outcomeCode
            ? (outcomeTerms.find((t) => t.code === card.outcomeCode)?.label ?? card.outcomeCode)
            : "Not chosen."}
        </Text>
        <View style={styles.chips}>
          {outcomeTerms.length === 0 ? (
            <Text style={styles.muted}>Outcomes have not synced to this phone yet.</Text>
          ) : (
            outcomeTerms.map((term) => (
              <Pressable
                key={term.id}
                onPress={() => {
                  const stamp = stampOffline(systemClock, null);
                  void updateJobCard(database, jobId, stamp, (cardDraft) => {
                    cardDraft.outcomeCode = term.code;
                  });
                }}
                style={[styles.chip, card?.outcomeCode === term.code && styles.chipSelected]}
                accessibilityRole="button"
                accessibilityState={{ selected: card?.outcomeCode === term.code }}
              >
                <Text style={styles.chipText}>{term.label}</Text>
              </Pressable>
            ))
          )}
        </View>
        <TextInput
          style={styles.input}
          multiline
          placeholder="Note for the office (optional)"
          placeholderTextColor={theme.colour.textMuted}
          value={outcomeNote}
          onChangeText={setOutcomeNote}
        />
        {outcomeError ? <Text style={styles.warning}>{outcomeError}</Text> : null}
        <Pressable style={styles.outline} onPress={() => void submitOutcome()} accessibilityRole="button">
          <Text style={styles.outlineText}>Record outcome</Text>
        </Pressable>
        <Text style={styles.footnote}>
          This sends the outcome above, along with whatever symptom, cause and remedy you chose. If the job
          card is not ready yet, the office refuses it and says why — what you recorded stays on this phone
          and you do not need to re-enter it.
        </Text>
      </Section>

      {/* JOB-15's checklist, exactly as the server computed it. */}
      <View style={styles.checklist}>
        <Text style={styles.checklistTitle}>Before this job can be completed</Text>
        {readiness.state === "outstanding" ? (
          readiness.messages.map((message) => (
            <Text key={message} style={styles.checklistItem}>
              • {message}
            </Text>
          ))
        ) : readiness.state === "ready" ? (
          <Text style={styles.checklistDone}>The office has everything it needs.</Text>
        ) : readiness.state === "not_applicable" ? (
          <Text style={styles.muted}>
            This job is not at a stage where it can be completed yet. Arrive on site and start work first.
          </Text>
        ) : (
          <Text style={styles.muted}>
            This job has not reached this phone from the office yet, so it cannot say what is outstanding.
            Sync when you have signal.
          </Text>
        )}
      </View>

      <Pressable
        onPress={onSign}
        disabled={readiness.state !== "ready"}
        style={[styles.primary, readiness.state !== "ready" && styles.primaryDisabled]}
        accessibilityRole="button"
      >
        <Text style={styles.primaryText}>Get the customer's signature</Text>
      </Pressable>
      <Text style={styles.footnote}>
        This list comes from the office and is the same one they check against. If they still refuse the
        card — because something changed while you were offline — what you recorded stays on this phone and
        the reason appears here.
      </Text>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function toTimingEvent(model: TimingEventModel): TimingEvent {
  return {
    clientId: model.id,
    jobId: model.jobId,
    visitId: model.visitId ?? null,
    kind: model.kind as never,
    stamp: {
      recordedOfflineAt: model.recordedOfflineAt.toISOString(),
      monotonicAt: model.monotonicAt,
      deviceOffsetMsAtCapture: model.deviceOffsetMsAtCapture ?? null,
      serverReceivedAt: model.serverReceivedAt ? new Date(model.serverReceivedAt).toISOString() : null,
    },
    geo:
      model.lat !== undefined && model.lng !== undefined
        ? { lat: model.lat, lng: model.lng, accuracyMetres: model.accuracyMetres ?? null }
        : null,
    pauseReason: model.pauseReason ?? null,
    note: model.note ?? null,
  };
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colour.background },
  content: { padding: theme.space.md, paddingBottom: theme.space.xl },
  back: { minHeight: theme.touchTarget, justifyContent: "center" },
  backText: { color: theme.colour.accent, fontSize: theme.font.body },
  title: { color: theme.colour.text, fontSize: theme.font.display, marginBottom: theme.space.xs },
  reference: { color: theme.colour.textMuted, fontSize: theme.font.small, marginBottom: theme.space.lg },
  notice: { color: theme.colour.warning, fontSize: theme.font.small, marginBottom: theme.space.md },
  section: { marginBottom: theme.space.lg },
  sectionTitle: {
    color: theme.colour.textMuted,
    fontSize: theme.font.small,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: theme.space.sm,
  },
  body: { color: theme.colour.text, fontSize: theme.font.body, marginBottom: theme.space.xs },
  muted: { color: theme.colour.textMuted, fontSize: theme.font.small, marginBottom: theme.space.xs },
  warning: { color: theme.colour.warning, fontSize: theme.font.small, marginTop: theme.space.sm },
  input: {
    color: theme.colour.text,
    fontSize: theme.font.body,
    backgroundColor: theme.colour.surface,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
    minHeight: 88,
    textAlignVertical: "top",
    marginBottom: theme.space.sm,
  },
  form: { marginTop: theme.space.sm },
  faultGroup: { marginTop: theme.space.sm },
  faultKindLabel: { color: theme.colour.textMuted, fontSize: theme.font.small, marginBottom: theme.space.xs },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm, marginBottom: theme.space.sm },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colour.border,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
    minHeight: 44,
    justifyContent: "center",
  },
  chipSelected: { borderColor: theme.colour.accent, backgroundColor: theme.colour.surface },
  chipText: { color: theme.colour.text, fontSize: theme.font.small },
  outline: {
    minHeight: theme.touchTarget,
    justifyContent: "center",
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colour.accent,
    paddingHorizontal: theme.space.md,
    marginTop: theme.space.sm,
  },
  outlineText: { color: theme.colour.accent, fontSize: theme.font.small, fontWeight: "700" },
  refusal: {
    backgroundColor: theme.colour.surface,
    borderLeftWidth: 4,
    borderLeftColor: theme.colour.danger,
    padding: theme.space.md,
    borderRadius: theme.radius.sm,
    marginBottom: theme.space.lg,
  },
  refusalTitle: { color: theme.colour.text, fontSize: theme.font.body, fontWeight: "700" },
  refusalBody: { color: theme.colour.text, fontSize: theme.font.small, marginTop: theme.space.xs, lineHeight: 20 },
  refusalUnknown: { color: theme.colour.warning, fontSize: theme.font.small, marginTop: theme.space.sm },
  checklist: {
    backgroundColor: theme.colour.surface,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
    marginBottom: theme.space.lg,
  },
  checklistTitle: { color: theme.colour.text, fontSize: theme.font.body, fontWeight: "700", marginBottom: theme.space.sm },
  checklistItem: { color: theme.colour.warning, fontSize: theme.font.small, lineHeight: 22 },
  checklistDone: { color: theme.colour.success, fontSize: theme.font.small },
  primary: {
    backgroundColor: theme.colour.accent,
    minHeight: theme.touchTarget,
    borderRadius: theme.radius.md,
    alignItems: "center",
    justifyContent: "center",
    marginTop: theme.space.sm,
  },
  primaryDisabled: { backgroundColor: theme.colour.surfaceRaised },
  primaryText: { color: theme.colour.text, fontSize: theme.font.body, fontWeight: "700" },
  secondary: { minHeight: theme.touchTarget, alignItems: "center", justifyContent: "center" },
  secondaryText: { color: theme.colour.accent, fontSize: theme.font.body },
  footnote: { color: theme.colour.textMuted, fontSize: theme.font.small, marginTop: theme.space.md, lineHeight: 20 },
});
