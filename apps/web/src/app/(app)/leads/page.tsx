import type { Metadata } from "next";
import Link from "next/link";
import { withTenant, listLeads } from "@meridian/db";
import { leadAttributionSummary, listDispositionReasons } from "@meridian/db/domain";
import { getService, LEAD_STAGE_LABEL } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { ConvertLeadForm } from "./convert-form";
import { StageForm } from "./stage-form";
import { AttributionPanel } from "./attribution-panel";

export const metadata: Metadata = { title: "Leads" };
export const dynamic = "force-dynamic";

const CHANNEL_LABEL: Record<string, string> = {
  website: "Website",
  phone: "Phone",
  whatsapp: "WhatsApp",
  walk_in: "Walk-in",
  referral: "Referral",
  contract_enquiry: "Contract enquiry",
  aggregator: "Aggregator",
  portal: "Customer portal",
  other: "Other",
};

export default async function LeadsPage() {
  const session = await requireSessionWith("customers:read");

  const { leads, reasons, attribution } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      leads: await listLeads(tx),
      reasons: await listDispositionReasons(tx, { activeOnly: true }),
      attribution: await leadAttributionSummary(tx),
    }),
  );

  const canConvert = ["owner", "admin", "operations_manager", "sales", "dispatcher"].includes(
    session.principal.role,
  );

  return (
    <AppShell session={session} active="leads">
      <div className="container-page py-8">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Leads</h1>
        <p className="prose-body mt-2 text-[14px]">
          Enquiries from every channel, newest first. Converting a lead creates the customer, the
          property and the job together.
        </p>

        <AttributionPanel summary={attribution} />

        {leads.length === 0 ? (
          <div
            className="mt-8 rounded border p-12 text-center"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            <h2 className="text-lg font-semibold">No open leads</h2>
            <p className="prose-body mx-auto mt-2 text-[14px]">
              Submit the quote form on the public site and it will appear here.
            </p>
          </div>
        ) : (
          <ul className="mt-8 space-y-4">
            {leads.map((lead) => (
              <li
                key={lead.id}
                className="rounded border p-6"
                style={{ backgroundColor: "var(--surface-raised)" }}
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap items-baseline gap-3">
                      <h2 className="text-[17px] font-semibold">{lead.name}</h2>
                      <span
                        className="rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                        style={{ backgroundColor: "var(--accent-wash)", color: "var(--accent-text)" }}
                      >
                        {LEAD_STAGE_LABEL[lead.stage]}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[14px]" style={{ color: "var(--text-secondary)" }}>
                      {lead.phone}
                      {lead.email ? ` · ${lead.email}` : ""}
                      {lead.serviceSlug
                        ? ` · ${getService(lead.serviceSlug)?.shortName ?? lead.serviceSlug}`
                        : ""}
                      {lead.area ? ` · ${lead.area}` : ""}
                      {lead.city ? `, ${lead.city}` : ""}
                    </p>
                    {lead.message ? (
                      <p className="prose-body mt-3 text-[14px]">{lead.message}</p>
                    ) : null}

                    {/*
                      Attribution on the row rather than behind a click (`LEAD-4`).
                      A number nobody sees while doing the work is a number nobody
                      checks, and this is the line that says whether the answer-engine
                      pages are earning anything.
                    */}
                    <p className="mt-3 text-[12px]" style={{ color: "var(--text-muted)" }}>
                      {CHANNEL_LABEL[lead.channel] ?? lead.channel}
                      {lead.calledNumber ? ` · called ${lead.calledNumber}` : ""}
                      {lead.utmCampaign ? ` · campaign ${lead.utmCampaign}` : ""}
                      {lead.utmSource ? ` · ${lead.utmSource}` : ""}
                      {lead.landingPage ? ` · from ${lead.landingPage}` : ""}
                      {lead.referrer ? ` · referred by ${shortHost(lead.referrer)}` : ""}
                      {!lead.utmSource && !lead.landingPage && !lead.referrer && !lead.calledNumber
                        ? " · no source recorded"
                        : ""}
                    </p>
                  </div>
                  <p className="tnum shrink-0 text-[13px]" style={{ color: "var(--text-muted)" }}>
                    {lead.createdAt.toLocaleString("en-GB", {
                      timeZone: "Asia/Dubai",
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </p>
                </div>

                {canConvert ? (
                  <div className="mt-5 flex flex-wrap gap-3 border-t pt-5">
                    <ConvertLeadForm
                      leadId={lead.id}
                      defaultTitle={
                        lead.message?.slice(0, 120) ??
                        `${getService(lead.serviceSlug ?? "")?.shortName ?? "Maintenance"} request`
                      }
                      defaultProperty={`${lead.name} - ${lead.area ?? lead.city ?? "site"}`}
                    />
                    <StageForm
                      leadId={lead.id}
                      currentStage={lead.stage}
                      reasons={reasons.map((reason) => ({
                        id: reason.id,
                        label: reason.label,
                        appliesTo: reason.appliesTo,
                      }))}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canConvert && reasons.length === 0 ? (
          <p className="mt-6 text-[13px]" style={{ color: "var(--text-muted)" }}>
            No lost or dormant reasons are configured, so leads that are dead cannot be closed and
            will sit here looking live.{" "}
            <Link
              href="/admin/reference/dispositions"
              className="underline underline-offset-2"
              style={{ color: "var(--accent-text)" }}
            >
              Add them in reference data
            </Link>
            .
          </p>
        ) : null}
      </div>
    </AppShell>
  );
}

/** "https://www.google.com/search?q=…" → "google.com". The bit worth reading. */
function shortHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 60);
  }
}
