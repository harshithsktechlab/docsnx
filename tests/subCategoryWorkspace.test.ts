/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE SUB-CATEGORY WORKSPACE — its gate, its write path, its spec        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `/modules/:moduleKey/:documentKey` is addressed by a taxonomy pair rather
 * than by a scope, which means it has its own gate (`withCategory`) and its own
 * normaliser (`toTaxonomyRecordFromFields`). Both replace something that used
 * to be enforced elsewhere, so both are asserted here:
 *
 *  - the gate must NARROW to one category. If it merely delegated to
 *    `withRecordScope`, a member with access to any category of the scope could
 *    read and write every other category on that page — the exact failure 0024
 *    exists to prevent.
 *  - the normaliser must treat the spec as an ALLOWLIST. Its legacy sibling
 *    passes unknown keys through (a bulk scan legitimately extracts undeclared
 *    fields); a form payload is attacker-controlled, and an undeclared key is
 *    one no encryption policy classifies — i.e. one that lands in Postgres in
 *    the clear.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getUserFromRequest = vi.fn();
const hasPermission = vi.fn();

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: (...a: any[]) => getUserFromRequest(...a),
  hasPermission: (...a: any[]) => hasPermission(...a),
}));
vi.mock('@/lib/db', () => ({
  db: {},
  withTenant: vi.fn(async (_t: string, cb: any) => cb({
    select: () => ({ from: () => ({ leftJoin: () => ({ where: () => ({ orderBy: async () => [] }) }) }) }),
  })),
}));
vi.mock('@/lib/vault/vaultRecords', () => ({ readJsonStore: vi.fn() }));

const { withCategory } = await import('@/lib/records/handler');
const { toTaxonomyRecordFromFields, REMINDER_FIELD_KEYS } = await import('@/lib/records/normalize');
const {
  DOCUMENT_CATEGORY_FIELD_SPECS, encryptedFieldsFor, fieldsFor,
} = await import('@/lib/documentCategoryFields');
const { DOCUMENT_CATEGORY_SEED } = await import('@/lib/documentCategories');
const { NAV_MODULES, TENANT_SPECIFIC_PATHS, subCategoryPath } = await import('@/lib/moduleRegistry');

const req = new Request('http://localhost/api/modules/identity/pan_card');
const STANDARD = { id: 'u1', tenantId: 't1', role: 'STANDARD' };
const PAN = { moduleKey: 'identity', documentKey: 'pan_card' };

beforeEach(() => {
  vi.clearAllMocks();
  getUserFromRequest.mockResolvedValue(STANDARD);
  hasPermission.mockResolvedValue(true);
});

