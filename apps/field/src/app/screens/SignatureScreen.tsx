/**
 * Customer sign-off (`FLD-13`, `FLD-14`).
 *
 * ── WHAT THIS SCREEN SENDS, AND WHY IT IS NOT A HASH ────────────────────────
 *
 * `job_signature/record` - `sync/payloads.ts`'s `recordSignature` - carries an
 * `uploadId`, `signedByName`, `signedByRole`, `satisfactionRating` and
 * `comments`. **It does not carry a digest.** That was checked against
 * `packages/docs/src/job-sheet-seal.ts` before writing this, per the note this
 * file used to carry saying not to: `sealJobSheet` there - the full FLD-14
 * pipeline: re-derive, compare digests, render a PDF, lock the card, email a
 * copy - exists and works, but it is wired only into the *web* app's job
 * detail actions (`apps/web/src/app/(app)/jobs/[id]/actions.ts`), never into
 * `FIELD_MUTATION_KINDS`. A handset has no route into it. Sending a digest
 * with `job_signature/record` would be sending a field nothing on the other
 * end reads.
 *
 * **The comment this file used to carry - "no server implementation of
 * `canonicalSheet()` exists" - was wrong**, and worth correcting rather than
 * quietly dropping: `job-sheet.ts`'s `canonicalJobSheet` is line-for-line the
 * same serialisation as `domain/signature.ts`'s `canonicalSheet` (same field
 * order, same `flatten()`, and `JOB_SHEET_FORMAT` is the same literal
 * `"meridian-jobsheet-v1"` this file's `sheet_format` line already sent). The
 * two were already byte-compatible; only the field app's own hashing step and
 * its write path were missing.
 *
 * ── WHAT IS SEALED LOCALLY, AND WHY ─────────────────────────────────────────
 *
 * `job_signoffs.sheet_digest` / `sheet_canonical` are **required, non-optional
 * columns** in `db/schema.ts` - a place to compute a real digest had to exist
 * before a signature row could be written at all, wire format notwithstanding.
 * `sealSheet()` (`domain/signature.ts`) is run here with `sha256OfCanonicalSheet`
 * (`domain/hash.ts` - a pure SHA-256, since `expo-crypto` is not a dependency
 * and this session has no simulator to verify a new native module against; see
 * that file's header for why a pure implementation is something this session
 * genuinely could check, and `test/hash.test.ts` for the four published test
 * vectors it is checked against). The digest is real and evidential *for this
 * device's own record* - it is simply not yet a promise the office's copy of
 * `FLD-14` can be asked to verify, because no field route calls it.
 *
 * **`technicianName` is a real, honest gap.** Nothing synced to this phone
 * carries the signed-in technician's name - `auth/device-store.ts` keeps only
 * `technicianId`, a UUID, and no working-set table (`working-set.ts`) holds
 * technician records at all. Rather than fabricate a name, the field is filled
 * with the id or, if even that is unavailable, a sentence saying so - see
 * `technicianNameFor` below. A wrong name baked into an evidential hash is
 * worse than an honest placeholder.
 *
 * NOT RENDERED IN THIS SESSION - no simulator was available. It compiles
 * under `npm run typecheck:native`.
 */

import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Database } from "@nozbe/watermelondb";

import { theme } from "../theme";
import { SignaturePad } from "../components/SignaturePad";
import {
  CONSENT_STATEMENT_V1,
  UNSIGNED_REASON_LABEL,
  sealSheet,
  type SheetContent,
  type Stroke,
  type UnsignedReason,
} from "../../domain/signature";
import { sha256OfCanonicalSheet } from "../../domain/hash";
import { deriveLabour, type TimingEvent } from "../../domain/attendance";
import { systemClock, stampOffline } from "../../domain/clock";
import { newClientId } from "../../domain/ids";
import { createJobSignoffRecord } from "../../db/watermelon";
import type { Customer, Job, JobCardModel, JobMaterial, Property, TaxonomyTerm, TimingEventModel } from "../../db/models";

/** Not configurable yet - matches the constant in `App.tsx`. */
const APP_VERSION = "0.1.0";

interface SheetSource {
  readonly jobReference: string;
  readonly customerName: string;
  readonly propertyAddress: string;
  readonly reportedFault: string;
  readonly diagnosedFault: string;
  readonly workCarriedOut: string;
  readonly materials: readonly { readonly description: string; readonly quantity: string; readonly unit: string }[];
  readonly labourMinutes: number;
  readonly outcomeLabel: string;
}

/**
 * A snapshot, deliberately not observed. `FLD-14`'s content is what was on
 * screen *at the moment the customer signed* - a live-updating query would
 * make the sheet a moving target, which is exactly the property canonicalising
 * and hashing exists to remove. It is re-read fresh each time this screen
 * mounts, which is what "at the moment of signing" means in practice for a
 * screen with no autosave.
 */
