/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   PUT /api/profiles — a member saves their OWN details without `edit`    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The default member level, "Contributor", has canEdit=false, and this route
 * used to demand `profiles/edit` even for a member's own row — so almost every
 * member got "Forbidden. Editing denied." saving their own date of birth. Own
 * details need no permission; `profiles/edit` still governs editing SOMEONE
 * ELSE's, and that must keep refusing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let written: any;
vi.mock('@/lib/db', () => ({
  db: {
    query: { users: { findFirst: async () => ({ id: 'other', name: 'Other', tenantId: 't1' }) } },
    insert: () => ({
      values: (v: any) => ({
        onConflictDoUpdate: () => ({ returning: async () => { written = v; return [{ id: 'p1', ...v }]; } }),
      }),
    }),
  },
}));

// A Contributor: can view and add, cannot edit.
const contributor = {
  id: 'm1', tenantId: 't1', role: 'STANDARD', name: 'Asha',
  permissions: [{ module: 'profiles', documentKey: null, canView: true, canAdd: true, canEdit: false, canDelete: false, canShare: false }],
};
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: async () => contributor,
  hasPermission: async (u: any, m: string, a: string) =>
    !!u.permissions.find((p: any) => p.module === m)?.[`can${a[0].toUpperCase()}${a.slice(1)}`],
}));
vi.mock('@/lib/audit', async () => ({ ...(await vi.importActual<any>('@/lib/audit')), writeAudit: async () => {} }));

import { PUT } from '@/app/api/profiles/route';

const put = (body: unknown) => PUT(new Request('http://x/api/profiles', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}));

beforeEach(() => { written = undefined; });

describe('PUT /api/profiles', () => {
  it('lets a member without profiles/edit save their own details', async () => {
    const res = await put({ personalDetails: { dob: '1986-04-21' } });
    expect(res.status).toBe(200);
    expect(written.userId).toBe('m1');
    expect(written.personalDetails.dob).toBe('1986-04-21');
  });

  it("still refuses editing someone else's profile without profiles/edit", async () => {
    const res = await put({ userId: 'other', personalDetails: { dob: '1990-01-01' } });
    expect(res.status).toBe(403);
    expect(written).toBeUndefined();
  });
});
