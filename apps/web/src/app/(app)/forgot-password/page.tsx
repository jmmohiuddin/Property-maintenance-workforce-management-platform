import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession, landingPathFor } from "@/lib/session";
import { AuthLayout } from "@/components/auth-layout";
import { ForgotForm } from "./forgot-form";

export const metadata: Metadata = {
  title: "Reset your password",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function ForgotPasswordPage() {
  // Somebody already signed in does not need this page, and landing on it is
  // usually a stale bookmark rather than an intention.
  const existing = await getSession();
  if (existing) redirect(landingPathFor(existing));

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="We'll email you a link. It works once and lasts 30 minutes."
    >
      <ForgotForm />
    </AuthLayout>
  );
}
