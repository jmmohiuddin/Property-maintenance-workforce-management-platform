import type { Metadata } from "next";
import Link from "next/link";
import { peekInvitation, MIN_PASSWORD_LENGTH } from "@meridian/auth";
import { AuthLayout } from "@/components/auth-layout";
import { FormBanner } from "@/components/form";
import { SetPasswordForm } from "../../reset-password/[token]/set-password-form";

export const metadata: Metadata = {
  title: "Accept your invitation",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** Role names as a person would say them, not as the enum spells them. */
const ROLE_LABEL: Readonly<Record<string, string>> = {
  owner: "Owner",
  admin: "Administrator",
  operations_manager: "Operations manager",
  dispatcher: "Dispatcher",
  supervisor: "Supervisor",
  technician: "Technician",
  accountant: "Accountant",
  sales: "Sales",
  hr: "HR",
  customer: "Customer",
  readonly: "Read-only",
};

export default async function AcceptInvitationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invitation = await peekInvitation(token);

  if (!invitation) {
    return (
      <AuthLayout title="That invitation is no longer valid">
        <FormBanner tone="error">
          <p>
            Invitations last seven days, work once, and are cancelled if a new one is issued for the
            same address. Ask whoever invited you to send another — it takes them a moment.
          </p>
          <Link
            href="/login"
            className="mt-3 inline-block font-medium"
            style={{ color: "var(--accent-text)" }}
          >
            Back to sign in
          </Link>
        </FormBanner>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={`Welcome, ${invitation.fullName.split(" ")[0]}`}
      subtitle={`You have been set up at ${invitation.brandName} as ${
        ROLE_LABEL[invitation.role] ?? invitation.role
      }. Choose a password to finish.`}
    >
      <SetPasswordForm
        token={token}
        kind="invite"
        minLength={MIN_PASSWORD_LENGTH}
        submitLabel="Create my account"
      />

      {/*
        Said before they set the password rather than sprung on them after.
        Somebody who knows a second step is coming completes it; somebody
        surprised by it at the sign-in screen often postpones it, and "later"
        for two-factor tends to mean never.
      */}
      <div className="mt-8 rounded-sm border p-4 text-[13px]" style={{ backgroundColor: "var(--surface-sunken)" }}>
        <p className="font-medium">You will set up two-factor sign-in next</p>
        <p className="mt-1.5" style={{ color: "var(--text-secondary)" }}>
          It takes about a minute and needs an authenticator app on your phone. This account can see
          customer and employee records, which is why it is not optional.
        </p>
      </div>
    </AuthLayout>
  );
}
