/**
 * The screen a technician sees when this phone has no working sign-in.
 *
 * ── WHAT IT DOES NOT HAVE ON IT ────────────────────────────────────────────
 *
 * There is no email box and no password box. Signing in happens on the
 * office's own `/login` page, shown in a web view, so that the password rules,
 * the lockout curve and the second factor are the ones the office already runs
 * and not a second copy living on a handset. This app never handles a password
 * and has nowhere to type one. See `src/auth/registration.ts`.
 *
 * There is also no error code anywhere on it. A technician standing in a plant
 * room with a torch cannot act on `device_revoked`, and the two things they can
 * act on - "sign in again" and "ring the office" - are what the screen says.
 * The sentences come from the server where the server wrote one, because it
 * wrote them for this screen.
 *
 * ── AND WHY IT SAYS SO WHEN IT CANNOT SIGN ANYBODY IN ──────────────────────
 *
 * The web view needs `react-native-webview`, which is not a dependency of this
 * workspace yet. Rather than a button that fails when pressed, the screen says
 * plainly that the phone is not finished being set up and who can finish it.
 * `FLD-17`'s rule applies here too: a visible refusal beats a silent one.
 *
 * NOT RENDERED IN THIS SESSION - see the note at the top of App.tsx.
 */

import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { theme } from "../theme";

/**
 * Why the app is asking. All three end in the same action; they differ only in
 * whether the technician is owed an explanation for losing a sign-in they had.
 */
export type SignInReason =
  /** This phone has never been registered. */
  | "notRegistered"
  /** It had a sign-in and the office has ended it. */
  | "signedOut";

export function SignInScreen({
  reason,
  canSignIn,
  busy,
  error,
  onSignIn,
}: {
  reason: SignInReason;
  /** False until the login web view exists in this build. */
  canSignIn: boolean;
  busy: boolean;
  /** A sentence to show, or null. Never a code. */
  error: string | null;
  onSignIn: () => void;
}): React.JSX.Element {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Sign in to this phone</Text>

      <Text style={styles.body}>
        {reason === "signedOut"
          ? "This phone has been signed out. Nothing you have recorded is lost - it is saved here and will be " +
            "sent as soon as you sign in again."
          : "This phone is not set up yet. Sign in with the same details you use for the office system, and " +
            "your jobs will download."}
      </Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {canSignIn ? (
        <>
          <Pressable
            onPress={onSignIn}
            style={[styles.primary, busy ? styles.primaryBusy : null]}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Sign in"
          >
            {busy ? (
              <ActivityIndicator color={theme.colour.text} />
            ) : (
              <Text style={styles.primaryText}>Sign in</Text>
            )}
          </Pressable>
          <Text style={styles.muted}>
            The office's sign-in page opens next. Your password is typed there, not here, and this app never
            sees it.
          </Text>
        </>
      ) : (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>
            This version of the app cannot open the sign-in page yet, so this phone cannot be set up from
            here. Ask the office to finish setting it up before you go out.
          </Text>
        </View>
      )}

      {/* FLD-16: the technician is told what the phone keeps, on the screen
          where they are being asked to hand it a credential. */}
      <Text style={styles.footnote}>
        Once you are signed in, this phone keeps a sign-in of its own in the phone's protected storage so you
        do not have to sign in again every day. It is not your password, it works only from this phone, and
        the office can end it at any time. No fingerprint or face data is stored by this app.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colour.background },
  content: { padding: theme.space.md, paddingTop: theme.space.xl, paddingBottom: theme.space.xl },
  title: { color: theme.colour.text, fontSize: theme.font.display, marginBottom: theme.space.md },
  body: {
    color: theme.colour.text,
    fontSize: theme.font.body,
    lineHeight: 25,
    marginBottom: theme.space.lg,
  },
  error: {
    color: theme.colour.danger,
    fontSize: theme.font.body,
    lineHeight: 24,
    marginBottom: theme.space.lg,
  },
  primary: {
    backgroundColor: theme.colour.accent,
    minHeight: theme.touchTarget,
    borderRadius: theme.radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBusy: { opacity: 0.6 },
  primaryText: { color: theme.colour.text, fontSize: theme.font.body, fontWeight: "700" },
  notice: {
    backgroundColor: theme.colour.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colour.warning,
    padding: theme.space.md,
  },
  noticeText: { color: theme.colour.warning, fontSize: theme.font.body, lineHeight: 24 },
  muted: {
    color: theme.colour.textMuted,
    fontSize: theme.font.small,
    lineHeight: 21,
    marginTop: theme.space.md,
  },
  footnote: {
    color: theme.colour.textMuted,
    fontSize: theme.font.small,
    lineHeight: 21,
    marginTop: theme.space.xl,
  },
});
