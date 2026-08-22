import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  withTenant,
  getLead,
  findDuplicateMatches,
  listCommunications,
  listDispositionReasons,
} from "@meridian/db";
import { getService, LEAD_STAGE_LABEL } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { LogCommunicationForm } from "../log-form";
import { CommunicationTimeline } from "../communication-timeline";
import { StageForm } from "../stage-form";
import { FollowUpForm } from "../follow-up-form";
import { LinkDuplicateForm } from "../link-duplicate-form";
import { ArrowLeft, UsersThree } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Lead" };
export const dynamic = "force-dynamic";

/**
 * One lead, with its history (`LEAD-5`, `LEAD-9`).
 *
 * The list screen answers "what is in the pipeline". This one answers "what has
 * happened with this person", which is the question somebody has open while the
 * phone is ringing — so the log form is above the history rather than below it,
 * and the duplicate check is at the top where it changes what gets said in the
 * first sentence of the call.
 */
export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSessionWith("customers:read");
  const { id } = await params;

  const { lead, duplicates, communications, reasons } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => {
      const found = await getLead(tx, id);
      if (!found) return { lead: null, duplicates: null, communications: [], reasons: [] };

      return {
        lead: found,
        // Recomputed on every view rather than read from the columns written at
        // creation. A customer created last week from a different enquiry is a
        // duplicate this lead did not have when it arrived, and a stale match
        // is the one a person acts on.
        duplicates: await findDuplicateMatches(tx, {
          phone: found.phone,
          email: found.email,
          excludeLeadId: found.id,
        }),
        communications: await listCommunications(tx, { leadId: id }),
        reasons: await listDispositionReasons(tx, { activeOnly: true }),
      };
    },
  );

  if (!lead) notFound();

  const canWrite = ["owner", "admin", "operations_manager", "sales", "dispatcher"].includes(
    session.principal.role,
  );

  return (
    <AppShell session={session} active="leads">
      <div className="container-page py-8">
        <Link
          href="/leads"
          className="inline-flex items-center gap-1.5 text-[13px]"
          style={{ color: "var(--text-secondary)" }}
        >
          <ArrowLeft size={14} aria-hidden />
          Leads
        </Link>

        <div className="mt-4 flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{lead.name}</h1>
          <span
            className="rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
            style={{ backgroundColor: "var(--accent-wash)", color: "var(--accent-text)" }}
          >
            {LEAD_STAGE_LABEL[lead.stage]}
          </span>
        </div>

        <p className="mt-2 text-[14px]" style={{ color: "var(--text-secondary)" }}>
          {lead.phone}
          {lead.email ? ` · ${lead.email}` : ""}
          {lead.serviceSlug ? ` · ${getService(lead.serviceSlug)?.shortName ?? lead.serviceSlug}` : ""}
          {lead.area ? ` · ${lead.area}` : ""}
          {lead.city ? `, ${lead.city}` : ""}
        </p>

        {lead.message ? <p className="prose-body mt-4 text-[14px]">{lead.message}</p> : null}

        {/* ── LEAD-5. Duplicates ───────────────────────────────────────────
            At the top, because it changes the first sentence of the call: "is
            this about the Bay Tower job from March" is a different conversation
            from "tell me about your building". */}
        {duplicates && duplicates.matches.length > 0 ? (
          <section className="mt-8">
            <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
              <UsersThree size={18} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
              We may already have this person
            </h2>
            <p className="prose-body mt-2 text-[14px]">
              Matched on{" "}
              {duplicates.matches.some((m) => m.isStrict)
                ? "phone and email — a strong match"
                : "phone or email — worth checking before you call"}
              .
            </p>

            <ul className="mt-4 space-y-3">
              {duplicates.matches.map((m) => (
                <li
                  key={`${m.kind}-${m.id}`}
                  className="rounded border p-4"
                  style={{ backgroundColor: "var(--surface-raised)" }}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <p className="text-[15px] font-medium">
                      {m.kind === "customer" ? (
                        <Link href={`/customers/${m.id}`} className="underline">
                          {m.name}
                        </Link>
                      ) : (
                        <Link href={`/leads/${m.id}`} className="underline">
                          {m.name}
                        </Link>
                      )}
                    </p>
                    <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                      {m.kind === "customer" ? "Existing customer" : `Lead · ${m.stage ? LEAD_STAGE_LABEL[m.stage] : ""}`}
                      {m.isStrict ? " · phone and email" : ""}
                    </span>
                  </div>
                  <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                    {m.phone ?? "no phone"}
                    {m.email ? ` · ${m.email}` : ""}
                  </p>

                  {canWrite ? (
                    <LinkDuplicateForm
                      leadId={lead.id}
                      matchKind={m.kind}
                      matchId={m.id}
                      matchName={m.name}
                      reasons={reasons.filter((r) => r.appliesTo === "lost" || r.appliesTo === "both")}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {lead.duplicateOfLeadId || lead.matchedCustomerId ? (
          <p className="mt-6 rounded border p-4 text-[14px]" style={{ backgroundColor: "var(--accent-wash)" }}>
            Linked as a duplicate.{" "}
            {lead.duplicateOfLeadId ? (
              <Link href={`/leads/${lead.duplicateOfLeadId}`} className="underline">
                See the original lead
              </Link>
            ) : null}
            {lead.matchedCustomerId ? (
              <Link href={`/customers/${lead.matchedCustomerId}`} className="underline">
                See the customer
              </Link>
            ) : null}
          </p>
        ) : null}

        <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div>
            {/* ── LEAD-9. Log and history ────────────────────────────────── */}
            <h2 className="text-lg font-semibold tracking-tight">Log a call or a message</h2>
            <div className="mt-3">
              {canWrite ? (
                <LogCommunicationForm leadId={lead.id} />
              ) : (
                <p className="prose-body text-[14px]">Your role can read this history but not add to it.</p>
              )}
            </div>

            <h2 className="mt-10 text-lg font-semibold tracking-tight">
              History ({communications.length})
            </h2>
            <CommunicationTimeline
              entries={communications}
              empty="Nothing logged yet. Every call, WhatsApp and site visit recorded here survives whoever leaves."
            />
          </div>

          <aside className="space-y-8">
            <div>
              <h2 className="text-[15px] font-semibold">Follow-up</h2>
              {canWrite ? (
                <FollowUpForm leadId={lead.id} nextFollowUpAt={lead.nextFollowUpAt} />
              ) : (
                <p className="prose-body mt-2 text-[13px]">
                  {lead.nextFollowUpAt
                    ? lead.nextFollowUpAt.toLocaleDateString("en-GB", {
                        timeZone: "Asia/Dubai",
                        dateStyle: "medium",
                      })
                    : "None set."}
                </p>
              )}
            </div>

            <div>
              <h2 className="text-[15px] font-semibold">Stage</h2>
              <div className="mt-2">
                <StageForm leadId={lead.id} currentStage={lead.stage} reasons={reasons} />
              </div>
            </div>

            <div>
              <h2 className="text-[15px] font-semibold">Where it came from</h2>
              <dl className="mt-2 space-y-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                <div>Channel: {lead.channel}</div>
                {lead.calledNumber ? <div>Called: {lead.calledNumber}</div> : null}
                {lead.utmCampaign ? <div>Campaign: {lead.utmCampaign}</div> : null}
                {lead.utmSource ? <div>Source: {lead.utmSource}</div> : null}
                {lead.landingPage ? <div>Landing page: {lead.landingPage}</div> : null}
                {lead.referrer ? <div>Referrer: {lead.referrer}</div> : null}
                <div>
                  Recorded:{" "}
                  {lead.createdAt.toLocaleString("en-GB", {
                    timeZone: "Asia/Dubai",
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </div>
              </dl>
            </div>
          </aside>
        </div>
      </div>
    </AppShell>
  );
}
