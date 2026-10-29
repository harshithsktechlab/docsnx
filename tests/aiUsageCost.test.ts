// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * What one AI call writes to `tenant_ai_usages` (migration 0075).
 *
 * The table used to hold tokens and a USD figure that left out Gemini's
 * thinking tokens — billed at the output rate — so it under-reported every
 * Gemini 3 call. These pin the arithmetic (thinking priced as output, INR as
 * USD × the configured rate, NULL when no rate is set) and the row that
 * `executeTenantWithRotation` writes: task, member, workspace, key source and
 * the credits the call was charged.
 *
 * `db` and the SDKs are mocked; every insert's `values()` payload is captured.
 */

let inserts: any[] = [];
let tenantRow: any = undefined;
let configRow: any = undefined;
let poolKeys: any[] = [];

vi.mock('../src/lib/db', () => ({
  db: {
    query: {
      apiKeys: { findMany: vi.fn(async () => poolKeys) },
      tenants: { findFirst: vi.fn(async () => tenantRow) },
      systemConfigs: { findFirst: vi.fn(async () => configRow) },
    },
    update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
    insert: vi.fn(() => ({
      values: (payload: any) => {
        inserts.push(payload);
        return { returning: async () => [{ id: `usage-${inserts.length}` }] };
      },
    })),
  },
}));

vi.mock('@google/genai', () => ({ GoogleGenAI: class { constructor(public opts: any) {} } }));
vi.mock('openai', () => ({ default: class { constructor(public opts: any) {} } }));
vi.mock('../src/lib/fieldCrypto', () => ({ decryptField: (v: any) => v }));
const spendTenantCredits = vi.fn(async (..._args: any[]) => undefined);
vi.mock('../src/lib/planProvisioning', () => ({ spendTenantCredits: (...a: any[]) => spendTenantCredits(...a) }));

let mod: typeof import('../src/lib/aiKeyManager');

// gemini-3.1-flash-lite: $0.25 / 1M input, $1.50 / 1M output (src/lib/aiModels.ts).
const MODEL = 'gemini-3.1-flash-lite';

