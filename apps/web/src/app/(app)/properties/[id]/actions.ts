"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant, registerAsset, linkJobToAsset, writeAuditNote } from "@meridian/db";
import { requireSessionWith } from "@/lib/session";
import { userMessage } from "@/lib/errors";

export interface AssetState {
  error?: string;
  ok?: string;
}

/**
 * An empty input is "not given", not "".
 *
 * Every optional field on this form arrives as `""` when nobody touched it, and
 * `""` is not a manufacturer, a serial number or a date. Collapsing it to
 * `undefined` before validation is what stops an untouched date field from
 * being reported to the operator as a malformed one.
 */
function blank<T extends z.ZodType>(inner: T) {
  return z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    inner.optional(),
  );
}

/**
 * A day, as the register stores it.
 *
 * Parsed as a string and kept as one all the way to the column. Turning it into
 * a `Date` here and back into a day in Postgres is what makes a warranty
 * expiring on 1 July arrive as 30 June, and the direction of that error is the
 * one that reports an expired warranty as still covered.
 */
const day = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates go in as YYYY-MM-DD.");

const registerSchema = z.object({
  propertyId: z.uuid(),
  categoryId: z.uuid("Choose what kind of asset this is."),
  tag: z.string().trim().min(2, "Give the asset a tag — the label on the plant."),
  name: z.string().trim().min(2, "Give the asset a name."),
  unitId: blank(z.uuid()),
  manufacturer: blank(z.string().trim().max(120)),
  model: blank(z.string().trim().max(120)),
  serialNumber: blank(z.string().trim().max(120)),
  location: blank(z.string().trim().max(160)),
  installedOn: blank(day),
  warrantyExpiresOn: blank(day),
  condition: z.enum(["new", "good", "fair", "poor", "end_of_life"]).default("good"),
  ppmIntervalDays: blank(
    z.coerce.number("A PPM interval is a number of days.").int().positive(),
  ),
});

/** `CON-13`. Put one piece of plant on a property's register. */
export async function createAsset(_prev: AssetState, formData: FormData): Promise<AssetState> {
  const session = await requireSessionWith("properties:write");

  const parsed = registerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the asset details." };
  }
  const input = parsed.data;

  try {
    const ctx = {
      tenantId: session.principal.tenantId,
      userId: session.principal.userId,
      actorKind: "user" as const,
    };

    await withTenant(ctx, async (tx) => {
      const asset = await registerAsset(tx, ctx, input);
      // In the same transaction as the insert, so the log cannot record plant
      // that rolled back.
      await writeAuditNote(tx, ctx, {
        tableName: "assets",
        recordId: asset.id,
        // `audit_log.action` is varchar(16).
        action: "asset_register",
        detail: {
          propertyId: input.propertyId,
          tag: input.tag,
          name: input.name,
          registeredBy: session.user.email,
        },
      });
    });
  } catch (error) {
    return { error: userMessage(error, "Could not register that asset.", "assets") };
  }

  revalidatePath(`/properties/${input.propertyId}`);
  return { ok: `${input.tag.toUpperCase()} added to the register.` };
}

const attachSchema = z.object({
  propertyId: z.string().uuid(),
  assetId: z.string().uuid(),
  jobId: z.string().uuid("Choose a job to attach."),
});

/**
 * Attach a job to the asset it was done on — `CON-13`'s service history.
 *
 * The job screens do not ask which asset the work is for, so until they do this
 * is the only writer `jobs.asset_id` has. See `domain/assets.ts`.
 */
export async function attachJob(_prev: AssetState, formData: FormData): Promise<AssetState> {
  const session = await requireSessionWith("properties:write");

  const parsed = attachSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Choose a job to attach." };
  }
  const { propertyId, assetId, jobId } = parsed.data;

  let reference: string;
  try {
    const ctx = {
      tenantId: session.principal.tenantId,
      userId: session.principal.userId,
      actorKind: "user" as const,
    };

    reference = (
      await withTenant(ctx, async (tx) => {
        const linked = await linkJobToAsset(tx, ctx, { assetId, jobId });
        await writeAuditNote(tx, ctx, {
          tableName: "jobs",
          recordId: jobId,
          action: "asset_job_link",
          detail: { assetId, reference: linked.reference, linkedBy: session.user.email },
        });
        return linked;
      })
    ).reference;
  } catch (error) {
    return { error: userMessage(error, "Could not attach that job.", "assets") };
  }

  revalidatePath(`/properties/${propertyId}/assets/${assetId}`);
  revalidatePath(`/properties/${propertyId}`);
  return { ok: `${reference} added to this asset's history.` };
}
