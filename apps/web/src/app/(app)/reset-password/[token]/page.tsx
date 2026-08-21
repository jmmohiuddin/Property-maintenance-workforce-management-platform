import type { Metadata } from "next";
import Link from "next/link";
import { peekResetToken, MIN_PASSWORD_LENGTH } from "@meridian/auth";
import { AuthLayout } from "@/components/auth-layout";
import { FormBanner } from "@/components/form";
import { SetPasswordForm } from "./set-password-form";

export const metadata: Metadata = {
  title: "Set a new password",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  /*
   * The token is checked BEFORE the form is rendered.
   *
   * Showing a password form for a dead link, accepting a password, and only
   * then refusing it is a worse experience than saying so up front — and it
   * teaches people that the link "sometimes works", so they retry the old email
   * instead of requesting a new one.
   *
   * Peeking does not consume: the token is spent only when a password is
   * actually set.
   */
  const subject = await peekResetToken(token);

  if (!subject) {
    return (
      <AuthLayout
        title="That link has expired"
        subtitle="Reset links work once and last 30 minutes."
      >
        <FormBanner tone="error">
          <p>
            This one has either been used already or run out of time. Both are normal — request a
            fresh one and it will arrive in a moment.
          </p>
          <Link
            href="/forgot-password"
            className="mt-3 inline-block font-medium"
            style={{ color: "var(--accent-text)" }}
          >
            Request a new link
          </Link>
        </FormBanner>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Set a new password"
      subtitle={`Signing in as ${subject.email}.`}
    >
      <SetPasswordForm
        token={token}
        kind="reset"
        minLength={MIN_PASSWORD_LENGTH}
        submitLabel="Set password and continue"
      />
    </AuthLayout>
  );
}
