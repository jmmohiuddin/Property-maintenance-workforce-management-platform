import Link from "next/link";
import { tenant } from "@meridian/core";

/**
 * The shell for the unauthenticated auth screens: sign in, forgot password,
 * reset password, accept an invitation.
 *
 * Extracted for the same reason as the form kit — four screens now share this
 * chrome, and the third duplicate is a component. It also keeps one property
 * consistent that is easy to lose per screen: these pages carry no navigation
 * at all. Somebody who cannot sign in has nowhere useful to be sent, and a
 * header full of links to pages that will redirect them back here is noise at
 * the moment they are least able to absorb it.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <Link href="/" className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="grid h-8 w-8 place-items-center rounded-sm font-mono text-[15px] font-bold"
            style={{ backgroundColor: "var(--accent)", color: "var(--accent-contrast)" }}
          >
            S
          </span>
          <span className="text-[15px] font-semibold tracking-tight">{tenant.brandName}</span>
        </Link>

        <h1 className="mt-10 text-3xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="prose-body mt-3 text-[15px]">{subtitle}</p> : null}

        <div className="mt-8">{children}</div>

        {footer ? <div className="mt-8">{footer}</div> : null}
      </div>
    </div>
  );
}
