/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   DELETE /api/account/delete — ordering, and what may abort the erasure  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The route's job is five steps in one specific order, and the order is the
 * whole design:
 *
 *   collect → RETAIN → purge Drive → purge local files → cascade
 *
 * Retention comes before the cascade because `users` cascades away and the
 * members would be unreadable afterwards; it is also the ONE step allowed to
 * abort the deletion, because an account erased with no record of whose it was
 * is worse than a deletion the user can simply retry. The purge steps take the
 * opposite trade: the user asked for this, so Google being down must not keep
 * the account alive.
 *
 * The confirmation check is here too. This action is irreversible, destroys
 * data in a third party's storage, and takes its own audit trail with it — a
 * verb-only DELETE would put all of that one stray fetch away.
 *
 * The erasure helpers themselves are covered in tests/accountErasure.test.ts;
 * they are mocked here so the ordering is legible.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { blindIndex, decryptField, isCiphertext } from '@/lib/fieldCrypto';

const TENANT = {
  id: 'tenant-1',
  name: 'The Sharma Household',
  googleDriveTokens: 'tokens',
  googleDriveFolderId: 'folder-cached',
};

const events: string[] = [];
let insertedRows: any[] = [];
let insertThrows = false;
let driveThrows = false;
let members: any[] = [];
let sessionUser: any = null;
let tenantRow: any = null;

// A bare stub: the route uses the pooled `db` directly (the `tenants` table
// carries no RLS policy of its own), so nothing here needs withTenant.
vi.mock('@/lib/db', () => ({ db: {}, withTenant: async (_t: string, cb: any) => cb({}) }));

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => sessionUser),
}));

vi.mock('@/lib/account/accountErasure', () => ({
  collectRetentionRecords: vi.fn(async () => {
    events.push('collect');
    return members;
  }),
  purgeTenantDrive: vi.fn(async () => {
    events.push('drive');
    if (driveThrows) throw new Error('drive offline');
    return { folderDeleted: true, filesDeleted: 0, grantRevoked: true, failures: [] };
  }),
  purgeLegacyUploadFiles: vi.fn(async () => {
    events.push('uploads');
    return { removed: 0, failures: 0 };
  }),
}));

// Fill in the stub above with just the three call shapes the route uses.
const dbModule = await import('@/lib/db');
(dbModule as any).db.query = {
  tenants: { findFirst: vi.fn(async () => tenantRow) },
};
(dbModule as any).db.insert = () => ({
  values: async (rows: any[]) => {
    events.push('retain');
    if (insertThrows) throw new Error('insert failed');
    insertedRows = rows;
  },
});
(dbModule as any).db.delete = () => ({
  where: async () => {
    events.push('cascade');
  },
});

const { DELETE } = await import('@/app/api/account/delete/route');

const request = (body: unknown) =>
  ({ json: async () => body, headers: new Headers() }) as any;

