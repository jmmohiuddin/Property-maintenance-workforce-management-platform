/**
 * `FLD-2`'s second half: *"Everything else is fetched on demand when online and
 * is explicitly unavailable offline. The screen says so, rather than showing an
 * empty state that looks like 'no data'."*
 *
 * An empty list and an unavailable list look identical and mean opposite
 * things. This component is the difference, and the message comes from
 * `offlineAvailability()` so that the wording is decided once.
 *
 * NOT RENDERED IN THIS SESSION.
 */

import { StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { offlineAvailability, type FieldResource } from "../../domain/working-set";

export function OfflineNotice({ resource }: { resource: FieldResource }): React.JSX.Element | null {
  const availability = offlineAvailability(resource);
  if (availability.kind === "available") return null;

  return (
    <View style={styles.box}>
      <Text style={styles.title}>Not stored on this phone</Text>
      <Text style={styles.body}>{availability.message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: theme.colour.surface,
    borderColor: theme.colour.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
    margin: theme.space.md,
  },
  title: { color: theme.colour.text, fontSize: theme.font.body, fontWeight: "700", marginBottom: theme.space.xs },
  body: { color: theme.colour.textMuted, fontSize: theme.font.small, lineHeight: 20 },
});
