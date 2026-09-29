/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   REMOVING A MEMBER — what must and must not go with them         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * This route used to be `tx.delete(users)`. Every `ON DELETE CASCADE` pointing
 * at `users.id` fired behind it and destroyed the member's documents, their
 * password vault, their wrapped vault key and their whole `audit_logs` history
 * — none of it through the deletion pipeline, so the ciphertext stayed on the
 * tenant's Drive forever while the rows referencing it vanished.
 *
 * Five failure modes these tests exist to prevent, four of them silent:
 *
 *   1. A destructive default. An older client that sends no body must not be
 *      able to delete records by omission.
 *   2. Access surviving the removal — a retained row whose permissions, vault
 *      key or devices are still live is worse than a hard delete.
 *   3. Deleting records the admin did NOT tick.
 *   4. An id from another tenant (or another member of this one) reaching the
 *      update because the `inArray` was trusted instead of the predicate.
 *   5. Tombstoning the rows but never taking them off Drive.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getUserFromRequest = vi.fn();
const writeAudit = vi.fn();

/** Every statement the route ran, so the predicates can be asserted. */
const capture: {
  tenantIds: string[];
  deletes: any[];
  updates: Array<{ set: any; where: any }>;
  selects: any[];
} = { tenantIds: [], deletes: [], updates: [], selects: [] };

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: (...a: any[]) => getUserFromRequest(...a),
  hashPassword: vi.fn(),
  // The household gate `resolveUtilityCompany` asks on the personal path. This
  // caller is a tenant admin, for whom the real function short-circuits to true.
  hasPersonalAccess: () => true,
}));
// Both gates: `requireActivePlan` is the account-level one and
// `requireActivePlanFor` the per-workspace one that `resolveUtilityCompany`
// and `withRecordScope` now call. A mock missing either throws inside the
// route and surfaces as a 500 on an assertion about something else.
vi.mock('@/lib/planGate', () => ({
  requireActivePlan: () => null,
  requireActivePlanFor: () => null,
}));
vi.mock('@/lib/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit')>()),
  writeAudit: (...a: any[]) => writeAudit(...a),
}));

/**
 * Drive is a remote service; the purge that follows the tombstone is stubbed at
 * the seam. What it does with the rows it is handed has its own contract in
 * tests/documentPurge.test.ts — here only the handoff matters.
 */
const purgeDeletedDocuments = vi.fn();
const invalidateAnalysisCache = vi.fn();
vi.mock('@/lib/records/documentPurge', () => ({
  purgeDeletedDocuments: (...a: any[]) => purgeDeletedDocuments(...a),
  invalidateAnalysisCache: (...a: any[]) => invalidateAnalysisCache(...a),
}));

/** The member the route resolves from the path param, or null for "no such". */
let targetUser: any = null;
/** Rows the pre-update SELECT finds — where the Drive pointers come from. */
let selectReturns: any[] = [];
/** Rows each UPDATE ... RETURNING reports, in call order. */
let updateReturns: any[][] = [];

vi.mock('@/lib/db', () => ({
  db: {},
  withTenant: vi.fn(async (tenantId: string, cb: any) => {
    capture.tenantIds.push(tenantId);
    let updateCall = 0;
    return cb({
      query: { users: { findFirst: async () => targetUser } },
      select: () => ({
        from: () => ({
          where: (w: any) => {
            capture.selects.push(w);
            return Promise.resolve(selectReturns);
          },
        }),
      }),
      update: () => ({
        set: (set: any) => ({
          where: (where: any) => {
            capture.updates.push({ set, where });
            const rows = updateReturns[updateCall++] ?? [];
            // `revokeMemberAccess` does not call .returning(); the record
            // updates do. A thenable covers both without two fake shapes.
            return Object.assign(Promise.resolve(rows), {
              returning: async () => rows,
            });
          },
        }),
      }),
      delete: () => ({
        where: (w: any) => {
          capture.deletes.push(w);
          return Promise.resolve([]);
        },
      }),
      insert: () => ({ values: async () => [] }),
    });
  }),
}));

const { DELETE } = await import('@/app/api/users/[id]/route');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const ADMIN = { id: '99999999-9999-4999-8999-999999999999', tenantId: TENANT_A, role: 'TENANT_ADMIN' };

