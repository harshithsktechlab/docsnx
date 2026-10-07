/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHICH CHANNELS AN ACCOUNT MUST PROVE                                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The rule these predicates encode is a product rule, and getting it wrong is
 * not a cosmetic bug in either direction:
 *
 *   too strict  an admin is asked for a code on a channel their row cannot
 *               reach — a permanent lockout, not a stricter policy.
 *   too loose   a member's unverified email address is sent a login code, or a
 *               half-verified admin is treated as fully verified and handed a
 *               session.
 *
 * Also the verify-screen form logic, which lives in a `.ts` sibling for exactly
 * this reason: the test runner cannot parse JSX out of `verify-email/page.js`,
 * so anything left in that component is untestable.
 */
import { describe, it, expect } from 'vitest';
import {
  requiredChannels, isFullyVerified, outstandingChannels,
} from '@/lib/verificationChannels';
import {
  readChallengeView, codeBoxes, challengeHeadline, isComplete, verifyPayload,
  applyChallengeUpdate,
} from '@/lib/otpForm';

const member = (o: any = {}) => ({
  role: 'STANDARD',
  // DELIBERATELY has an address. A fixture with `email: null` could not tell
  // "routes by role" apart from "falls back when there is no address" — which
  // is the bug the rule exists to prevent.
  email: 'asha@example.test',
  phoneNumber: '+919876543210',
  emailVerified: false,
  phoneVerified: false,
  ...o,
});

const admin = (o: any = {}) => member({ role: 'TENANT_ADMIN', ...o });

describe('a member is verified over WhatsApp and nothing else', () => {
  it('never requires the email channel, even with an address on file', () => {
    expect(requiredChannels(member())).toEqual({ email: false, phone: true });
  });

  it('is fully verified on the phone flag alone', () => {
    expect(isFullyVerified(member({ phoneVerified: true }))).toBe(true);
    // And an `email_verified` left true by the pre-0052 backfill does NOT
    // stand in for it.
    expect(isFullyVerified(member({ emailVerified: true }))).toBe(false);
  });
});

describe('a tenant admin must prove both', () => {
  it('requires each channel', () => {
    expect(requiredChannels(admin())).toEqual({ email: true, phone: true });
  });

  it('is not verified by either one alone', () => {
    expect(isFullyVerified(admin({ emailVerified: true }))).toBe(false);
    expect(isFullyVerified(admin({ phoneVerified: true }))).toBe(false);
    expect(isFullyVerified(admin({ emailVerified: true, phoneVerified: true }))).toBe(true);
  });

  it('drops a channel the row has no usable contact for', () => {
    // Not a lockout. `validateUserContacts` makes both mandatory on every write
    // path, so this branch is only ever taken by an older row.
    expect(requiredChannels(admin({ email: null }))).toEqual({ email: false, phone: true });
    expect(requiredChannels(admin({ phoneNumber: null }))).toEqual({ email: true, phone: false });
  });

  it('treats an unusable number as no number', () => {
    // Six digits with dashes: long enough to pass a length check, and not a
    // number `toDialString` will produce anything from.
    expect(requiredChannels(admin({ phoneNumber: '1-2-3-4-5-6' })).phone).toBe(false);
  });

  it('fails CLOSED when neither contact is reachable', () => {
    // "No channels required" would read as "fully verified" and hand out a
    // session. Unreachable in practice — such a row cannot be looked up by any
    // identifier — but it must not be the permissive branch.
    const orphan = admin({ email: null, phoneNumber: null });
    expect(isFullyVerified(orphan)).toBe(false);
  });
});

describe('what is still outstanding', () => {
  it('drops a channel already cleared', () => {
    expect(outstandingChannels(admin({ emailVerified: true })))
      .toEqual({ email: false, phone: true });
  });

  it('is empty once everything required is done', () => {
    expect(outstandingChannels(admin({ emailVerified: true, phoneVerified: true })))
      .toEqual({ email: false, phone: false });
  });
});

// ── the verify screen's own logic ──────────────────────────────────────────

