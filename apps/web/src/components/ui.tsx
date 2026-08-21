import Link from "next/link";
import { telLink, responseCommitment, type Service } from "@meridian/core";
import { ArrowUpRight, Lightning, PhoneCall } from "@phosphor-icons/react/dist/ssr";

export function Section({
  children,
  className = "",
  tone = "default",
}: {
  children: React.ReactNode;
  className?: string;
  tone?: "default" | "sunken" | "inverse";
}) {
  const bg =
    tone === "sunken"
      ? "var(--surface-sunken)"
      : tone === "inverse"
        ? "var(--surface-inverse)"
        : "var(--surface)";
  const fg = tone === "inverse" ? "var(--text-on-inverse)" : "var(--text-primary)";
  return (
    <section className={`py-20 md:py-28 ${className}`} style={{ backgroundColor: bg, color: fg }}>
      {children}
    </section>
  );
}

/** Small uppercase label above a headline. Rationed: see the design notes. */
export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="font-mono text-[11px] font-medium uppercase tracking-[0.16em]"
      style={{ color: "var(--accent-text)" }}
    >
      {children}
    </p>
  );
}

export function ServiceCard({ service, image }: { service: Service; image?: string }) {
  return (
    <Link
      href={`/services/${service.slug}`}
      className="group flex flex-col justify-between rounded border p-6 transition-colors hover:border-[var(--border-strong)]"
      style={{ backgroundColor: "var(--surface-raised)" }}
    >
      {image ? (
        <img
          src={image}
          alt=""
          loading="lazy"
          className="mb-5 h-36 w-full rounded-sm object-cover"
          width={640}
          height={288}
        />
      ) : null}
      <div>
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-[17px] font-semibold tracking-tight">{service.name}</h3>
          <ArrowUpRight
            size={17}
            aria-hidden
            className="mt-0.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
            style={{ color: "var(--accent-text)" }}
          />
        </div>
        <p className="prose-body mt-2 text-[14px]">{service.tagline}</p>
      </div>
      {/*
        This used to read "From AED 150 · call-out". That number was invented,
        along with every other price in the catalogue, so WEB-2 removed it. What
        replaces it is a commitment the SLA clock is actually measured against
        (JOB-4) rather than a price nobody had set. Real prices arrive with
        WEB-16, generated from the rate card so they cannot drift from what is
        quoted.
      */}
      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <span style={{ color: "var(--text-secondary)" }}>{responseCommitment(service)}</span>
        {service.emergency ? (
          <span
            className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
            style={{ backgroundColor: "var(--accent-wash)", color: "var(--accent-text)" }}
          >
            <Lightning size={11} weight="fill" aria-hidden />
            24/7
          </span>
        ) : null}
      </div>
    </Link>
  );
}

/**
 * The answer block. Every page has exactly one, and it is the paragraph an
 * answer engine should be able to lift without needing the rest of the page.
 * It is visible copy first and structured data second, never the reverse.
 *
 * On the accent rule: a left accent border is an overused device and it was
 * removed from the notice, error and list treatments, where a background wash
 * or a hairline border already did the same job. It stays here because this is
 * the one case where it earns its place: at most one instance per page, no
 * competing background, and it is marking the single most important paragraph
 * on the page. If it were repeated it would be decoration; used once it is
 * hierarchy. Do not reintroduce it elsewhere.
 */
export function AnswerBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-l-2 pl-5 md:pl-6" style={{ borderColor: "var(--accent)" }}>
      <p className="answer-lead">{children}</p>
    </div>
  );
}

/**
 * A phone call-to-action that renders nothing when there is no number.
 *
 * The alternative — an anchor with an empty `href` and an empty label — is a
 * dead control that looks like a live one, which is the failure mode WEB-2
 * exists to remove in copy and this component removes in markup. The number is
 * required (`WEB-4`, and `missingRequiredFields()` reports it), so an absent
 * button is a visible gap rather than a hidden one.
 */
export function CallLink({
  phone,
  label,
  className = "btn btn-primary",
  icon = true,
}: {
  phone: string | null;
  label?: string;
  className?: string;
  icon?: boolean;
}) {
  const href = telLink(phone);
  if (!href || !phone) return null;

  return (
    <a href={href} className={className}>
      {icon ? <PhoneCall size={17} weight="fill" aria-hidden /> : null}
      <span className="tabular-nums">{label ?? phone}</span>
    </a>
  );
}