async function loadSheetSource(database: Database, jobId: string): Promise<SheetSource | null> {
  let job: Job;
  try {
    job = await database.get<Job>("jobs").find(jobId);
  } catch {
    return null;
  }

  const card = await database
    .get<JobCardModel>("job_cards")
    .query()
    .fetch()
    .then((rows) => rows.find((r) => r.jobId === jobId) ?? null);

  const materials = await database
    .get<JobMaterial>("job_materials")
    .query()
    .fetch()
    .then((rows) => rows.filter((r) => r.jobId === jobId));

  const events = await database
    .get<TimingEventModel>("timing_events")
    .query()
    .fetch()
    .then((rows) => rows.filter((r) => r.jobId === jobId));

  const customerName = await database
    .get<Customer>("customers")
    .find(job.customerId)
    .then((c) => c.name)
    .catch(() => "");

  const propertyAddress = await database
    .get<Property>("properties")
    .find(job.propertyId)
    .then((p) => p.address)
    .catch(() => "");

  let outcomeLabel = card?.outcomeCode ?? "";
  if (card?.outcomeCode) {
    const terms = await database.get<TaxonomyTerm>("taxonomy_terms").query().fetch();
    const match = terms.find((t) => t.vocabulary === "outcomeCodes" && t.code === card.outcomeCode);
    outcomeLabel = match?.label ?? card.outcomeCode;
  }

  const labour = deriveLabour(events.map(toTimingEvent));

  return {
    jobReference: job.reference,
    customerName,
    propertyAddress,
    reportedFault: job.reportedFault ?? "",
    diagnosedFault: card?.diagnosisNote ?? "",
    workCarriedOut: card?.workCarriedOut ?? "",
    materials: materials.map((m) => ({ description: m.description, quantity: m.quantity, unit: m.unit })),
    labourMinutes: labour.workMinutes,
    outcomeLabel,
  };
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

/** See the header note on `technicianName`: an id is honest, a guess is not. */
function technicianNameFor(technicianId: string | null): string {
  return technicianId ? technicianId : "(not recorded on this device)";
}

export function SignatureScreen({
  database,
  jobId,
  technicianId,
  onDone,
}: {
  database: Database;
  jobId: string;
  /** This device's own technician id, if it has signed in. See `App.tsx`. */
  technicianId: string | null;
  onDone: () => void;
}): React.JSX.Element {
  const [strokes, setStrokes] = useState<readonly Stroke[]>([]);
  const [aspectRatio, setAspectRatio] = useState(2);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [email, setEmail] = useState("");
  const [unsigned, setUnsigned] = useState<UnsignedReason | null>(null);
  const [note, setNote] = useState("");
  const [sheet, setSheet] = useState<SheetSource | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadSheetSource(database, jobId).then((result) => {
      if (!cancelled) setSheet(result);
    });
    return () => {
      cancelled = true;
    };
  }, [database, jobId]);

  const hasSignature = strokes.length > 0 && name.trim().length > 0 && role.trim().length > 0;
  const canSave = hasSignature && sheet !== null && !saving;

  async function save(): Promise<void> {
    if (!canSave || !sheet) return;
    setSaving(true);
    setError(null);
    try {
      const stamp = stampOffline(systemClock, null);
      const content: SheetContent = {
        jobReference: sheet.jobReference,
        customerName: sheet.customerName,
        propertyAddress: sheet.propertyAddress,
        reportedFault: sheet.reportedFault,
        diagnosedFault: sheet.diagnosedFault,
        workCarriedOut: sheet.workCarriedOut,
        materials: sheet.materials,
        labourMinutes: sheet.labourMinutes,
        outcomeLabel: sheet.outcomeLabel,
        technicianName: technicianNameFor(technicianId),
        recordedOfflineAt: stamp.recordedOfflineAt,
        consent: CONSENT_STATEMENT_V1,
      };
      const sealed = await sealSheet(content, sha256OfCanonicalSheet);

      await createJobSignoffRecord(database, {
        clientId: newClientId(),
        jobId,
        visitId: null,
        signedByName: name.trim(),
        signedByRole: role.trim(),
        signedByEmail: email.trim() || null,
        strokesJson: JSON.stringify(strokes),
        aspectRatio,
        consentVersion: CONSENT_STATEMENT_V1.version,
        consentText: CONSENT_STATEMENT_V1.text,
        sheetDigest: sealed.sha256,
        sheetCanonical: sealed.canonical,
        technicianId: technicianId ?? "",
        appVersion: APP_VERSION,
        satisfactionRating: null,
        comments: null,
        stamp,
      });

      // Not sent yet - filed locally, offline-safe. `app/upload-runner.ts`
      // renders the strokes to a PNG, uploads it, and only then queues
      // `job_signature/record` into the outbox once it has an `uploadId` to
      // cite. See that file's header for why a signature cannot skip the
      // upload step the way a material line or a "no parts" declaration can.
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The signature could not be saved on this phone.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Pressable onPress={onDone} style={styles.back} accessibilityRole="button">
        <Text style={styles.backText}>← Job card</Text>
      </Pressable>

      <Text style={styles.title}>Customer sign-off</Text>

      {/* FLD-13: the versioned consent statement, above the pad. */}
      <View style={styles.consent}>
        <Text style={styles.consentText}>{CONSENT_STATEMENT_V1.text}</Text>
        <Text style={styles.consentVersion}>{CONSENT_STATEMENT_V1.version}</Text>
      </View>

      <SignaturePad onChange={(next, ratio) => {
        setStrokes(next);
        setAspectRatio(ratio);
      }} />

      <TextInput
        style={styles.input}
        placeholder="Printed name"
        placeholderTextColor={theme.colour.textMuted}
        value={name}
        onChangeText={setName}
        autoCapitalize="words"
      />
      <TextInput
        style={styles.input}
        placeholder="Their role here (tenant, building manager, owner)"
        placeholderTextColor={theme.colour.textMuted}
        value={role}
        onChangeText={setRole}
      />
      <TextInput
        style={styles.input}
        placeholder="Email for their copy"
        placeholderTextColor={theme.colour.textMuted}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable
        style={[styles.primary, !canSave && styles.primaryDisabled]}
        disabled={!canSave}
        onPress={() => void save()}
        accessibilityRole="button"
      >
        <Text style={styles.primaryText}>
          {saving ? "Saving…" : sheet === null ? "Loading the job card…" : "Save signature"}
        </Text>
      </Pressable>

      {/* FLD-13: never force a fake signature. */}
      <Text style={styles.sectionTitle}>Nobody available to sign?</Text>
      <View style={styles.reasons}>
        {(Object.keys(UNSIGNED_REASON_LABEL) as UnsignedReason[]).map((reason) => (
          <Pressable
            key={reason}
            onPress={() => setUnsigned(reason)}
            style={[styles.reason, unsigned === reason && styles.reasonSelected]}
            accessibilityRole="button"
          >
            <Text style={styles.reasonText}>{UNSIGNED_REASON_LABEL[reason]}</Text>
          </Pressable>
        ))}
      </View>
      {unsigned ? (
        <>
          <TextInput
            style={styles.input}
            placeholder="What happened — a supervisor has to accept this"
            placeholderTextColor={theme.colour.textMuted}
            value={note}
            onChangeText={setNote}
            multiline
          />
          <Text style={styles.footnote}>
            This closes the visit unsigned and asks a supervisor to accept it. It is a normal outcome and is
            always better than a signature somebody else wrote. Recording it is not wired up in this
            build — `job_unsigned_attestations` has no mutation kind in `FIELD_MUTATION_KINDS` yet.
          </Text>
        </>
      ) : null}

      <Text style={styles.footnote}>Job {jobId}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colour.background },
  content: { padding: theme.space.md, paddingBottom: theme.space.xl },
  back: { minHeight: theme.touchTarget, justifyContent: "center" },
  backText: { color: theme.colour.accent, fontSize: theme.font.body },
  title: { color: theme.colour.text, fontSize: theme.font.display, marginBottom: theme.space.md },
  consent: {
    backgroundColor: theme.colour.surface,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
    marginBottom: theme.space.md,
  },
  consentText: { color: theme.colour.text, fontSize: theme.font.small, lineHeight: 21 },
  consentVersion: { color: theme.colour.textMuted, fontSize: 11, marginTop: theme.space.sm },
  input: {
    color: theme.colour.text,
    fontSize: theme.font.body,
    backgroundColor: theme.colour.surface,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space.md,
    minHeight: theme.touchTarget,
    marginTop: theme.space.sm,
  },
  error: { color: theme.colour.danger, fontSize: theme.font.small, marginTop: theme.space.sm },
  primary: {
    backgroundColor: theme.colour.accent,
    minHeight: theme.touchTarget,
    borderRadius: theme.radius.md,
    alignItems: "center",
    justifyContent: "center",
    marginTop: theme.space.lg,
  },
  primaryDisabled: { backgroundColor: theme.colour.surfaceRaised },
  primaryText: { color: theme.colour.text, fontSize: theme.font.body, fontWeight: "700" },
  sectionTitle: {
    color: theme.colour.textMuted,
    fontSize: theme.font.small,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: theme.space.xl,
    marginBottom: theme.space.sm,
  },
  reasons: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm },
  reason: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colour.border,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
    minHeight: 44,
    justifyContent: "center",
  },
  reasonSelected: { borderColor: theme.colour.accent, backgroundColor: theme.colour.surface },
  reasonText: { color: theme.colour.text, fontSize: theme.font.small },
  footnote: { color: theme.colour.textMuted, fontSize: theme.font.small, marginTop: theme.space.md, lineHeight: 20 },
});
