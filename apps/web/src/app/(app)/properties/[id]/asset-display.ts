/**
 * How the register renders a day and a warranty.
 *
 * In its own module rather than in the page, because both the register and the
 * asset record show them and a page file is not somewhere to import from.
 */

/** A stored day is already a Dubai day. Rendering it must not re-interpret it. */
export function readableDay(day: string): string {
  const [y, m, d] = day.split("-");
  return `${d}/${m}/${y}`;
}

export const CONDITION_LABEL: Record<string, string> = {
  new: "New",
  good: "Good",
  fair: "Fair",
  poor: "Poor",
  end_of_life: "End of life",
};

/**
 * What the warranty line says, and in what tone.
 *
 * `daysRemaining` was computed by Postgres against `current_date`; nothing here
 * re-derives it from a `Date`, because that is the arithmetic that reports an
 * expired warranty as live for the first four hours of every Dubai day — and
 * that error runs in the direction that authorises a repair the manufacturer
 * will refuse to pay for.
 */
export function warrantyNote(
  expiresOn: string | null,
  daysRemaining: number | null,
): { text: string; critical: boolean } {
  if (!expiresOn || daysRemaining === null) {
    return { text: "No warranty recorded", critical: false };
  }
  if (daysRemaining < 0) {
    return { text: `Warranty expired ${readableDay(expiresOn)}`, critical: true };
  }
  if (daysRemaining <= 60) {
    return {
      text: `Warranty ends ${readableDay(expiresOn)} — ${daysRemaining} days`,
      critical: true,
    };
  }
  return { text: `Under warranty until ${readableDay(expiresOn)}`, critical: false };
}
