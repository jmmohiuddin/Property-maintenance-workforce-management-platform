import type { Metadata } from "next";
import Link from "next/link";
import { withCustomerScope, listCustomerProperties, listAssetChoices } from "@meridian/db";
import { tenant, telLink } from "@meridian/core";
import { requirePortalSession } from "@/lib/session";
import { PortalShell } from "@/components/portal-shell";
import { RequestForm } from "./request-form";
import { PhoneCall } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Raise a request" };
export const dynamic = "force-dynamic";

export default async function PortalRequestPage() {
  const session = await requirePortalSession();

  // CON-13. The plant on the account comes down with the properties rather than
  // on a change of the dropdown: an account has a handful of buildings and a
  // few dozen machines between them, and a round trip per keystroke buys
  // nothing but a spinner on a phone in a basement.
  const { properties, assets } = await withCustomerScope(
    {
      tenantId: session.principal.tenantId,
      customerId: session.customerId,
      userId: session.principal.userId,
    },
    async (tx) => {
      const properties = await listCustomerProperties(tx);
      return {
        properties,
        assets: await listAssetChoices(
          tx,
          properties.map((p) => p.id),
        ),
      };
    },
  );

  return (
    <PortalShell session={session} active="request">
      <div className="container-page py-8">
        <nav aria-label="Breadcrumb" className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          <Link href="/portal" className="hover:underline">
            Your account
          </Link>
          <span className="mx-2" aria-hidden>
            /
          </span>
          <span style={{ color: "var(--text-secondary)" }}>Raise a request</span>
        </nav>

        <div className="mt-6 grid gap-10 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Raise a request</h1>
            <p className="prose-body mt-3">
              Describe the symptom. You do not need to know the cause, or which trade it needs — that
              is our job.
            </p>

            <div className="mt-8">
              {properties.length === 0 ? (
                <div className="rounded border p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
                  <h2 className="text-[15px] font-semibold">No properties on your account yet</h2>
                  <p className="prose-body mt-2 text-[14px]">
                    Call us on {tenant.phone} and we will add them.
                  </p>
                </div>
              ) : (
                <RequestForm properties={[...properties]} assets={[...assets]} />
              )}
            </div>
          </div>

          <aside className="lg:col-span-5">
            <div
              className="rounded border-2 p-6"
              style={{ backgroundColor: "var(--surface-raised)", borderColor: "var(--accent)" }}
            >
              <h2 className="text-[15px] font-semibold">Is it an emergency?</h2>
              <p className="prose-body mt-2 text-[14px]">
                Water coming in, no power, or anything unsafe — do not use this form. Call the
                24-hour line and a technician is assigned during the call.
              </p>
              <a href={telLink(tenant.emergencyPhone)} className="btn btn-primary mt-4">
                <PhoneCall size={17} weight="fill" aria-hidden />
                {tenant.emergencyPhone}
              </a>
            </div>

            <dl className="mt-8 space-y-5 text-[14px]">
              <div>
                <dt className="font-semibold">What happens next</dt>
                <dd className="prose-body mt-1 text-[14px]">
                  We triage it, decide the trade and priority, and assign a technician. You can
                  follow it on your account the whole way.
                </dd>
              </div>
              <div>
                <dt className="font-semibold">Priority</dt>
                <dd className="prose-body mt-1 text-[14px]">
                  Tell us how urgent it feels. We may adjust it after triage, and if we do we will
                  tell you why.
                </dd>
              </div>
            </dl>
          </aside>
        </div>
      </div>
    </PortalShell>
  );
}