describe('withCategory — the gate', () => {
  it('404s an unseeded pair BEFORE authenticating', async () => {
    const res = await withCategory(
      req, { moduleKey: 'identity', documentKey: 'not_a_category' }, 'view',
      async () => new Response('should not run'),
    );
    expect(res.status).toBe(404);
    expect(getUserFromRequest).not.toHaveBeenCalled();
  });

  it('401s an anonymous caller', async () => {
    getUserFromRequest.mockResolvedValue(null);
    const res = await withCategory(req, PAN, 'view', async () => new Response('nope'));
    expect(res.status).toBe(401);
  });

  it('403s SUPER_ADMIN — a platform role does not read tenant records', async () => {
    getUserFromRequest.mockResolvedValue({ ...STANDARD, role: 'SUPER_ADMIN' });
    const res = await withCategory(req, PAN, 'view', async () => new Response('nope'));
    expect(res.status).toBe(403);
  });

  it('narrows ctx.keys to the ONE category, not the whole scope', async () => {
    // `identity/pan_card` is owned by the `documents` scope, which spans 18
    // categories. Handing the handler all of them would let this page read
    // passports, marksheets and marriage certificates.
    let seen: any = null;
    await withCategory(req, PAN, 'view', async (ctx) => {
      seen = ctx.keys;
      return new Response('ok');
    });
    expect(seen).toEqual([PAN]);
  });

  it('403s when the caller holds the module but is denied THIS sub-category', async () => {
    hasPermission.mockImplementation(
      async (_u: any, _m: string, _a: string, documentKey?: string) => documentKey !== 'pan_card',
    );
    const res = await withCategory(req, PAN, 'view', async () => new Response('should not run'));
    expect(res.status).toBe(403);
  });

  it('asks about the action it was given, not just view', async () => {
    await withCategory(req, PAN, 'add', async () => new Response('ok'));
    expect(hasPermission).toHaveBeenCalledWith(STANDARD, 'identity', 'add', expect.any(String));
  });

  /**
   * ── A MIRROR ADDRESS RESOLVES TO THE CATEGORY THAT OWNS THE RECORDS ──────
   *
   * `/modules/vehicle/insurance_cross_ref` is a second way to reach
   * `insurance/vehicle_policies` (src/lib/categoryMirrors.ts). The gate is what
   * makes that true for the whole route surface at once — list, read, create,
   * edit and delete all filter on `ctx.keys` — so it is also the one place the
   * mirror could become a way AROUND the Insurance permission. Both halves are
   * asserted here.
   */
  describe('a mirrored category', () => {
    const ALIAS = { moduleKey: 'vehicle', documentKey: 'insurance_cross_ref' };
    const CANONICAL = { moduleKey: 'insurance', documentKey: 'vehicle_policies' };

    it('narrows ctx.keys to the CANONICAL pair, so the page lists the policies', async () => {
      let seen: any = null;
      await withCategory(req, ALIAS, 'view', async (ctx) => {
        seen = ctx.keys;
        return new Response('ok');
      });
      // Not the alias: no record is stored under it, so listing on it would
      // show an empty page under a tile that says it has records.
      expect(seen).toEqual([CANONICAL]);
    });

    it('resolves to the scope that owns the canonical, not the alias', async () => {
      let scope: string | null = null;
      await withCategory(req, ALIAS, 'view', async (ctx) => {
        scope = ctx.scope;
        return new Response('ok');
      });
      expect(scope).toBe('lic_mediclaim');
    });

    it('gates on the Insurance permission — a mirror is not a second door', async () => {
      // Every Vehicle right in the world, denied Insurance. This is the whole
      // security story of mirroring: permission follows the data.
      hasPermission.mockImplementation(
        async (_u: any, moduleKey: string) => moduleKey !== 'insurance',
      );
      const res = await withCategory(req, ALIAS, 'view', async () => new Response('should not run'));
      expect(res.status).toBe(403);
    });

    it('opens on the Insurance permission alone, without the alias key', async () => {
      // The alias's own permission row is deliberately not consulted: it would
      // let a module that does not own the data deny access to it.
      hasPermission.mockImplementation(
        async (_u: any, _m: string, _a: string, documentKey?: string) =>
          documentKey !== 'insurance_cross_ref',
      );
      let ran = false;
      const res = await withCategory(req, ALIAS, 'view', async () => {
        ran = true;
        return new Response('ok');
      });
      expect(res.status).toBe(200);
      expect(ran).toBe(true);
    });

    it('still 404s a pair that is in no taxonomy, before canonicalising', async () => {
      // Canonicalisation must never rescue a fabricated pair into a real one.
      const res = await withCategory(
        req, { moduleKey: 'vehicle', documentKey: 'insurance_cross_reff' }, 'view',
        async () => new Response('should not run'),
      );
      expect(res.status).toBe(404);
      expect(getUserFromRequest).not.toHaveBeenCalled();
    });
  });
});

