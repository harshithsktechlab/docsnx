import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  isGoogleOAuthConfigured,
  sanitizeReturnTo,
  signOAuthState,
  verifyOAuthState,
} from '@/lib/googleDrive';

/**
 * The OAuth `state` is what lets the callback prove a connect flow was started by
 * this app, for this tenant, and know where to send the admin back to. If any of
 * this weakens, an attacker can bind their own Google account to someone else's
 * tenant, or bounce an admin to an external site after consent.
 */
describe('Google OAuth state', () => {
  it('round-trips the tenant, user and return path', () => {
    const state = { tenantId: 'tenant-a', userId: 'user-1', returnTo: '/settings' };
    const decoded = verifyOAuthState(signOAuthState(state));

    expect(decoded).toMatchObject(state);
  });

  it('rejects a tampered token', () => {
    const signed = signOAuthState({ tenantId: 'tenant-a', userId: 'user-1', returnTo: '/settings' });
    // Flip the last character of the signature.
    const tampered = signed.slice(0, -1) + (signed.slice(-1) === 'A' ? 'B' : 'A');

    expect(verifyOAuthState(tampered)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const forged = jwt.sign(
      { tenantId: 'victim-tenant', userId: 'attacker', returnTo: '/settings' },
      'not-the-app-secret',
      { expiresIn: '10m' }
    );

    expect(verifyOAuthState(forged)).toBeNull();
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign(
      { tenantId: 'tenant-a', userId: 'user-1', returnTo: '/settings' },
      process.env.JWT_SECRET as string,
      { expiresIn: '-1s' }
    );

    expect(verifyOAuthState(expired)).toBeNull();
  });

  it('rejects missing state', () => {
    expect(verifyOAuthState(null)).toBeNull();
    expect(verifyOAuthState(undefined)).toBeNull();
    expect(verifyOAuthState('')).toBeNull();
  });

  /**
   * The session cookie is signed with the same JWT_SECRET and already carries
   * `userId` and `tenantId`, so without a type claim it satisfies every other
   * check here — silently swapping the 10-minute state window for a 7-day one.
   * Shape mirrors JWTPayload in src/lib/auth.ts (see auth.test.ts for why these
   * tests sign directly rather than import that module).
   */
  it('rejects a session token used as state', () => {
    const sessionToken = jwt.sign(
      { userId: 'user-1', email: 'admin@example.com', role: 'TENANT_ADMIN', tenantId: 'tenant-a' },
      process.env.JWT_SECRET as string,
      { expiresIn: '7d' }
    );

    expect(verifyOAuthState(sessionToken)).toBeNull();
  });

  it('rejects a validly-signed token that is not a state token', () => {
    const wrongType = jwt.sign(
      { tenantId: 'tenant-a', userId: 'user-1', returnTo: '/settings', typ: 'password_reset' },
      process.env.JWT_SECRET as string,
      { expiresIn: '10m' }
    );

    expect(verifyOAuthState(wrongType)).toBeNull();
  });

  it('rejects a state token missing its identity claims', () => {
    const noIdentity = jwt.sign(
      { returnTo: '/settings', typ: 'google_oauth_state' },
      process.env.JWT_SECRET as string,
      { expiresIn: '10m' }
    );

    expect(verifyOAuthState(noIdentity)).toBeNull();
  });

  it('sanitizes returnTo on the way out, not just on the way in', () => {
    // A state token minted before the allow-list changed must not become an
    // open redirect just because it verified.
    const openRedirect = jwt.sign(
      { tenantId: 'tenant-a', userId: 'user-1', returnTo: 'https://evil.example.com', typ: 'google_oauth_state' },
      process.env.JWT_SECRET as string,
      { expiresIn: '10m' }
    );

    expect(verifyOAuthState(openRedirect)?.returnTo).toBe('/dashboard');
  });
});

describe('sanitizeReturnTo', () => {
  it('keeps allow-listed internal paths', () => {
    for (const path of ['/settings', '/onboarding', '/backup', '/dashboard']) {
      expect(sanitizeReturnTo(path)).toBe(path);
    }
  });

  it('falls back to /dashboard for anything off the allow-list', () => {
    // Open-redirect attempts and protocol-relative URLs must never survive.
    expect(sanitizeReturnTo('https://evil.example.com')).toBe('/dashboard');
    expect(sanitizeReturnTo('//evil.example.com')).toBe('/dashboard');
    expect(sanitizeReturnTo('/settings/../../admin')).toBe('/dashboard');
    expect(sanitizeReturnTo('javascript:alert(1)')).toBe('/dashboard');
    expect(sanitizeReturnTo(null)).toBe('/dashboard');
    expect(sanitizeReturnTo(undefined)).toBe('/dashboard');
  });
});

describe('isGoogleOAuthConfigured', () => {
  const original = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };

  beforeEach(() => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });

  afterEach(() => {
    if (original.id) process.env.GOOGLE_CLIENT_ID = original.id;
    if (original.secret) process.env.GOOGLE_CLIENT_SECRET = original.secret;
  });

  it('is false unless both credentials are present', () => {
    expect(isGoogleOAuthConfigured()).toBe(false);

    process.env.GOOGLE_CLIENT_ID = 'id';
    expect(isGoogleOAuthConfigured()).toBe(false);

    process.env.GOOGLE_CLIENT_SECRET = 'secret';
    expect(isGoogleOAuthConfigured()).toBe(true);
  });
});

/**
 * The origin the flow started on rides inside the state because the callback
 * cannot ask: it runs on whatever host is in the registered redirect URI, and
 * the SameSite=Strict session cookie is withheld on the return from Google. Send
 * the admin back to the wrong one of `docsnx.com` / `www.docsnx.com` and the
 * host-only cookie is absent, so a successful connect ends at the login screen.
 */
describe('Google OAuth state — return origin', () => {
  const savedAppUrl = process.env.APP_URL;

  beforeEach(() => {
    process.env.APP_URL = 'https://www.docsnx.com';
  });

  afterEach(() => {
    if (savedAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = savedAppUrl;
  });

  it('round-trips the apex origin an admin started on', () => {
    const signed = signOAuthState({
      tenantId: 'tenant-a',
      userId: 'user-1',
      returnTo: '/settings',
      origin: 'https://docsnx.com',
    });

    expect(verifyOAuthState(signed)?.origin).toBe('https://docsnx.com');
  });

  it('drops a foreign origin even though we signed it ourselves', () => {
    // The origin is derived from a client-controlled Host header at sign time,
    // so our own signature proves nothing about it. Without the re-check this
    // is an open redirect that survives `sanitizeReturnTo`.
    const signed = signOAuthState({
      tenantId: 'tenant-a',
      userId: 'user-1',
      returnTo: '/settings',
      origin: 'https://evil.example.com',
    });

    expect(verifyOAuthState(signed)?.origin).toBeUndefined();
  });

  it('leaves origin undefined on a state minted before the field existed', () => {
    const legacy = signOAuthState({ tenantId: 'tenant-a', userId: 'user-1', returnTo: '/settings' });

    // The callback falls back to APP_URL, i.e. exactly the old behaviour.
    expect(verifyOAuthState(legacy)?.origin).toBeUndefined();
  });
});
