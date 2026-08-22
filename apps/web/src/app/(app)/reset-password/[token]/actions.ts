"use server";

import { redirect } from "next/navigation";
import { completePasswordReset, acceptInvitation, passwordProblem } from "@meridian/auth";

/**
 * Set a password from a reset link or an invitation link.
 *
 * Both flows end the same way and share this action, but they are kept apart by
 * an explicit `kind` rather than by inferring which token type was presented.
 * Inferring would mean trying one and falling back to the other, and a
 * fall-through between two token namespaces is where privilege-escalation bugs
 * live — a valid invitation token accepted as a reset would set the password of
 * whichever account the fallback resolved to.
 */

export interface SetPasswordState {
  readonly error?: string;
  readonly fieldError?: string;
}

export async function setPassword(
  _prev: SetPasswordState,
  formData: FormData,
): Promise<SetPasswordState> {
  const token = String(formData.get("token") ?? "");
  const kind = String(formData.get("kind") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (kind !== "reset" && kind !== "invite") {
    return { error: "That link is not valid. Ask for a new one." };
  }

  // Checked before the token is spent, so a mismatch or a short password lets
  // the person try again with the same link rather than having to request
  // another one.
  const problem = passwordProblem(password);
  if (problem) return { fieldError: problem };

  if (password !== confirm) {
    return { fieldError: "The two passwords do not match." };
  }

  const result =
    kind === "reset"
      ? await completePasswordReset({ token, password })
      : await acceptInvitation({ token, password });

  if (!result.ok) {
    if (result.reason === "weak_password") return { fieldError: passwordProblem(password) ?? "" };
    return {
      error:
        kind === "reset"
          ? "That reset link has expired or has already been used. Request a new one."
          : "That invitation has expired or has already been accepted. Ask for a new one.",
    };
  }

  // Deliberately NOT signed in automatically.
  //
  // Two reasons. Holding the link is not proof of identity — it is proof of
  // access to a mailbox, which is enough to set a password but not enough to
  // hand over a session. And signing in immediately would skip the second
  // factor for an account that has one, which is precisely the account where
  // that matters most.
  redirect("/login?reset=1");
}