describe('toTaxonomyRecordFromFields', () => {
  const specs = fieldsFor(PAN);

  it('keeps only keys the category declares', () => {
    const out = toTaxonomyRecordFromFields(specs, {
      pan_number: 'ABCDE1234F',
      // Not a PAN Card field. An undeclared key is one the encryption policy
      // does not name, so accepting it would write it to the open tier.
      account_number: '123456789012',
    });
    expect(out.record.pan_number).toBe('ABCDE1234F');
    expect(out.record.account_number).toBeUndefined();
  });

  it('drops blanks rather than storing empty values', () => {
    const out = toTaxonomyRecordFromFields(specs, { pan_number: '', notes: null });
    expect(out.record).toEqual({});
  });

  it('emits a blind index ONLY for the scope’s dedupe fields', () => {
    const out = toTaxonomyRecordFromFields(specs, { pan_number: 'ABCDE1234F' }, ['pan_number']);
    expect(out.searchHashes.pan_number).toBeTruthy();

    const none = toTaxonomyRecordFromFields(specs, { pan_number: 'ABCDE1234F' }, []);
    expect(none.searchHashes).toEqual({});
  });

  it('masks a sealed identifier so a list can render it without the plaintext', () => {
    const out = toTaxonomyRecordFromFields(specs, { pan_number: 'ABCDE1234F' }, ['pan_number']);
    expect(out.masked.pan_number).toBeTruthy();
    expect(out.masked.pan_number).not.toBe('ABCDE1234F');
  });

  it('does not mask an open field — a mask on a readable value is just noise', () => {
    const out = toTaxonomyRecordFromFields(specs, { document_title: 'Priya PAN' });
    expect(out.masked.document_title).toBeUndefined();
  });

  it('derives a reminder from a deadline date, labelled as the form labelled it', () => {
    const rc = fieldsFor({ moduleKey: 'vehicle', documentKey: 'registration_certificate' });
    const validTo = rc.find((f) => f.fieldKey === 'valid_to');
    expect(validTo, 'the RC still declares valid_to').toBeTruthy();

    const out = toTaxonomyRecordFromFields(rc, { valid_to: '2030-06-01' });
    expect(out.reminders).toHaveLength(1);
    expect(out.reminders[0].key).toBe('valid_to');
    expect(out.reminders[0].label).toBe(validTo!.fieldLabel);
    expect(out.nextDueAt).toBe(new Date('2030-06-01').toISOString());
  });

  it('does not remind about a date that merely records when something happened', () => {
    // `issue_date` is on almost every category. Treating it as a deadline would
    // put a permanently-overdue item on every record in the vault.
    expect(REMINDER_FIELD_KEYS.has('issue_date')).toBe(false);
    const out = toTaxonomyRecordFromFields(specs, { issue_date: '2019-04-02' });
    expect(out.reminders).toEqual([]);
    expect(out.nextDueAt).toBeNull();
  });

  it('never sets nextDueAt from a resolved reminder', () => {
    const bill = fieldsFor({ moduleKey: 'utility_bills', documentKey: 'electricity' });
    const out = toTaxonomyRecordFromFields(bill, { due_date: '2026-01-10', isPaid: 'true' });
    expect(out.nextDueAt).toBeNull();
  });
});

describe('the stored field spec', () => {
  it('covers every seeded category, and none is empty', () => {
    // An empty spec renders an add form with no inputs, which reads as a broken
    // page rather than as a missing seed.
    expect(DOCUMENT_CATEGORY_FIELD_SPECS).toHaveLength(DOCUMENT_CATEGORY_SEED.length);
    for (const row of DOCUMENT_CATEGORY_FIELD_SPECS) {
      expect(row.fields.length, `${row.moduleKey}/${row.documentKey}`).toBeGreaterThan(0);
    }
  });

  it('orders fields by sortOrder, so a JSON round trip keeps the form’s order', () => {
    for (const row of DOCUMENT_CATEGORY_FIELD_SPECS) {
      const orders = row.fields.map((f) => f.sortOrder);
      expect(orders, `${row.moduleKey}/${row.documentKey}`).toEqual([...orders].sort((a, b) => a - b));
    }
  });
});

