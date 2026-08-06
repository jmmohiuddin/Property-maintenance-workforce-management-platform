import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withTenant, getTechnician } from "@meridian/db";
import { getService } from "@meridian/core";
import { can } from "@meridian/auth";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { SkillPanel } from "./skill-panel";
import { CertificationPanel } from "./certification-panel";

export const metadata: Metadata = { title: "Technician" };
export const dynamic = "force-dynamic";

const dubaiDate = (d: Date) =>
  d.toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium" });

export default async function TechnicianPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSessionWith("technicians:read");
  const { id } = await params;

  const detail = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    (tx) => getTechnician(tx, id),
  );

  if (!detail) notFound();

  const { technician, skills, certifications } = detail;
  const canWrite = can(session.principal, "technicians:write");
  const blocking = certifications.filter(
    (c) => c.state === "expired" && c.requiredForServices.length > 0,
  );

  return (
    <AppShell session={session} active="technicians">
      <div className="container-page py-8">
        <nav aria-label="Breadcrumb" className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          <Link href="/technicians" className="hover:underline">
            Technicians
          </Link>
          <span className="mx-2" aria-hidden>
            /
          </span>
          <span style={{ color: "var(--text-secondary)" }}>{technician.fullName}</span>
        </nav>

        <div className="mt-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{technician.fullName}</h1>
          <p className="tnum text-[14px]" style={{ color: "var(--text-secondary)" }}>
            {technician.employeeCode} &middot; {technician.phone}
            {technician.email ? ` · ${technician.email}` : ""}
          </p>
        </div>

        <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-[14px]">
          {[
            { label: "Primary trade", value: getService(technician.primaryTrade)?.shortName ?? technician.primaryTrade },
            { label: "Grade", value: technician.grade.replace(/_/g, " ") },
            { label: "Employment", value: technician.employment.replace(/_/g, " ") },
            { label: "Base", value: technician.baseCity ?? "Not set" },
            { label: "Visa expires", value: technician.visaExpiresOn ? dubaiDate(technician.visaExpiresOn) : "Not recorded" },
          ].map((f) => (
            <div key={f.label}>
              <dt className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                {f.label}
              </dt>
              <dd className="mt-0.5 font-medium capitalize">{f.value}</dd>
            </div>
          ))}
        </dl>

        {blocking.length > 0 ? (
          <p
            role="status"
            className="mt-6 rounded p-4 text-[14px]"
            style={{ backgroundColor: "var(--accent-wash)", color: "var(--text-primary)" }}
          >
            Dispatch is currently refusing this technician for{" "}
            <strong>
              {[...new Set(blocking.flatMap((c) => c.requiredForServices))]
                .map((slug) => getService(slug)?.shortName ?? slug)
                .join(", ")}
            </strong>{" "}
            because {blocking.map((c) => c.name).join(" and ")}{" "}
            {blocking.length === 1 ? "has" : "have"} lapsed.
          </p>
        ) : null}

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <SkillPanel technicianId={technician.id} skills={[...skills]} canWrite={canWrite} />
          <CertificationPanel
            technicianId={technician.id}
            certifications={[...certifications]}
            canWrite={canWrite}
          />
        </div>
      </div>
    </AppShell>
  );
}
