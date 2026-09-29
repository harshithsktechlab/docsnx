import { describe, it, expect } from 'vitest';
import {
  DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_SCOPES,
  hasDriveFileScope,
  serializeDriveTokens,
} from '@/lib/googleDrive';

/**
 * Google's consent screen shows `drive.file` as a CHECKBOX.
 *
 * Untick it and the connect flow still completes: Google returns an
 * authorization code, the token exchange succeeds, and what comes back is a
 * perfectly valid credential that can read the account's email address and
 * nothing else. Stored, it sets every column that means "connected" — and then
 * every Drive call answers 403 "insufficient authentication scopes".
 *
 * The vault has no local fallback by design, so a tenant in that state cannot
 * save a single record, while Settings tells them they are connected and the
 * form tells them only "Could not save this record". That happened in
 * production. `hasDriveFileScope` is what makes the state impossible to create
 * and visible where it already exists, so its edges are worth pinning down.
 */
describe('hasDriveFileScope', () => {
  const EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';

  it('accepts a grant carrying the Drive scope', () => {
    expect(hasDriveFileScope({ access_token: 'a', scope: GOOGLE_DRIVE_SCOPES.join(' ') })).toBe(true);
  });

  it('rejects the partial consent this exists for: email granted, Drive unticked', () => {
    expect(hasDriveFileScope({ access_token: 'a', scope: EMAIL_SCOPE })).toBe(false);
  });

  it('is not fooled by a scope that merely contains the string', () => {
    // Scopes are space-separated whole values, not substrings. A prefix match
    // would accept a hypothetical `…/drive.file.readonly` as write access.
    expect(hasDriveFileScope({ scope: `${DRIVE_FILE_SCOPE}.readonly` })).toBe(false);
  });

  it('accepts a grant whose scope order differs or carries extra scopes', () => {
    expect(
      hasDriveFileScope({ scope: `openid ${EMAIL_SCOPE} ${DRIVE_FILE_SCOPE} profile` })
    ).toBe(true);
  });

  it('treats a grant with NO scope field as good', () => {
    // Rows written before we recorded the scope have nothing to judge. Flagging
    // them would tell working tenants to reconnect — worse than the silence
    // this whole change is fixing. Only an explicit list missing the scope
    // counts as a failure.
    expect(hasDriveFileScope({ access_token: 'a', refresh_token: 'r' })).toBe(true);
    expect(hasDriveFileScope({ access_token: 'a', scope: '' })).toBe(true);
    expect(hasDriveFileScope({ access_token: 'a', scope: '   ' })).toBe(true);
  });

  it('reads through the encrypted-at-rest form the tenant row actually holds', () => {
    // The column is never a plain object in production: `serializeDriveTokens`
    // encrypts it. If this predicate could only read the legacy jsonb shape it
    // would answer "no grant" for every real tenant and lock them all out.
    const good = serializeDriveTokens({ access_token: 'a', scope: GOOGLE_DRIVE_SCOPES.join(' ') });
    const partial = serializeDriveTokens({ access_token: 'a', scope: EMAIL_SCOPE });

    expect(typeof good).toBe('string');
    expect(hasDriveFileScope(good)).toBe(true);
    expect(hasDriveFileScope(partial)).toBe(false);
  });

  it('reports no grant at all as unusable', () => {
    expect(hasDriveFileScope(null)).toBe(false);
    expect(hasDriveFileScope(undefined)).toBe(false);
    expect(hasDriveFileScope('')).toBe(false);
  });

  it('keeps the Drive scope in what the connect flow asks for', () => {
    // The predicate is only as good as the request that precedes it.
    expect(GOOGLE_DRIVE_SCOPES).toContain(DRIVE_FILE_SCOPE);
  });
});
