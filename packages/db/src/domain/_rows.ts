/**
 * Coercions for rows that come back from `tx.execute`.
 *
 * ── THE TRAP THIS EXISTS FOR ───────────────────────────────────────────────
 *
 * Drizzle's query builder knows each column's type and hands back a real
 * `Date` for a `timestamptz`. `tx.execute` does not: it returns whatever the
 * driver produced, and for postgres-js that is a **string**.
 *
 *     const rows = await tx.execute<{ created_at: Date }>(sql`select now() ...`);
 *     rows[0].created_at.getTime();   // TypeError at runtime
 *
 * The type parameter on `execute` is an assertion, not a check, so the compiler
 * believes the annotation and says nothing. Every raw query in this package that
 * reads a timestamp has to convert, and the failure mode when it does not is a
 * `TypeError` in a code path — an overdue invoice, a scheduled visit — that a
 * test with tidy fixtures can easily miss.
 *
 * So: raw queries declare their row types with `string` for timestamps, which is
 * the truth, and pass them through these on the way out.
 */

/** A timestamp from a raw query. Null stays null; anything unparseable throws. */
export function rowDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    // Loud rather than silently null. A null here would be read as "no due
    // date" and an invoice would quietly stop being overdue.
    throw new Error(`Not a date: ${String(value)}`);
  }
  return date;
}

/**
 * The same, where the column is `NOT NULL` and a null would be a bug rather
 * than a state.
 */
export function requiredRowDate(value: string | Date | null | undefined): Date {
  const date = rowDate(value);
  if (!date) throw new Error("Expected a timestamp and got null");
  return date;
}