beforeEach(() => {
  events.length = 0;
  insertedRows = [];
  insertThrows = false;
  driveThrows = false;
  sessionUser = { id: 'u1', tenantId: 'tenant-1', role: 'TENANT_ADMIN' };
  tenantRow = { ...TENANT };
  members = [
    { id: 'u1', name: 'Asha Sharma', email: 'asha@example.com', phoneNumber: '+919876543210', phoneDial: '919876543210', role: 'TENANT_ADMIN' },
    { id: 'u2', name: 'Ravi Sharma', email: 'ravi@example.com', phoneNumber: null, phoneDial: null, role: 'STANDARD' },
  ];
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('DELETE /api/account/delete', () => {
  it('refuses anyone who is not a tenant admin', async () => {
    sessionUser = { id: 'u2', tenantId: 'tenant-1', role: 'STANDARD' };

    const res = await DELETE(request({ confirm: 'The Sharma Household' }));

    expect(res.status).toBe(403);
    expect(events).not.toContain('cascade');
  });

  it('refuses an unauthenticated caller', async () => {
    sessionUser = null;
    const res = await DELETE(request({ confirm: 'The Sharma Household' }));
    expect(res.status).toBe(401);
  });

  it('refuses a workspace name that does not match, and deletes nothing', async () => {
    const res = await DELETE(request({ confirm: 'the sharma workspace' }));

    expect(res.status).toBe(400);
    expect(events).toEqual([]);
  });

  it('refuses a body with no confirmation at all', async () => {
    const res = await DELETE(request({}));
    expect(res.status).toBe(400);
    expect(events).toEqual([]);
  });

  it('retains the members BEFORE the cascade that would make them unreadable', async () => {
    await DELETE(request({ confirm: 'The Sharma Household' }));

    expect(events).toEqual(['collect', 'retain', 'drive', 'uploads', 'cascade']);
  });

  it('retains name, phone, email and the phone lookup key — and nothing else', async () => {
    await DELETE(request({ confirm: 'The Sharma Household' }));

    expect(insertedRows).toHaveLength(2);
    expect(Object.keys(insertedRows[0]).sort()).toEqual(
      ['email', 'name', 'phoneNumber', 'phoneDialIndex', 'role', 'tenantId', 'tenantName'].sort(),
    );
  });

  it('writes the phone lookup key as blindIndex(phone_dial), and NULL for a member with no number', async () => {
    await DELETE(request({ confirm: 'The Sharma Household' }));

    const [asha, ravi] = insertedRows;
    // What lets a later mobile-number sign-in be told the account was erased
    // (src/lib/account/erasedAccountLookup.ts). The same keyed hash over the
    // same normalised dial string, or the lookup can never match it.
    expect(asha.phoneDialIndex).toBe(blindIndex('919876543210'));
    expect(asha.phoneDialIndex).not.toContain('9876543210');
    expect(ravi.phoneDialIndex).toBeNull();
  });

  it('stores the retained name and phone as ciphertext, sealed under the app key', async () => {
    await DELETE(request({ confirm: 'The Sharma Household' }));

    const [asha] = insertedRows;
    // The tenant key is a `tenant_encryption_keys` row and cascades away, so
    // anything sealed under it would be unreadable the moment it was written.
    expect(isCiphertext(asha.name)).toBe(true);
    expect(decryptField(asha.name)).toBe('Asha Sharma');
    expect(decryptField(asha.phoneNumber)).toBe('+919876543210');
    // Cleartext by design: trial_used_emails already holds it that way.
    expect(asha.email).toBe('asha@example.com');
    // A member with no phone keeps a NULL rather than an empty ciphertext.
    expect(insertedRows[1].phoneNumber).toBeNull();
  });

  it('refuses to erase when the member read comes back empty', async () => {
    // Not "an empty workspace" — the admin making the request is a member, so
    // there is always at least one row. Empty means the RLS session was never
    // scoped and Postgres filtered everything out silently; erasing on that
    // would leave an empty retention table and no record of anyone.
    members = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await DELETE(request({ confirm: 'The Sharma Household' }));

    expect(res.status).toBe(500);
    expect(events).not.toContain('cascade');
    expect(events).not.toContain('retain');
  });

  it('erases an account even when a member has a blank name', async () => {
    // `deleted_accounts.name` is NOT NULL and encryptField('') is null, so the
    // insert would fail and — by the rule above — abort the deletion. Refusing
    // to erase an account over a missing name is the wrong trade.
    members = [{ id: 'u1', name: '', email: 'a@x.com', phoneNumber: null, phoneDial: null, role: 'TENANT_ADMIN' }];

    const res = await DELETE(request({ confirm: 'The Sharma Household' }));

    expect(res.status).toBe(200);
    expect(decryptField(insertedRows[0].name)).toBe('(no name recorded)');
  });

  it('scopes the retention row to the SESSION tenant, never one from the body', async () => {
    await DELETE(request({ confirm: 'The Sharma Household', tenantId: 'tenant-victim' }));

    expect(insertedRows.every((r) => r.tenantId === 'tenant-1')).toBe(true);
  });

  it('aborts the deletion if the retention write fails', async () => {
    // An account erased with no record of whose it was is worse than a failed
    // deletion — the user can retry that.
    insertThrows = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await DELETE(request({ confirm: 'The Sharma Household' }));

    expect(res.status).toBe(500);
    expect(events).not.toContain('cascade');
  });

  it('deletes the account even when Drive cannot be reached', async () => {
    // The opposite trade to the one above: the user asked for this, and Google
    // being down cannot keep the account alive.
    driveThrows = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await DELETE(request({ confirm: 'The Sharma Household' }));

    // The helpers swallow their own failures; this proves the route survives one
    // that escapes anyway — a bug in the purge must not block the erasure.
    expect(res.status).toBe(200);
    expect(events).toContain('cascade');
  });

  it('clears the session cookie — the JWT outlives the account otherwise', async () => {
    const res = await DELETE(request({ confirm: 'The Sharma Household' }));

    expect(res.status).toBe(200);
    // 7-day expiry, checked against no session store; without this the cookie
    // keeps authenticating a user row that no longer exists.
    expect(res.cookies.get('auth_token')?.value).toBe('');
  });

  it('tolerates a workspace name typed with stray whitespace', async () => {
    const res = await DELETE(request({ confirm: '  The Sharma Household  ' }));
    expect(res.status).toBe(200);
  });
});
