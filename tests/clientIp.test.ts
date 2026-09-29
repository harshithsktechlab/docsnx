import { describe, it, expect } from 'vitest';
import { getClientIp } from '@/lib/clientIp';

/** Build a bare Request carrying only the headers under test. */
function reqWith(headers: Record<string, string>): Request {
  return new Request('https://docsnx.com/api/auth/register', { headers });
}

/** The exact chain that broke production: Cloudflare's client IP + nginx's peer. */
const IPV6_CLIENT = '2405:201:21:5904:1d96:7024:1c5e:b751';
const CF_EDGE = '172.70.46.201';

describe('getClientIp', () => {
  it('takes only the client from a chained x-forwarded-for', () => {
    const ip = getClientIp(reqWith({ 'x-forwarded-for': `${IPV6_CLIENT}, ${CF_EDGE}` }));

    expect(ip).toBe(IPV6_CLIENT);
  });

  it('returns a value that fits users.consent_ip_address varchar(45)', () => {
    const ip = getClientIp(reqWith({ 'x-forwarded-for': `${IPV6_CLIENT}, ${CF_EDGE}` }));

    // The raw header is 51 chars and overflowed the column with SQLSTATE 22001.
    expect(ip.length).toBeLessThanOrEqual(45);
  });

  it('truncates even an absurdly long single value', () => {
    const ip = getClientIp(reqWith({ 'x-forwarded-for': 'a'.repeat(200) }));

    expect(ip).toHaveLength(45);
  });

  it('prefers cf-connecting-ip over x-forwarded-for', () => {
    const ip = getClientIp(
      reqWith({
        'cf-connecting-ip': IPV6_CLIENT,
        'x-forwarded-for': `203.0.113.9, ${CF_EDGE}`,
        'x-real-ip': CF_EDGE,
      }),
    );

    expect(ip).toBe(IPV6_CLIENT);
  });

  it('falls back to x-real-ip when no forwarded headers are present', () => {
    expect(getClientIp(reqWith({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('ignores blank headers and falls through', () => {
    const ip = getClientIp(reqWith({ 'cf-connecting-ip': '  ', 'x-forwarded-for': '203.0.113.9' }));

    expect(ip).toBe('203.0.113.9');
  });

  it('returns "unknown" when no IP headers are present', () => {
    expect(getClientIp(reqWith({}))).toBe('unknown');
  });
});
