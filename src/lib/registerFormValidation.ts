/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT /register CHECKS BEFORE IT POSTS — and it is not a second opinion ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The register form used to answer every mistake with one of three blanket
 * toasts — "Please fill in all required fields and select a plan" — and left the
 * page exactly as it was: nothing outlined, nothing focused, and no way to tell
 * which input was the problem. Everything the server refused arrived the same
 * way, including zod's own machine wording.
 *
 * The form is shorter than it was — the workspace name moved to onboarding, the
 * company name to its own wizard step, and the plan to /billing — so what is
 * left is the five answers an account cannot be created without.
 *
 * This returns the shape the rest of the product already uses for that:
 * `fieldErrors`, keyed by the input's `id` (see src/lib/records/
 * fieldValidation.ts, which documents the contract, and POST
 * /api/auth/register, which now answers with the same map).
 *
 * ── THE MESSAGES ARE THE SERVER'S ──────────────────────────────────────────
 * Where the route has a sentence for a rule, that exact sentence is used here,
 * so a mistake caught in the browser and the same mistake caught by the API do
 * not read as two different problems. The contact rules are not re-implemented
 * at all: `validateUserContacts` IS the rule for who must have an email and a
 * number, the route calls it, and it imports only `./phone` (no imports of its
 * own), so it runs unchanged in the browser.
 *
 * ── THIS IS COURTESY. THE ROUTE IS THE AUTHORITY ───────────────────────────
 * Nothing here is a security control; /api/auth/register re-checks all of it —
 * every rule but the password confirmation, which is this form's alone (see
 * below). Its job is to stop someone being sent through a round-trip only to be
 * refused.
 */
import { validateUserContacts } from './userContactValidation';

export interface RegisterFormValues {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
  phoneNumber: string;
  accountType: string;
  consentData: boolean;
}

/** `field → message`, keyed by input id. Empty object means the form is valid. */
export type RegisterFieldErrors = Partial<Record<keyof RegisterFormValues, string>>;

/**
 * The order the person reads the form in, which is the order the first error is
 * chosen in. Not `Object.keys` — that is insertion order of whatever failed, so
 * an unticked consent box could be focused ahead of an empty name above it.
 */
export const REGISTER_FIELD_ORDER: readonly (keyof RegisterFormValues)[] = [
  'name', 'email', 'phoneNumber', 'password', 'confirmPassword',
  'accountType', 'consentData',
];

const ACCOUNT_TYPES = new Set(['personal', 'business', 'both']);

export function validateRegisterForm(values: RegisterFormValues): RegisterFieldErrors {
  const errors: RegisterFieldErrors = {};
  const trimmed = (v: string) => (v || '').trim();

  if (!ACCOUNT_TYPES.has(values.accountType)) {
    errors.accountType = 'Choose what you will use DocsNX for';
  }

  const name = trimmed(values.name);
  if (!name) errors.name = 'Full name is required.';
  else if (name.length < 2) errors.name = 'Name is too short';

  // ── EMAIL AND MOBILE: ASK THE ONE PLACE THAT KNOWS ─────────────────────────
  // A self-signup creates a TENANT_ADMIN, for whom both are compulsory and the
  // number must be one `toDialString` can actually normalise — the same call
  // the route makes, so the browser cannot accept a number the API will reject.
  //
  // Blank is handled here rather than deferred to it only for the wording: the
  // form calls this field "Email Address", and "compulsory for Tenant Admins"
  // is an answer to a question nobody signing up has asked.
  const email = trimmed(values.email);
  if (!email) errors.email = 'Email address is required.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Invalid email format';

  const contacts = validateUserContacts({
    role: 'TENANT_ADMIN',
    email,
    // PhoneInput seeds the field with the bare country code ('+91'), so an
    // untouched field is not empty — it is a dial string with no subscriber
    // number, which `toDialString` rejects. Passing it through is what turns
    // that into "please provide a valid mobile number" rather than silence.
    phoneNumber: values.phoneNumber,
  });
  if (contacts.errors.phoneNumber) errors.phoneNumber = contacts.errors.phoneNumber;
  if (!errors.email && contacts.errors.email) errors.email = contacts.errors.email;

  if (!values.password) errors.password = 'Security password is required.';
  else if (values.password.length < 8) errors.password = 'Password must be at least 8 characters';

  // ── THE ONE RULE THE SERVER CANNOT CHECK ──────────────────────────────────
  // The confirmation is never posted — only the password is — so unlike every
  // other message in this file, this one has no counterpart in the route. That
  // is the whole point of asking twice: a typo in a password nobody can read
  // back is otherwise discovered at the next sign-in, on an account whose OTP
  // has already been consumed.
  //
  // The sentence is the one /reset-password already uses, so the two places
  // that ask for a password twice do not read as two different products.
  if (!values.confirmPassword) errors.confirmPassword = 'Please confirm your password.';
  else if (values.password && values.password !== values.confirmPassword) {
    errors.confirmPassword = 'Passwords do not match';
  }

  if (!values.consentData) {
    errors.consentData = 'You must agree to the Privacy Policy and Terms of Service to register.';
  }

  return errors;
}

/** The first failing field in reading order, or undefined. */
export function firstInvalidField(
  errors: Record<string, string | undefined>,
): string | undefined {
  const inOrder = REGISTER_FIELD_ORDER.find((key) => errors[key]);
  // A key the server named that this form does not know about still gets
  // focused if it happens to match an input id — better than nothing at all.
  return inOrder ?? Object.keys(errors).find((key) => errors[key]);
}
