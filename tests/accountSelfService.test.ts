/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   /api/account — a member edits THEIR OWN details, photo and password    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Until these routes existed only a tenant admin could change a member's name,
 * mobile, email or password (PUT /api/users/[id]), and no one could set a photo.
 * What this file pins:
 *
 *  - a STANDARD member can use all three routes on their own row;
 *  - the target is the session's user — the body cannot name another, and
 *    cannot carry a role, tenant or sign-in switch;
 *  - email / mobile are login identities, so changing either needs the CURRENT
 *    password, while a plain name change does not;
 *  - a member who can sign in cannot clear both of their sign-in identities;
 *  - the password route checks the current password and the length rule;
 *  - the photo is judged by its magic bytes, not by what the client claims.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const TENANT = 'tenant-1';

let row: any;
let lastUpdate: any;
let duplicateEmailRow: any;
let updateError: any;
let storedAvatar: any;

vi.mock('@/lib/db', () => {
  const tx = {
    query: {
      users: { findFirst: async () => row },
      userAvatars: { findFirst: async () => storedAvatar },
    },
    update: () => ({
      set: (values: any) => ({
        where: () => ({
          returning: async () => {
            if (updateError) throw updateError;
            lastUpdate = values;
            return [{ ...row, ...values }];
          },
          then: (resolve: any) => { lastUpdate = values; return Promise.resolve().then(resolve); },
        }),
      }),
    }),
    insert: () => ({
      values: (values: any) => ({
        onConflictDoUpdate: async () => { storedAvatar = values; },
      }),
    }),
    delete: () => ({
      where: () => ({ returning: async () => { const had = storedAvatar; storedAvatar = undefined; return had ? [{ userId: 'm1' }] : []; } }),
    }),
  };
  return {
    db: { query: { users: { findFirst: async () => duplicateEmailRow } } },
    withTenant: async (_t: string, fn: any) => fn(tx),
  };
});

let session: any;
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: async () => session,
  comparePassword: async (pw: string, hash: string) => hash === `hash:${pw}`,
  hashPassword: async (pw: string) => `hash:${pw}`,
}));

const writeAudit = vi.fn(async () => {});
vi.mock('@/lib/audit', async () => {
  const actual: any = await vi.importActual('@/lib/audit');
  return { ...actual, writeAudit: (...a: any[]) => (writeAudit as any)(...a) };
});

import { PATCH as patchProfile } from '@/app/api/account/profile/route';
import { POST as postPassword } from '@/app/api/account/password/route';
import { PUT as putAvatar, DELETE as deleteAvatar } from '@/app/api/account/avatar/route';
import { GET as getAvatar } from '@/app/api/account/avatar/[userId]/route';
import { sniffAvatarType, MAX_AVATAR_BYTES } from '@/lib/avatarImage';

