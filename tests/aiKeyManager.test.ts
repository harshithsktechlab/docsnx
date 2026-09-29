// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Transient-fault handling for the AI key pool.
 *
 * Written after a bulk scan died in production on this, verbatim from Google:
 *
 *   {"error":{"code":503,"message":"This model is currently experiencing high
 *    demand. Spikes in demand are usually temporary. Please try again
 *    later.","status":"UNAVAILABLE"}}
 *
 * Three separate bugs turned that into a red toast: the 503 was classified
 * SERVICE_UNAVAILABLE (checked before the overload branch), SERVICE_UNAVAILABLE
 * was not rotatable so the loop broke on the first key and never reached the
 * OpenAI key behind it, and nothing anywhere retried. The assertions below are
 * mostly about what must NOT happen again: no give-up on the first 503, no
 * "add more API keys" message for a provider outage, and no health penalty
 * charged to a key for a fault that was Google's.
 *
 * `db` and the provider SDKs are mocked — this file is about control flow, and
 * importing the real ones opens a Postgres pool.
 */

const GEMINI_503 = () => {
  const err: any = new Error(
    '{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}',
  );
  err.status = 503;
  return err;
};

/**
 * The 404 that followed the 503, six months later, when Google actually
 * retired the model. Same feature down, completely different fix.
 */
const GEMINI_404 = () => {
  const err: any = new Error(
    '{"error":{"code":404,"message":"This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.6-flash for the latest features and improvements.","status":"NOT_FOUND"}}',
  );
  err.status = 404;
  return err;
};

// apiKeys rows the pool sees. Mutated per test.
let poolKeys: any[] = [];

/**
 * Every `db.update(apiKeys).set(payload)` the module performs.
 *
 * Key health is asserted through these rather than by spying on the exported
 * markKey* helpers: under ESM the module's internal call sites bind the local
 * function directly, so a `vi.spyOn(mod, 'markKeyError')` never fires and every
 * "was not charged" assertion would pass whether or not the code was fixed.
 */
let keyWrites: any[] = [];

vi.mock('../src/lib/db', () => ({
  db: {
    query: {
      apiKeys: {
        findMany: vi.fn(async () => poolKeys),
        findFirst: vi.fn(async () => poolKeys[0]),
      },
      tenants: { findFirst: vi.fn(async () => undefined) },
      systemConfigs: { findFirst: vi.fn(async () => undefined) },
    },
    update: vi.fn(() => ({
      set: (payload: any) => {
        keyWrites.push(payload);
        return { where: async () => undefined };
      },
    })),
    insert: vi.fn(() => ({ values: async () => undefined })),
  },
}));

// markKeyUsed is the success path; the other two are the penalties.
const usageWrites = () => keyWrites.filter((w) => 'lastUsedAt' in w);
const penaltyWrites = () => keyWrites.filter((w) => 'lastError' in w);
const quotaWrites = () =>
  penaltyWrites().filter((w) => String(w.lastError).startsWith('Quota exhausted'));
const errorWrites = () =>
  penaltyWrites().filter((w) => !String(w.lastError).startsWith('Quota exhausted'));

// buildClientFromKey constructs these; the tests only care which provider came back.
vi.mock('@google/genai', () => ({ GoogleGenAI: class { constructor(public opts: any) {} } }));
vi.mock('openai', () => ({ default: class { constructor(public opts: any) {} } }));
vi.mock('../src/lib/fieldCrypto', () => ({ decryptField: (v: any) => v }));
vi.mock('../src/lib/planProvisioning', () => ({ spendTenantCredits: vi.fn(async () => undefined) }));

const key = (over: any = {}) => ({
  id: 'key-1',
  label: 'primary',
  apiKey: 'k',
  provider: 'gemini',
  model: 'gemini-2.5-flash',
  isActive: true,
  priority: 1,
  dailyUsage: 0,
  dailyLimit: 100,
  errorCount: 0,
  lastResetAt: new Date(),
  ...over,
});

let mod: typeof import('../src/lib/aiKeyManager');

beforeEach(async () => {
  vi.clearAllMocks();
  keyWrites = [];
  delete process.env.GEMINI_API_KEY;
  poolKeys = [key()];
  mod = await import('../src/lib/aiKeyManager');
  // The backoff sleeps for real seconds otherwise. Fake timers plus a manual
  // pump would work, but stubbing the wait keeps these tests about ordering.
  vi.spyOn(global, 'setTimeout').mockImplementation(((fn: any) => {
    fn();
    return 0 as any;
  }) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('classifyAIError', () => {
  it("reads Gemini's 503 as MODEL_OVERLOADED, not SERVICE_UNAVAILABLE", () => {
    // The regression itself: a queue to wait out, misread as a dead service.
    expect(mod.classifyAIError(GEMINI_503())).toBe(mod.AI_ERROR_CODES.MODEL_OVERLOADED);
  });

  it('still reads a bare 503 as SERVICE_UNAVAILABLE', () => {
    const err: any = new Error('Service Unavailable');
    err.status = 503;
    expect(mod.classifyAIError(err)).toBe(mod.AI_ERROR_CODES.SERVICE_UNAVAILABLE);
  });

  it('does not let the overload wording swallow a genuine quota error', () => {
    const err: any = new Error('You exceeded your current quota');
    err.status = 429;
    expect(mod.classifyAIError(err)).toBe(mod.AI_ERROR_CODES.QUOTA_EXHAUSTED);
  });

  it('reads a retired model as MODEL_NOT_FOUND, not UNKNOWN', () => {
    // As UNKNOWN this was non-rotatable, so the pool broke on the first key and
    // every AI feature went down while a working OpenAI key sat behind it.
    expect(mod.classifyAIError(GEMINI_404())).toBe(mod.AI_ERROR_CODES.MODEL_NOT_FOUND);
  });

  it('does not read the retired-model 404 as an outage', () => {
    // The distinction that matters: waiting fixes a 503 and never fixes a 404.
    expect(mod.classifyAIError(GEMINI_404())).not.toBe(mod.AI_ERROR_CODES.MODEL_OVERLOADED);
    expect(mod.classifyAIError(GEMINI_404())).not.toBe(mod.AI_ERROR_CODES.SERVICE_UNAVAILABLE);
  });

  it('does not let the overload wording swallow a bad key', () => {
    const err: any = new Error('API key not valid');
    err.status = 400;
    expect(mod.classifyAIError(err)).toBe(mod.AI_ERROR_CODES.INVALID_KEY);
  });
});

describe('executeWithRotation — transient faults', () => {
  it('retries the same key and succeeds rather than surfacing the first 503', async () => {
    const callFn = vi
      .fn()
      .mockRejectedValueOnce(GEMINI_503())
      .mockRejectedValueOnce(GEMINI_503())
      .mockResolvedValue({ text: 'ok' });

    const result = await mod.executeWithRotation(callFn);

    expect(result).toEqual({ text: 'ok' });
    expect(callFn).toHaveBeenCalledTimes(3);
    // Retried in place — one key, so no second client was ever built.
    expect(new Set(callFn.mock.calls.map((c: any) => c[0].keyId)).size).toBe(1);
    // Counted against the daily limit once, not once per attempt.
    expect(usageWrites()).toHaveLength(1);
    expect(penaltyWrites()).toEqual([]);
  });

  it('falls through to the OpenAI key once backoff is exhausted', async () => {
    poolKeys = [
      key({ id: 'gem-1', provider: 'gemini', priority: 1 }),
      key({ id: 'oai-1', provider: 'openai', model: 'gpt-4o-mini', priority: 2, label: 'fallback' }),
    ];

    const callFn = vi.fn(async (info: any) => {
      if (info.provider === 'gemini') throw GEMINI_503();
      return { text: 'from openai' };
    });

    const result = await mod.executeWithRotation(callFn);

    expect(result).toEqual({ text: 'from openai' });
    // 3 attempts against Gemini, then the OpenAI key.
    expect(callFn).toHaveBeenCalledTimes(4);
    expect(callFn.mock.calls.at(-1)![0].provider).toBe('openai');
  });

  it('does not charge a key for the provider being overloaded', async () => {
    const callFn = vi.fn().mockRejectedValue(GEMINI_503());

    await expect(mod.executeWithRotation(callFn)).rejects.toThrow();

    // errorCount orders the pool in getAvailableKeys; Google's bad minute must
    // not permanently demote a healthy key.
    expect(penaltyWrites()).toEqual([]);
  });

  it('still charges a key that is genuinely out of quota', async () => {
    const err: any = new Error('You exceeded your current quota');
    err.status = 429;
    const callFn = vi.fn().mockRejectedValue(err);

    await expect(mod.executeWithRotation(callFn)).rejects.toMatchObject({
      errorCode: mod.AI_ERROR_CODES.ALL_KEYS_EXHAUSTED,
    });
    expect(quotaWrites()).toHaveLength(1);
  });

  it('reports an outage as an outage, not as ALL_KEYS_EXHAUSTED', async () => {
    const callFn = vi.fn().mockRejectedValue(GEMINI_503());

    // "Add more API keys" is the wrong instruction here — more keys queue
    // against the same overloaded model.
    await expect(mod.executeWithRotation(callFn)).rejects.toMatchObject({
      errorCode: mod.AI_ERROR_CODES.MODEL_OVERLOADED,
    });
  });

  it('does not retry a non-transient error', async () => {
    const err: any = new Error('API key not valid');
    err.status = 403;
    const callFn = vi.fn().mockRejectedValue(err);

    await expect(mod.executeWithRotation(callFn)).rejects.toThrow();

    // One attempt, then straight to rotation — a bad key gets no backoff.
    expect(callFn).toHaveBeenCalledTimes(1);
    expect(errorWrites()).toEqual([
      expect.objectContaining({ lastError: 'API key not valid' }),
    ]);
  });
});

describe('executeWithRotation — retired model', () => {
  it('rotates past the key on the dead model instead of giving up on it', async () => {
    poolKeys = [
      key({ id: 'gem-1', provider: 'gemini', model: 'gemini-2.5-flash', priority: 1 }),
      key({ id: 'oai-1', provider: 'openai', model: 'gpt-4o-mini', priority: 2, label: 'fallback' }),
    ];

    const callFn = vi.fn(async (info: any) => {
      if (info.provider === 'gemini') throw GEMINI_404();
      return { text: 'from openai' };
    });

    const result = await mod.executeWithRotation(callFn);

    expect(result).toEqual({ text: 'from openai' });
    // Exactly two calls: no backoff on the Gemini key, then the OpenAI key.
    // Retrying a model id that no longer exists is pure added latency.
    expect(callFn).toHaveBeenCalledTimes(2);
    expect(callFn.mock.calls.at(-1)![0].provider).toBe('openai');
  });

  it('does not charge the key for a model the provider retired', async () => {
    const callFn = vi.fn().mockRejectedValue(GEMINI_404());

    await expect(mod.executeWithRotation(callFn)).rejects.toMatchObject({
      errorCode: mod.AI_ERROR_CODES.MODEL_NOT_FOUND,
    });

    // The key is healthy — its `model` column is stale. errorCount orders the
    // pool, so demoting it would outlast the config fix.
    expect(penaltyWrites()).toEqual([]);
  });

  it('tells the admin to change the model, not to buy more keys', async () => {
    const callFn = vi.fn().mockRejectedValue(GEMINI_404());

    await expect(mod.executeWithRotation(callFn)).rejects.toThrow(/AI Settings/);
  });
});
