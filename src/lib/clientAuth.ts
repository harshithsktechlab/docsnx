import { PLAN_EXEMPT_MODULES } from './planGate';
import { moduleAxisLapsed } from './moduleAxis';

/**
 * Sign in with an email address OR a registered mobile number.
 *
 * Sends `identifier` and NOTHING ELSE. It used to send the same string as both
 * `identifier` and `email`, and the route's zod schema had `.email()` on that
 * second field — so a mobile number failed validation and came back as
 * "400 Invalid input" before the lookup ran. Phone sign-in was unreachable from
 * this function no matter what the server matched on. The schema is permissive
 * now too, but there is no reason to keep posting a number under a field called
 * `email`.
 */
export async function clientLogin(identifier: string, password: string): Promise<any> {
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.requireVerification) {
        return {
          success: false,
          requireVerification: true,
          // True when the code could NOT be sent — a member whose WhatsApp
          // gateway rejected the message. Carried through so the caller can
          // show the error instead of sending them to a verification screen to
          // wait for something that never left.
          verificationUndeliverable: !!data.verificationUndeliverable,
          email: data.email,
          // Masked destinations, so the verify screen can name where the code
          // went without the caller having to know the account's details.
          emailHint: data.emailHint,
          phoneHint: data.phoneHint,
          error: data.error,
        };
      }
      if (data.accountErased) {
        // 410: the account existed and was erased. The page shows the date
        // and a way to start over instead of a "check your password" toast.
        return {
          success: false,
          accountErased: true,
          erasedAt: data.erasedAt,
          role: data.role,
          error: data.error,
        };
      }
      return { success: false, error: data.error || 'Login failed', reference: data.reference };
    }
    return data;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
  phoneNumber?: string | null;
  consentDataProcessing?: boolean;
  /** 'personal' | 'business' | 'both'. Omitted means personal. */
  accountType?: string;
  /**
   * Not asked at signup any more — the onboarding wizard names the workspace.
   * Still accepted and still honoured by the route; omitted, it derives one
   * from the admin's name (src/lib/workspaceName.ts).
   */
  tenantName?: string | null;
  /**
   * Not asked at signup either — the wizard's Companies step collects it. Still
   * honoured when sent, which is what an older cached bundle does.
   */
  companyName?: string | null;
}

/**
 * Takes an object rather than ten positional arguments.
 *
 * It was already eight, and `(tenantName, name, email, password, phoneNumber,
 * planCode, consentData, consentAi)` is four strings in a row where a
 * transposition compiles cleanly and registers the wrong thing. The form asks
 * for fewer of them now, but the argument that shape was a hazard has not
 * changed.
 */
export async function clientRegister(input: RegisterInput): Promise<any> {
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        consentDataProcessing: true,
        ...input,
      }),
    });
    const data = await res.json();
    // ── A REFUSAL IS STILL AN ANSWER ────────────────────────────────────────
    // This used to `throw new Error(data.error)`, which reduced every refusal
    // to its sentence and dropped the rest of the body on the floor. That was
    // fine while the only refusal was a dead end; it is not now that the route
    // distinguishes "you already have an account, sign in" (`accountExists`)
    // from "your last sign-up never finished verifying" (`requiresVerification`,
    // with the identifier to continue on). The page needs those flags to have
    // anywhere to send the person.
    //
    // `error` is still populated on every non-2xx, so the existing
    // `toast.error(res.error || …)` fallback reads exactly as it did.
    if (!res.ok) return { ...data, success: false, error: data.error || 'Registration failed' };
    return data;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Submit the first-login code. `identifier` is an email address or a mobile
 * number — whichever the person signed in with, so someone who used their
 * number is not asked for an address to finish.
 */
