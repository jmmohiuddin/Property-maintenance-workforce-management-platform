import type { Metadata } from "next";
import { withCustomerScope, customerNotificationSettings } from "@meridian/db";
import {
  CUSTOMER_NOTIFICATION_EVENT_LABEL,
  CUSTOMER_NOTIFICATION_EVENT_DESCRIPTION,
} from "@meridian/core";
import { requirePortalSession } from "@/lib/session";
import { PortalShell } from "@/components/portal-shell";
import { PreferenceToggle } from "./preference-toggle";

export const metadata: Metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

/**
 * Per-event opt-out (`POR-5`).
 *
 * ── WHY AN OPT-OUT SCREEN IS PART OF A NOTIFICATIONS FEATURE ──────────────
 *
 * Because the alternative is not "the customer receives more messages", it is
 * "the customer marks the address as spam". A person who cannot find a way to
 * stop one message stops all of them by the means available to them, and that
 * means costs the deliverability of the quotation notification too — the one
 * message the business genuinely needs read.
 *
 * Seven switches, not one. The events are not one preference: "technician on
 * the way" is worth a message for ten minutes and nothing afterwards, while
 * "invoice issued" matters to whoever pays and to nobody else. A single switch
 * is what makes somebody turn everything off to stop the one they did not want.
 */
export default async function PortalNotificationsPage() {
  const session = await requirePortalSession();

  const settings = await withCustomerScope(
    {
      tenantId: session.principal.tenantId,
      customerId: session.customerId,
      userId: session.principal.userId,
    },
    (tx) => customerNotificationSettings(tx, session.customerId),
  );

  const offCount = settings.filter((s) => !s.isEnabled).length;

  return (
    <PortalShell session={session} active="notifications">
      <div className="container-page py-8">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Notifications</h1>
        <p className="prose-body mt-2 max-w-[60ch] text-[14px]">
          Choose what we email you about. These settings apply to the whole account, so everyone on
          it gets the same messages.
        </p>

        {offCount > 0 ? (
          <p className="mt-4 text-[13px]" style={{ color: "var(--text-secondary)" }}>
            {offCount} of {settings.length} turned off.
          </p>
        ) : null}

        <div
          className="mt-8 divide-y rounded border"
          style={{ backgroundColor: "var(--surface-raised)" }}
        >
          {settings.map((s) => (
            <PreferenceToggle
              key={s.event}
              event={s.event}
              label={CUSTOMER_NOTIFICATION_EVENT_LABEL[s.event]}
              description={CUSTOMER_NOTIFICATION_EVENT_DESCRIPTION[s.event]}
              isEnabled={s.isEnabled}
            />
          ))}
        </div>

        <p className="prose-body mt-6 max-w-[60ch] text-[13px]">
          Turning something off here stops the email. It does not stop the work, and everything is
          still on your account — requests, quotations and invoices are all visible whether or not
          we email you about them.
        </p>
      </div>
    </PortalShell>
  );
}
