/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE ONE LINE A LOCKED PHONE SHOWS                                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The bell is scoped to the workspace you are standing in, so a row in it never
 * has to name one. A push has no such luxury: it arrives with no shell, no chip
 * and no workspace, and "Insurance renewal due" is genuinely ambiguous on an
 * account running a household and three companies.
 *
 * The cap is the part worth pinning. Android gives a title roughly one line and
 * truncates it before it touches the body, so an untrimmed company name does not
 * merely look untidy — it pushes the actual subject off the screen, leaving a
 * notification that says only who it is about and never what it wants.
 */
import { describe, it, expect } from 'vitest';
import { pushTitleFor, PUSH_PREFIX_MAX } from '@/lib/notifications';

describe('pushTitleFor', () => {
  it('prefixes with the workspace', () => {
    expect(pushTitleFor('Trade licence due', 'Acme')).toBe('Acme · Trade licence due');
  });

  it('leaves the title alone when there is no workspace to name', () => {
    // The single-workspace account, and every caller that decided not to prefix
    // — a billing notice, whose title already names its half.
    expect(pushTitleFor('Plan expires in 3 days', null)).toBe('Plan expires in 3 days');
    expect(pushTitleFor('Plan expires in 3 days')).toBe('Plan expires in 3 days');
    expect(pushTitleFor('Plan expires in 3 days', '  ')).toBe('Plan expires in 3 days');
  });

  it('trims a long workspace name rather than spending the line on it', () => {
    const long = 'Sharma Industries Private Limited';
    const out = pushTitleFor('Trade licence due', long);

    expect(out).toContain('Trade licence due');
    expect(out.startsWith('Sharma Industries'.slice(0, PUSH_PREFIX_MAX - 1))).toBe(true);
    expect(out).toContain('…');
    // Half a company name plus the whole subject beats the whole name and none
    // of the subject.
    expect(out.indexOf('·')).toBeLessThanOrEqual(PUSH_PREFIX_MAX + 1);
  });

  it('does not trim a name that already fits', () => {
    const name = 'a'.repeat(PUSH_PREFIX_MAX);
    expect(pushTitleFor('x', name)).toBe(`${name} · x`);
  });
});
