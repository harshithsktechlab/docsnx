/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   PHONE NUMBERS, NORMALISED — the one spelling everything compares on    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A stored `users.phone_number` is a DISPLAY value: '+91 98765 43210' and
 * '+919876543210' and '9876543210' are the same handset typed three ways, and
 * an `eq()` against any one of them misses the other two. That was fine while
 * the only consumer was the WhatsApp bridge, which normalised on the way out.
 * It stopped being fine when the number became a LOGIN IDENTIFIER: someone who
 * registered through PhoneInput and then typed their bare ten digits into the
 * sign-in box got "Invalid credentials" for a number the platform holds.
 *
 * So `toDialString` moved here, out of src/lib/whatsapp.ts, and its output is
 * now persisted as `users.phone_dial` and carries a unique index. Two things
 * follow from that, and both are the reason this file is separate:
 *
 *   1. It has NO imports. The auth routes need normalisation; importing
 *      whatsapp.ts would drag `db` and `encryption` in behind it for a pure
 *      string function, and pull a database into unit tests that want none.
 *   2. Its answer is now an identity, not a formatting nicety. Changing what
 *      this function returns for an input that already has a row rewrites who
 *      that row belongs to — a backfill, not a bug fix. See the DEFAULT_COUNTRY
 *      note below for the one place that judgement is baked in.
 *
 * whatsapp.ts re-exports `toDialString` so its own callers and tests never had
 * to learn that it moved.
 */

/**
 * The default country code for a bare national number.
 *
 * Numbers are stored as `+91XXXXXXXXXX` by src/components/ui/PhoneInput.jsx, so
 * this is a safety net for rows written before that component existed or by a
 * script — not the normal path.
 *
 * NOW ALSO AN IDENTITY DECISION: a bare '9876543210' at the login box resolves
 * to '919876543210' and signs in whoever holds that row. Changing this constant
 * would silently re-point every bare-national number at a different account.
 */
const DEFAULT_COUNTRY_CODE = '91';

/** Length of a bare Indian mobile number, the only national format we assume. */
const NATIONAL_DIGITS = 10;

/**
 * Shortest country code + subscriber number worth dialling.
 *
 * Ten, because that is what the SHORTEST country PhoneInput offers comes to:
 * '+65' plus Singapore's eight digits. Anything under it is a half-typed field,
 * not a number someone can be reached on.
 */
const MIN_INTERNATIONAL_DIGITS = 10;

/**
 * A stored phone number as the engine wants it: digits only, country code
 * included, no `+`.
 *
 * Returns `null` for anything too short to be a real number, which is how a
 * junk or placeholder value stops before it reaches the engine — and, since
 * 0039, how it stops before it becomes a login identity or takes the unique
 * index hostage.
 */
export function toDialString(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, '');

  // A LEADING '+' MEANS THE COUNTRY CODE IS ALREADY THERE, whatever the length.
  // Counting digits alone is not enough: PhoneInput offers ten countries, and
  // '+65' plus a Singapore number is exactly ten digits — the same length as a
  // bare Indian mobile. Prefixing that would dial 91 65… and reach nobody.
  if (trimmed.startsWith('+')) {
    return digits.length >= MIN_INTERNATIONAL_DIGITS ? digits : null;
  }

  // No '+': a bare national number, which we can only read as the default
  // country's. Anything shorter is a fragment, not a number.
  if (digits.length === NATIONAL_DIGITS) return DEFAULT_COUNTRY_CODE + digits;
  if (digits.length < NATIONAL_DIGITS) return null;
  return digits;
}

/**
 * Which column a sign-in identifier is aimed at.
 *
 * Deliberately just an '@' test rather than an email regex. This does not decide
 * whether an address is DELIVERABLE — `users.email` already holds whatever was
 * accepted at registration — it only decides which of two exact-match lookups to
 * run. A regex here would be stricter than the column it queries, which is the
 * wrong direction: it would refuse to look up addresses that exist.
 *
 * Anything without an '@' is treated as a phone number and handed to
 * `toDialString`, which returns null for the junk cases.
 */
export function isEmailIdentifier(value: string | null | undefined): boolean {
  return !!value && value.includes('@');
}
