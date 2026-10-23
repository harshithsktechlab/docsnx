/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHICH CONTACTS AN ACCOUNT MUST HAVE, BY ROLE                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * - Tenant Admins / Super Admins: BOTH email and mobile number are compulsory.
 *   Their address is the channel of record for billing, plan notices, password
 *   resets and their own verification code.
 * - Members (STANDARD): the MOBILE NUMBER is compulsory; email is OPTIONAL and
 *   is never verified. The number is their login identity (`users.phone_dial`,
 *   0039) and the only channel their first-login code goes out on (0040).
 *
 * ── EVERY WRITE PATH MUST CALL THIS ────────────────────────────────────────
 * POST /api/users, PUT /api/users/[id] and POST /api/onboarding/users. The
 * second and third did not, which is how an admin could blank a member's mobile
 * — silently revoking their sign-in — and how the onboarding wizard created
 * members with no number at all.
 *
 * The mobile check deliberately mirrors `toDialString` (src/lib/phone.ts)
 * rather than counting characters: that function is what decides whether a
 * number can actually be dialled and stored as an identity, so accepting
 * anything it would reject means writing a row whose `phone_dial` is null —
 * an account that cannot log in, created by a form that said it was fine.
 */
import { toDialString, isBlankPhone } from './phone';

export interface ContactValidationInput {
  role: 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'STANDARD';
  email?: string | null;
  phoneNumber?: string | null;
}

export interface ContactValidationResult {
  isValid: boolean;
  errors: {
    email?: string;
    phoneNumber?: string;
  };
}

export function validateUserContacts({
  role,
  email,
  phoneNumber,
}: ContactValidationInput): ContactValidationResult {
  const errors: { email?: string; phoneNumber?: string } = {};

  const cleanPhone = (phoneNumber || '').trim();
  const cleanEmail = (email || '').trim();

  const isAdmin = role === 'TENANT_ADMIN' || role === 'SUPER_ADMIN';

  // Compulsory for admins. Optional for a member: they are added as a record
  // only, and a contact is only needed when the admin gives them access (see
  // POST /api/users/[id]/sign-in). A number that IS given must be one the
  // platform can normalise into an identity — see the header.
  if (isBlankPhone(cleanPhone)) {
    if (isAdmin) errors.phoneNumber = 'Mobile Number is compulsory.';
  } else if (!toDialString(cleanPhone)) {
    errors.phoneNumber = 'Please provide a valid mobile number, including the country code.';
  }

  // Email compulsory for Tenant Admins
  if (isAdmin) {
    if (!cleanEmail || !cleanEmail.includes('@')) {
      errors.email = 'Email Address is compulsory for Tenant Admins.';
    }
  } else {
    // Optional for members — an absent address is a valid, supported state, not
    // a field someone forgot. If one IS given it still has to look like one, so
    // a typo does not silently become the account's address.
    if (cleanEmail && !cleanEmail.includes('@')) {
      errors.email = 'Please provide a valid email address.';
    }
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
  };
}

/**
 * The first reason an edit to someone's contacts must be refused, or null.
 *
 * Both writers of an existing account's contacts — an admin editing a member
 * (PUT /api/users/[id]) and a person editing themselves (PATCH
 * /api/account/profile) — have to apply the SAME two rules to the MERGED result
 * (current values overlaid with whatever the request sent), so they share this:
 *
 *   1. the contacts left behind must satisfy `validateUserContacts` for the role;
 *   2. a member who can sign in must keep a mobile number or an email, since
 *      either is their login — clearing both locks them out silently.
 */
export function contactEditProblem(input: {
  role: ContactValidationInput['role'];
  email?: string | null;
  phoneNumber?: string | null;
  /** `users.signInDisabledAt` is set — nothing to lock out. */
  signInDisabled?: boolean;
}): string | null {
  const check = validateUserContacts(input);
  if (!check.isValid) {
    return check.errors.phoneNumber || check.errors.email || 'Invalid contact details';
  }
  if (input.role === 'STANDARD' && !input.signInDisabled && isBlankPhone(input.phoneNumber) && !input.email) {
    return 'A member who can sign in needs a mobile number or an email to sign in with.';
  }
  return null;
}
