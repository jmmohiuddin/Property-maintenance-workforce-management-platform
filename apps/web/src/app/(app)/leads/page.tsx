import type { Metadata } from "next";
import Link from "next/link";
import { withTenant } from "@meridian/db";
import {
  searchLeads,
  leadAttributionSummary,
  leadDispositionReport,
  leadNurtureQueue,
  listDispositionReasons,
} from "@meridian/db/domain";
import { getService, LEAD_STAGE_LABEL, OPEN_LEAD_STAGES, type LeadStage } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { ConvertLeadForm } from "./convert-form";
import { StageForm } from "./stage-form";
import { AttributionPanel } from "./attribution-panel";
import { NurturePanel } from "./nurture-panel";
import { DispositionPanel } from "./disposition-panel";
import { MagnifyingGlass, UsersThree } from "@phosphor-icons/react/dist/ssr";

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

/**
 * `LEAD-8`. Search and paging state live in the query string, not in React.
 *
 * Three properties fall out of that and all three matter here: the page is a
 * server component that can run the indexed query directly, a filtered list is
 * a URL somebody can send to a colleague, and the back button works. A
 * client-side search box over a fetched array would give up all three and would
 * still be reading the same unbounded list this screen used to.
 */
export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSessionWith("customers:read");

  const params = await searchParams;
  const q = typeof params["q"] === "string" ? params["q"].trim() : "";
  const cursor = typeof params["after"] === "string" ? params["after"] : undefined;
  const showClosed = params["closed"] === "1";

  // Open stages by default. A search, though, looks across everything: somebody
  // typing a phone number is asking "do we know this person", and answering
  // "no" because the only match was marked lost in March is the wrong answer.
  const stages: readonly LeadStage[] | undefined = q || showClosed ? undefined : OPEN_LEAD_STAGES;

  const { page, reasons, attribution, nurture, disposition } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      page: await searchLeads(tx, { q: q || undefined, stages, cursor, limit: 25 }),
      reasons: await listDispositionReasons(tx, { activeOnly: true }),
      attribution: await leadAttributionSummary(tx),
      nurture: await leadNurtureQueue(tx),
      disposition: await leadDispositionReport(tx),
    }),
  );

  const leads = page.rows;

  /** Preserve the current filters when building a "next page" link. */
  const pageHref = (after: string | null) => {
    const next = new URLSearchParams();
    if (q) next.set("q", q);
    if (showClosed) next.set("closed", "1");
    if (after) next.set("after", after);
    const query = next.toString();
    return query ? `/leads?${query}` : "/leads";
  };

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

        {/* GET, not a server action. The result is a URL, which is the whole
            point: a filtered list can be bookmarked, sent to a colleague and
            reached with the back button. */}
        <form method="get" action="/leads" className="mt-6 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[16rem] flex-1">
            <MagnifyingGlass
              size={16}
              aria-hidden
              className="absolute left-3 top-1/2 -translate-y-1/2"
              style={{ color: "var(--text-muted)" }}
            />
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Name, phone or email"
              aria-label="Search leads"
              className="w-full rounded-sm border py-2 pl-9 pr-3 text-[14px] outline-none focus:border-[var(--accent)]"
            />
          </div>
          <label className="flex items-center gap-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>
            <input type="checkbox" name="closed" value="1" defaultChecked={showClosed} className="h-4 w-4" />
            Include closed
          </label>
          <button type="submit" className="btn btn-secondary !py-2 text-[14px]">
            Search
          </button>
          {q ? (
            <Link href="/leads" className="text-[13px] underline" style={{ color: "var(--text-muted)" }}>
              Clear
            </Link>
          ) : null}
        </form>

        <NurturePanel queue={nurture} />
        <AttributionPanel summary={attribution} />
        <DispositionPanel report={disposition} />

        {leads.length === 0 ? (
          <div
            className="mt-8 rounded border p-12 text-center"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            <h2 className="text-lg font-semibold">{q ? "Nothing matched" : "No open leads"}</h2>
            <p className="prose-body mx-auto mt-2 text-[14px]">
              {q
                ? "No lead has that name, phone number or email address. Phone numbers are matched on the last nine digits, so the country code does not matter."
                : "Submit the quote form on the public site and it will appear here."}
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
                      <h2 className="text-[17px] font-semibold">
                        <Link href={`/leads/${lead.id}`} className="underline underline-offset-2">
                          {lead.name}
                        </Link>
                      </h2>
                      <span
                        className="rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                        style={{ backgroundColor: "var(--accent-wash)", color: "var(--accent-text)" }}
                      >
                        {LEAD_STAGE_LABEL[lead.stage]}
                      </span>
                      {/* LEAD-5. On the row, not behind a click. A duplicate
                          spotted after the call has already been made has cost
                          the thing it exists to save. */}
                      {lead.duplicateOfLeadId || lead.matchedCustomerId ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] font-semibold"
                          style={{ backgroundColor: "var(--surface)", color: "var(--text-secondary)" }}
                        >
                          <UsersThree size={12} weight="fill" aria-hidden />
                          Duplicate
                        </span>
                      ) : null}
                      {lead.dispositionLabel ? (
                        <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                          {lead.dispositionLabel}
                        </span>
                      ) : null}
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

        {page.nextCursor ? (
          <div className="mt-6">
            {/* Keyset, so this is "everything after the last row on this page"
                rather than "skip 25". A lead recorded while somebody pages
                cannot push a row past the boundary and out of sight. */}
            <Link href={pageHref(page.nextCursor)} className="btn btn-secondary">
              Show older leads
            </Link>
          </div>
        ) : null}

        {cursor ? (
          <p className="mt-4 text-[13px]">
            <Link href={pageHref(null)} className="underline" style={{ color: "var(--text-muted)" }}>
              Back to the newest
            </Link>
          </p>
        ) : null}

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
