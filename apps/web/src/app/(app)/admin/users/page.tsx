import type { Metadata } from "next";
import { withTenant } from "@meridian/db";
import { listStaff, listPendingInvitations } from "@meridian/db/domain";
import { lockStateAt, describeWait } from "@meridian/auth";
import { formatDubai } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { ROLE_LABEL, isManagedHere } from "./roles";
import {
  InvitePanel,
  UnlockButton,
  ActiveToggle,
  RoleSelect,
  ResetMfaButton,
  CancelInvitationButton,
} from "./user-actions";

export const metadata: Metadata = {
  title: "Users",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * `/admin/users` — `ADM-1`.
 *
 * The screen whose absence meant the system was not a product. Before this,
 * creating a user, resetting a password, unlocking an account or clearing a
 * second factor all required a database client, and all four are things that
 * happen at 07:00 on a Tuesday while somebody stands waiting.
 *
 * Consequence-ordered, like every other list here: locked accounts first —
 * somebody cannot work — then deactivated, then people with no second factor,
 * then everyone else. `listStaff` does that ordering in SQL so it cannot be
 * lost by a client-side sort.
 */
export default async function AdminUsersPage() {
  const session = await requireSessionWith("users:manage");

  const { staff, invitations } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      staff: await listStaff(tx),
      invitations: await listPendingInvitations(tx),
    }),
  );

  const now = new Date();
  const locked = staff.filter((s) => lockStateAt(s.lockedUntil, now).locked);
  const withoutMfa = staff.filter((s) => s.isActive && !s.mfaEnabled);

  return (
    <AppShell session={session} active="admin">
      <main id="main" className="container-page py-10">
        <header className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
            <p className="prose-body mt-2 text-[15px]">
              {staff.length} {staff.length === 1 ? "account" : "accounts"}
              {invitations.length > 0 ? ` · ${invitations.length} invitation${invitations.length === 1 ? "" : "s"} outstanding` : ""}
            </p>
          </div>
        </header>

        {/* The alert bar pattern: shown only when something is actually wrong. */}
        {locked.length > 0 || withoutMfa.length > 0 ? (
          <div className="mt-6 space-y-2">
            {locked.length > 0 ? (
              <p
                className="rounded-sm p-3 text-[14px]"
                style={{ backgroundColor: "var(--status-critical-wash)" }}
              >
                ⛔ {locked.length} {locked.length === 1 ? "account is" : "accounts are"} locked and
                cannot sign in. Lockouts clear themselves, so unlock only if somebody is waiting.
              </p>
            ) : null}
            {withoutMfa.length > 0 ? (
              <p
                className="rounded-sm p-3 text-[14px]"
                style={{ backgroundColor: "var(--status-warning-wash)" }}
              >
                ⚠ {withoutMfa.length}{" "}
                {withoutMfa.length === 1 ? "person has" : "people have"} not set up two-factor
                sign-in. Nudge them — these accounts can see customer and employee records.
              </p>
            ) : null}
          </div>
        ) : null}

        <section className="mt-8 rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
          <h2 className="text-[15px] font-semibold">Invite somebody</h2>
          <div className="mt-4">
            <InvitePanel />
          </div>
        </section>

        {invitations.length > 0 ? (
          <section className="mt-8">
            <h2 className="text-[15px] font-semibold">Waiting to be accepted</h2>
            <ul className="mt-3 divide-y border-y">
              {invitations.map((i) => (
                <li key={i.id} className="flex flex-wrap items-baseline justify-between gap-3 py-3">
                  <div>
                    <p className="text-[14px] font-medium">{i.fullName}</p>
                    <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                      {i.email} · {ROLE_LABEL[i.role] ?? i.role} · expires {formatDubai(i.expiresAt)}
                    </p>
                  </div>
                  <CancelInvitationButton invitationId={i.id} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="mt-10">
          <h2 className="text-[15px] font-semibold">Accounts</h2>

          {staff.length === 0 ? (
            <p className="prose-body mt-4 text-[15px]">
              Nobody has an account yet. Invite the first person above — they will set their own
              password and enrol a second factor.
            </p>
          ) : (
            <ul className="mt-3 divide-y border-y">
              {staff.map((s) => {
                const lock = lockStateAt(s.lockedUntil, now);
                const isSelf = s.userId === session.principal.userId;

                return (
                  <li key={s.membershipId} className="py-4">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-baseline gap-2 text-[15px] font-medium">
                          {s.fullName}
                          {isSelf ? (
                            <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                              (you)
                            </span>
                          ) : null}
                          {!s.isActive ? (
                            <span
                              className="rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                              style={{
                                backgroundColor: "var(--status-neutral-wash)",
                                color: "var(--status-neutral-text)",
                              }}
                            >
                              Deactivated
                            </span>
                          ) : null}
                          {lock.locked ? (
                            <span
                              className="rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                              style={{
                                backgroundColor: "var(--status-critical-wash)",
                                color: "var(--status-critical-text)",
                              }}
                            >
                              Locked
                            </span>
                          ) : null}
                        </p>
                        <p className="mt-0.5 text-[13px]" style={{ color: "var(--text-muted)" }}>
                          {s.email} ·{" "}
                          {/*
                            The copy now matches the mechanism (SEC-4). It used
                            to say "temporarily locked" while the lockout was in
                            fact permanent, which sent people away to wait for
                            something that was never going to happen.
                          */}
                          {lock.locked
                            ? `unlocks in ${describeWait(lock.retryAfterSeconds)}`
                            : s.lastLoginAt
                              ? `last signed in ${formatDubai(s.lastLoginAt)}`
                              : "never signed in"}
                          {s.mfaEnabled ? " · two-factor on" : " · no two-factor"}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        {/*
                          Own row, and portal users, are read-only here.
                          A role the picker cannot represent must never be
                          rendered *in* the picker: a select falls back to its
                          first option, so a customer contact would display as
                          "Owner" and one stray submit would make them one.
                        */}
                        {isSelf || !isManagedHere(s.role) ? (
                          <span className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                            {ROLE_LABEL[s.role] ?? s.role}
                            {!isSelf && !isManagedHere(s.role) ? (
                              <span className="ml-1" style={{ color: "var(--text-muted)" }}>
                                · managed from the customer record
                              </span>
                            ) : null}
                          </span>
                        ) : (
                          <RoleSelect userId={s.userId} role={s.role} />
                        )}
                        {lock.locked ? <UnlockButton userId={s.userId} /> : null}
                        {!isSelf && s.mfaEnabled ? (
                          <ResetMfaButton userId={s.userId} fullName={s.fullName} />
                        ) : null}
                        {!isSelf ? (
                          <ActiveToggle userId={s.userId} isActive={s.isActive} fullName={s.fullName} />
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <p className="mt-10 text-[13px]" style={{ color: "var(--text-muted)" }}>
          Every action on this page is written to the audit log with your name against it.
        </p>
      </main>
    </AppShell>
  );
}
