/**
 * What a TENANT_ADMIN must type to confirm erasing a workspace (or half of one).
 *
 * The admin's own MOBILE NUMBER, not the workspace name: the name is long,
 * carries a curly apostrophe and fights phone autocorrect, while the number is
 * short, numeric and something only the admin knows.
 *
 * Numbers are compared as dial strings (`toDialString`), so '+91 98765 43210',
 * '+919876543210' and '9876543210' are the same answer.
 *
 * An admin with no usable number (the column is nullable) falls back to the
 * workspace name, so the guard is never skipped and deletion is never blocked.
 *
 * Pure and import-free beyond phone.ts: the settings page uses it in the
 * browser and the erase routes use it on the server, so both sides agree.
 * Company erasure is NOT covered — it confirms on the company's own name.
 */
import { toDialString } from '@/lib/phone';

export interface ErasureConfirmSubject {
  phoneNumber?: string | null;
  phoneDial?: string | null;
  // Lets `AuthUser` and the settings page's untyped `meUser` pass: without an
  // index signature TS treats this all-optional type as "weak" and rejects them.
  [key: string]: unknown;
}

/** The admin's dial string, from the persisted key or else the display value. */
export function adminDial(user: ErasureConfirmSubject | null | undefined): string | null {
  return user?.phoneDial || toDialString(user?.phoneNumber) || null;
}

/** Which string the admin has to type, and what to show them as the prompt. */
export function erasureConfirmSpec(
  user: ErasureConfirmSubject | null | undefined,
  workspaceName: string,
): { by: 'phone' | 'name'; display: string } {
  if (adminDial(user)) {
    return { by: 'phone', display: user?.phoneNumber?.trim() || `+${adminDial(user)}` };
  }
  return { by: 'name', display: workspaceName };
}

/** Does what was typed confirm the erasure? */
export function erasureConfirmMatches(
  typed: string,
  user: ErasureConfirmSubject | null | undefined,
  workspaceName: string,
): boolean {
  const dial = adminDial(user);
  if (dial) return toDialString(typed) === dial;
  return !!workspaceName.trim() && typed.trim() === workspaceName.trim();
}
