/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POWER SCAN FILES INTO THE WORKSPACE IT WAS OPENED FROM                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A company's Power Scan is the same page and the same model call as the
 * household's; only the taxonomy differs. Two things have to hold for that to
 * be true rather than merely to look true:
 *
 *  1. A CROSS-TAXONOMY PAIR IS NOT A NEAR MISS, IT IS UNUSABLE. The prompt is
 *     built from one taxonomy, so a personal pair coming back inside a company
 *     means the model answered from memory rather than from the list. Filed, it
 *     produces a personal category with a company id — a row
 *     `documents_account_scope_ck` refuses — and the member finds out at the end
 *     of a forty-page scan.
 *
 *  2. A COMPANY HAS NO CATCH-ALL. `other/uncategorized` is a household module.
 *     Falling back to it inside a company is case 1 by another route, so an
 *     unplaceable page comes back with NO category and the review grid asks the
 *     member where it goes. An honest question beats a record filed somewhere
 *     nobody will look for it.
 *
 * The harness is the one `scanTaxonomyClassification.test.ts` uses: the model is
 * a stub that replies with whatever the test sets.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** What the model answered, swapped per test. */
let modelReply = '';

vi.mock('@/lib/aiKeyManager', () => ({
  AI_ERROR_CODES: {},
  AI_ERROR_MESSAGES: {},
  executeTenantWithRotation: async (_t: string, _f: string, fn: any) => fn({
    provider: 'openai',
    model: 'test',
    client: {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: modelReply } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        },
      },
    },
  }),
}));

const { scanMultipleFiles } = await import('@/lib/ai');

const PAGES = [{ base64: '', mimeType: 'image/jpeg', fileName: 'a.jpg', originalName: 'a.jpg', pageNumber: 1, totalPages: 1 }];
const reply = (records: unknown[]) => JSON.stringify({ proposedRecords: records });
const scan = (scope: 'personal' | 'business') =>
  scanMultipleFiles(PAGES as any, 't1', 'u1', scope) as Promise<any>;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('a company scan', () => {
  it('files a business pair and reports its module as the scan category', async () => {
    modelReply = reply([{
      title: 'GST Registration',
      kind: 'record',
      candidates: [{ moduleKey: 'biz_tax', documentKey: 'gst_returns' }],
      fileIndices: [0],
      extractedData: {},
    }]);

    const [rec] = (await scan('business')).proposedRecords;

    expect(rec.extractedData).toMatchObject({ moduleKey: 'biz_tax', documentKey: 'gst_returns' });
    // The business scopes map to themselves — see the "THE BUSINESS SCOPES"
    // block in scanCategoryModule.ts for why that identity entry is deliberate.
    expect(rec.category).toBe('biz_tax');
  });

  it('refuses a personal pair rather than filing it into the company', async () => {
    // A PAN card scanned inside a company. Real document, real pair, and no
    // business workspace can hold it.
    modelReply = reply([{
      kind: 'record',
      fileIndices: [0],
      candidates: [{ moduleKey: 'identity', documentKey: 'pan_card' }],
      extractedData: {},
    }]);

    const [rec] = (await scan('business')).proposedRecords;

    expect(rec.extractedData.moduleKey).toBe('');
    expect(rec.extractedData.documentKey).toBe('');
    expect(rec.category).toBe('');
  });

  it('does NOT fall back to the household catch-all', async () => {
    // The failure this exists to stop: `other/uncategorized` is personal, so a
    // company record filed there is refused on save, at the end of the scan.
    modelReply = reply([{
      kind: 'record',
      fileIndices: [0],
      candidates: [{ moduleKey: 'not_a_module', documentKey: 'nope' }],
      extractedData: {},
    }]);

    const [rec] = (await scan('business')).proposedRecords;

    expect(rec.extractedData.moduleKey).not.toBe('other');
    expect(rec.extractedData.moduleKey).toBe('');
    expect(rec.category).toBe('');
  });

  it('skips a personal candidate to reach a business one listed after it', async () => {
    // Order is the model's confidence, so a wrong-taxonomy first choice must not
    // block a correct second — it is discarded, not treated as the answer.
    modelReply = reply([{
      kind: 'record',
      fileIndices: [0],
      candidates: [
        { moduleKey: 'identity', documentKey: 'pan_card' },
        { moduleKey: 'biz_licenses', documentKey: 'trade_license' },
      ],
      extractedData: {},
    }]);

    const [rec] = (await scan('business')).proposedRecords;

    expect(rec.extractedData).toMatchObject({
      moduleKey: 'biz_licenses', documentKey: 'trade_license',
    });
  });
});

describe('a household scan is unchanged', () => {
  it('still files a personal pair', async () => {
    modelReply = reply([{
      kind: 'record',
      fileIndices: [0],
      candidates: [{ moduleKey: 'identity', documentKey: 'pan_card' }],
      extractedData: {},
    }]);

    const [rec] = (await scan('personal')).proposedRecords;

    expect(rec.extractedData).toMatchObject({ moduleKey: 'identity', documentKey: 'pan_card' });
    expect(rec.category).toBe('document');
  });

  it('refuses a business pair, the same rule in the other direction', async () => {
    // A trade licence scanned from the household. It cannot be stored without a
    // company, so the household's catch-all is the right destination — the
    // member re-files it from the company's own Power Scan.
    modelReply = reply([{
      kind: 'record',
      fileIndices: [0],
      candidates: [{ moduleKey: 'biz_licenses', documentKey: 'trade_license' }],
      extractedData: {},
    }]);

    const [rec] = (await scan('personal')).proposedRecords;

    expect(rec.extractedData).toMatchObject({ moduleKey: 'other', documentKey: 'uncategorized' });
  });

  it('keeps the catch-all it has always had', async () => {
    modelReply = reply([{
      kind: 'record',
      fileIndices: [0],
      candidates: [{ moduleKey: 'not_a_module', documentKey: 'nope' }],
      extractedData: {},
    }]);

    const [rec] = (await scan('personal')).proposedRecords;

    expect(rec.extractedData).toMatchObject({ moduleKey: 'other', documentKey: 'uncategorized' });
    expect(rec.category).toBe('document');
  });

  it('defaults to the household when no scope is passed at all', async () => {
    // Every caller that predates the business account omits the argument, and
    // must keep the behaviour it has.
    modelReply = reply([{
      kind: 'record',
      fileIndices: [0],
      candidates: [{ moduleKey: 'identity', documentKey: 'pan_card' }],
      extractedData: {},
    }]);

    const [rec] = ((await (scanMultipleFiles(PAGES as any, 't1', 'u1') as Promise<any>))).proposedRecords;

    expect(rec.extractedData).toMatchObject({ moduleKey: 'identity', documentKey: 'pan_card' });
  });
});
