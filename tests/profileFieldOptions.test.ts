/**
 * Company-profile dropdown choices (Field Config → Company Profile).
 *
 * Asserted here:
 *  1. The built-in list answers whenever nothing valid is stored, and a read
 *     failure degrades to it rather than breaking the profile page.
 *  2. Validation: blank / duplicate values are refused, blank labels default to
 *     the value.
 *  3. The admin route is super-admin only, UPDATE-only (409 with no settings
 *     row), resets to defaults on an empty list, and audits.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireSuperAdmin = vi.fn();
const writeAudit = vi.fn();
const state: { row: any[]; set: any[] } = { row: [], set: [] };
let failRead = false;

vi.mock('@/lib/adminGuard', () => ({
  requireSuperAdmin: (...a: any[]) => requireSuperAdmin(...a),
  SUPER_ADMIN_ONLY: 'Super admin only',
}));
vi.mock('@/lib/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit')>()),
  writeAudit: (...a: any[]) => writeAudit(...a),
}));
vi.mock('@/lib/db', () => {
  const chain: any = {
    select: () => chain,
    from: () => chain,
    limit: async () => {
      if (failRead) throw new Error('db down');
      return state.row;
    },
    update: () => ({
      set: (v: any) => {
        state.set.push(v);
        return { where: async () => undefined };
      },
    }),
  };
  return { db: chain };
});

import {
  DEFAULT_ENTITY_TYPES, loadEntityTypeOptions, normalizeOptions,
} from '@/lib/profileFieldOptions';
import { GET, PUT } from '@/app/api/admin/document-fields/profile-options/route';

const put = (body: any) => PUT(new Request('http://x/api/admin/document-fields/profile-options', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.row = [];
  state.set = [];
  failRead = false;
  requireSuperAdmin.mockResolvedValue({ id: 'u1', tenantId: 't1' });
});

describe('loadEntityTypeOptions', () => {
  it('falls back to defaults with no row, NULL, or an empty list', async () => {
    expect(await loadEntityTypeOptions()).toEqual(DEFAULT_ENTITY_TYPES);
    state.row = [{ profileFieldOptions: null }];
    expect(await loadEntityTypeOptions()).toEqual(DEFAULT_ENTITY_TYPES);
    state.row = [{ id: 'c1', profileFieldOptions: { entityType: [] } }];
    expect(await loadEntityTypeOptions()).toEqual(DEFAULT_ENTITY_TYPES);
  });

  it('returns the stored list when set', async () => {
    state.row = [{ profileFieldOptions: { entityType: [{ value: 'Co-op', label: 'Co-operative' }] } }];
    expect(await loadEntityTypeOptions()).toEqual([{ value: 'Co-op', label: 'Co-operative' }]);
  });

  it('never throws — a failed read degrades to the defaults', async () => {
    failRead = true;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await loadEntityTypeOptions()).toEqual(DEFAULT_ENTITY_TYPES);
  });
});

describe('normalizeOptions', () => {
  it('defaults a blank label to the value and trims', () => {
    expect(normalizeOptions([{ value: ' LLP ', label: '' }])).toEqual({
      ok: true, options: [{ value: 'LLP', label: 'LLP' }],
    });
  });
  it('rejects blank and duplicate (case-insensitive) values', () => {
    expect(normalizeOptions([{ value: '  ' }]).ok).toBe(false);
    expect(normalizeOptions([{ value: 'LLP' }, { value: 'llp' }]).ok).toBe(false);
  });
});

describe('/api/admin/document-fields/profile-options', () => {
  it('403s for anyone but a super admin', async () => {
    requireSuperAdmin.mockResolvedValue(null);
    expect((await GET(new Request('http://x'))).status).toBe(403);
    expect((await put({ entityType: [{ value: 'A' }] })).status).toBe(403);
    expect(state.set).toHaveLength(0);
  });

  it('409s when the settings row does not exist', async () => {
    expect((await put({ entityType: [{ value: 'A' }] })).status).toBe(409);
  });

  it('400s on duplicates and saves a valid list with an audit row', async () => {
    state.row = [{ id: 'c1' }];
    expect((await put({ entityType: [{ value: 'A' }, { value: 'a' }] })).status).toBe(400);
    expect(state.set).toHaveLength(0);

    const res = await put({ entityType: [{ value: 'A', label: 'Alpha' }] });
    expect(res.status).toBe(200);
    expect(state.set[0].profileFieldOptions).toEqual({ entityType: [{ value: 'A', label: 'Alpha' }] });
    expect(writeAudit).toHaveBeenCalledTimes(1);
  });

  it('resets to the defaults on an empty list', async () => {
    state.row = [{ id: 'c1' }];
    const res = await put({ entityType: [] });
    const json = await res.json();
    expect(state.set[0].profileFieldOptions).toBeNull();
    expect(json.entityType).toEqual(DEFAULT_ENTITY_TYPES);
    expect(json.isDefault).toBe(true);
  });
});

describe('registration field settings on entity types', () => {
  it('carries the registration keys through and drops blank ones', () => {
    const r = normalizeOptions([
      { value: 'LLP', registrationLabel: ' LLPIN ', registrationPlaceholder: '', registrationPattern: '^[A-Z]{3}-\\d{4}$' },
    ]);
    expect(r).toEqual({
      ok: true,
      options: [{ value: 'LLP', label: 'LLP', registrationLabel: 'LLPIN', registrationPattern: '^[A-Z]{3}-\\d{4}$' }],
    });
  });

  it('rejects a format that is not a valid pattern', () => {
    const r = normalizeOptions([{ value: 'LLP', registrationPattern: '([' }]);
    expect(r.ok).toBe(false);
  });

  it('the defaults round-trip unchanged through validation', () => {
    const r = normalizeOptions(DEFAULT_ENTITY_TYPES);
    expect(r).toEqual({ ok: true, options: DEFAULT_ENTITY_TYPES });
  });

  it('PUT 400s on a bad pattern and persists a good one', async () => {
    state.row = [{ id: 'c1' }];
    expect((await put({ entityType: [{ value: 'A', registrationPattern: '([' }] })).status).toBe(400);
    expect(state.set).toHaveLength(0);
    expect((await put({ entityType: [{ value: 'A', registrationLabel: 'CIN' }] })).status).toBe(200);
    expect(state.set[0].profileFieldOptions.entityType[0].registrationLabel).toBe('CIN');
  });
});