const MEMBER_ID = 'dddddddd-4444-4444-8444-dddddddddddd';
const DOC_1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const DOC_2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const PWD_1 = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
/** Belongs to another tenant. The route must never learn anything about it. */
const FOREIGN_DOC = 'cccccccc-3333-4333-8333-cccccccccccc';

// `name` is NOT NULL on users and is what the audit trail names a member by —
// the email is PII that would otherwise sit unencrypted in a table that is
// never purged.
const MEMBER = {
  id: MEMBER_ID, tenantId: TENANT_A, role: 'STANDARD',
  name: 'Kid Krishnan', email: 'kid@example.com',
};

const remove = (body: unknown, id = MEMBER_ID) =>
  DELETE(
    new Request(`http://localhost/api/users/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  capture.tenantIds = [];
  capture.deletes = [];
  capture.updates = [];
  capture.selects = [];
  selectReturns = [];
  updateReturns = [];
  targetUser = MEMBER;
  getUserFromRequest.mockResolvedValue(ADMIN);
});

/**
 * How many times a value is bound into a built Drizzle predicate.
 *
 * The predicate is a live SQL object holding table references, so it cannot be
 * serialised — this walks it instead, guarding against the cycles those
 * references create.
 */
function countBound(node: any, needle: string, seen = new Set<any>()): number {
  if (node === needle) return 1;
  if (node === null || typeof node !== 'object' || seen.has(node)) return 0;
  seen.add(node);
  return Object.values(node).reduce<number>((n, v) => n + countBound(v, needle, seen), 0);
}

describe('the gate', () => {
  it('refuses a caller who is not an admin', async () => {
    getUserFromRequest.mockResolvedValue({ ...ADMIN, role: 'STANDARD' });
    expect((await remove({ mode: 'retain' })).status).toBe(403);
  });

  it('404s a member who is not in this tenant', async () => {
    targetUser = undefined;
    expect((await remove({ mode: 'retain' })).status).toBe(404);
  });

  it('refuses to remove the caller themselves', async () => {
    targetUser = { ...MEMBER, id: ADMIN.id };
    expect((await remove({ mode: 'retain' }, ADMIN.id)).status).toBe(400);
  });

  it('will not let a tenant admin touch a SUPER_ADMIN', async () => {
    targetUser = { ...MEMBER, role: 'SUPER_ADMIN' };
    expect((await remove({ mode: 'retain' })).status).toBe(403);
  });
});

describe('the choice is required, never assumed', () => {
  it('400s a STANDARD member removed with no body at all', async () => {
    // The failure mode: a client that predates the dialog falling through to
    // some default. Neither path may be reachable by omission.
    expect((await remove(undefined)).status).toBe(400);
    expect(capture.updates).toHaveLength(0);
    expect(capture.deletes).toHaveLength(0);
  });

  it('400s a malformed or unknown mode', async () => {
    expect((await remove({ mode: 'purge' })).status).toBe(400);
    expect((await remove({})).status).toBe(400);
  });

  it('refuses an unbounded selection', async () => {
    const many = Array.from({ length: 501 }, () => DOC_1);
    expect((await remove({ mode: 'delete', documentIds: many })).status).toBe(400);
  });

  it('does not require a body for an admin, who holds no records', async () => {
    // Only a STANDARD member can be a record HOLDER, so only their removal has
    // a choice to make.
    targetUser = { ...MEMBER, role: 'TENANT_ADMIN' };
    expect((await remove(undefined)).status).toBe(200);
  });

  it('ignores a delete aimed at an admin rather than honouring it', async () => {
    targetUser = { ...MEMBER, role: 'TENANT_ADMIN' };
    await remove({ mode: 'delete', documentIds: [DOC_1] });
    // Only revokeMemberAccess's single update on `users` — no record tombstone.
    expect(capture.updates).toHaveLength(1);
    expect(capture.updates[0].set).toHaveProperty('deletedAt');
  });
});

describe('access is revoked on BOTH paths', () => {
  for (const mode of ['retain', 'delete'] as const) {
    it(`destroys permissions, vault keys and devices on '${mode}'`, async () => {
      await remove({ mode, documentIds: [], passwordIds: [] });
      // permissions + user_vault_keys + user_devices.
      expect(capture.deletes).toHaveLength(3);
    });

    it(`soft-deletes the user and clears its bearer secrets on '${mode}'`, async () => {
      await remove({ mode, documentIds: [], passwordIds: [] });
      const userUpdate = capture.updates[0].set;
      expect(userUpdate.deletedAt).toBeInstanceOf(Date);
      // A live reset token is a way back into an account just revoked.
      expect(userUpdate.resetToken).toBeNull();
      expect(userUpdate.resetTokenExpiry).toBeNull();
      expect(userUpdate.emailVerificationOtp).toBeNull();
    });
  }

  it('never hard-deletes the user row', async () => {
    // The retained row is what keeps `holder_id` resolving and what saves the
    // member's audit trail. A cascade would take both.
    await remove({ mode: 'retain' });
    expect(capture.updates.some((u) => 'deletedAt' in u.set)).toBe(true);
  });

  it('tombstones the email so the address is not locked globally', async () => {
    // `users.email` is globally unique, so a retained row would hold the
    // address for every tenant, forever.
    await remove({ mode: 'retain' });
    const email = capture.updates[0].set.email;
    expect(email).not.toBe(MEMBER.email);
    expect(email).toContain(MEMBER.email);
    expect(email).toMatch(/^removed\.\d+\./);
  });
});

describe("the 'retain' path keeps every record", () => {
  it('tombstones nothing and purges nothing', async () => {
    await remove({ mode: 'retain' });
    // One update only — the user row. No document, no password.
    expect(capture.updates).toHaveLength(1);
    expect(purgeDeletedDocuments).not.toHaveBeenCalled();
  });

  it('ignores ids sent alongside retain', async () => {
    // A stale picker selection left in the body must not delete anything when
    // the admin chose to keep the records.
    await remove({ mode: 'retain', documentIds: [DOC_1], passwordIds: [PWD_1] });
    expect(capture.updates).toHaveLength(1);
  });
});

describe("the 'delete' path deletes exactly what was ticked", () => {
  it('tombstones the documents through the shared helper, not by hand', async () => {
    selectReturns = [{ id: DOC_1, categoryModuleKey: 'identity', categoryDocumentKey: 'pan_card', fileDriveId: 'drive-1' }];
    updateReturns = [[], [{ id: DOC_1, title: 'PAN Card' }]];

    await remove({ mode: 'delete', documentIds: [DOC_1] });

    const docUpdate = capture.updates[1].set;
    // deletedDocumentState(): status flips, the URL is cleared and the Drive
    // pointer is nulled. A bare deleted_at stamp would leave the row reachable.
    expect(docUpdate.status).toBe('deleted');
    expect(docUpdate.filePath).toBeNull();
    expect(docUpdate.fileDriveId).toBeNull();
  });

  it('reads the Drive pointers BEFORE the update that nulls them', async () => {
    selectReturns = [{ id: DOC_1, categoryModuleKey: 'identity', categoryDocumentKey: 'pan_card', fileDriveId: 'drive-1' }];
    updateReturns = [[], [{ id: DOC_1, title: 'PAN Card' }]];

    await remove({ mode: 'delete', documentIds: [DOC_1] });

    // Sourcing them from the update's RETURNING would always find null and
    // silently purge nothing.
    expect(capture.selects).toHaveLength(1);
    expect(purgeDeletedDocuments).toHaveBeenCalledWith(
      ADMIN,
      [expect.objectContaining({ fileDriveId: 'drive-1' })],
    );
  });

  it('purges only the documents the update actually matched', async () => {
    // The SELECT and the UPDATE share a predicate, but a row can be tombstoned
    // by a concurrent request between them. Purging a Drive object for a row
    // this request did not delete would destroy someone else's bytes.
    selectReturns = [
      { id: DOC_1, categoryModuleKey: 'identity', categoryDocumentKey: 'pan_card', fileDriveId: 'drive-1' },
      { id: DOC_2, categoryModuleKey: 'identity', categoryDocumentKey: 'passport', fileDriveId: 'drive-2' },
    ];
    updateReturns = [[], [{ id: DOC_1, title: 'PAN Card' }]];

    await remove({ mode: 'delete', documentIds: [DOC_1, DOC_2] });

    const purged = purgeDeletedDocuments.mock.calls[0][1];
    expect(purged.map((r: any) => r.id)).toEqual([DOC_1]);
  });

  it('takes the passwords with them and drops the stale AI analysis', async () => {
    selectReturns = [{ id: DOC_1, categoryModuleKey: 'identity', categoryDocumentKey: 'pan_card', fileDriveId: 'drive-1' }];
    updateReturns = [[], [{ id: DOC_1, title: 'PAN Card' }], [{ id: PWD_1, title: 'Netflix' }]];

    const res = await remove({ mode: 'delete', documentIds: [DOC_1], passwordIds: [PWD_1] });

    expect((await res.json()).deleted).toEqual({ documents: 1, passwords: 1 });
    expect(invalidateAnalysisCache).toHaveBeenCalledWith(TENANT_A);
  });

  it('audits one row per record, plus the removal itself', async () => {
    selectReturns = [{ id: DOC_1, categoryModuleKey: 'identity', categoryDocumentKey: 'pan_card', fileDriveId: null }];
    updateReturns = [[], [{ id: DOC_1, title: 'PAN Card' }], [{ id: PWD_1, title: 'Netflix' }]];

    await remove({ mode: 'delete', documentIds: [DOC_1], passwordIds: [PWD_1] });

    // Collapsing them would lose which records were destroyed.
    const details = writeAudit.mock.calls.map((c) => c[0].details);
    expect(details).toHaveLength(3);
    expect(details[0]).toContain('PAN Card');
    expect(details[1]).toContain('Netflix');
    // By NAME, not by address: the trail is unencrypted and never purged.
    expect(details[2]).toContain(MEMBER.name);
    expect(details[2]).not.toContain(MEMBER.email);

    // And the per-record lines name them too. "Deleted because the member was
    // removed" cannot say WHICH member once the holder row is gone.
    expect(details[0]).toContain(MEMBER.name);
    expect(details[1]).toContain(MEMBER.name);
  });

  it('de-duplicates a repeated id before it reaches SQL', async () => {
    selectReturns = [{ id: DOC_1, categoryModuleKey: 'identity', categoryDocumentKey: 'pan_card', fileDriveId: null }];
    updateReturns = [[], [{ id: DOC_1, title: 'PAN Card' }]];

    await remove({ mode: 'delete', documentIds: [DOC_1, DOC_1, DOC_1] });

    // The audit row count cannot show this — it comes from RETURNING, which a
    // repeated id in the IN list would not duplicate anyway. What dedupe
    // actually prevents is the id being bound three times, so that is what is
    // asserted: the built predicate must carry exactly one copy.
    expect(countBound(capture.updates[1].where, DOC_1)).toBe(1);
  });

  it('runs no record statement at all when nothing was ticked', async () => {
    await remove({ mode: 'delete', documentIds: [], passwordIds: [] });
    expect(capture.updates).toHaveLength(1);
    expect(capture.selects).toHaveLength(0);
  });
});

describe('tenant isolation', () => {
  it("runs inside withTenant for the CALLER's tenant", async () => {
    await remove({ mode: 'delete', documentIds: [DOC_1] });
    // The lookup and the mutation, both scoped to the session tenant — never a
    // tenantId taken from the request.
    expect(new Set(capture.tenantIds)).toEqual(new Set([TENANT_A]));
  });

  it("reports another tenant's id as simply not deleted", async () => {
    // The UPDATE matched only this tenant's row. The response is a COUNT, not a
    // per-id verdict, so it cannot be used to probe for other members' ids.
    selectReturns = [{ id: DOC_1, categoryModuleKey: 'identity', categoryDocumentKey: 'pan_card', fileDriveId: null }];
    updateReturns = [[], [{ id: DOC_1, title: 'Mine' }]];

    const res = await remove({ mode: 'delete', documentIds: [DOC_1, FOREIGN_DOC] });
    const body = await res.json();

    expect(body.deleted.documents).toBe(1);
    expect(JSON.stringify(body)).not.toContain(FOREIGN_DOC);
    expect(JSON.stringify(body)).not.toContain('Forbidden');
  });

  it('builds one scoped statement per table, not a per-id loop', async () => {
    selectReturns = [];
    updateReturns = [[], [], []];
    await remove({ mode: 'delete', documentIds: [DOC_1, DOC_2], passwordIds: [PWD_1] });
    // users + documents + passwords. A loop could run a query outside the RLS
    // session var.
    expect(capture.updates).toHaveLength(3);
  });
});
