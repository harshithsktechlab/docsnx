/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT TO DO WITH A POST /api/auth/register ANSWER                       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Five meaningfully different shapes come back from that route, and the one
 * that matters most here is the one that must NOT navigate:
 *
 *   verify   signed up, codes are out. → /verify-email
 *   billing  signed up, nothing to verify. → /billing, which is the only place
 *            a tenant with no plan can reach anyway (see Shell.js).
 *   pending  a sign-up already waiting on its codes, and not one this
 *            registration may retire. → /verify-email, where Resend lives.
 *   exists   the address (or the number) belongs to a FINISHED account.
 *            STAYS ON THE FORM. See below.
 *   failed   anything else — no default plan, the 23505 race, a dead network.
 *            Stays on the form, which it always did.
 *
 * ── WHY `exists` HAS NO DESTINATION ────────────────────────────────────────
 * It used to: the register page pushed to /login the moment the route answered
 * `accountExists`. That was an overcorrection on an earlier bug (the refusal
 * had been a dead-end toast with nowhere to go) and it cost more than it
 * bought — the name, the number, the password, the account type and the
 * consent tick were all discarded on the way out, so someone who simply
 * mistyped their address, or owns two and picked the wrong one, had no route
 * back to the form they had just filled in. The route's own `fieldErrors`,
 * which name the exact input at fault, were never rendered at all.
 *
 * So the refusal is now answered where it happened: the field is marked, and
 * `signInHref` is the escape hatch, carrying the typed address so /login opens
 * with it already in the box. The ONLY outcome without an `href` — which is
 * what the switch in the page keys off, and what the test pins down.
 *
 * Pure: no fetch, no React, no router. The register page carries JSX in a .js
 * file and cannot be imported by Vitest, so the decision lives here instead.
 */
import type { Flash } from '@/lib/flashToast';

/** What `setFlash` takes: a `Flash` minus the timestamp it stamps itself. */
export type FlashInput = Omit<Flash, 'at'>;

/** `field id → message`, keyed by element id on the register form. */
export type FieldErrors = Record<string, string>;

export type RegisterOutcome =
  | { kind: 'verify'; flash: FlashInput; href: string }
  | { kind: 'billing'; flash: FlashInput; href: string }
  | { kind: 'pending'; flash: FlashInput; href: string }
  | { kind: 'exists'; message: string; fieldErrors: FieldErrors; signInHref: string }
  | { kind: 'failed'; message: string; fieldErrors?: FieldErrors };

/** The response body, as far as this decision is concerned. */
export interface RegisterResponse {
  success?: boolean;
  error?: string;
  message?: string;
  fieldErrors?: FieldErrors;
  requireVerification?: boolean;
  requiresVerification?: boolean;
  accountExists?: boolean;
  identifier?: string;
  emailHint?: string;
  phoneHint?: string;
  needsEmailCode?: boolean;
  needsPhoneCode?: boolean;
}

/**
 * The /verify-email query, built in ONE place because two outcomes reach that
 * screen — a successful signup and a pending one — and a second hand-rolled
 * copy would be the one that forgets `needsPhoneCode` and renders a single box
 * for an account that owes two codes.
 *
 * The masked hints let the verify screen name BOTH destinations rather than
 * only the address; without them a new tenant admin is told to watch an inbox
 * and never learns a copy is sitting in WhatsApp.
 */
export function verifyUrl(res: RegisterResponse, typedEmail: string): string {
  const query = new URLSearchParams({
    identifier: res.identifier || typedEmail.trim(),
  });
  if (res.emailHint) query.set('emailHint', res.emailHint);
  if (res.phoneHint) query.set('phoneHint', res.phoneHint);
  // See the login page: two channels means two boxes.
  if (res.needsEmailCode) query.set('needsEmailCode', 'true');
  if (res.needsPhoneCode) query.set('needsPhoneCode', 'true');
  return `/verify-email?${query.toString()}`;
}

/** /login with the address already typed in, so the hop costs nothing. */
export function signInUrl(typedEmail: string): string {
  const identifier = typedEmail.trim();
  if (!identifier) return '/login';
  return `/login?${new URLSearchParams({ identifier }).toString()}`;
}

export function resolveRegisterOutcome(
  res: RegisterResponse | null | undefined,
  typedEmail: string,
): RegisterOutcome {
  const body = res || {};

  if (body.success) {
    if (body.requireVerification) {
      return {
        kind: 'verify',
        // The route's own sentence, which names the channels that ACTUALLY
        // accepted the send. The fallback no longer promises email: claiming a
        // channel the server did not confirm is how a month of dead SMTP
        // stayed invisible to everyone who signed up.
        flash: {
          message: body.message || 'Registration successful! Check your messages for the verification code.',
          type: 'success',
          pin: '/verify-email',
          tag: 'register-sent',
        },
        href: verifyUrl(body, typedEmail),
      };
    }
    // No plan is chosen here, and none is granted: a new account arrives with
    // nothing and picks a plan at /billing, which is the only place it can
    // reach until it has one.
    return {
      kind: 'billing',
      flash: {
        message: 'Registration successful — choose a plan to activate your workspace.',
        type: 'success',
        pin: '/billing',
        tag: 'register-done',
      },
      href: '/billing?welcome=1',
    };
  }

  // A sign-up already waiting on its codes. No code was sent by /register —
  // deliberately, it cannot prove the caller owns that account — so the verify
  // screen's Resend button is what actually issues one. That button is the
  // whole reason this outcome still navigates while `exists` does not.
  if (body.requiresVerification) {
    return {
      kind: 'pending',
      flash: {
        message: body.error || 'This account is waiting to be verified.',
        type: 'info',
        pin: '/verify-email',
        tag: 'register-pending',
      },
      href: verifyUrl(body, typedEmail),
    };
  }

  if (body.accountExists) {
    const message = body.error || 'You already have an account. Please sign in.';
    return {
      kind: 'exists',
      message,
      // Straight from the route, which marks the field the caller actually
      // typed into — the address OR the number, never both, since echoing the
      // row's other contact would turn a refusal into a lookup of somebody
      // else's details. The fallback covers an older build that sent none.
      fieldErrors: body.fieldErrors || { email: message },
      signInHref: signInUrl(typedEmail),
    };
  }

  // Everything the route can attribute to a field still arrives with
  // `fieldErrors` — including the 23505 race, which cannot say WHAT the
  // winning row is and so deliberately omits `accountExists`. Anything it
  // cannot attribute (no default plan configured) has only the sentence.
  return {
    kind: 'failed',
    message: body.error || 'Registration failed',
    fieldErrors: body.fieldErrors,
  };
}
