/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT /register REFUSES BEFORE IT POSTS                                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The register form answered every mistake with one of three blanket toasts and
 * marked nothing on screen. `validateRegisterForm` replaced them, and it lives
 * in its own module precisely so this file can exist — a `page.js` holding JSX
 * cannot be imported by Vitest.
 *
 * What is pinned here is the KEYING as much as the rules: each message must be
 * filed under the id of the input it belongs to, because that is what the page
 * outlines and scrolls to. A correct rule filed under the wrong key is an error
 * message the user cannot act on.
 *
 * The form is shorter than it was: the workspace name and the first company are
 * asked by the onboarding wizard, and the plan and discount code by /billing.
 * What remains is the five answers an account cannot be created without, plus
 * the one rule that exists only here — the password confirmation.
 */
import { describe, it, expect } from 'vitest';
import {
  validateRegisterForm, firstInvalidField, REGISTER_FIELD_ORDER,
} from '@/lib/registerFormValidation';

/** A signup that should pass cleanly, so each test can break one thing. */
const VALID = {
  name: 'Asha Menon',
  email: 'asha@example.test',
  password: 'hunter2hunter2',
  confirmPassword: 'hunter2hunter2',
  phoneNumber: '+919876543210',
  accountType: 'personal',
  consentData: true,
};

const check = (overrides: Partial<typeof VALID> = {}) =>
  validateRegisterForm({ ...VALID, ...overrides });

describe('a complete signup', () => {
  it('passes for a personal account', () => {
    expect(check()).toEqual({});
  });

  it('passes for a business account, which is no longer asked for a company', () => {
    // The company moved to the wizard's Companies step, where
    // /api/onboarding/complete refuses to finish without one. Demanding it here
    // would refuse every business signup on a field that is not on screen.
    expect(check({ accountType: 'business' })).toEqual({});
  });

  it('passes for the combo account, whose stored value is still `both`', () => {
    // The LABEL changed to "Combo (Personal + Business)". The value must not:
    // it is the tenant's `account_type`, read by the register route,
    // `getDefaultPlan`, `planStatus` and the onboarding step list.
    expect(check({ accountType: 'both' })).toEqual({});
  });

  it('refuses an account type that is not one of the three', () => {
    expect(check({ accountType: 'enterprise' }).accountType)
      .toBe('Choose what you will use DocsNX for');
  });
});

describe('each mistake lands on its own field', () => {
  it('uses the route’s own sentence for a name that is too short', () => {
    // Same wording the API answers with, so the same mistake caught on either
    // side does not read as two different problems.
    expect(check({ name: 'A' }).name).toBe('Name is too short');
  });

  it('flags a blank name', () => {
    expect(check({ name: '   ' }).name).toBe('Full name is required.');
  });

  it('flags a malformed email and a short password', () => {
    expect(check({ email: 'asha.example.test' }).email).toBe('Invalid email format');
    expect(check({ password: 'hunter2', confirmPassword: 'hunter2' }).password)
      .toBe('Password must be at least 8 characters');
  });

  it('flags a number PhoneInput has only seeded with a country code', () => {
    // The field is never literally empty — PhoneInput writes '+91' into it on
    // mount — so a "required" check on emptiness would pass an untouched field
    // straight through to a 400.
    const errors = check({ phoneNumber: '+91' });
    expect(errors.phoneNumber).toBeTruthy();
  });

  it('flags a number that cannot be dialled, not just a short one', () => {
    // The same judgement `toDialString` makes on the server, reached through
    // `validateUserContacts` — so the browser cannot accept a number the API
    // will reject.
    expect(check({ phoneNumber: '+91 12345' }).phoneNumber).toBeTruthy();
  });

  it('flags an unticked consent', () => {
    expect(check({ consentData: false }).consentData)
      .toBe('You must agree to the Privacy Policy and Terms of Service to register.');
  });
});

/**
 * ── THE ONE RULE THE SERVER CANNOT CHECK ──────────────────────────────────
 * The confirmation is never posted, so unlike every other message in this
 * module there is no counterpart in /api/auth/register. If it stops being
 * enforced here it stops being enforced anywhere, silently.
 */
describe('the password confirmation', () => {
  it('flags a mismatch, in the words /reset-password already uses', () => {
    expect(check({ confirmPassword: 'hunter2hunter3' }).confirmPassword)
      .toBe('Passwords do not match');
  });

  it('flags an empty confirmation', () => {
    expect(check({ confirmPassword: '' }).confirmPassword)
      .toBe('Please confirm your password.');
  });

  it('does not cry mismatch when the password itself is the problem', () => {
    // Both boxes empty is one mistake with one fix, not two. Reporting "they do
    // not match" over two blank fields sends the person looking for a typo.
    const errors = check({ password: '', confirmPassword: '' });
    expect(errors.password).toBe('Security password is required.');
    expect(errors.confirmPassword).toBe('Please confirm your password.');
  });

  it('accepts a confirmation that matches exactly', () => {
    expect(check({ password: 'correct horse battery', confirmPassword: 'correct horse battery' }))
      .toEqual({});
  });
});

describe('which field gets focused', () => {
  it('picks the first in reading order, not in failure order', () => {
    const errors = check({ name: '', password: 'short', consentData: false });
    expect(firstInvalidField(errors)).toBe('name');
  });

  it('falls back to a key the server named that this form does not order', () => {
    expect(firstInvalidField({ somethingElse: 'nope' })).toBe('somethingElse');
  });

  it('returns undefined for a clean form', () => {
    expect(firstInvalidField(check())).toBeUndefined();
  });

  it('orders every field the validator can produce', () => {
    // A field missing from the order list still shows its message but is never
    // the one scrolled to, which is exactly the silent half of the old bug.
    const everythingWrong = validateRegisterForm({
      name: '', email: '', password: '', confirmPassword: '',
      phoneNumber: '', accountType: '', consentData: false,
    });
    for (const key of Object.keys(everythingWrong)) {
      expect(REGISTER_FIELD_ORDER).toContain(key);
    }
  });
});
