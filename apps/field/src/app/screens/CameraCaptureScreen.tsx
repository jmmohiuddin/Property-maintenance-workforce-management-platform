/**
 * "Take a photo" (`FLD-7`, `FLD-8`).
 *
 * ── THE ROLE IS CHOSEN, NEVER DEFAULTED ─────────────────────────────────────
 *
 * `attachmentKindForPhotoRole` sends only the `after` role to `photo_after`,
 * the one kind `JOB-15`'s gate counts (`domain/job-card.ts`). Defaulting the
 * role picker to anything - even to `before`, the most common shot - would
 * make it possible to fill a job card with photographs and still have none of
 * them count as the evidence the gate wants, silently. So the review screen
 * below starts with **no role selected** and the confirm button stays
 * disabled until the technician has deliberately tapped one; there is no path
 * from shutter to saved photo that does not pass through that choice.
 *
 * ── WHAT THIS DOES AND DOES NOT DO ITSELF ───────────────────────────────────
 *
 * It captures, compresses (`media/queue.ts`'s `compressionPlan` - longest edge
 * 2048px, JPEG quality 0.75, never upscaled) and hands the result back to the
 * caller. It does **not** write to the local database and does **not** queue
 * anything - `JobCardScreen.onCaptured` does that, via `createJobPhotoRecord`,
 * which is the offline-safe write. This screen only produces the bytes.
 *
 * NOT RENDERED IN THIS SESSION - no simulator was available. It compiles
 * under `npm run typecheck:native`; nothing about its layout has been seen.
 */

