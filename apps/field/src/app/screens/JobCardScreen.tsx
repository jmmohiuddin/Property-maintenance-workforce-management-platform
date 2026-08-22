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
 * ── WHAT IS STUBBED HERE, EXPLICITLY ───────────────────────────────────────
 *
 * The three buttons marked `notImplemented` below do nothing but say so. They
 * are camera capture (`FLD-7`/`FLD-8`), part scanning (`FLD-5`/`FLD-9`) and the
 * outcome picker's write path. Each needs either a native module that is not
 * installed or a sync payload shape that is not yet known, and a button that
 * silently does nothing is worse than one that admits it.
 *
 * NOT RENDERED IN THIS SESSION - see the note at the top of App.tsx.
 */

import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Database } from "@nozbe/watermelondb";
import { Q } from "@nozbe/watermelondb";

import { theme } from "../theme";
import type { Job, JobCardModel, JobMaterial, JobPhoto, TimingEventModel } from "../../db/models";
import {
  canDeclareNoMaterials,
  completionReadiness,
  interpretRefusal,
  isMaterialSource,
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
  const [notice, setNotice] = useState<string | null>(null);

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
    ];
    return () => subscriptions.forEach((s) => s.unsubscribe());
  }, [database, jobId]);

  const labour = useMemo(() => deriveLabour(events.map(toTimingEvent)), [events]);

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
      photos: photos.map((photo) => ({
        clientId: photo.id,
        jobId,
        role: photo.role as never,
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
        <Stub label="Fault codes (symptom / cause / remedy)" setNotice={setNotice} />
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
            : photos.map((p) => p.role).join(", ")}
        </Text>
        <Stub label="Take a photo" setNotice={setNotice} />
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
        <Stub label="Scan or add a part" setNotice={setNotice} />
        {canDeclareNoMaterials(draft) ? (
          <Stub label="Record that you used no parts" setNotice={setNotice} />
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
        <Text style={styles.body}>{card?.outcomeCode ?? "Not chosen."}</Text>
        <Stub label="Choose what happened" setNotice={setNotice} />
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

/** A control that is not built, and says so rather than doing nothing. */
function Stub({ label, setNotice }: { label: string; setNotice: (m: string) => void }): React.JSX.Element {
  return (
    <Pressable
      style={styles.stub}
      accessibilityRole="button"
      onPress={() => setNotice(`"${label}" is not built yet in this version.`)}
    >
      <Text style={styles.stubText}>{label} — not built</Text>
    </Pressable>
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
  },
  stub: {
    minHeight: theme.touchTarget,
    justifyContent: "center",
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colour.border,
    borderStyle: "dashed",
    paddingHorizontal: theme.space.md,
    marginTop: theme.space.sm,
  },
  stubText: { color: theme.colour.textMuted, fontSize: theme.font.small },
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
  },
  primaryDisabled: { backgroundColor: theme.colour.surfaceRaised },
  primaryText: { color: theme.colour.text, fontSize: theme.font.body, fontWeight: "700" },
  footnote: { color: theme.colour.textMuted, fontSize: theme.font.small, marginTop: theme.space.md, lineHeight: 20 },
});