describe('mandatory fields', () => {
  it('requires a title in every category', () => {
    // The write path has always refused an empty title. Until this was set, the
    // stored spec said otherwise, so no form marked it and a user learned it was
    // mandatory only by having their record rejected.
    for (const row of DOCUMENT_CATEGORY_SEED) {
      const title = fieldsFor(row).find((f) => f.fieldKey === 'document_title');
      expect(title?.isRequired, `${row.moduleKey}/${row.documentKey}`).toBe(true);
    }
  });

  it('asks for something beyond the title in every real category', () => {
    // `other/uncategorized` is the exception and must stay one: it holds scans
    // whose module could not be identified, so demanding a specific field of it
    // would block the very records that most need somewhere to land.
    const bare = DOCUMENT_CATEGORY_SEED.filter((row) =>
      !fieldsFor(row).some((f) => f.isRequired && f.fieldKey !== 'document_title'));
    expect(bare.map((r) => `${r.moduleKey}/${r.documentKey}`)).toEqual(['other/uncategorized']);
  });

  it('requires the deadline on the documents that exist to be renewed', () => {
    // A follow-up that never fires because the date was optional is this
    // product's quietest failure — the record looks filed and the renewal is
    // simply never raised.
    const mustHaveDeadline: Array<[string, string, string]> = [
      ['insurance', 'health_policies', 'renewal_due_date'],
      ['insurance', 'vehicle_policies', 'valid_to'],
      ['insurance', 'term_policies', 'renewal_due_date'],
      ['vehicle', 'registration_certificate', 'valid_to'],
      ['vehicle', 'puc_certificate', 'valid_to'],
      ['warranty_amc', 'appliance_warranties', 'warranty_expiry'],
      ['warranty_amc', 'amc_contracts', 'valid_to'],
      ['rentals_subscriptions', 'rental_agreements', 'lease_to'],
      ['rentals_subscriptions', 'subscription_receipts', 'renewal_due_date'],
      ['utility_bills', 'electricity', 'due_date'],
      ['identity', 'passport', 'expiry_date'],
      ['identity', 'driving_license', 'expiry_date'],
    ];
    for (const [moduleKey, documentKey, fieldKey] of mustHaveDeadline) {
      const spec = fieldsFor({ moduleKey, documentKey }).find((f) => f.fieldKey === fieldKey);
      expect(spec, `${moduleKey}/${documentKey}.${fieldKey} exists`).toBeTruthy();
      expect(spec?.isRequired, `${moduleKey}/${documentKey}.${fieldKey} required`).toBe(true);
    }
  });

  it('does not force a date onto documents that legitimately have none', () => {
    // A power of attorney can be perpetual, a disability certificate permanent,
    // a senior-citizen card for life. Demanding an expiry would make the user
    // invent one, and an invented date raises a false renewal later.
    const mustStayOptional: Array<[string, string, string]> = [
      ['property_legal', 'power_of_attorney', 'valid_to'],
      ['health_medical', 'disability_certificate', 'valid_to'],
      ['civil_government', 'senior_citizen_card', 'valid_to'],
      ['biz_contracts', 'client_customer_contracts', 'valid_to'],
    ];
    for (const [moduleKey, documentKey, fieldKey] of mustStayOptional) {
      const spec = fieldsFor({ moduleKey, documentKey }).find((f) => f.fieldKey === fieldKey);
      expect(spec?.isRequired, `${moduleKey}/${documentKey}.${fieldKey}`).toBeFalsy();
    }
  });

  it('never marks a hidden field required', () => {
    // The form renders neither `holder_name` (the "Belongs to" picker owns it)
    // nor `custom_fields`. Requiring one would make every form in that category
    // unsubmittable with nothing on screen to explain why.
    for (const row of DOCUMENT_CATEGORY_SEED) {
      for (const key of ['holder_name', 'custom_fields']) {
        const spec = fieldsFor(row).find((f) => f.fieldKey === key);
        expect(spec?.isRequired, `${row.moduleKey}/${row.documentKey}.${key}`).toBeFalsy();
      }
    }
  });

  it('leaves a past-dated fact out of the reminder keys', () => {
    // `retirement_date` on a pension order records when someone retired. As a
    // deadline it would be permanently overdue for every pensioner, and no
    // action could ever clear it.
    expect(REMINDER_FIELD_KEYS.has('retirement_date')).toBe(false);
  });
});

