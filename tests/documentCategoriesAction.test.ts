/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE PICKER LIST IS FILTERED FOR THE ACTION IT IS FOR                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * /api/document-categories answers "which categories may I ...?" and every
 * dropdown in the app is built from it. It used to answer only for `view`,
 * which is the wrong question for a WRITE form: the upload picker offered a
 * member with View only on Identity every Identity sub-category, and the upload
 * then 403'd on a choice the form had put in front of them.
 *
 * The list is filtered, never gated — some access shows a short list, not a
 * refusal — so these assert the CONTENTS, not the status code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ROWS = [
  { id: 'c1', moduleKey: 'identity', documentKey: 'passport', documentName: 'Passport' },
  { id: 'c2', moduleKey: 'identity', documentKey: 'pan_card', documentName: 'PAN Card' },
  { id: 'c3', moduleKey: 'medical', documentKey: 'prescriptions', documentName: 'Prescriptions' },
  // A real mirror: an ADDRESS for `insurance/vehicle_policies`, whose records
  // live in another module. See src/lib/categoryMirrors.ts.
  { id: 'c4', moduleKey: 'vehicle', documentKey: 'insurance_cross_ref', documentName: 'Vehicle insurance' },
  { id: 'c5', moduleKey: 'insurance', documentKey: 'vehicle_policies', documentName: 'Vehicle insurance' },
];
const keysIn = (body: any) => body.categories.map((c: any) => c.documentKey);

const queryChain = {
  select: () => ({
    from: () => ({ where: () => ({ orderBy: () => ROWS }) }),
  }),
};
vi.mock('@/lib/db', () => ({
  db: queryChain,
  withTenant: async (_t: string, cb: any) => cb(queryChain),
}));

const hasPermission = vi.fn(async () => true);
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => ({ id: 'u1', tenantId: 't1', role: 'STANDARD' })),
  hasPermission: (...a: any[]) => hasPermission(...(a as [])),
}));

const { GET } = await import('@/app/api/document-categories/route');

const call = async (qs = '') => {
  const res = await GET(new Request(`http://localhost/api/document-categories${qs}`));
  return { status: res.status, body: await res.json() };
};

/** The View-only member: everything readable, nothing writable. */
const viewOnly = () =>
  hasPermission.mockImplementation(async (..._a: any[]) => (_a[2] as string) === 'view');

beforeEach(() => {
  vi.clearAllMocks();
  hasPermission.mockResolvedValue(true as any);
});

describe('?action=', () => {
  it('defaults to view, so every existing caller is unchanged', async () => {
    viewOnly();
    const { status, body } = await call();

    expect(status).toBe(200);
    expect(body.categories).toHaveLength(ROWS.length);
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'identity', 'view', 'passport');
  });

  it('asks about `add` when a write form asks', async () => {
    viewOnly();
    const { body } = await call('?action=add');

    // The whole point: a View-only member is offered nothing to upload into,
    // rather than being offered everything and refused on submit.
    expect(body.categories).toEqual([]);
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'identity', 'add', 'passport');
  });

  it('returns a SUBSET of the view list, never something outside it', async () => {
    // `add` on one sub-category only.
    hasPermission.mockImplementation(async (..._a: any[]) => {
      const [, mod, action, key] = _a as any[];
      if (action === 'view') return true;
      return mod === 'identity' && key === 'passport';
    });

    const viewIds = (await call()).body.categories.map((c: any) => c.id);
    const addIds = (await call('?action=add')).body.categories.map((c: any) => c.id);

    expect(addIds).toEqual(['c1']);
    expect(addIds.every((id: string) => viewIds.includes(id))).toBe(true);
  });

  it('accepts edit', async () => {
    await call('?action=edit');
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'identity', 'edit', 'passport');
  });

  it('400s an unknown action instead of falling back to view', async () => {
    // A typo'd action silently defaulting to `view` would hand a picker the
    // permissive list — the exact bug this parameter exists to fix.
    const { status } = await call('?action=bogus');
    expect(status).toBe(400);
    expect(hasPermission).not.toHaveBeenCalled();
  });

  it('refuses delete and share — they are asked per row, not per list', async () => {
    expect((await call('?action=delete')).status).toBe(400);
    expect((await call('?action=share')).status).toBe(400);
  });
});

/**
 * ── MIRRORS ────────────────────────────────────────────────────────────────
 *
 * This one endpoint feeds the sidebar, the module page AND every picker, so it
 * is where a mirrored category has to be told apart from an ordinary one: the
 * nav wants the row (that IS the Vehicle tile), and a picker must not offer it
 * (its canonical is already in the list, and nothing is ever filed under an
 * address).
 */
describe('mirrored categories', () => {
  it('keeps the mirror in the view list — it is the module\'s tile', async () => {
    const { body } = await call();
    expect(keysIn(body)).toContain('insurance_cross_ref');
  });

  it('marks it, so a caller matching on categoryId can drop it', async () => {
    // No document carries a mirror's id, so a filter chip built from it would
    // be a guaranteed empty result. The documents page reads this flag.
    const { body } = await call();
    const mirror = body.categories.find((c: any) => c.documentKey === 'insurance_cross_ref');
    expect(mirror.mirrorOf).toEqual({ moduleKey: 'insurance', documentKey: 'vehicle_policies' });
    const ordinary = body.categories.find((c: any) => c.documentKey === 'passport');
    expect(ordinary.mirrorOf).toBeNull();
  });

  it('drops it from an add picker, so the category is offered exactly once', async () => {
    const { body } = await call('?action=add');
    expect(keysIn(body)).not.toContain('insurance_cross_ref');
    // The place those documents actually go is still on offer.
    expect(keysIn(body)).toContain('vehicle_policies');
  });

  it('drops it from an edit picker for the same reason', async () => {
    const { body } = await call('?action=edit');
    expect(keysIn(body)).not.toContain('insurance_cross_ref');
  });

  it('asks the CANONICAL permission, not the module the row is listed under', async () => {
    // A mirror must not be a way around the permission of the module that holds
    // the records — and must not be deniable from one that does not.
    hasPermission.mockImplementation(
      async (..._a: any[]) => (_a[1] as string) !== 'insurance',
    );
    const { body } = await call();
    expect(keysIn(body)).not.toContain('insurance_cross_ref');
    expect(keysIn(body)).not.toContain('vehicle_policies');
    expect(keysIn(body)).toContain('passport');
  });
});
