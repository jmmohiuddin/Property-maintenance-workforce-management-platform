/**
 * `FLD-17`, in full: what is waiting, what failed, what the office has not
 * seen, and a button that forces a resync.
 *
 * *"A silently stuck queue is worse than a visible error, and field technicians
 * will happily work for a week on a broken sync if nothing tells them."*
 *
 * This screen also carries the clock-divergence report and the "what we track"
 * disclosure `FLD-16` requires - both belong on the screen a technician opens
 * when they want to know what the app is doing with their work.
 *
 * NOT RENDERED IN THIS SESSION.
 */

import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { theme } from "../theme";
import type { SyncRunner, SyncStatus } from "../sync-runner";
import { SKEW_SIGNIFICANT_MS } from "../../domain/clock";
import { hasStrongRandomness } from "../../domain/ids";
import { CAPTURE_PIPELINE } from "../../media/exif";
import { WORKING_SET, ONLINE_ONLY_MESSAGE, NOT_YET_AVAILABLE_MESSAGE } from "../../domain/working-set";

export function SyncStatusScreen({
  runner,
  status,
  onBack,
}: {
  runner: SyncRunner;
  status: SyncStatus | null;
  onBack: () => void;
}): React.JSX.Element {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Pressable onPress={onBack} style={styles.back} accessibilityRole="button">
        <Text style={styles.backText}>← Jobs</Text>
      </Pressable>

      <Text style={styles.title}>Sync</Text>
      <Text style={styles.summary}>{status?.summary ?? "Starting up"}</Text>

      {status?.lastError ? <Text style={styles.error}>{status.lastError}</Text> : null}

      <Pressable
        onPress={() => void runner.drain()}
        style={styles.primary}
        disabled={status?.running === true}
        accessibilityRole="button"
      >
        <Text style={styles.primaryText}>{status?.running ? "Syncing…" : "Sync now"}</Text>
      </Pressable>

      {/* Clock divergence, per ADR 0004 and TRD §8.5. */}
      <Section title="This phone's clock">
        {status?.skew ? (
          <>
            <Text style={styles.body}>
              {Math.abs(status.skew.offsetMs) < 1000
                ? "Matches the office."
                : `${describeOffset(status.skew.offsetMs)} (${status.skew.severity}).`}
            </Text>
            {Math.abs(status.skew.offsetMs) >= SKEW_SIGNIFICANT_MS ? (
              <Text style={styles.warning}>
                Times you record on this phone are being saved with the office's clock as well as this one, so
                nothing is lost - but fix the phone's time when you can.
              </Text>
            ) : null}
          </>
        ) : (
          <Text style={styles.muted}>Not measured yet. It is checked on every sync.</Text>
        )}
        {!hasStrongRandomness() ? (
          <Text style={styles.muted}>
            This device has no secure random number source, so record identifiers use a weaker one.
          </Text>
        ) : null}
      </Section>

      {/* FLD-2: what is on the phone and what is not. */}
      <Section title="What is stored on this phone">
        {WORKING_SET.map((entry) => (
          <Text key={entry.resource} style={styles.muted}>
            • {entry.bound}
          </Text>
        ))}
      </Section>

      <Section title="What is not">
        {Object.values(ONLINE_ONLY_MESSAGE).map((message) => (
          <Text key={message} style={styles.muted}>
            • {message}
          </Text>
        ))}
      </Section>

      <Section title="What is not built yet">
        {[...new Set(Object.values(NOT_YET_AVAILABLE_MESSAGE))].map((message) => (
          <Text key={message} style={styles.notBuilt}>
            • {message}
          </Text>
        ))}
      </Section>

      {/* FLD-16's always-accessible "what we track" screen. */}
      <Section title="What happens to a photograph you take">
        {CAPTURE_PIPELINE.map((step) => (
          <Text key={step.id} style={step.implemented ? styles.muted : styles.notBuilt}>
            • {step.description}
            {step.implemented ? "" : "  (not built in this version)"}
          </Text>
        ))}
      </Section>

      <Section title="Location">
        <Text style={styles.muted}>
          Your position is recorded when you arrive, start, finish, photograph and sign - six moments, not a
          continuous trail. It is not recorded outside working hours and it is not used to judge your
          performance.
        </Text>
        <Text style={styles.notBuilt}>
          Location capture is not built in this version. Nothing is being recorded.
        </Text>
      </Section>
    </ScrollView>
  );
}

function describeOffset(offsetMs: number): string {
  const minutes = Math.round(Math.abs(offsetMs) / 60_000);
  const direction = offsetMs > 0 ? "behind" : "ahead of";
  if (minutes < 60) return `About ${minutes} minute${minutes === 1 ? "" : "s"} ${direction} the office`;
  const hours = Math.round(minutes / 60);
  return `About ${hours} hour${hours === 1 ? "" : "s"} ${direction} the office`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colour.background },
  content: { padding: theme.space.md, paddingBottom: theme.space.xl },
  back: { minHeight: theme.touchTarget, justifyContent: "center" },
  backText: { color: theme.colour.accent, fontSize: theme.font.body },
  title: { color: theme.colour.text, fontSize: theme.font.display },
  summary: { color: theme.colour.textMuted, fontSize: theme.font.body, marginBottom: theme.space.md },
  error: { color: theme.colour.danger, fontSize: theme.font.small, marginBottom: theme.space.md, lineHeight: 20 },
  primary: {
    backgroundColor: theme.colour.accent,
    minHeight: theme.touchTarget,
    borderRadius: theme.radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: { color: theme.colour.text, fontSize: theme.font.body, fontWeight: "700" },
  section: { marginTop: theme.space.xl },
  sectionTitle: {
    color: theme.colour.textMuted,
    fontSize: theme.font.small,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: theme.space.sm,
  },
  body: { color: theme.colour.text, fontSize: theme.font.body, marginBottom: theme.space.xs },
  muted: { color: theme.colour.textMuted, fontSize: theme.font.small, lineHeight: 21, marginBottom: theme.space.xs },
  notBuilt: { color: theme.colour.warning, fontSize: theme.font.small, lineHeight: 21, marginBottom: theme.space.xs },
  warning: { color: theme.colour.warning, fontSize: theme.font.small, lineHeight: 21, marginTop: theme.space.xs },
});
