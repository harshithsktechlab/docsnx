import { describe, it, expect } from 'vitest';
import { alreadyAddedSentence, invitedCodePayload, invitedDestination } from '@/lib/invitedSignupForm';

const both = { needsEmailCode: true, needsPhoneCode: true, emailHint: '', phoneHint: '' };

describe('invitedCodePayload', () => {
  it('needs only one of the two codes', () => {
    expect(invitedCodePayload(both, { phone: '222222' })).toEqual({ phoneOtp: '222222' });
    expect(invitedCodePayload(both, { email: '111111', phone: '222222' }))
      .toEqual({ emailOtp: '111111', phoneOtp: '222222' });
  });

  it('waits while nothing is entered or a started box is unfinished', () => {
    expect(invitedCodePayload(both, {})).toBeNull();
    expect(invitedCodePayload(both, { email: '111111', phone: '22' })).toBeNull();
  });
});

describe('alreadyAddedSentence', () => {
  it('names the inviter when there is one', () => {
    expect(alreadyAddedSentence({ inviterName: 'Ravi', workspaceName: 'Acme' }))
      .toBe('Ravi has already added you as a user of Acme.');
    expect(alreadyAddedSentence({ inviterName: '', workspaceName: 'Acme' }))
      .toBe('You have already been added as a user of Acme.');
  });
});

describe('invitedDestination', () => {
  it('goes to the workspace dashboard, billing, or the own-account code screen', () => {
    expect(invitedDestination({ next: 'dashboard' }, 'a@x.test').href).toBe('/dashboard');
    expect(invitedDestination({ next: 'billing' }, 'a@x.test').href).toBe('/billing?welcome=1');
    expect(invitedDestination({ next: 'verify', needsPhoneCode: true }, 'a@x.test').href)
      .toBe('/verify-email?identifier=a%40x.test&needsPhoneCode=true&own=1');
  });
});