describe('the verify screen draws one box per outstanding code', () => {
  const view = (o: any = {}) => ({
    needsEmailCode: false, needsPhoneCode: false, emailHint: '', phoneHint: '', ...o,
  });

  it('draws two for an admin who owes both', () => {
    expect(codeBoxes(view({ needsEmailCode: true, needsPhoneCode: true })))
      .toEqual(['email', 'phone']);
  });

  it('draws one for a member', () => {
    expect(codeBoxes(view({ needsPhoneCode: true }))).toEqual(['phone']);
  });

  it('falls back to a single box when nothing said otherwise', () => {
    // The page was opened directly rather than through a login redirect. One
    // box is the safe default: the route routes a bare `otp` to whichever
    // single channel is outstanding, and refuses it when both are.
    expect(codeBoxes(view())).toEqual(['single']);
  });

  it('reads the flags out of URL params', () => {
    const params: Record<string, string> = { needsPhoneCode: 'true', phoneHint: '98••••3210' };
    const parsed = readChallengeView((k) => params[k] ?? null);

    expect(parsed).toEqual({
      needsEmailCode: false, needsPhoneCode: true, emailHint: '', phoneHint: '98••••3210',
    });
  });

  it('says both are needed when both are', () => {
    expect(challengeHeadline(view({ needsEmailCode: true, needsPhoneCode: true })))
      .toContain('Both');
  });
});

describe('what the screen posts', () => {
  const dual = { needsEmailCode: true, needsPhoneCode: true, emailHint: '', phoneHint: '' };
  const single = { needsEmailCode: false, needsPhoneCode: false, emailHint: '', phoneHint: '' };

  it('sends one code per box', () => {
    expect(verifyPayload(dual, { email: '111111', phone: '222222' }))
      .toEqual({ emailOtp: '111111', phoneOtp: '222222' });
  });

  it('sends a bare otp on the cold-start path', () => {
    // The member shape, and the shape older clients already post.
    expect(verifyPayload(single, { single: '123456' })).toEqual({ otp: '123456' });
  });

  it('is not complete until every box holds six digits', () => {
    expect(isComplete(dual, { email: '111111', phone: '2222' })).toBe(false);
    expect(isComplete(dual, { email: '111111', phone: '222222' })).toBe(true);
  });
});

describe('a rejected verify folds its progress back into the screen', () => {
  it('drops the box whose code was accepted', () => {
    const before = { needsEmailCode: true, needsPhoneCode: true, emailHint: 'a', phoneHint: 'b' };
    // The route banks a correct half even when the other fails, and reports
    // what is LEFT — asking again for a code that has already been redeemed
    // would be asking for one that no longer exists.
    const after = applyChallengeUpdate(before, { needsEmailCode: false, needsPhoneCode: true });

    expect(codeBoxes(after)).toEqual(['phone']);
    // Hints survive: the response does not resend them on every rejection.
    expect(after.phoneHint).toBe('b');
  });

  it('leaves the view alone when the response says nothing', () => {
    const before = { needsEmailCode: true, needsPhoneCode: true, emailHint: 'a', phoneHint: 'b' };
    expect(applyChallengeUpdate(before, {})).toEqual(before);
    expect(applyChallengeUpdate(before, null)).toEqual(before);
  });
});

describe('requiredChannels — WhatsApp switched off', () => {
  const off = { whatsappEnabled: false };

  it('asks an admin for their email code only', () => {
    expect(requiredChannels(admin(), off)).toEqual({ email: true, phone: false });
  });

  it('lets an admin through on email alone, without marking the phone verified', () => {
    expect(isFullyVerified(admin({ emailVerified: true, phoneVerified: false }), off)).toBe(true);
    expect(outstandingChannels(admin({ emailVerified: true }), off)).toEqual({ email: false, phone: false });
  });

  it('still owes the email code until it is entered', () => {
    expect(outstandingChannels(admin(), off)).toEqual({ email: true, phone: false });
    expect(isFullyVerified(admin(), off)).toBe(false);
  });

  it('leaves a member on WhatsApp — their email is never verified, so never a fallback', () => {
    expect(requiredChannels(member(), off)).toEqual({ email: false, phone: true });
  });

  it('is unchanged when the flag is on or omitted', () => {
    expect(requiredChannels(admin(), { whatsappEnabled: true })).toEqual({ email: true, phone: true });
    expect(requiredChannels(admin())).toEqual({ email: true, phone: true });
  });
});
