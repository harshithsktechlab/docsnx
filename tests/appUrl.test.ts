import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getAppBaseUrl, getRequestOrigin, isAllowedAppOrigin } from '@/lib/appUrl';

const ENV_KEYS = ['APP_URL', 'NEXT_PUBLIC_APP_URL', 'PORT'] as const;
const saved: Record<string, string | undefined> = {};

/** Build a bare Request carrying only the headers nginx would forward. */
function req(headers: Record<string, string>): Request {
  return new Request('http://127.0.0.1:3005/api/auth/forgot-password', { headers });
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('getAppBaseUrl', () => {
  it('prefers APP_URL over the request headers', () => {
    process.env.APP_URL = 'https://www.docsnx.com';
    const url = getAppBaseUrl(req({ host: 'evil.example.com', 'x-forwarded-proto': 'https' }));
    expect(url).toBe('https://www.docsnx.com');
  });

  it('falls back to NEXT_PUBLIC_APP_URL when APP_URL is unset', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.docsnx.com';
    expect(getAppBaseUrl()).toBe('https://www.docsnx.com');
  });

  it('normalizes a trailing slash and a missing scheme', () => {
    process.env.APP_URL = 'www.docsnx.com/';
    expect(getAppBaseUrl()).toBe('https://www.docsnx.com');
  });

  it('derives the origin from forwarded headers when nothing is configured', () => {
    const url = getAppBaseUrl(req({ host: 'www.docsnx.com', 'x-forwarded-proto': 'https' }));
    expect(url).toBe('https://www.docsnx.com');
  });

  it('prefers x-forwarded-host over host, and defaults the scheme to http', () => {
    const url = getAppBaseUrl(req({ host: '127.0.0.1:3005', 'x-forwarded-host': 'localhost:3005' }));
    expect(url).toBe('http://localhost:3005');
  });

  it('falls back to localhost:PORT with no config and no request', () => {
    process.env.PORT = '3005';
    expect(getAppBaseUrl()).toBe('http://localhost:3005');
  });

  it('never emits a localhost link once APP_URL is pinned — the reported bug', () => {
    process.env.APP_URL = 'https://www.docsnx.com';
    process.env.PORT = '3005';
    expect(`${getAppBaseUrl()}/reset-password?token=abc`).toBe(
      'https://www.docsnx.com/reset-password?token=abc'
    );
  });
});

/**
 * `getAppBaseUrl` answers "what origin do we PUT IN AN EMAIL"; this pair answers
 * "what origin is this browser actually on". They differ in production, where
 * nginx serves both `docsnx.com` and `www.docsnx.com` but APP_URL names only the
 * second — and the session cookie is host-only, so redirecting a signed-in admin
 * across that line logs them out.
 */
describe('getRequestOrigin', () => {
  it('follows the request even when APP_URL says otherwise', () => {
    process.env.APP_URL = 'https://www.docsnx.com';
    const url = getRequestOrigin(req({ host: 'docsnx.com', 'x-forwarded-proto': 'https' }));
    expect(url).toBe('https://docsnx.com');
  });

  it('prefers x-forwarded-host, since host is the loopback nginx proxies to', () => {
    const url = getRequestOrigin(
      req({ host: '127.0.0.1:3005', 'x-forwarded-host': 'docsnx.com', 'x-forwarded-proto': 'https' })
    );
    expect(url).toBe('https://docsnx.com');
  });

  it('falls back to the configured base URL when there is no request', () => {
    process.env.APP_URL = 'https://www.docsnx.com';
    expect(getRequestOrigin()).toBe('https://www.docsnx.com');
  });
});

describe('isAllowedAppOrigin', () => {
  beforeEach(() => {
    process.env.APP_URL = 'https://www.docsnx.com';
  });

  it('accepts the configured host and its apex/www counterpart', () => {
    expect(isAllowedAppOrigin('https://www.docsnx.com')).toBe(true);
    expect(isAllowedAppOrigin('https://docsnx.com')).toBe(true);
  });

  it('rejects a foreign host, however plausible', () => {
    // The origin it guards reaches us in a client-controlled header, so these
    // are the strings an open-redirect attempt would actually carry.
    expect(isAllowedAppOrigin('https://evil.example.com')).toBe(false);
    expect(isAllowedAppOrigin('https://docsnx.com.evil.example.com')).toBe(false);
    expect(isAllowedAppOrigin('https://evil-docsnx.com')).toBe(false);
    expect(isAllowedAppOrigin('https://sub.docsnx.com')).toBe(false);
  });

  it('rejects empty and unparseable input', () => {
    expect(isAllowedAppOrigin(null)).toBe(false);
    expect(isAllowedAppOrigin(undefined)).toBe(false);
    expect(isAllowedAppOrigin('')).toBe(false);
    expect(isAllowedAppOrigin('   ')).toBe(false);
    expect(isAllowedAppOrigin('http://')).toBe(false);
  });

  it('compares hosts, so the port is part of the identity', () => {
    process.env.APP_URL = 'http://localhost:3005';
    expect(isAllowedAppOrigin('http://localhost:3005')).toBe(true);
    expect(isAllowedAppOrigin('http://localhost:4000')).toBe(false);
  });
});
