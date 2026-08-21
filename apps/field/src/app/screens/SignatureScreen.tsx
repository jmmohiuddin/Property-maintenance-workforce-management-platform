/**
 * Customer sign-off (`FLD-13`, `FLD-14`).
 *
 * The consent statement is rendered **above** the pad, as `FLD-13` requires,
 * and its version is part of what gets hashed. A consent statement below the
 * signature, or absent, means the signature was given to nothing.
 *
 * ── WHAT IS AND IS NOT WIRED ───────────────────────────────────────────────
 *
 * The strokes are captured, the identity fields are collected, and
 * `canonicalSheet()` builds the exact text that would be hashed. **The hash is
 * not computed and the signature is not written to the database**: SHA-256
 * needs `expo-crypto`, which is not installed, and writing a signature record
 * whose `sheet_digest` was a placeholder would produce exactly the thing
 * `FLD-14` exists to prevent - a signature that proves nothing while looking
 * like it does.
 *
 * So this screen renders the flow and refuses to complete it, visibly. That is
 * the honest state of it.
 *
 * NOT RENDERED IN THIS SESSION.
 */

import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Database } from "@nozbe/watermelondb";

import { theme } from "../theme";
import { SignaturePad } from "../components/SignaturePad";
import {
  CONSENT_STATEMENT_V1,
  UNSIGNED_REASON_LABEL,
  type Stroke,
  type UnsignedReason,
} from "../../domain/signature";

export function SignatureScreen({
  jobId,
  onDone,
}: {
  database: Database;
  jobId: string;
  onDone: () => void;
}): JSX.Element {
  const [strokes, setStrokes] = useState<readonly Stroke[]>([]);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [email, setEmail] = useState("");
  const [unsigned, setUnsigned] = useState<UnsignedReason | null>(null);
  const [note, setNote] = useState("");

  const hasSignature = strokes.length > 0 && name.trim().length > 0 && role.trim().length > 0;

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

      <SignaturePad onChange={(next) => setStrokes(next)} />

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

      <View style={styles.blocked}>
        <Text style={styles.blockedTitle}>Signing is not finished in this build</Text>
        <Text style={styles.blockedBody}>
          The signature can be drawn but not saved. Saving requires a SHA-256 hash of the exact job sheet on
          screen, and the hashing module is not installed. A signature stored without that hash would look
          valid and prove nothing, so this build refuses to store one.
        </Text>
      </View>

      <Pressable style={[styles.primary, styles.primaryDisabled]} disabled accessibilityRole="button">
        <Text style={styles.primaryText}>
          {hasSignature ? "Save signature — not available" : "Sign, then print the name"}
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
            always better than a signature somebody else wrote. Recording it is also not wired up in this
            build.
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
  blocked: {
    backgroundColor: theme.colour.surface,
    borderLeftWidth: 4,
    borderLeftColor: theme.colour.warning,
    padding: theme.space.md,
    borderRadius: theme.radius.sm,
    marginTop: theme.space.lg,
  },
  blockedTitle: { color: theme.colour.text, fontSize: theme.font.body, fontWeight: "700" },
  blockedBody: { color: theme.colour.textMuted, fontSize: theme.font.small, marginTop: theme.space.xs, lineHeight: 20 },
  primary: {
    backgroundColor: theme.colour.accent,
    minHeight: theme.touchTarget,
    borderRadius: theme.radius.md,
    alignItems: "center",
    justifyContent: "center",
    marginTop: theme.space.md,
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