const json = (method: string, body: unknown) => new Request('http://x/api', {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const send = async (res: Response) => ({ status: res.status, body: await res.json().catch(() => null) });

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const bytesReq = (method: string, bytes: Uint8Array) =>
  new Request('http://x/api', { method, headers: { 'Content-Type': 'image/jpeg' }, body: bytes as any });

beforeEach(() => {
  vi.clearAllMocks();
  lastUpdate = undefined;
  duplicateEmailRow = null;
  updateError = null;
  storedAvatar = undefined;
  session = { id: 'm1', tenantId: TENANT, role: 'STANDARD', name: 'Asha', email: 'asha@example.com' };
  row = {
    id: 'm1', tenantId: TENANT, role: 'STANDARD', name: 'Asha',
    email: 'asha@example.com', phoneNumber: '+919876543210', phoneDial: '919876543210',
    passwordHash: 'hash:oldpassword', activatedAt: new Date(), signInDisabledAt: null,
  };
});

describe('PATCH /api/account/profile', () => {
  it('lets a member rename themselves with no password', async () => {
    const r = await send(await patchProfile(json('PATCH', { name: '  Asha K  ' })));
    expect(r.status).toBe(200);
    expect(lastUpdate.name).toBe('Asha K');
    expect(writeAudit).toHaveBeenCalledOnce();
    expect(r.body.user.passwordHash).toBeUndefined();
  });

  it('refuses without a session', async () => {
    session = null;
    expect((await patchProfile(json('PATCH', { name: 'X' }))).status).toBe(401);
  });

  it.each(['role', 'tenantId', 'id', 'permissions', 'signInDisabledAt'])(
    'rejects a body that tries to set %s',
    async (field) => {
      const res = await patchProfile(json('PATCH', { name: 'Asha', [field]: 'TENANT_ADMIN' }));
      expect(res.status).toBe(400);
      expect(lastUpdate).toBeUndefined();
    },
  );

  it('demands the current password to change the email, and rejects a wrong one', async () => {
    expect((await patchProfile(json('PATCH', { email: 'new@example.com' }))).status).toBe(403);
    const wrong = await patchProfile(json('PATCH', { email: 'new@example.com', currentPassword: 'nope' }));
    expect(wrong.status).toBe(403);
    expect(lastUpdate).toBeUndefined();
  });

  it('changes the email with the right password, lower-cased', async () => {
    const r = await send(await patchProfile(json('PATCH', {
      email: 'New@Example.com', currentPassword: 'oldpassword',
    })));
    expect(r.status).toBe(200);
    expect(lastUpdate.email).toBe('new@example.com');
  });

  it('writes phoneNumber and phoneDial together', async () => {
    const r = await send(await patchProfile(json('PATCH', {
      phoneNumber: '+919000000001', currentPassword: 'oldpassword',
    })));
    expect(r.status).toBe(200);
    expect(lastUpdate.phoneNumber).toBe('+919000000001');
    expect(lastUpdate.phoneDial).toBe('919000000001');
  });

  it('does not ask for a password when the email is sent back unchanged', async () => {
    const r = await patchProfile(json('PATCH', { email: 'ASHA@example.com', name: 'Asha B' }));
    expect(r.status).toBe(200);
  });

  it('refuses an address another live account holds', async () => {
    duplicateEmailRow = { id: 'someone-else' };
    const res = await patchProfile(json('PATCH', { email: 'taken@example.com', currentPassword: 'oldpassword' }));
    expect(res.status).toBe(400);
    expect(lastUpdate).toBeUndefined();
  });

  it('maps a unique-index race on the mobile to a form error, not a 500', async () => {
    updateError = Object.assign(new Error('dup'), { code: '23505', constraint_name: 'users_phone_dial_uq' });
    const res = await patchProfile(json('PATCH', { phoneNumber: '+919000000002', currentPassword: 'oldpassword' }));
    expect(res.status).toBe(400);
  });

  it('will not let a member who can sign in clear both their mobile and email', async () => {
    const res = await patchProfile(json('PATCH', { email: '', phoneNumber: '+91', currentPassword: 'oldpassword' }));
    expect(res.status).toBe(400);
    expect(lastUpdate).toBeUndefined();
  });

  it('lets a member clear their optional email while keeping the mobile', async () => {
    const res = await patchProfile(json('PATCH', { email: '', currentPassword: 'oldpassword' }));
    expect(res.status).toBe(200);
    expect(lastUpdate.email).toBeNull();
  });

  it('keeps the admin rule: an admin cannot blank their mobile', async () => {
    row.role = 'TENANT_ADMIN';
    session.role = 'TENANT_ADMIN';
    const res = await patchProfile(json('PATCH', { phoneNumber: '+91', currentPassword: 'oldpassword' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/account/password', () => {
  it('changes the password when the current one is right', async () => {
    const r = await send(await postPassword(json('POST', {
      currentPassword: 'oldpassword', newPassword: 'a-new-password',
    })));
    expect(r.status).toBe(200);
    expect(lastUpdate.passwordHash).toBe('hash:a-new-password');
    expect(lastUpdate.requiresPasswordChange).toBe(false);
    // Nothing secret is written to the trail.
    expect(JSON.stringify(writeAudit.mock.calls)).not.toContain('a-new-password');
    expect(JSON.stringify(writeAudit.mock.calls)).not.toContain('oldpassword');
  });

  it('rejects a wrong current password', async () => {
    const res = await postPassword(json('POST', { currentPassword: 'wrong', newPassword: 'a-new-password' }));
    expect(res.status).toBe(403);
    expect(lastUpdate).toBeUndefined();
  });

  it('rejects a new password that is too short', async () => {
    const res = await postPassword(json('POST', { currentPassword: 'oldpassword', newPassword: 'short' }));
    expect(res.status).toBe(400);
    expect(lastUpdate).toBeUndefined();
  });

  it('rejects reusing the current password', async () => {
    const res = await postPassword(json('POST', { currentPassword: 'oldpassword', newPassword: 'oldpassword' }));
    expect(res.status).toBe(400);
  });

  it('refuses without a session', async () => {
    session = null;
    expect((await postPassword(json('POST', { currentPassword: 'a', newPassword: 'bbbbbbbb' }))).status).toBe(401);
  });
});

describe('profile photo', () => {
  it('sniffs the real type from the bytes and refuses SVG and junk', () => {
    expect(sniffAvatarType(JPEG)).toBe('image/jpeg');
    expect(sniffAvatarType(PNG)).toBe('image/png');
    expect(sniffAvatarType(SVG)).toBeNull();
    expect(sniffAvatarType(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('stores a JPEG for the member with the sniffed type', async () => {
    const r = await send(await putAvatar(bytesReq('PUT', JPEG)));
    expect(r.status).toBe(200);
    expect(storedAvatar.userId).toBe('m1');
    expect(storedAvatar.tenantId).toBe(TENANT);
    expect(storedAvatar.contentType).toBe('image/jpeg');
    expect(r.body.avatarUrl).toMatch(/^\/api\/account\/avatar\/m1\?v=\d+$/);
  });

  it('refuses an SVG even when the client calls it a JPEG', async () => {
    const res = await putAvatar(bytesReq('PUT', SVG));
    expect(res.status).toBe(400);
    expect(storedAvatar).toBeUndefined();
  });

  it('refuses an oversized photo', async () => {
    const big = new Uint8Array(MAX_AVATAR_BYTES + 1);
    big.set(JPEG);
    expect((await putAvatar(bytesReq('PUT', big))).status).toBe(413);
    expect(storedAvatar).toBeUndefined();
  });

  it('removes the photo', async () => {
    await putAvatar(bytesReq('PUT', PNG));
    expect((await deleteAvatar(new Request('http://x/api', { method: 'DELETE' }))).status).toBe(200);
    expect(storedAvatar).toBeUndefined();
  });

  it('serves a stored photo with a pinned type and nosniff', async () => {
    storedAvatar = { userId: 'm1', contentType: 'image/png', data: Buffer.from(PNG).toString('base64') };
    const id = '11111111-1111-1111-1111-111111111111';
    const res = await getAvatar(new Request('http://x/api'), { params: Promise.resolve({ userId: id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('answers 404, never 403, for an id with no photo in this tenant', async () => {
    const id = '22222222-2222-2222-2222-222222222222';
    const res = await getAvatar(new Request('http://x/api'), { params: Promise.resolve({ userId: id }) });
    expect(res.status).toBe(404);
  });

  it('answers 404 for a malformed id', async () => {
    const res = await getAvatar(new Request('http://x/api'), { params: Promise.resolve({ userId: '../etc' }) });
    expect(res.status).toBe(404);
  });
});

describe('a SUPER_ADMIN edits their own account', () => {
  beforeEach(() => {
    session = { ...session, role: 'SUPER_ADMIN' };
    row = { ...row, role: 'SUPER_ADMIN' };
  });

  it('can rename themselves', async () => {
    const r = await send(await patchProfile(json('PATCH', { name: 'Root' })));
    expect(r.status).toBe(200);
    expect(lastUpdate.name).toBe('Root');
  });

  it('can change their password with the current one', async () => {
    const r = await send(await postPassword(json('POST', {
      currentPassword: 'oldpassword', newPassword: 'brand-new-pass-1',
    })));
    expect(r.status).toBe(200);
    expect(lastUpdate.passwordHash).toBe('hash:brand-new-pass-1');
  });

  it('is still refused a wrong current password', async () => {
    const res = await postPassword(json('POST', { currentPassword: 'nope', newPassword: 'brand-new-pass-1' }));
    expect(res.status).toBe(403);
    expect(lastUpdate).toBeUndefined();
  });

  it('can upload and remove a photo', async () => {
    expect((await putAvatar(bytesReq('PUT', JPEG))).status).toBe(200);
    expect(storedAvatar.contentType).toBe('image/jpeg');
    expect((await deleteAvatar(new Request('http://x/api', { method: 'DELETE' }))).status).toBe(200);
    expect(storedAvatar).toBeUndefined();
  });

  it('still cannot smuggle a role into the body', async () => {
    const res = await patchProfile(json('PATCH', { name: 'Root', role: 'TENANT_ADMIN' }));
    expect(res.status).toBe(400);
    expect(lastUpdate).toBeUndefined();
  });
});
