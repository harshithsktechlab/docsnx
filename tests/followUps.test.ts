/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   FOLLOW-UPS — every module's renewals, not two of them                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `collectFollowUps` used to skip any row whose `categoryModuleKey` was not in
 * `RECORD_SCOPE_KEYS` — comparing a TAXONOMY MODULE key against SCOPE keys. The
 * two vocabularies overlap in exactly two strings (`utility_bills` and
 * `tax_compliance`), so reminders for the other twelve modules were dropped
 * before anything read them: insurance renewals, vehicle PUC and fitness,
 * warranty expiry, rental agreements. Silently, on both follow-up routes.
 *
 * That is precisely the bug shape that survives manual testing — the page
 * rendered, it just had less on it than it should have. These assertions are
 * the thing that would have caught it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const readJsonStore = vi.fn();
const rows: any[] = [];

vi.mock('@/lib/vault/vaultRecords', () => ({
  readJsonStore: (...a: any[]) => readJsonStore(...a),
}));
vi.mock('@/lib/db', () => ({
  db: {},
  withTenant: vi.fn(async (_t: string, cb: any) => cb({
    select: () => ({ from: () => ({ where: async () => rows }) }),
  })),
}));

/**
 * The category spec, which `remindersForCategory` reads to resolve each
 * reminder's alert window. Empty by default so these tests stay about which
 * reminders are FOUND; the alert-window suite below drives it directly.
 */
const categorySpec: any[] = [];
vi.mock('@/lib/records/categorySpec', () => ({
  loadCategoryFieldSpec: vi.fn(async () => categorySpec),
}));

/**
 * `collectFollowUps` now asks this once per distinct category. Mocked open by
 * default so the tests above stay about reminders; the permission suite at the
 * bottom drives it directly.
 */
const hasPermission = vi.fn(async (..._a: any[]) => true);
/**
 * The COMPANY grain. Follow-ups aggregate every category a member can see, so
 * without this a member with no grant on a company would still be told when
 * that company's licences expire — the record title and its renewal date, which
 * is most of what the record says.
 */
const hasCompanyAccess = vi.fn(async (..._a: any[]) => true);
vi.mock('@/lib/auth', () => ({
  hasPermission: (...a: any[]) => hasPermission(...a),
  hasCompanyAccess: (...a: any[]) => hasCompanyAccess(...a),
}));

const { collectFollowUps, remindersForCategory, daysUntil } =
  await import('@/lib/records/followUps');

const USER = { id: 'u1', tenantId: 't1', tenant: { id: 't1' } };

