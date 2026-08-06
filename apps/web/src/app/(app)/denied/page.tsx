import type { Metadata } from "next";
import { permissionsForRole } from "@meridian/auth";
import { requireSession } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { Lock } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Not permitted" };
export const dynamic = "force-dynamic";

export default async function DeniedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const permission = typeof params["permission"] === "string" ? params["permission"] : undefined;
  const held = permissionsForRole(session.principal.role);

  return (
    <AppShell session={session} active="">
      <div className="container-page py-16">
        <div className="max-w-2xl">
          <Lock size={28} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
          <h1 className="mt-5 text-3xl font-semibold tracking-tight">You do not have access to this</h1>
          <p className="prose-body mt-4">
            Your role is <strong>{session.principal.role.replace(/_/g, " ")}</strong>, which does not
            include{" "}
            {permission ? (
              <code
                className="rounded-sm px-1.5 py-0.5 font-mono text-[13px]"
                style={{ backgroundColor: "var(--surface-sunken)" }}
              >
                {permission}
              </code>
            ) : (
              "this permission"
            )}
            . If that is wrong, an owner or administrator can change it.
          </p>

          <h2 className="mt-10 text-[15px] font-semibold">What your role does allow</h2>
          <ul className="mt-4 flex flex-wrap gap-2">
            {held.map((p) => (
              <li
                key={p}
                className="rounded-sm border px-2.5 py-1 font-mono text-[12px]"
                style={{ color: "var(--text-secondary)" }}
              >
                {p}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </AppShell>
  );
}
