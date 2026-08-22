"use client";

import { useActionState } from "react";
import { captureSignatureAction, amendJobSheetAction, type ActionState } from "./actions";
import {
  CheckCircle,
  Warning,
  PenNib,
  FileText,
  LockSimple,
  ArrowsClockwise,
} from "@phosphor-icons/react/dist/ssr";

const INITIAL: ActionState = {};

const fieldClass =
  "w-full rounded-sm border px-3 py-2 text-[13px] outline-none focus:border-[var(--accent)]";
const fieldStyle: React.CSSProperties = {
  backgroundColor: "var(--surface)",
  color: "var(--text-primary)",
  borderColor: "var(--border-strong)",
};

export interface JobSheetRowView {
  id: string;
  kind: "original" | "amendment";
  reference: string;
  sequence: number;
  /** Lower-case hex, 64 characters. */
  contentSha256: string;
  pdfSha256: string;
  sealedAt: string;
  amendmentReasonLabel: string | null;
  amendmentDetail: string | null;
}

export interface AmendmentReasonOption {
  code: string;
  label: string;
  description: string | null;
}

export interface JobSheetView {
  jobId: string;
  /** Every sheet on the job, original first. Empty until one is signed. */
  sheets: JobSheetRowView[];
  signature: {
    signedByName: string;
    signedByRole: string | null;
    signerEmail: string | null;
    signedAt: string;
    consentVersion: string | null;
  } | null;
  /**
   * The digest of the sheet this page is showing, or the sentence saying why
   * there is no sheet to show yet.
   *
   * One or the other, never both. A form that cannot be submitted usefully is
   * better replaced by the reason than left on the screen looking available.
   */
  presentedSha256: string | null;
  notReady: string | null;
  reasons: AmendmentReasonOption[];
}

/**
 * The signed job sheet (`FLD-14`).
 *
 * ── WHY THIS IS A SEPARATE PANEL FROM THE JOB CARD ──────────────────────────
 *
 * The job card is `JOB-15`: four conditions that have to be met before work can
 * be called complete, all of them editable until they are. This is what happens
 * at the end of that — one irreversible act that produces a document, freezes
 * the card and sends the customer their copy. Putting the signature pad inside
 * the card panel, where it used to be, made it look like a fifth field.
 *
 * ── WHY THE DIGEST IS ON THE SCREEN ─────────────────────────────────────────
 *
 * Because it is what the customer is being asked to rely on, and because an
 * operator who has to explain the sheet to a customer in a dispute needs to be
 * able to read the number off the screen and off the document and see that they
 * match. A fingerprint that only exists in the database is a fingerprint the
 * business cannot use.
 *
 * ── WHAT THIS PANEL DOES NOT DECIDE ─────────────────────────────────────────
 *
 * Nothing. The lock is `assertJobCardUnlocked` and the triggers in `0037`; the
 * digest comparison is in `sealJobSheet`; the vocabulary is checked against the
 * tenant's own list on the server. What is rendered here is the state and the
 * two forms — and the sign-off button stays enabled even when the sheet cannot
 * be produced, for the reason the job card panel gives: disabling it would make
 * the browser the authority on a rule the server owns, and an operator facing a
 * greyed-out button learns nothing.
 */
export function JobSheetPanel({ sheet }: { sheet: JobSheetView }) {
  const original = sheet.sheets.find((s) => s.kind === "original") ?? null;
  const amendments = sheet.sheets.filter((s) => s.kind === "amendment");

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Signed job sheet</h2>
        <span
          className="flex items-center gap-1.5 text-[13px]"
          style={{
            color: original ? "var(--status-success-text)" : "var(--text-muted)",
          }}
        >
          {original ? (
            <>
              <LockSimple size={14} weight="fill" aria-hidden />
              Signed and locked
            </>
          ) : (
            "Not yet signed"
          )}
        </span>
      </div>

      <p className="prose-body mt-2 text-[14px]">
        A signature only means something if the sheet it was given to cannot change afterwards. The
        sheet is hashed at the moment it is shown, an unalterable copy is stored, the job card is
        closed to edits, and the customer is emailed their own dated copy. Corrections after that
        are separate, reason-coded amendments — the signed sheet itself is never rewritten.
      </p>

      <div className="mt-6 space-y-6">
        {original ? (
          <SealedBlock original={original} amendments={amendments} sheet={sheet} />
        ) : (
          <SignBlock sheet={sheet} />
        )}
      </div>
    </section>
  );
}