/**
 * `custom_fields` was SEALED from 0025 until drizzle/0038, on the reasoning that
 * a field nobody declared is the likeliest place for an account number someone
 * had nowhere else to put. That was overruled deliberately by the platform
 * owner: it is the free-text remainder and is wanted readable.
 *
 * These assertions are the inverse of the ones they replace, kept rather than
 * deleted because the direction is now the thing worth pinning — a future
 * change that quietly re-seals it would be as much a surprise as one that
 * unsealed it used to be.
 */
describe('custom_fields is plain text everywhere', () => {
  it('is still declared by every category', () => {
    // Unsealed, not removed. It remains the escape hatch on every form.
    for (const row of DOCUMENT_CATEGORY_SEED) {
      const keys = fieldsFor(row).map((f) => f.fieldKey);
      expect(keys, `${row.moduleKey}/${row.documentKey}`).toContain('custom_fields');
    }
  });

  it('is in no category’s encrypt list', () => {
    for (const row of DOCUMENT_CATEGORY_SEED) {
      expect(encryptedFieldsFor(row), `${row.moduleKey}/${row.documentKey}`)
        .not.toContain('custom_fields');
    }
  });

  it('is opened even when the STORED policy still seals it', async () => {
    // The mirror of the case this replaces. Every stored policy written before
    // 0038 still names custom_fields, so the code floor — not the migration —
    // is what makes the behaviour uniform. Without it the field would be
    // readable for tenants whose seed had run and sealed for everyone else.
    const { loadEncryptionPolicy } = await import('@/lib/vault/fieldSplitter');
    const { BASELINE_OPEN_KEYS, BASELINE_SEALED_KEYS } =
      await import('@/lib/documentCategoryFields');

    expect(BASELINE_OPEN_KEYS).toContain('custom_fields');
    expect(BASELINE_SEALED_KEYS).not.toContain('custom_fields');
    // The two floors must never name the same key, or the order in which
    // withBaseline applies them would silently decide the outcome.
    for (const key of BASELINE_OPEN_KEYS) {
      expect(BASELINE_SEALED_KEYS, `${key} is on both floors`).not.toContain(key);
    }

    const chain: any = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      // A row exactly as 0025 left it.
      limit: () => Promise.resolve([{ encryptedFields: 'pan_number,notes,custom_fields' }]),
      then: (ok: any, err: any) => Promise.resolve([]).then(ok, err),
    };
    const policy = await loadEncryptionPolicy({ select: () => chain } as any,
      { moduleKey: 'identity', documentKey: 'pan_card' });

    expect(policy).not.toContain('custom_fields');
    // …and the other free-text baseline key is untouched by the change.
    expect(policy).toContain('notes');
  });

  it('is stripped from every stored policy by migration 0038', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const sql = readFileSync(
      join(__dirname, '..', 'drizzle', '0038_custom_fields_plaintext.sql'), 'utf8');
    expect(sql).toMatch(/UPDATE "document_category_fields"/);
    expect(sql).toMatch(/custom_fields/);
    // It must refuse to leave a row still sealing it…
    expect(sql).toMatch(/still seal custom_fields/);
    // …and refuse to have taken `notes` down with it, which a strip broad
    // enough to catch both would be: a silent, tenant-wide leak.
    expect(sql).toMatch(/stopped sealing notes/);
  });
});

describe('navigation points at the workspace', () => {
  it('every sub-category links to /modules/<moduleKey>/<documentKey>', () => {
    for (const mod of NAV_MODULES) {
      for (const sub of mod.subCategories) {
        expect(sub.path).toBe(`/modules/${mod.key}/${sub.documentKey}`);
        expect(sub.path).toBe(subCategoryPath(mod.key, sub.documentKey));
      }
    }
  });

  it('every module owns its own landing page — no two share one', () => {
    // Three modules used to resolve to /documents, so all three lit up as
    // active at once and the sidebar needed a `sharesPath` workaround.
    const paths = NAV_MODULES.map((m) => m.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('guards the whole module tree against SUPER_ADMIN', () => {
    expect(TENANT_SPECIFIC_PATHS).toContain('/modules');
  });
});
