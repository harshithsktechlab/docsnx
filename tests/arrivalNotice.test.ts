/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   arrivalNotice — one sentence for one arrival at the wizard             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Shell's gate takes over a navigation that was already carrying a message of
 * its own: a tenant admin who has just verified their codes was told "Account
 * verified successfully!" and then, on the same screen, "Finish setting up your
 * workspace first". This is the rule that folds the two into one.
 */
import { describe, it, expect } from 'vitest';
import { arrivalNotice, VERIFIED_TAG } from '@/lib/arrivalNotice';
import type { Flash } from '@/lib/flashToast';

const flash = (over: Partial<Flash> = {}): Flash => ({
  message: 'Account verified successfully!',
  type: 'success',
  at: Date.now(),
  ...over,
});

describe('a just-verified admin', () => {
  it('is greeted once, with both halves in one sentence', () => {
    const said = arrivalNotice(flash({ tag: VERIFIED_TAG }), true);

    expect(said).toBe('Account verified — finish setting up your workspace, starting with Google Drive.');
  });
});

describe('an admin arriving any other way', () => {
  it('is told what the gate is for', () => {
    expect(arrivalNotice(null, true)).toBe(
      'Finish setting up your workspace first — connecting your Google Drive is the last step.',
    );
  });

  it('is not folded in by an unrelated pending message', () => {
    expect(arrivalNotice(flash({ message: 'Login successful!', tag: 'login-ok' }), true)).toBe(
      'Finish setting up your workspace first — connecting your Google Drive is the last step.',
    );
  });
});

describe('a member', () => {
  // They cannot finish setup — the complete endpoint 401s them — so they are
  // told why the app is closed rather than handed an instruction they cannot
  // act on, whatever they were carrying.
  it('is told their admin is still setting up', () => {
    expect(arrivalNotice(null, false)).toBe('Your administrator is still setting up this workspace.');
    expect(arrivalNotice(flash({ tag: VERIFIED_TAG }), false)).toBe(
      'Your administrator is still setting up this workspace.',
    );
  });
});