/** A row as `documents` returns it, plus the Drive record it points at. */
function reminderIn(moduleKey: string, documentKey: string, days: number) {
  const due = new Date();
  due.setDate(due.getDate() + days);
  return {
    row: { id: `${moduleKey}-1`, title: 'A record', categoryModuleKey: moduleKey, categoryDocumentKey: documentKey, metadata: null },
    record: {
      name: 'A record',
      reminders: [{ key: 'valid_to', label: 'Insurance', date: due.toISOString(), resolved: false }],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rows.length = 0;
  categorySpec.length = 0;
  hasPermission.mockImplementation(async () => true);
  hasCompanyAccess.mockImplementation(async () => true);
});

/**
 * ── BUSINESS REMINDERS ─────────────────────────────────────────────────────
 *
 * A company's licences and registrations expire, and `valid_to` is a reminder
 * field for every business category. Before the vault became company-scoped,
 * `collectFollowUps` opened the PERSONAL store for every row — so a business
 * record's reminders were looked for where they are not, found nothing, and
 * were dropped. Silently, which is the worst way for a reminder feature to fail.
 */
describe('business reminders', () => {
  const COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it("opens the COMPANY's vault for a company record", async () => {
    const { row, record } = reminderIn('biz_licenses', 'trade_license', 5);
    rows.push({ ...row, companyId: COMPANY });
    readJsonStore.mockResolvedValue({ store: { records: { [row.id]: record } } });

    const items = await collectFollowUps(USER);
    expect(items).toHaveLength(1);
    expect(readJsonStore.mock.calls[0][0].companyId).toBe(COMPANY);
  });

  it('links a company reminder into that company workspace', async () => {
    // `/modules/biz_licenses/...` would 400 — a business module addressed with
    // no company — so the reminder would be visible and unreachable, which is
    // worse than not raising it at all.
    const { row, record } = reminderIn('biz_licenses', 'trade_license', 5);
    rows.push({ ...row, companyId: COMPANY });
    readJsonStore.mockResolvedValue({ store: { records: { [row.id]: record } } });

    const [item] = await collectFollowUps(USER);
    expect(item.link).toBe(`/business/${COMPANY}/modules/biz_licenses/trade_license`);
  });

  it('keeps a personal reminder on the personal path and vault', async () => {
    const { row, record } = reminderIn('insurance', 'life_policies', 5);
    rows.push(row);
    readJsonStore.mockResolvedValue({ store: { records: { [row.id]: record } } });

    const [item] = await collectFollowUps(USER);
    expect(item.link).toBe('/modules/insurance/life_policies');
    expect(readJsonStore.mock.calls[0][0].companyId).toBeNull();
  });

  it('raises nothing for a company the member cannot reach', async () => {
    // The gate, not just the label: without it the member learns the record's
    // title and its renewal date, which is most of what the record says.
    hasCompanyAccess.mockImplementation(async () => false);
    const { row, record } = reminderIn('biz_licenses', 'trade_license', 5);
    rows.push({ ...row, companyId: COMPANY });
    readJsonStore.mockResolvedValue({ store: { records: { [row.id]: record } } });

    expect(await collectFollowUps(USER)).toEqual([]);
    // And it costs no Drive read either.
    expect(readJsonStore).not.toHaveBeenCalled();
  });

  it('opens one store per COMPANY, not one per category', async () => {
    // Two companies filing into the same category hold two separate encrypted
    // stores. Keying the group on the category alone would open whichever came
    // first and attribute both companies' rows to it.
    const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const a = reminderIn('biz_licenses', 'trade_license', 5);
    const b = reminderIn('biz_licenses', 'trade_license', 6);
    rows.push({ ...a.row, companyId: COMPANY }, { ...b.row, companyId: OTHER });
    readJsonStore.mockResolvedValue({ store: { records: {} } });

    await collectFollowUps(USER);
    const seen = readJsonStore.mock.calls.map((c: any[]) => c[0].companyId).sort();
    expect(seen).toEqual([COMPANY, OTHER].sort());
  });
});

describe('module coverage', () => {
  it('collects reminders from a module whose key is NOT a scope key', async () => {
    // `insurance` is a taxonomy module; the scope that owns it is called
    // `lic_mediclaim`. Under the old check this row was discarded.
    const { row, record } = reminderIn('insurance', 'life_policies', 5);
    rows.push(row);
    readJsonStore.mockResolvedValue({ store: { records: { [row.id]: record } } });

    const items = await collectFollowUps(USER);
    expect(items).toHaveLength(1);
    expect(items[0].module).toBe('insurance');
  });

  it('reads each category’s store under the CATEGORY’s module', async () => {
    // A scope can span two modules, and a property_legal record has no store
    // under bank_investments.
    const { row, record } = reminderIn('property_legal', 'sale_deed_title', 3);
    rows.push(row);
    readJsonStore.mockResolvedValue({ store: { records: { [row.id]: record } } });

    await collectFollowUps(USER);
    expect(readJsonStore).toHaveBeenCalledWith(
      expect.anything(), 'property_legal',
      { moduleKey: 'property_legal', documentKey: 'sale_deed_title' },
    );
  });

  it('ignores a row whose category is not in the taxonomy at all', async () => {
    rows.push({
      id: 'x', title: 'Orphan', categoryModuleKey: 'made_up', categoryDocumentKey: 'nonsense', metadata: null,
    });
    const items = await collectFollowUps(USER);
    expect(items).toEqual([]);
    expect(readJsonStore).not.toHaveBeenCalled();
  });
});

describe('links', () => {
  it('points at the sub-category workspace, which is a route that exists', async () => {
    // It used to build `/${module.replace(/_/g, '-')}` — `/health-medical`,
    // `/bank-investments` — none of which are pages.
    const { row, record } = reminderIn('health_medical', 'insurance_claims', 2);
    rows.push(row);
    readJsonStore.mockResolvedValue({ store: { records: { [row.id]: record } } });

    const [item] = await collectFollowUps(USER);
    expect(item.link).toBe('/modules/health_medical/insurance_claims');
  });
});

describe('overdue is not resolved', () => {
  it('keeps a lapsed reminder, and ranks it first', async () => {
    const past = reminderIn('vehicle', 'puc_certificate', -10);
    const soon = reminderIn('insurance', 'health_policies', 4);
    rows.push(past.row, soon.row);
    readJsonStore.mockImplementation(async (_ctx: any, moduleKey: string) => ({
      store: { records: moduleKey === 'vehicle'
        ? { [past.row.id]: past.record }
        : { [soon.row.id]: soon.record } },
    }));

    const items = await collectFollowUps(USER);
    expect(items).toHaveLength(2);
    expect(items[0].daysLeft).toBeLessThan(0);
    expect(items[0].severity).toBe('URGENT');
    expect(items[0].title).toMatch(/Overdue/);
  });

  it('drops one that was explicitly resolved', async () => {
    const { row, record } = reminderIn('utility_bills', 'electricity', 2);
    record.reminders[0].resolved = true;
    rows.push(row);
    readJsonStore.mockResolvedValue({ store: { records: { [row.id]: record } } });

    expect(await collectFollowUps(USER)).toEqual([]);
  });
});

describe('remindersForCategory — degrade or report, per caller', () => {
  const KEY = { moduleKey: 'insurance', documentKey: 'life_policies' };
  const ROWS = [{ id: 'r1', title: 'LIC' }];

  it('yields nothing when the store is unreadable, by default', async () => {
    // The follow-up page aggregates every category; one unreadable store must
    // not empty the whole list.
    readJsonStore.mockRejectedValue(new Error('drive down'));
    expect(await remindersForCategory(USER as any, KEY, ROWS)).toEqual([]);
  });

  it('throws for a strict caller, so "could not check" is not shown as "nothing due"', async () => {
    readJsonStore.mockRejectedValue(new Error('drive down'));
    await expect(
      remindersForCategory(USER as any, KEY, ROWS, { strict: true }),
    ).rejects.toThrow('drive down');
  });

  it('honours a wider threshold — the summary looks 90 days out, not 15', async () => {
    const far = reminderIn('insurance', 'life_policies', 60);
    readJsonStore.mockResolvedValue({ store: { records: { r1: far.record } } });

    expect(await remindersForCategory(USER as any, KEY, ROWS)).toEqual([]);
    expect(
      await remindersForCategory(USER as any, KEY, ROWS, { thresholdDays: 90 }),
    ).toHaveLength(1);
  });
});

/**
 * The card's button text and its "Recommended Action:" line are set HERE, not
 * in the page — /follow-up, the sidebar count route and the notification job
 * all read this builder, and a rule any one of them keeps to itself drifts.
 * followUpActions.test.ts owns the mapping; these two assert only that a built
 * item actually carries it, which is what a page reading `r.actionLabel` needs.
 */
describe('the ask travels with the item', () => {
  it('labels the button from the record’s own category', async () => {
    const { row, record } = reminderIn('utility_bills', 'electricity', 2);
    rows.push(row);
    readJsonStore.mockResolvedValue({ store: { records: { [row.id]: record } } });

    const [item] = await collectFollowUps(USER);
    expect(item.actionLabel).toBe('Pay Bill');
    expect(item.recommendedAction).toMatch(/Pay the bill/);
  });

  it('sharpens the label once the date has passed', async () => {
    const { row, record } = reminderIn('property_legal', 'sale_deed_title', -124);
    rows.push(row);
    readJsonStore.mockResolvedValue({ store: { records: { [row.id]: record } } });

    const [item] = await collectFollowUps(USER);
    expect(item.actionLabel).toBe('Review Contract Now');
  });
});

describe('daysUntil', () => {
  it('counts whole days and goes negative once a date has passed', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(daysUntil(yesterday)).toBe(-1);
    expect(daysUntil(new Date())).toBe(0);
    expect(daysUntil(null)).toBe(Number.POSITIVE_INFINITY);
  });
});

