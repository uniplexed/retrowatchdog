/**
 * 23505 = unique_violation. drizzle-orm wraps the `pg.DatabaseError` in
 * `DrizzleQueryError.cause`, so both the bare and the wrapped shape are checked.
 * Any route pre-check is a courtesy; only the database decides the race.
 */
export function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  const causeCode = (error as { cause?: { code?: string } }).cause?.code;
  return code === "23505" || causeCode === "23505";
}
