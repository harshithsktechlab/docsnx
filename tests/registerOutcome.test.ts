/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A TAKEN EMAIL ADDRESS DOES NOT LEAVE THE REGISTER FORM                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Signing up with an address that already had an account used to push the
 * person to /login, which discarded the name, the number, the password, the
 * account type and the consent tick they had just filled in — a brutal answer
 * to a mistyped address, and the reason `exists` is now the one outcome with
 * no destination at all.
 *
 * `href` is the property the page switches on, so "no `href`" is the assertion
 * that actually keeps the form on screen. The other cases are here because the
 * three branches that DO navigate share this function now, and a regression in
 * the /verify-email query is how a two-code account gets one code box.
 */
import { describe, it, expect } from 'vitest';
import { resolveRegisterOutcome, verifyUrl, signInUrl } from '@/lib/registerOutcome';

const TYPED_EMAIL = 'amit@sharma.com';

describe('resolveRegisterOutcome — a finished account', () => {
  const taken = {
    success: false,
    error: 'Email already registered',
    fieldErrors: { email: 'Email already registered' },
    accountExists: true,
  };

  it('stays on the form: no destination of any kind', () => {
    const outcome = resolveRegisterOutcome(taken, TYPED_EMAIL);
    expect(outcome.kind).toBe('exists');
    expect(outcome).not.toHaveProperty('href');
    expect(outcome).not.toHaveProperty('flash');
  });

  it("marks the email field with the route's own sentence", () => {
    const outcome = resolveRegisterOutcome(taken, TYPED_EMAIL);
    if (outcome.kind !== 'exists') throw new Error('expected exists');
    expect(outcome.fieldErrors.email).toBe('Email already registered');
    expect(outcome.message).toBe('Email already registered');
  });

  it('offers a sign-in link carrying the typed address', () => {
    const outcome = resolveRegisterOutcome(taken, '  Amit@Sharma.com  ');
    if (outcome.kind !== 'exists') throw new Error('expected exists');
    const url = new URL(outcome.signInHref, 'https://example.test');
    expect(url.pathname).toBe('/login');
    expect(url.searchParams.get('identifier')).toBe('Amit@Sharma.com');
  });

  it('marks the NUMBER when the number is what collided', () => {
    // The route only ever echoes the contact the caller typed — never the
    // row's other one, which would turn a refusal into a lookup of somebody
    // else's details. See src/app/api/auth/register/route.ts.
    const outcome = resolveRegisterOutcome({
      success: false,
      error: 'Mobile number already registered',
      fieldErrors: { phoneNumber: 'Mobile number already registered' },
      accountExists: true,
    }, TYPED_EMAIL);
    if (outcome.kind !== 'exists') throw new Error('expected exists');
    expect(outcome.fieldErrors.phoneNumber).toBe('Mobile number already registered');
    expect(outcome.fieldErrors.email).toBeUndefined();
  });

  it('falls back to marking the email when an older build sends no fieldErrors', () => {
    const outcome = resolveRegisterOutcome({
      success: false,
      error: 'Email already registered',
      accountExists: true,
    }, TYPED_EMAIL);
    if (outcome.kind !== 'exists') throw new Error('expected exists');
    expect(outcome.fieldErrors.email).toBe('Email already registered');
  });
});

describe('resolveRegisterOutcome — the branches that still navigate', () => {
  it('sends a sign-up still waiting on its codes to /verify-email', () => {
    // It keeps its redirect on purpose: nothing is left to do on the register
    // form, and /verify-email is the only screen with a Resend button —
    // /register deliberately issues no code for a row it cannot prove the
    // caller owns.
    const outcome = resolveRegisterOutcome({
      success: false,
      error: 'This email address already has a sign-up waiting to be verified.',
      requiresVerification: true,
      identifier: TYPED_EMAIL,
    }, TYPED_EMAIL);
    expect(outcome.kind).toBe('pending');
    if (outcome.kind !== 'pending') return;
    expect(outcome.href).toContain('/verify-email?');
    expect(outcome.flash.pin).toBe('/verify-email');
    expect(outcome.flash.type).toBe('info');
  });

  it('sends a fresh signup to /verify-email with both code boxes asked for', () => {
    const outcome = resolveRegisterOutcome({
      success: true,
      requireVerification: true,
      message: 'Registration successful! We sent a separate verification code to your email and WhatsApp.',
      identifier: TYPED_EMAIL,
      emailHint: 'a***@s*****.com',
      phoneHint: '+91 ****** 4321',
      needsEmailCode: true,
      needsPhoneCode: true,
    }, TYPED_EMAIL);
    expect(outcome.kind).toBe('verify');
    if (outcome.kind !== 'verify') return;
    const url = new URL(outcome.href, 'https://example.test');
    expect(url.searchParams.get('identifier')).toBe(TYPED_EMAIL);
    expect(url.searchParams.get('emailHint')).toBe('a***@s*****.com');
    expect(url.searchParams.get('phoneHint')).toBe('+91 ****** 4321');
    // Two channels means two boxes; dropping either is how a two-code account
    // gets a form that posts one.
    expect(url.searchParams.get('needsEmailCode')).toBe('true');
    expect(url.searchParams.get('needsPhoneCode')).toBe('true');
    expect(outcome.flash.message).toContain('Registration successful');
  });

  it('sends a signup with nothing to verify to /billing', () => {
    const outcome = resolveRegisterOutcome({ success: true }, TYPED_EMAIL);
    expect(outcome.kind).toBe('billing');
    if (outcome.kind !== 'billing') return;
    expect(outcome.href).toBe('/billing?welcome=1');
    expect(outcome.flash.pin).toBe('/billing');
  });
});

describe('resolveRegisterOutcome — plain failures', () => {
  it('treats the 23505 race as a failure, not as a known account', () => {
    // The INSERT lost a race with a second registration. What the winning row
    // actually is was never established, so the route omits `accountExists`
    // rather than guess — and this must NOT offer to sign in to an account
    // that may itself be unverified.
    const outcome = resolveRegisterOutcome({
      success: false,
      error: 'Email already registered',
      fieldErrors: { email: 'Email already registered' },
    }, TYPED_EMAIL);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.fieldErrors?.email).toBe('Email already registered');
    expect(outcome).not.toHaveProperty('signInHref');
  });

  it('carries a sentence with no field through untouched', () => {
    const outcome = resolveRegisterOutcome({
      success: false,
      error: 'No default plan is configured for this account type.',
    }, TYPED_EMAIL);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.message).toBe('No default plan is configured for this account type.');
    expect(outcome.fieldErrors).toBeUndefined();
  });

  it('survives a body that says nothing at all', () => {
    expect(resolveRegisterOutcome(undefined, TYPED_EMAIL)).toEqual({
      kind: 'failed',
      message: 'Registration failed',
      fieldErrors: undefined,
    });
  });
});

describe('url builders', () => {
  it('falls back to the typed address when the route names no identifier', () => {
    const url = new URL(verifyUrl({}, '  amit@sharma.com '), 'https://example.test');
    expect(url.searchParams.get('identifier')).toBe(TYPED_EMAIL);
  });

  it('leaves the hints off rather than sending empty ones', () => {
    expect(verifyUrl({ identifier: TYPED_EMAIL }, TYPED_EMAIL))
      .toBe(`/verify-email?identifier=${encodeURIComponent(TYPED_EMAIL)}`);
  });

  it('gives a bare /login when there is no address to carry', () => {
    expect(signInUrl('   ')).toBe('/login');
  });
});
