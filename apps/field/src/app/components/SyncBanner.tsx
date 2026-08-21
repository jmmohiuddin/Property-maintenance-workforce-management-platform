/**
 * `FLD-17`, the technician-facing half: *"The technician sees '3 items waiting
 * · last synced 14:02' and can force a resync. A silently stuck queue is worse
 * than a visible error, and field technicians will happily work for a week on
 * a broken sync if nothing tells them."*
 *
 * Permanently visible rather than a toast. A message that disappears is a
 * message that was not seen, and the failure this defends against is measured
 * in days.
 *
 * NOT RENDERED IN THIS SESSION - see the note at the top of App.tsx.
 */

import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import type { SyncStatus } from "../sync-runner";

export function SyncBanner({
  status,
  onPress,
}: {
  status: SyncStatus | null;
  onPress: () => void;
}): JSX.Element {
  const tone = bannerTone(status);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel="Sync status">
      <View style={[styles.bar, { backgroundColor: tone }]}>
        <Text style={styles.text} numberOfLines={1}>
          {status?.summary ?? "Starting up"}
        </Text>
        {status?.needsSignIn ? <Text style={styles.action}>Sign in</Text> : null}
      </View>
    </Pressable>
  );
}

function bannerTone(status: SyncStatus | null): string {
  if (!status) return theme.colour.surfaceRaised;
  if (status.needsSignIn) return theme.colour.danger;
  if (status.lastError) return theme.colour.warning;
  // A refused job card is work waiting for the technician, not an error.
  if (status.refused > 0) return theme.colour.pending;
  // Clock skew is shown here rather than buried in a diagnostics screen: a
  // device two hours out is recording times nobody can rely on, and the
  // technician is the only person who can fix it.
  if (status.skew && (status.skew.severity === "significant" || status.skew.severity === "unusable")) {
    return theme.colour.warning;
  }
  return theme.colour.surfaceRaised;
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
  },
  text: { color: theme.colour.text, fontSize: theme.font.small, flexShrink: 1 },
  action: { color: theme.colour.text, fontSize: theme.font.small, fontWeight: "700" },
});
