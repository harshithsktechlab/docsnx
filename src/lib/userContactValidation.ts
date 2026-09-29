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
import { toDialString } from './phone';

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

  // Mobile Number compulsory for all roles, and it must be one the platform
  // can actually normalise into an identity — see the header.
  if (!cleanPhone) {
    errors.phoneNumber = 'Mobile Number is compulsory.';
  } else if (!toDialString(cleanPhone)) {
    errors.phoneNumber = 'Please provide a valid mobile number, including the country code.';
  }

  // Email compulsory for Tenant Admins
  if (role === 'TENANT_ADMIN' || role === 'SUPER_ADMIN') {
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
