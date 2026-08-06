import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { tenant } from "@meridian/core";
import { getSession, getMfaCookie, landingPathFor } from "@/lib/session";
import { VerifyForm } from "./verify-form";

export const metadata: Metadata = {
  title: "Two-factor code",
  robots: { index: false, follow: false },
};

export default async function VerifyPage() {
  const existing = await getSession();
  if (existing) redirect(landingPathFor(existing));

  // No challenge cookie means there is nothing to verify. Sending them back to
  // the password step is the only honest option — this page cannot start a
  // login on its own, which is the point.
  const challenge = await getMfaCookie();
  if (!challenge) redirect("/login");

  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <Link href="/" className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="grid h-8 w-8 place-items-center rounded-sm font-mono text-[15px] font-bold"
            style={{ backgroundColor: "var(--accent)", color: "var(--accent-contrast)" }}
          >
            M
          </span>
          <span className="text-[15px] font-semibold tracking-tight">{tenant.brandName}</span>
        </Link>

        <h1 className="mt-10 text-3xl font-semibold tracking-tight">Two-factor code</h1>
        <p className="prose-body mt-3 text-[15px]">
          Your password was accepted. Enter the six-digit code from your authenticator app to
          finish signing in.
        </p>

        <div className="mt-8">
          <VerifyForm />
        </div>

        <p className="prose-body mt-8 text-[13px]">
          Lost your phone? Enter one of your recovery codes in the same box. Each one works once.
        </p>

        <p className="mt-4 text-[13px]" style={{ color: "var(--text-muted)" }}>
          <Link href="/login" style={{ color: "var(--accent-text)" }} className="underline underline-offset-2">
            Start again
          </Link>
        </p>
      </div>
    </div>
  );
}
