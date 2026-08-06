import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { tenant } from "@meridian/core";
import { getSession, landingPathFor } from "@/lib/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export default async function LoginPage() {
  const existing = await getSession();
  if (existing) redirect(landingPathFor(existing));

  return (
    <div className="grid min-h-[100dvh] lg:grid-cols-2">
      <div className="flex items-center justify-center px-6 py-16">
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

          <h1 className="mt-10 text-3xl font-semibold tracking-tight">Sign in</h1>
          <p className="prose-body mt-3 text-[15px]">Operations, dispatch and accounts.</p>

          <div className="mt-8">
            <LoginForm />
          </div>

          <p className="mt-8 text-[13px]" style={{ color: "var(--text-muted)" }}>
            Customer looking to raise a request?{" "}
            <Link href="/quote" style={{ color: "var(--accent-text)" }} className="underline underline-offset-2">
              Use the request form
            </Link>
            .
          </p>
        </div>
      </div>

      {/* Development credentials panel. Rendered only outside production, and
          only because a seeded dev database is useless if nobody knows the
          logins. It must never appear on a deployed environment. */}
      {process.env.NODE_ENV !== "production" ? (
        <aside
          className="hidden flex-col justify-center border-l px-10 lg:flex"
          style={{ backgroundColor: "var(--surface-sunken)" }}
        >
          <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.16em]" style={{ color: "var(--accent-text)" }}>
            Development only
          </h2>
          <p className="prose-body mt-4 text-[14px]">
            Seeded accounts. All share the password{" "}
            <code className="tnum rounded-sm px-1.5 py-0.5" style={{ backgroundColor: "var(--surface-raised)" }}>
              MeridianDev2026!
            </code>
          </p>
          <dl className="mt-6 space-y-3 text-[13px]">
            {[
              ["omar@meridianfm.example", "Owner"],
              ["rania@meridianfm.example", "Operations manager"],
              ["yusuf@meridianfm.example", "Dispatcher"],
              ["priya@meridianfm.example", "Accountant"],
              ["bilal@meridianfm.example", "Technician"],
              ["fatima@baytower.example", "Customer portal"],
              ["hana@gulfpropertycare.example", "Owner, second tenant"],
            ].map(([email, role]) => (
              <div key={email} className="flex items-baseline justify-between gap-4 border-b pb-2">
                <dt className="font-mono">{email}</dt>
                <dd className="shrink-0" style={{ color: "var(--text-muted)" }}>
                  {role}
                </dd>
              </div>
            ))}
          </dl>
          <p className="prose-body mt-6 text-[13px]">
            Sign in as the second-tenant owner to confirm that none of the first tenant&apos;s jobs are
            reachable. That is row-level security doing its job, not the UI filtering.
          </p>
        </aside>
      ) : null}
    </div>
  );
}