import { useRef, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { File } from "expo-file-system";
import * as Location from "expo-location";

import { theme } from "../theme";
import { PHOTO_ROLES, PHOTO_ROLE_LABEL, type PhotoRole } from "../../domain/job-card";
import { compressionPlan } from "../../media/queue";

export interface CapturedPhotoResult {
  readonly role: PhotoRole;
  readonly localUri: string;
  readonly originalUri: string;
  readonly byteSize: number;
  readonly geo: { readonly lat: number; readonly lng: number; readonly accuracyMetres: number | null } | null;
}

export function CameraCaptureScreen({
  onCaptured,
  onCancel,
}: {
  onCaptured: (result: CapturedPhotoResult) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [captured, setCaptured] = useState<{ uri: string; width: number; height: number } | null>(null);
  const [role, setRole] = useState<PhotoRole | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Still reading the permission state.
  if (!permission) return <View style={styles.screen} />;

  if (!permission.granted) {
    return (
      <View style={[styles.screen, styles.centred]}>
        <Text style={styles.title}>Camera access needed</Text>
        <Text style={styles.body}>This app needs the camera to photograph the job.</Text>
        <Pressable style={styles.primary} onPress={() => void requestPermission()} accessibilityRole="button">
          <Text style={styles.primaryText}>Allow camera</Text>
        </Pressable>
        <Pressable style={styles.secondary} onPress={onCancel} accessibilityRole="button">
          <Text style={styles.secondaryText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  async function takePhoto(): Promise<void> {
    if (!cameraRef.current) return;
    setError(null);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 1 });
      setCaptured({ uri: photo.uri, width: photo.width, height: photo.height });
      setRole(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The camera could not take a photo.");
    }
  }

  async function confirm(): Promise<void> {
    if (!captured || !role) return;
    setBusy(true);
    setError(null);
    try {
      // "original retained locally until the compressed copy is confirmed
      // synced" (`media/queue.ts`) - `captured.uri` is that original, and it
      // is handed back untouched; only the caller decides when it may go.
      const plan = compressionPlan(captured.width, captured.height);
      const manipulated = await manipulateAsync(
        captured.uri,
        plan.resize ? [{ resize: { width: plan.targetWidth, height: plan.targetHeight } }] : [],
        { compress: plan.quality, format: SaveFormat.JPEG },
      );
      const file = new File(manipulated.uri);

      // Best-effort and never blocking: a photograph's role and content are
      // what the job card needs, and a technician must never be stuck on this
      // screen because a GPS fix is slow to arrive or permission was never
      // granted.
      const geo = await bestEffortLocation();

      onCaptured({ role, localUri: manipulated.uri, originalUri: captured.uri, byteSize: file.size, geo });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The photo could not be saved.");
      setBusy(false);
    }
  }

  if (captured) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Image source={{ uri: captured.uri }} style={styles.preview} resizeMode="contain" />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Text style={styles.sectionTitle}>What is this a photo of?</Text>
        <Text style={styles.body}>
          Choose deliberately. Only "After" counts as the evidence a completed job needs — the others
          record what you found or fitted, but none of them satisfy that requirement on their own.
        </Text>
        <View style={styles.roles}>
          {PHOTO_ROLES.map((r) => (
            <Pressable
              key={r}
              onPress={() => setRole(r)}
              style={[styles.role, role === r && styles.roleSelected]}
              accessibilityRole="button"
              accessibilityState={{ selected: role === r }}
            >
              <Text style={styles.roleText}>{PHOTO_ROLE_LABEL[r]}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable
          style={[styles.primary, (!role || busy) && styles.primaryDisabled]}
          disabled={!role || busy}
          onPress={() => void confirm()}
          accessibilityRole="button"
        >
          <Text style={styles.primaryText}>{busy ? "Saving…" : "Use this photo"}</Text>
        </Pressable>
        <Pressable
          style={styles.secondary}
          onPress={() => {
            setCaptured(null);
            setRole(null);
          }}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryText}>Retake</Text>
        </Pressable>
        <Pressable style={styles.secondary} onPress={onCancel} accessibilityRole="button">
          <Text style={styles.secondaryText}>Cancel</Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <View style={styles.screen}>
      <CameraView ref={cameraRef} style={styles.camera} facing="back" />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.controls}>
        <Pressable
          style={styles.shutter}
          onPress={() => void takePhoto()}
          accessibilityRole="button"
          accessibilityLabel="Take photo"
        />
        <Pressable style={styles.secondary} onPress={onCancel} accessibilityRole="button">
          <Text style={styles.secondaryText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

async function bestEffortLocation(): Promise<CapturedPhotoResult["geo"]> {
  try {
    const status = await Location.getForegroundPermissionsAsync();
    if (!status.granted) return null;
    const position = await Location.getCurrentPositionAsync({});
    return {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracyMetres: position.coords.accuracy ?? null,
    };
  } catch {
    return null;
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colour.background },
  centred: { alignItems: "center", justifyContent: "center", padding: theme.space.xl },
  content: { padding: theme.space.md, paddingBottom: theme.space.xl },
  camera: { flex: 1 },
  controls: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: theme.space.lg,
    alignItems: "center",
    gap: theme.space.md,
  },
  shutter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: theme.colour.text,
    borderWidth: 4,
    borderColor: theme.colour.surfaceRaised,
  },
  preview: { width: "100%", height: 320, backgroundColor: theme.colour.surface, borderRadius: theme.radius.md },
  title: { color: theme.colour.text, fontSize: theme.font.title, marginBottom: theme.space.md, textAlign: "center" },
  body: { color: theme.colour.textMuted, fontSize: theme.font.small, marginTop: theme.space.sm, marginBottom: theme.space.md, lineHeight: 20 },
  sectionTitle: {
    color: theme.colour.textMuted,
    fontSize: theme.font.small,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: theme.space.lg,
  },
  roles: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm, marginBottom: theme.space.lg },
  role: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colour.border,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
    minHeight: 44,
    justifyContent: "center",
  },
  roleSelected: { borderColor: theme.colour.accent, backgroundColor: theme.colour.surface },
  roleText: { color: theme.colour.text, fontSize: theme.font.small },
  primary: {
    backgroundColor: theme.colour.accent,
    minHeight: theme.touchTarget,
    borderRadius: theme.radius.md,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: theme.space.sm,
  },
  primaryDisabled: { backgroundColor: theme.colour.surfaceRaised },
  primaryText: { color: theme.colour.text, fontSize: theme.font.body, fontWeight: "700" },
  secondary: { minHeight: theme.touchTarget, alignItems: "center", justifyContent: "center" },
  secondaryText: { color: theme.colour.accent, fontSize: theme.font.body },
  error: { color: theme.colour.danger, fontSize: theme.font.small, marginTop: theme.space.sm },
});
