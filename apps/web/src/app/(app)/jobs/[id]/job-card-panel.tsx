"use client";

import { useActionState } from "react";
import {
  uploadJobPhotoAction,
  exemptAfterPhotoAction,
  addJobMaterialAction,
  declareNoMaterialsAction,
  recordLabourAction,
  type ActionState,
} from "./actions";
import { CheckCircle, Warning, Camera, Wrench, Clock, PenNib } from "@phosphor-icons/react/dist/ssr";

const INITIAL: ActionState = {};

const fieldClass =
  "w-full rounded-sm border px-3 py-2 text-[13px] outline-none focus:border-[var(--accent)]";
const fieldStyle: React.CSSProperties = {
  backgroundColor: "var(--surface)",
  color: "var(--text-primary)",
  borderColor: "var(--border-strong)",
};

export interface JobCardPhoto {
  id: string;
  kind: string;
  caption: string | null;
  capturedAt: string | null;
}

export interface JobCardMaterial {
  id: string;
  sku: string | null;
  description: string;
  quantity: string;
  unit: string;
  cost: string | null;
  isBillable: boolean;
}

export interface JobCardVisitLabour {
  visitId: string;
  sequence: number;
  technicianName: string;
  /** Already formatted; null means nobody has filled it in. */
  worked: string | null;
  travel: string | null;
}

export interface ExemptionReasonOption {
  code: string;
  label: string;
  description: string | null;
}

export interface JobCardView {
  jobId: string;
  photos: JobCardPhoto[];
  afterPhotoCount: number;
  exemption: { label: string; note: string | null } | null;
  materials: JobCardMaterial[];
  materialsNone: { note: string | null } | null;
  labour: JobCardVisitLabour[];
  labourTotal: string | null;
  signature: { signedByName: string; signedByRole: string | null; signedAt: string } | null;
  gaps: string[];
  reasons: ExemptionReasonOption[];
}

/**
 * The job card (`JOB-15`).
 *
 * ── WHY THIS SCREEN EXISTS AT ALL ───────────────────────────────────────────
 *
 * `job_attachments`, `job_materials` and `job_signoffs` have been in the schema
 * since `0000` and nothing in this application has ever written a row to any of
 * them; `job_visits.work_minutes` is the same. Adding the completion gate
 * without adding this panel would have turned `JOB-15` into a wall: a rule
 * nobody could satisfy, which gets removed rather than met.
 *
 * ── WHAT THIS PANEL IS NOT ──────────────────────────────────────────────────
 *
 * It is not the enforcement. The checklist below is rendered from the same
 * `gaps` the server computes in `assertJobCardComplete`, and it is a courtesy:
 * the refusal happens in the domain layer, inside the transaction that would
 * otherwise complete the job, because `M11` — the React Native field app — will
 * reach the same records through an API and would not run a line of this file.
 *
 * The "Record and complete" button is deliberately left enabled when the card
 * is incomplete. Disabling it would make the browser the authority on a rule
 * the server owns, and the two would eventually disagree — at which point the
 * operator is looking at a greyed-out button with no explanation instead of a
 * sentence naming what is missing.
 */