function Block({
  icon,
  title,
  status,
  tone,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  status: string;
  tone: "good" | "warn" | "quiet";
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
            color:
              tone === "good"
                ? "var(--status-success-text)"
                : tone === "warn"
                  ? "var(--status-warning-text)"
                  : "var(--text-muted)",
          }}
        >
          {tone === "good" ? (
            <CheckCircle size={14} weight="fill" aria-hidden />
          ) : tone === "warn" ? (
            <Warning size={14} weight="fill" aria-hidden />
          ) : null}
          {status}
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

/**
 * A digest, laid out so a person can actually compare it.
 *
 * Broken into groups and in a monospaced face, because the operational use of
 * this string is somebody reading it off a screen against a printed page. An
 * unbroken run of 64 characters is a string nobody checks, and a string nobody
 * checks is the same as no string.
 */
function Digest({ value, label }: { value: string; label: string }) {
  const groups = value.match(/.{1,8}/g) ?? [value];
  return (
    <div className="mt-3">
      <p className="text-[12px] font-medium" style={{ color: "var(--text-muted)" }}>
        {label}
      </p>
      <p
        className="mt-1 break-all font-mono text-[12px] leading-relaxed"
        style={{ color: "var(--text-secondary)" }}
      >
        {groups.join(" ")}
      </p>
    </div>
  );
}

function SealedBlock({
  original,
  amendments,
  sheet,
}: {
  original: JobSheetRowView;
  amendments: JobSheetRowView[];
  sheet: JobSheetView;
}) {
  return (
    <>
      <Block icon={<FileText size={16} weight="fill" />} title={original.reference} status="Sealed" tone="good">
        {sheet.signature ? (
          <p className="text-[13px]">
            Signed by {sheet.signature.signedByName}
            {sheet.signature.signedByRole ? `, ${sheet.signature.signedByRole}` : ""} on{" "}
            {sheet.signature.signedAt}.
            {sheet.signature.signerEmail
              ? ` A copy went to ${sheet.signature.signerEmail}.`
              : " No address was given for the signer, so the copy went to the customer on file."}
          </p>
        ) : null}

        {sheet.signature?.consentVersion ? (
          <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
            Given under consent statement {sheet.signature.consentVersion}, whose exact wording is
            reproduced on the sheet and covered by the digest below.
          </p>
        ) : null}

        <Digest label="Content fingerprint — the sheet as it was on screen" value={original.contentSha256} />
        <Digest label="Stored document fingerprint" value={original.pdfSha256} />

        <p className="mt-4">
          <a
            className="btn btn-secondary !py-2 text-[13px]"
            href={`/jobs/${sheet.jobId}/job-sheet/${original.id}`}
          >
            Open the signed sheet
          </a>
        </p>
      </Block>

      {amendments.map((a) => (
        <Block
          key={a.id}
          icon={<ArrowsClockwise size={16} weight="fill" />}
          title={a.reference}
          status={a.amendmentReasonLabel ?? "Amendment"}
          tone="quiet"
        >
          <p className="text-[13px]">{a.amendmentDetail}</p>
          <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
            Raised {a.sealedAt}. The sheet above is unchanged.
          </p>
          <p className="mt-3">
            <a
              className="btn btn-secondary !py-2 text-[13px]"
              href={`/jobs/${sheet.jobId}/job-sheet/${a.id}`}
            >
              Open the amendment
            </a>
          </p>
        </Block>
      ))}

      <Block
        icon={<ArrowsClockwise size={16} weight="fill" />}
        title="Something on the signed sheet is wrong"
        status="Corrections are amendments"
        tone="quiet"
      >
        <p className="prose-body text-[13px]">
          The signed sheet stays exactly as it is, and so does its fingerprint. What you write here
          becomes a second document, linked to it, saying what was wrong and what the position
          actually is. The customer gets that too.
        </p>
        <AmendForm sheet={sheet} />
      </Block>
    </>
  );
}

function SignBlock({ sheet }: { sheet: JobSheetView }) {
  return (
    <Block
      icon={<PenNib size={16} weight="fill" />}
      title="Take the customer's signature"
      status={sheet.notReady ? "The sheet is not ready" : "Ready to sign"}
      tone={sheet.notReady ? "warn" : "quiet"}
    >
      {sheet.notReady ? (
        <p className="prose-body text-[13px]">{sheet.notReady}</p>
      ) : (
        <>
          <p className="prose-body text-[13px]">
            Show the customer the sheet, then record who signed it. The sheet is sealed exactly as
            they saw it — if anything on the job card changes between now and the signature being
            saved, it is refused rather than recorded against a document nobody read.
          </p>
          <p className="mt-3">
            <a
              className="btn btn-secondary !py-2 text-[13px]"
              href={`/jobs/${sheet.jobId}/job-sheet/preview`}
            >
              Open the sheet to show the customer
            </a>
          </p>
          {sheet.presentedSha256 ? (
            <Digest label="What this sheet fingerprints to" value={sheet.presentedSha256} />
          ) : null}
          <SignatureForm jobId={sheet.jobId} presentedSha256={sheet.presentedSha256 ?? ""} />
        </>
      )}
    </Block>
  );
}