/**
 * ── THE SUB-CATEGORY A MEMBER CANNOT OPEN ──────────────────────────────────
 * `collectFollowUps` filtered by tenant and by `visibleDocument()` and nothing
 * else, so `/follow-up` and the sidebar badge handed a restricted member the
 * record titles, field labels and due dates of every sub-category in the
 * workspace — each card linking to a page that would then 403. Every other
 * reader of these stores gates per sub-category; these two did not.
 *
 * The check lives in the shared builder rather than in the two routes, because
 * duplicated rules across those exact two routes are what the consolidation
 * removed. These assertions are what keep it there.
 */
describe('permissions', () => {
  it('drops a sub-category the member may not view', async () => {
    const allowed = reminderIn('insurance', 'life_policies', 5);
    const denied = reminderIn('business', 'gst_registration', 5);
    rows.push(allowed.row, denied.row);
    readJsonStore.mockImplementation(async (_ctx: any, moduleKey: string) => ({
      store: { records: moduleKey === 'insurance'
        ? { [allowed.row.id]: allowed.record }
        : { [denied.row.id]: denied.record } },
    }));
    hasPermission.mockImplementation(async (...a: any[]) => a[1] === 'insurance');

    const items = await collectFollowUps(USER);
    expect(items).toHaveLength(1);
    expect(items[0].module).toBe('insurance');
  });

  it('asks per sub-category, not per module — a module is not one permission', async () => {
    const a = reminderIn('insurance', 'life_policies', 5);
    const b = reminderIn('insurance', 'vehicle_policies', 5);
    rows.push(a.row, b.row);
    readJsonStore.mockImplementation(async (_c: any, _m: string, key: any) => ({
      store: { records: key.documentKey === 'life_policies'
        ? { [a.row.id]: a.record }
        : { [b.row.id]: b.record } },
    }));
    hasPermission.mockImplementation(async (...args: any[]) => args[3] === 'life_policies');

    const items = await collectFollowUps(USER);
    expect(items).toHaveLength(1);
    expect(items[0].documentKey).toBe('life_policies');
    expect(hasPermission).toHaveBeenCalledWith(USER, 'insurance', 'view', 'life_policies');
    expect(hasPermission).toHaveBeenCalledWith(USER, 'insurance', 'view', 'vehicle_policies');
  });

  it('costs one call per DISTINCT category, however many records it holds', async () => {
    // Asking per row would be one permission lookup per document.
    const one = reminderIn('vehicle', 'puc_certificate', 5);
    rows.push(one.row, { ...one.row, id: 'vehicle-2' }, { ...one.row, id: 'vehicle-3' });
    readJsonStore.mockResolvedValue({ store: { records: {} } });

    await collectFollowUps(USER);
    expect(hasPermission).toHaveBeenCalledTimes(1);
  });

  it('opens no store for a denied category', async () => {
    const denied = reminderIn('business', 'gst_registration', 5);
    rows.push(denied.row);
    hasPermission.mockImplementation(async () => false);

    expect(await collectFollowUps(USER)).toEqual([]);
    expect(readJsonStore).not.toHaveBeenCalled();
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE ALERT WINDOW — per field, per record, resolved on every read       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Before this, every reminder surfaced at fifteen days. The window is now
 * whichever of three authors is most specific, and it is resolved HERE rather
 * than stamped into the record when it was written — which is the only reason a
 * super admin changing a lead reaches records already on file.
 */
describe('the alert window', () => {
  const KEY = { moduleKey: 'insurance', documentKey: 'life_policies' };
  const ROWS = [{ id: 'r1', title: 'A record' }];

  /** A reminder N days out, on the given taxonomy key. */
  function due(days: number, key = 'valid_to', extra: Record<string, unknown> = {}) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return {
      name: 'A record',
      ...extra,
      reminders: [{ key, label: 'Insurance', date: date.toISOString(), resolved: false }],
    };
  }

  it('uses the dictionary’s per-key lead, not a global fifteen days', async () => {
    // `valid_to` ships a 30-day lead. At 25 days out this is inside its window
    // and would have been invisible under the old constant.
    readJsonStore.mockResolvedValue({ store: { records: { r1: due(25) } } });
    expect(await remindersForCategory(USER as any, KEY, ROWS)).toHaveLength(1);
  });

  it('excludes what is beyond the field’s window', async () => {
    readJsonStore.mockResolvedValue({ store: { records: { r1: due(40) } } });
    expect(await remindersForCategory(USER as any, KEY, ROWS)).toEqual([]);
  });

  it('honours the operator’s configured lead over the dictionary’s', async () => {
    categorySpec.push({ fieldKey: 'valid_to', dataType: 'date', alertDaysBefore: 60 });
    readJsonStore.mockResolvedValue({ store: { records: { r1: due(40) } } });

    const [item] = await remindersForCategory(USER as any, KEY, ROWS);
    expect(item).toBeTruthy();
    // Carried on the item so the notification ladder need not recompute it.
    expect(item.alertWindowDays).toBe(60);
  });

  it('lets ONE record ask for less notice than its category', async () => {
    categorySpec.push({ fieldKey: 'valid_to', dataType: 'date', alertDaysBefore: 60 });
    readJsonStore.mockResolvedValue({
      store: { records: { r1: due(40, 'valid_to', { alert_days_before: 5 }) } },
    });
    expect(await remindersForCategory(USER as any, KEY, ROWS)).toEqual([]);
  });

  it('lets ONE record ask for more', async () => {
    readJsonStore.mockResolvedValue({
      store: { records: { r1: due(80, 'valid_to', { alert_days_before: 120 }) } },
    });
    const [item] = await remindersForCategory(USER as any, KEY, ROWS);
    expect(item.alertWindowDays).toBe(120);
  });

  it('grades severity against the item’s own window, not against fifteen', async () => {
    // 25 days out with a 30-day lead is WARNING — inside the window. Judged
    // against the old global constant it would have read INFO: "not due yet",
    // on a card the page had just decided to show.
    categorySpec.push({ fieldKey: 'valid_to', dataType: 'date', alertDaysBefore: 30 });
    readJsonStore.mockResolvedValue({ store: { records: { r1: due(25) } } });

    const [item] = await remindersForCategory(USER as any, KEY, ROWS);
    expect(item.severity).toBe('WARNING');
  });

  it('keeps URGENT absolute — three days is three days', async () => {
    categorySpec.push({ fieldKey: 'valid_to', dataType: 'date', alertDaysBefore: 90 });
    readJsonStore.mockResolvedValue({ store: { records: { r1: due(2) } } });

    const [item] = await remindersForCategory(USER as any, KEY, ROWS);
    expect(item.severity).toBe('URGENT');
  });

  it('leaves a NAMED horizon alone — the summary tab still sees everything', async () => {
    // A caller passing thresholdDays is asking a different question, so the
    // per-field windows must not narrow its answer back down.
    readJsonStore.mockResolvedValue({ store: { records: { r1: due(400) } } });
    expect(
      await remindersForCategory(USER as any, KEY, ROWS, {
        thresholdDays: Number.POSITIVE_INFINITY,
      }),
    ).toHaveLength(1);
  });

  it('falls back to the dictionary when the spec cannot be read', async () => {
    // A spec failure costs the OPERATOR'S window, not the whole list: the
    // configured 60 days is unreachable, so `valid_to`'s shipped 30 answers.
    // 25 days is inside that, 40 is not — which is what proves the fallback ran
    // rather than the configured value having been used anyway.
    categorySpec.push({ fieldKey: 'valid_to', dataType: 'date', alertDaysBefore: 60 });
    const { loadCategoryFieldSpec } = await import('@/lib/records/categorySpec');

    vi.mocked(loadCategoryFieldSpec).mockRejectedValueOnce(new Error('db down'));
    readJsonStore.mockResolvedValue({ store: { records: { r1: due(25) } } });
    expect(await remindersForCategory(USER as any, KEY, ROWS)).toHaveLength(1);

    vi.mocked(loadCategoryFieldSpec).mockRejectedValueOnce(new Error('db down'));
    readJsonStore.mockResolvedValue({ store: { records: { r1: due(40) } } });
    expect(await remindersForCategory(USER as any, KEY, ROWS)).toEqual([]);
  });
});