export function JobCardPanel({ card }: { card: JobCardView }) {
  const needsPhoto = card.gaps.includes("after_photo");
  const needsMaterials = card.gaps.includes("materials");
  const needsLabour = card.gaps.includes("labour");

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Job card</h2>
        <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          {card.gaps.length === 0
            ? "Complete. The work can be closed."
            : `${card.gaps.length} of 3 still outstanding`}
        </p>
      </div>

      <p className="prose-body mt-2 text-[14px]">
        A job cannot be marked complete without an outcome, an after photograph or a coded reason
        there is none, the parts used or a declaration that none were, and the time on the tools.
        That is checked on the server when the outcome is recorded, not here.
      </p>

      <div className="mt-6 space-y-6">
        {/* ── Photographs ──────────────────────────────────────────────── */}
        <Block
          icon={<Camera size={16} weight="bold" aria-hidden />}
          title="Photographs"
          done={!needsPhoto}
          summary={
            card.exemption
              ? `Exempt: ${card.exemption.label}`
              : card.afterPhotoCount > 0
                ? `${card.afterPhotoCount} after ${card.afterPhotoCount === 1 ? "photograph" : "photographs"} on file`
                : "No after photograph yet"
          }
        >
          {card.photos.length > 0 ? (
            <ul className="mb-4 space-y-1.5">
              {card.photos.map((p) => (
                <li key={p.id} className="text-[13px]">
                  <a
                    href={`/jobs/${card.jobId}/photo/${p.id}`}
                    className="hover:underline"
                    style={{ color: "var(--accent-text)" }}
                  >
                    {p.kind.replace("photo_", "")} — {p.caption ?? "no caption"}
                  </a>
                  {p.capturedAt ? (
                    <span className="tnum ml-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
                      {p.capturedAt}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {card.exemption ? (
            <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
              Exempted: {card.exemption.label}
              {card.exemption.note ? ` — ${card.exemption.note}` : ""}
            </p>
          ) : null}

          <PhotoForm jobId={card.jobId} />

          {/* The exemption is offered only while there is nothing to exempt.
              Once an after photograph is on file the server refuses one, and
              offering a form whose only outcome is a refusal is worse than
              offering nothing. */}
          {needsPhoto ? <ExemptForm jobId={card.jobId} reasons={card.reasons} /> : null}
        </Block>

        {/* ── Materials ────────────────────────────────────────────────── */}
        <Block
          icon={<Wrench size={16} weight="bold" aria-hidden />}
          title="Materials"
          done={!needsMaterials}
          summary={
            card.materialsNone
              ? "Declared: none used"
              : card.materials.length > 0
                ? `${card.materials.length} ${card.materials.length === 1 ? "line" : "lines"}`
                : "Nothing recorded"
          }
        >
          {card.materials.length > 0 ? (
            <ul className="mb-4 space-y-1.5">
              {card.materials.map((m) => (
                <li key={m.id} className="flex flex-wrap items-baseline gap-x-3 text-[13px]">
                  <span className="tnum">
                    {m.quantity} {m.unit}
                  </span>
                  <span>{m.description}</span>
                  {m.sku ? (
                    <span className="tnum text-[12px]" style={{ color: "var(--text-muted)" }}>
                      {m.sku}
                    </span>
                  ) : null}
                  {m.cost ? <span className="tnum text-[12px]">{m.cost}</span> : null}
                  {!m.isBillable ? (
                    <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                      not billable
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {card.materialsNone ? (
            <p className="mb-4 text-[13px]" style={{ color: "var(--text-secondary)" }}>
              Declared as using no parts or consumables
              {card.materialsNone.note ? ` — ${card.materialsNone.note}` : ""}.
            </p>
          ) : null}

          <MaterialForm jobId={card.jobId} />

          {/* "None" is a fact somebody records, not the absence of records —
              which is the whole of the requirement's "or explicitly none". */}
          {card.materials.length === 0 && !card.materialsNone ? (
            <NoMaterialsForm jobId={card.jobId} />
          ) : null}
        </Block>

        {/* ── Labour ───────────────────────────────────────────────────── */}
        <Block
          icon={<Clock size={16} weight="bold" aria-hidden />}
          title="Labour"
          done={!needsLabour}
          summary={card.labourTotal ? `${card.labourTotal} on the tools` : "No time recorded"}
        >
          {card.labour.length === 0 ? (
            <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
              No visit is assigned to this job, so there is nobody whose time to record. Assign a
              technician first.
            </p>
          ) : (
            <div className="space-y-4">
              {card.labour.map((v) => (
                <LabourForm key={v.visitId} jobId={card.jobId} visit={v} />
              ))}
            </div>
          )}
        </Block>

        {/* ── Sign-off ─────────────────────────────────────────────────── */}
        {/*
          Moved out of this panel and into `JobSheetPanel` (`FLD-14`).

          It sat here as a fifth, optional block while a signature was a name
          and an image — the whole of what `recordJobSignature` used to store.
          Signing now seals a hashed, immutable job sheet, emails the customer
          their copy, and closes this card to edits, and none of that is a field
          on the card. Leaving a signature form here would have left two ways to
          sign a job, one of which produces evidence and one of which does not.

          The state stays visible below, because an operator reading the card
          needs to know whether it is still theirs to change.
        */}
        <Block
          icon={<PenNib size={16} weight="bold" aria-hidden />}
          title="Customer sign-off"
          done={card.signature !== null}
          optional
          summary={
            card.signature
              ? `Signed by ${card.signature.signedByName} on ${card.signature.signedAt}`
              : "Not signed"
          }
        >
          {card.signature ? (
            <p className="text-[13px]">
              {card.signature.signedByName}
              {card.signature.signedByRole ? `, ${card.signature.signedByRole}` : ""} —{" "}
              {card.signature.signedAt}. This card is locked; corrections are amendments to the
              signed job sheet below.
            </p>
          ) : (
            <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
              Not one of the four things that gate completion — a technician who cannot find anybody
              to sign, an empty villa, a night shift in a plant room, must still be able to close the
              job. When there is somebody to sign, the signed job sheet section below is where it
              happens.
            </p>
          )}
        </Block>
      </div>
    </section>
  );
}

function Block({
  icon,
  title,
  done,
  optional,
  summary,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  done: boolean;
  optional?: boolean;
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-[14px] font-semibold">
          <span style={{ color: "var(--accent)" }}>{icon}</span>
          {title}
        </h3>
        <span
          className="flex items-center gap-1.5 text-[13px]"
          style={{
            color: done
              ? "var(--status-success-text)"
              : optional
                ? "var(--text-muted)"
                : "var(--status-warning-text)",
          }}
        >
          {done ? (
            <CheckCircle size={14} weight="fill" aria-hidden />
          ) : optional ? null : (
            <Warning size={14} weight="fill" aria-hidden />
          )}
          {summary}
        </span>
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function Result({ state }: { state: ActionState }) {
  if (!state.error && !state.ok) return null;
  return (
    <p
      role="status"
      className="mt-2 flex items-start gap-2 text-[13px]"
      style={{ color: state.error ? "var(--accent-text)" : "var(--text-secondary)" }}
    >
      {state.error ? (
        <Warning size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
      ) : (
        <CheckCircle size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
      )}
      {state.error ?? state.ok}
    </p>
  );
}

function PhotoForm({ jobId }: { jobId: string }) {
  const [state, formAction, pending] = useActionState(uploadJobPhotoAction, INITIAL);
  return (
    <form action={formAction} className="space-y-3 border-t pt-4">
      <input type="hidden" name="jobId" value={jobId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="photo-kind" className="block text-[13px] font-medium">
            Which shot
          </label>
          <select id="photo-kind" name="kind" className={`${fieldClass} mt-1`} style={fieldStyle}>
            <option value="photo_after">After</option>
            <option value="photo_before">Before</option>
          </select>
        </div>
        <div>
          <label htmlFor="photo-caption" className="block text-[13px] font-medium">
            Caption (optional)
          </label>
          <input
            id="photo-caption"
            name="caption"
            maxLength={200}
            className={`${fieldClass} mt-1`}
            style={fieldStyle}
          />
        </div>
      </div>
      <div>
        <label htmlFor="photo-file" className="block text-[13px] font-medium">
          Image
        </label>
        {/* PNG, JPEG, WebP and HEIC — the allowlist `packages/files` sniffs
            for. The type is read from the bytes on the server, so this
            attribute is a file-picker convenience and nothing more. */}
        <input
          id="photo-file"
          name="photo"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/heic"
          required
          className={`${fieldClass} mt-1`}
          style={fieldStyle}
        />
      </div>
      <button type="submit" disabled={pending} className="btn btn-secondary !py-2 text-[13px] disabled:opacity-60">
        {pending ? "Uploading..." : "Attach photograph"}
      </button>
      <Result state={state} />
    </form>
  );
}

function ExemptForm({ jobId, reasons }: { jobId: string; reasons: ExemptionReasonOption[] }) {
  const [state, formAction, pending] = useActionState(exemptAfterPhotoAction, INITIAL);

  if (reasons.length === 0) {
    // The empty-picker case this codebase has shipped once already. The
    // vocabulary is seeded, so this is the tenant created outside the seed —
    // and saying so beats a `<select>` with nothing in it, which reads as a
    // broken form and sends the operator to the notes field instead.
    return (
      <p className="mt-4 border-t pt-4 text-[13px]" style={{ color: "var(--text-muted)" }}>
        No photo exemption reasons are configured for this company, so the after photograph cannot
        be waived. Upload one, or have an administrator install the standard list.
      </p>
    );
  }

  return (
    <form action={formAction} className="mt-4 space-y-3 border-t pt-4">
      <input type="hidden" name="jobId" value={jobId} />
      <div>
        <label htmlFor="exempt-reason" className="block text-[13px] font-medium">
          Or: why there is no after photograph
        </label>
        <select
          id="exempt-reason"
          name="reasonCode"
          required
          className={`${fieldClass} mt-1`}
          style={fieldStyle}
        >
          <option value="">Choose…</option>
          {reasons.map((r) => (
            <option key={r.code} value={r.code}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="exempt-note" className="block text-[13px] font-medium">
          Note (optional)
        </label>
        <input
          id="exempt-note"
          name="note"
          maxLength={240}
          placeholder="What the reason code does not say"
          className={`${fieldClass} mt-1`}
          style={fieldStyle}
        />
      </div>
      <button type="submit" disabled={pending} className="btn btn-secondary !py-2 text-[13px] disabled:opacity-60">
        {pending ? "Saving..." : "Record the exemption"}
      </button>
      <Result state={state} />
    </form>
  );
}

function MaterialForm({ jobId }: { jobId: string }) {
  const [state, formAction, pending] = useActionState(addJobMaterialAction, INITIAL);
  return (
    <form action={formAction} className="space-y-3 border-t pt-4">
      <input type="hidden" name="jobId" value={jobId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor="material-description" className="block text-[13px] font-medium">
            Part or consumable
          </label>
          <input
            id="material-description"
            name="description"
            required
            maxLength={240}
            className={`${fieldClass} mt-1`}
            style={fieldStyle}
          />
        </div>
        <div>
          <label htmlFor="material-quantity" className="block text-[13px] font-medium">
            Quantity
          </label>
          <input
            id="material-quantity"
            name="quantity"
            inputMode="decimal"
            defaultValue="1"
            required
            className={`${fieldClass} mt-1`}
            style={fieldStyle}
          />
        </div>
        <div>
          <label htmlFor="material-unit" className="block text-[13px] font-medium">
            Unit
          </label>
          <input
            id="material-unit"
            name="unit"
            defaultValue="ea"
            maxLength={16}
            className={`${fieldClass} mt-1`}
            style={fieldStyle}
          />
        </div>
        <div>
          <label htmlFor="material-sku" className="block text-[13px] font-medium">
            SKU (optional)
          </label>
          <input
            id="material-sku"
            name="sku"
            maxLength={64}
            className={`${fieldClass} mt-1`}
            style={fieldStyle}
          />
        </div>
        <div>
          <label htmlFor="material-cost" className="block text-[13px] font-medium">
            Unit cost, AED (optional)
          </label>
          <input
            id="material-cost"
            name="unitCost"
            inputMode="decimal"
            className={`${fieldClass} mt-1`}
            style={fieldStyle}
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" name="isBillable" defaultChecked />
        Billable to the customer
      </label>
      <button type="submit" disabled={pending} className="btn btn-secondary !py-2 text-[13px] disabled:opacity-60">
        {pending ? "Saving..." : "Add material"}
      </button>
      <Result state={state} />
    </form>
  );
}

function NoMaterialsForm({ jobId }: { jobId: string }) {
  const [state, formAction, pending] = useActionState(declareNoMaterialsAction, INITIAL);
  return (
    <form action={formAction} className="mt-4 space-y-3 border-t pt-4">
      <input type="hidden" name="jobId" value={jobId} />
      <div>
        <label htmlFor="none-note" className="block text-[13px] font-medium">
          Or: no parts were used
        </label>
        <input
          id="none-note"
          name="note"
          maxLength={240}
          placeholder="Note (optional)"
          className={`${fieldClass} mt-1`}
          style={fieldStyle}
        />
      </div>
      <button type="submit" disabled={pending} className="btn btn-secondary !py-2 text-[13px] disabled:opacity-60">
        {pending ? "Saving..." : "Declare no materials used"}
      </button>
      <Result state={state} />
    </form>
  );
}

function LabourForm({ jobId, visit }: { jobId: string; visit: JobCardVisitLabour }) {
  const [state, formAction, pending] = useActionState(recordLabourAction, INITIAL);
  return (
    <form action={formAction} className="border-t pt-4 first:border-0 first:pt-0">
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="visitId" value={visit.visitId} />
      <p className="text-[13px] font-medium">
        Visit {visit.sequence} &middot; {visit.technicianName}
        {visit.worked ? (
          <span className="ml-2 font-normal" style={{ color: "var(--text-muted)" }}>
            {visit.worked} on the tools
            {visit.travel ? `, ${visit.travel} travelling` : ""}
          </span>
        ) : null}
      </p>
      <div className="mt-2 grid gap-3 sm:grid-cols-3">
        <div>
          <label
            htmlFor={`work-${visit.visitId}`}
            className="block text-[12px]"
            style={{ color: "var(--text-secondary)" }}
          >
            Minutes on the tools
          </label>
          <input
            id={`work-${visit.visitId}`}
            name="workMinutes"
            inputMode="numeric"
            required
            className={`${fieldClass} mt-1`}
            style={fieldStyle}
          />
        </div>
        <div>
          <label
            htmlFor={`travel-${visit.visitId}`}
            className="block text-[12px]"
            style={{ color: "var(--text-secondary)" }}
          >
            Travel minutes
          </label>
          <input
            id={`travel-${visit.visitId}`}
            name="travelMinutes"
            inputMode="numeric"
            className={`${fieldClass} mt-1`}
            style={fieldStyle}
          />
        </div>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={pending}
            className="btn btn-secondary w-full !py-2 text-[13px] disabled:opacity-60"
          >
            {pending ? "Saving..." : "Record time"}
          </button>
        </div>
      </div>
      {/* Zero is a real answer, and saying so here is what stops somebody
          inventing a number for a visit that never reached the work. */}
      <p className="mt-1.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
        Zero is valid — a visit that never reached the work spent no time on the tools.
      </p>
      <Result state={state} />
    </form>
  );
}

