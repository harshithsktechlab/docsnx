/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POSTGRES CONSTRAINT VIOLATIONS, READ AS USER-FACING FACTS              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `users_phone_dial_uq` (drizzle/0039) means a second account cannot take a
 * mobile number a live account already holds. That is a rule someone can
 * plausibly hit by hand — two family members, one handset — and an uncaught
 * 23505 surfaces as "Internal Server Error", which reads as the platform being
 * broken rather than the form being wrong.
 *
 * Matched on the constraint NAME, not on the message text: a message match
 * would also catch an unrelated unique index that happened to mention a column
 * with a similar name, and would answer "that mobile number is taken" for it.
 */

/** The three shapes a pg error arrives in across drizzle/postgres-js versions. */
function pgCode(error: unknown): string | null {
  const err = error as any;
  return err?.code ?? err?.cause?.code ?? err?.originalError?.code ?? null;
}

function pgConstraint(error: unknown): string | null {
  const err = error as any;
  return err?.constraint_name ?? err?.constraint ?? err?.cause?.constraint_name ?? err?.cause?.constraint ?? null;
}

/** 23505 is `unique_violation`. */
export function isUniqueViolation(error: unknown): boolean {
  return pgCode(error) === '23505';
}

/** Specifically: this mobile number already belongs to another live account. */
export function isDuplicatePhone(error: unknown): boolean {
  return isUniqueViolation(error) && pgConstraint(error) === 'users_phone_dial_uq';
}

/**
 * Specifically: this email address already belongs to another live account.
 *
 * Matched on `users_email_uq`, the PARTIAL index 0040 put in place of the
 * baseline `users_email_unique` constraint. Routes that check for a duplicate
 * address before inserting still should — this is the race, not the check.
 */
export function isDuplicateEmail(error: unknown): boolean {
  return isUniqueViolation(error) && pgConstraint(error) === 'users_email_uq';
}

/** The one sentence every route uses for it, so they cannot word it three ways. */
export const DUPLICATE_PHONE_MESSAGE =
  'This mobile number is already registered to another account.';

/** Its email counterpart. Same reasoning: one wording, one place. */
export const DUPLICATE_EMAIL_MESSAGE =
  'This email address is already registered to another account.';