function SignatureForm({ jobId, presentedSha256 }: { jobId: string; presentedSha256: string }) {
  const [state, formAction, pending] = useActionState(captureSignatureAction, INITIAL);
  return (
    <form action={formAction} className="mt-5 space-y-3 border-t pt-4">
      <input type="hidden" name="jobId" value={jobId} />
      {/* The digest of the sheet THIS page rendered. The server re-derives it
          and refuses if the record has moved since. */}
      <input type="hidden" name="presentedSha256" value={presentedSha256} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="sign-name" className="block text-[13px] font-medium">
            Signed by
          </label>
          <input
            id="sign-name"
            name="signedByName"
            required
            maxLength={160}
            className={`${fieldClass} mt-1`}
            style={fieldStyle}
          />
        </div>
        <div>
          <label htmlFor="sign-role" className="block text-[13px] font-medium">
            Their relationship to the site
          </label>
          <input
            id="sign-role"
            name="signedByRole"
            maxLength={80}
            placeholder="Building manager, tenant, security"
            className={`${fieldClass} mt-1`}
            style={fieldStyle}
          />
        </div>
        <div>
          <label htmlFor="sign-email" className="block text-[13px] font-medium">
            Where their copy goes
          </label>
          <input
            id="sign-email"
            name="signerEmail"
            type="email"
            maxLength={200}
            className={`${fieldClass} mt-1`}
            style={fieldStyle}
          />
          {/* Asked for here rather than taken from the customer record, because
              the person signing at a site is frequently not the person the
              invoices go to — and a contemporaneous copy that reaches the wrong
              inbox is both useless as evidence and a disclosure. */}
          <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
            The signer&rsquo;s own address. Left blank, the copy goes to the customer on file.
          </p>
        </div>
        <div>
          <label htmlFor="sign-rating" className="block text-[13px] font-medium">
            Satisfaction, 1–5 (optional)
          </label>
          <input
            id="sign-rating"
            name="satisfactionRating"
            inputMode="numeric"
            className={`${fieldClass} mt-1`}
            style={fieldStyle}
          />
        </div>
      </div>
      <div>
        <label htmlFor="sign-image" className="block text-[13px] font-medium">
          Signature image
        </label>
        <input
          id="sign-image"
          name="signature"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/heic"
          required
          className={`${fieldClass} mt-1`}
          style={fieldStyle}
        />
      </div>
      <div>
        <label htmlFor="sign-comments" className="block text-[13px] font-medium">
          Their comments (optional)
        </label>
        <textarea
          id="sign-comments"
          name="comments"
          rows={2}
          className={`${fieldClass} mt-1`}
          style={fieldStyle}
        />
      </div>
      <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
        Saving this seals the sheet and locks the job card. Nothing on the card can be changed
        afterwards.
      </p>
      <button
        type="submit"
        disabled={pending}
        className="btn btn-secondary !py-2 text-[13px] disabled:opacity-60"
      >
        {pending ? "Sealing..." : "Seal the sheet and record the signature"}
      </button>
      <Result state={state} />
    </form>
  );
}

function AmendForm({ sheet }: { sheet: JobSheetView }) {
  const [state, formAction, pending] = useActionState(amendJobSheetAction, INITIAL);
  return (
    <form action={formAction} className="mt-4 space-y-3 border-t pt-4">
      <input type="hidden" name="jobId" value={sheet.jobId} />
      <div>
        <label htmlFor="amend-reason" className="block text-[13px] font-medium">
          What kind of thing is wrong
        </label>
        <select
          id="amend-reason"
          name="reasonCode"
          required
          defaultValue=""
          className={`${fieldClass} mt-1`}
          style={fieldStyle}
        >
          <option value="" disabled>
            Choose a reason
          </option>
          {sheet.reasons.map((r) => (
            <option key={r.code} value={r.code}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="amend-detail" className="block text-[13px] font-medium">
          What the position actually is
        </label>
        <textarea
          id="amend-detail"
          name="detail"
          rows={3}
          required
          className={`${fieldClass} mt-1`}
          style={fieldStyle}
        />
        <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
          The code says what kind of thing went wrong. It cannot say what is right, and an
          amendment without that discredits the record without replacing it.
        </p>
      </div>
      <button
        type="submit"
        disabled={pending}
        className="btn btn-secondary !py-2 text-[13px] disabled:opacity-60"
      >
        {pending ? "Raising..." : "Raise the amendment"}
      </button>
      <Result state={state} />
    </form>
  );
}