export async function clientVerifyOtp(
  identifier: string,
  /**
   * One code per outstanding channel. A member (and any older client) sends a
   * bare `otp`; a tenant admin sends `emailOtp` and `phoneOtp`, which are two
   * DIFFERENT codes and both required. Built by `verifyPayload` in
   * src/lib/otpForm.ts.
   */
  codes: { otp?: string; emailOtp?: string; phoneOtp?: string },
): Promise<any> {
  try {
    const res = await fetch('/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, ...codes }),
    });
    const data = await res.json();
    if (!res.ok) {
      // An already-verified account is not a failure worth throwing over — the
      // screen sends them to sign in instead.
      if (data.alreadyVerified) {
        return { success: false, alreadyVerified: true, error: data.error };
      }
      // A rejection carries what is STILL outstanding, which is not the same as
      // what was outstanding before: a correct half is banked by the route. The
      // screen folds these forward, so they must survive the failure path
      // rather than being flattened into a message.
      return {
        success: false,
        error: data.error || 'Verification failed',
        needsEmailCode: data.needsEmailCode,
        needsPhoneCode: data.needsPhoneCode,
      };
    }
    return data;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Ask for a fresh code on both channels.
 *
 * The route answers identically for a known and an unknown identifier — it takes
 * no password, so a distinguishable "not found" would let anyone test whether a
 * number is registered. Don't add branching here that reintroduces the tell.
 */
export async function clientResendOtp(identifier: string): Promise<any> {
  try {
    const res = await fetch('/api/auth/resend-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Resend failed');
    return data;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function clientLogout(): Promise<any> {
  try {
    const res = await fetch('/api/auth/logout', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Logout failed');
    return data;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function clientGetMe(): Promise<any> {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unauthorized');
    return data;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   clientCan — the browser's copy of hasPermission, and only a copy       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Decides whether to RENDER a control. It decides nothing else. Every route
 * asks `hasPermission` again server-side, so hiding a button here is courtesy —
 * a member who forges the request still gets a 403 from `withCategory`.
 *
 * The precedence has to match src/lib/auth.ts exactly, because the failure mode
 * of a mismatch is silent and asymmetric: too permissive and the UI offers an
 * action that then errors; too strict and a member is quietly locked out of
 * something they were granted, with nothing to click and nothing to report.
 *
 *   1. SUPER_ADMIN → false. It is a platform role; tenant records are not its.
 *      (auth.ts returns true only for the three platform modules, none of which
 *      is a taxonomy module, so this is that same answer.)
 *   2. TENANT_ADMIN → true, short-circuit.
 *   3. the (module, documentKey) row if there is one — a sub-category override
 *      WINS over the module default, which is the whole point of 0024.
 *   4. otherwise the (module, null) row.
 *   5. no row at all → false. Deny by default.
 */
export function clientCan(
  user: any,
  moduleKey: string,
  documentKey: string | null,
  action: 'view' | 'add' | 'edit' | 'delete' | 'share' = 'view',
): boolean {
  if (!user) return false;
  // Mirrors the expired-plan carve-out in hasPermission — see PLAN_EXEMPT_MODULES
  // — INCLUDING which axis answers for which module, which is why both call the
  // SAME function rather than each spelling the rule out. tests/planGate.test.ts
  // asserts the two agree, per axis and per module.
  if (moduleAxisLapsed(user, moduleKey) && !PLAN_EXEMPT_MODULES.has(moduleKey)) return false;
  if (user.role === 'SUPER_ADMIN') return false;
  if (user.role === 'TENANT_ADMIN') return true;
  if (!Array.isArray(user.permissions)) return false;

  const perm = (documentKey
      ? user.permissions.find((p: any) => p.module === moduleKey && p.documentKey === documentKey)
      : undefined)
    ?? user.permissions.find((p: any) => p.module === moduleKey && !p.documentKey);
  if (!perm) return false;

  if (action === 'view') return !!perm.canView;
  if (action === 'add') return !!perm.canAdd;
  if (action === 'edit') return !!perm.canEdit;
  if (action === 'delete') return !!perm.canDelete;
  if (action === 'share') return !!perm.canShare;
  return false;
}