beforeEach(async () => {
  vi.clearAllMocks();
  inserts = [];
  poolKeys = [];
  tenantRow = { id: 't-1', maxMembers: 1, extraMembers: 0, aiCreditsBalance: 1000, aiCreditsBalanceBusiness: 1000, apiKey: null };
  configRow = { aiCostBulkScan: '10.00', usdInrRate: '96.5150', aiCostMultiplier: '2.00' };
  delete process.env.GEMINI_API_KEY;
  mod = await import('../src/lib/aiKeyManager');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('computeAiUsageCost', () => {
  it('prices thinking tokens at the output rate', () => {
    const { costUsd } = mod.computeAiUsageCost(MODEL, 1_000_000, 0, 1_000_000, null);
    expect(costUsd).toBeCloseTo(0.25 + 1.5, 10);
  });

  it('converts to INR with the given rate', () => {
    const { costUsd, costInr } = mod.computeAiUsageCost(MODEL, 1_000_000, 1_000_000, 0, 96.515);
    expect(costUsd).toBeCloseTo(1.75, 10);
    expect(costInr).toBeCloseTo(1.75 * 96.515, 10);
  });

  it('multiplies INR into the final cost', () => {
    const { costInr, finalCostInr } = mod.computeAiUsageCost(MODEL, 1_000_000, 0, 0, 96.515, 2);
    expect(costInr).toBeCloseTo(0.25 * 96.515, 10);
    expect(finalCostInr).toBeCloseTo(0.25 * 96.515 * 2, 10);
  });

  it('leaves the final cost null when there is no INR to multiply', () => {
    expect(mod.computeAiUsageCost(MODEL, 100, 10, 0, null, 2).finalCostInr).toBeNull();
  });

  it('leaves INR null when no rate is configured', () => {
    expect(mod.computeAiUsageCost(MODEL, 100, 10, 0, null).costInr).toBeNull();
    expect(mod.computeAiUsageCost(MODEL, 100, 10, 0, 0).costInr).toBeNull();
  });
});

describe('parseUsdInrRate', () => {
  it('reads the decimal string Postgres returns', () => {
    expect(mod.parseUsdInrRate('96.5150')).toBe(96.515);
  });
  it('treats unset, blank, zero and garbage as no rate', () => {
    for (const v of [null, undefined, '', '0', '-1', 'abc']) expect(mod.parseUsdInrRate(v)).toBeNull();
  });
});

describe('recordTenantAiUsage', () => {
  it('writes every column, with USD and INR including thinking tokens', async () => {
    await mod.recordTenantAiUsage({
      tenantId: 't-1',
      modelName: MODEL,
      promptTokens: 2000,
      completionTokens: 100,
      thinkingTokens: 300,
      cachedTokens: 50,
      action: 'DOC_CLASSIFY',
      userId: 'u-1',
      companyId: null,
      keySource: 'env',
      apiKeyId: null,
      creditsCharged: 1,
      usdInrRate: 96.515,
      costMultiplier: 2,
      context: { batchId: 'b-1', moduleKey: 'identity', documentKey: 'pan_card', fileCount: 1, pageCount: 2 },
    });

    const usd = 2000 * 0.25e-6 + 400 * 1.5e-6;
    expect(inserts).toHaveLength(1);
    const row = inserts[0];
    expect(row).toMatchObject({
      tenantId: 't-1',
      modelName: MODEL,
      promptTokens: 2000,
      completionTokens: 100,
      thinkingTokens: 300,
      cachedTokens: 50,
      action: 'DOC_CLASSIFY',
      userId: 'u-1',
      companyId: null,
      keySource: 'env',
      apiKeyId: null,
      creditsCharged: 1,
      usdInrRate: '96.515',
    });
    expect(Number(row.cost)).toBeCloseTo(usd, 12);
    expect(Number(row.costInr)).toBeCloseTo(usd * 96.515, 10);
    expect(row.costMultiplier).toBe('2');
    expect(Number(row.finalCostInr)).toBeCloseTo(usd * 96.515 * 2, 10);
    expect(row).toMatchObject({
      batchId: 'b-1', moduleKey: 'identity', documentKey: 'pan_card', fileCount: 1, pageCount: 2, documentId: null,
    });
  });

  it('returns the new row id', async () => {
    const id = await mod.recordTenantAiUsage({
      tenantId: 't-1', modelName: MODEL, promptTokens: 1, completionTokens: 1, keySource: 'pool',
    });
    expect(id).toBe('usage-1');
  });

  it('writes NULL INR and warns when no rate is set', async () => {
    await mod.recordTenantAiUsage({
      tenantId: 't-1', modelName: MODEL, promptTokens: 10, completionTokens: 1, keySource: 'pool',
    });
    expect(inserts[0].usdInrRate).toBeNull();
    expect(inserts[0].costInr).toBeNull();
  });
});

describe('executeTenantWithRotation → tenant_ai_usages row', () => {
  const callFn = vi.fn(async () => ({
    text: '{}', promptTokens: 1000, completionTokens: 50, thinkingTokens: 20, cachedTokens: 0,
  }));

  it('records a FIELD_READ on the env key, charged as a Power scan', async () => {
    process.env.GEMINI_API_KEY = 'env-key';
    // Neither the legacy tenants.max_members columns nor seats drive the price.
    tenantRow = { ...tenantRow, maxMembers: 9, extraMembers: 9 };

    const out: any = await mod.executeTenantWithRotation('t-1', 'FIELD_READ', callFn, 'u-9', 'c-2', {
      batchId: 'batch-7', moduleKey: 'identity', documentKey: 'pan_card', pageCount: 2,
    });
    // The row id travels back on the result, for the browser to send with the save.
    expect(out.usageId).toBe('usage-1');

    // Power scan: a flat 10 credits, whatever the workspace's seats.
    // Called from a company workspace (c-2), so it is paid from the Business pool.
    expect(spendTenantCredits).toHaveBeenCalledWith('t-1', expect.objectContaining({ amount: 10, reason: 'spend_bulk_scan', pool: 'business' }));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      action: 'FIELD_READ',
      userId: 'u-9',
      companyId: 'c-2',
      keySource: 'env',
      apiKeyId: null,
      creditsCharged: 10,
      thinkingTokens: 20,
      usdInrRate: '96.515',
      costMultiplier: '2',
      batchId: 'batch-7',
      moduleKey: 'identity',
      documentKey: 'pan_card',
      pageCount: 2,
    });
    expect(inserts[0].costInr).not.toBeNull();
  });

  it('charges the flat price and words the ledger line without a seat count', async () => {
    process.env.GEMINI_API_KEY = 'env-key';
    await mod.executeTenantWithRotation('t-1', 'RECORD_ANALYSIS', callFn, 'u-1');
    expect(spendTenantCredits).toHaveBeenCalledWith('t-1', expect.objectContaining({
      pool: 'personal',
      amount: 1,
      description: expect.not.stringContaining('members'),
    }));
  });

  it("records the tenant's own key as free", async () => {
    tenantRow = { ...tenantRow, apiKey: 'tenant-key', aiProvider: 'gemini', aiModel: MODEL };

    await mod.executeTenantWithRotation('t-1', 'RECORD_ANALYSIS', callFn, 'u-1');

    expect(spendTenantCredits).not.toHaveBeenCalled();
    expect(inserts[0]).toMatchObject({ action: 'RECORD_ANALYSIS', keySource: 'tenant', creditsCharged: 0 });
  });
});
