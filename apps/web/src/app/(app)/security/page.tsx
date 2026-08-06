import type { Metadata } from "next";
import { getMfaStatus, isStaff } from "@meridian/auth";
import { requireSession } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { PortalShell } from "@/components/portal-shell";
import { MfaPanel } from "./mfa-panel";

export const metadata: Metadata = {
  title: "Security",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const recoveryUsed =
    typeof params["recovery_used"] === "string" ? Number(params["recovery_used"]) : null;

  const status = await getMfaStatus({
    tenantId: session.principal.tenantId,
    userId: session.principal.userId,
  });

  // Customers get this page too, in their own chrome. A portal user approving
  // a five-figure quotation has as much reason to want a second factor as the
  // person who raised it, and the underlying flow does not care which they are.
  const Shell = isStaff(session.principal.role) ? AppShell : PortalShell;

  return (
    <Shell session={session} active="security">
      <div className="container-page py-8">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Security</h1>
        <p className="prose-body mt-2 text-[14px]">
          Settings for your own sign-in. Nothing here affects anybody else&rsquo;s account.
        </p>

        {recoveryUsed !== null && Number.isFinite(recoveryUsed) ? (
          <p
            role="status"
            className="mt-6 max-w-2xl rounded p-4 text-[14px]"
            style={{ backgroundColor: "var(--accent-wash)", color: "var(--text-primary)" }}
          >
            You signed in with a recovery code, so it has been spent. You have{" "}
            <strong className="tnum">{recoveryUsed}</strong>{" "}
            {recoveryUsed === 1 ? "code" : "codes"} left
            {recoveryUsed <= 2
              ? " — turn two-factor off and on again to issue a fresh set before you are locked out."
              : ". Set your authenticator up again when you can."}
          </p>
        ) : null}

        <div className="mt-8 max-w-2xl">
          <MfaPanel
            enabled={status.enabled}
            enabledAt={status.enabledAt}
            recoveryCodesRemaining={status.recoveryCodesRemaining}
            accountEmail={session.user.email}
          />

          <section
            className="mt-6 rounded border p-6"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            <h2 className="text-lg font-semibold tracking-tight">Sessions</h2>
            <p className="prose-body mt-2 text-[14px]">
              Signing in creates a session that lasts twelve hours. The cookie is
              <code className="mx-1 font-mono text-[13px]">httpOnly</code>, so page scripts cannot
              read it, and only a hash of the token is stored — a database dump does not yield a
              usable session.
            </p>
            <p className="prose-body mt-3 text-[14px]">
              Turning two-factor sign-in off signs out every other session, because weakening an
              account is exactly when a session you did not start should stop working.
            </p>
          </section>
        </div>
      </div>
    </Shell>
  );
}
