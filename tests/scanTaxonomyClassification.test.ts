/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   PASS 1 FILES EVERY RECORD, NOT JUST THE ONES CALLED "document"         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The bug this pins: a Power Scan of ~25 household documents came back with no
 * category, no sub-category and no fields on almost every row.
 *
 * It was not misclassification. The prompt asked TWO questions — which of
 * seventeen hardcoded scan categories is this, and (only if the answer was
 * `document`) which of the 83 master sub-categories. So a prescription
 * answered `medical` and was never asked the second question at all: no pair,
 * therefore no `categoryId`, therefore no second pass reading its fields,
 * therefore an empty row with no picker on it — because the review grid only
 * rendered <CategorySelect> for `document`.
 *
 * There is one question now. The model files the record against the taxonomy
 * and the scan category is READ BACK off the pair, which is well defined
 * because the fifteen record scopes partition all 83 categories.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** What the model answered, swapped per test. */
let modelReply = '';

vi.mock('@/lib/aiKeyManager', () => ({
  AI_ERROR_CODES: {},
  AI_ERROR_MESSAGES: {},
  // Runs the callback against a fake OpenAI client, which is the simplest of
  // `generateContent`'s two provider paths — it takes the reply verbatim and
  // does no token counting or context caching.
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

/** One page of input; the content never matters, only the model's answer. */
const PAGES = [{ base64: '', mimeType: 'image/jpeg', fileName: 'a.jpg', originalName: 'a.jpg', pageNumber: 1, totalPages: 1 }];

const reply = (records: unknown[]) => JSON.stringify({ proposedRecords: records });

const scan = () => scanMultipleFiles(PAGES as any, 't1', 'u1') as Promise<any>;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('the scan category is derived from the taxonomy pair', () => {
  it('files a prescription under health_medical and reports it as medical', async () => {
    // THE regression. This record's scan category was previously the model's
    // own word for it, and carried no pair at all.
    modelReply = reply([{
      title: 'Prescription',
      kind: 'record',
      candidates: [{ moduleKey: 'health_medical', documentKey: 'records_prescriptions' }],
      holderName: 'Arjun',
      fileIndices: [0],
      extractedData: {},
    }]);

    const [rec] = (await scan()).proposedRecords;

    expect(rec.extractedData).toMatchObject({
      moduleKey: 'health_medical', documentKey: 'records_prescriptions',
    });
    expect(rec.category).toBe('medical');
  });

  it('routes each module to the page that owns it', async () => {
    modelReply = reply([
      { kind: 'record', fileIndices: [0], candidates: [{ moduleKey: 'insurance', documentKey: 'life_policies' }] },
      { kind: 'record', fileIndices: [0], candidates: [{ moduleKey: 'employment', documentKey: 'salary_slips' }] },
      { kind: 'record', fileIndices: [0], candidates: [{ moduleKey: 'utility_bills', documentKey: 'electricity' }] },
      { kind: 'record', fileIndices: [0], candidates: [{ moduleKey: 'identity', documentKey: 'pan_card' }] },
    ]);

    const cats = (await scan()).proposedRecords.map((r: any) => r.category);

    expect(cats).toEqual(['lic_mediclaim', 'employment_payroll', 'utility_bill', 'document']);
  });

  it('takes the second candidate when the first is a near miss', async () => {
    // `identity/pan` is the classic near miss: a real module, a plausible key,
    // and no such pair. All-or-nothing checking turned that into the catch-all
    // and a blank form, which is what the candidates list exists to stop.
    modelReply = reply([{
      kind: 'record',
      fileIndices: [0],
      candidates: [
        { moduleKey: 'identity', documentKey: 'pan' },
        { moduleKey: 'identity', documentKey: 'pan_card' },
      ],
    }]);

    const [rec] = (await scan()).proposedRecords;

    expect(rec.extractedData.documentKey).toBe('pan_card');
    expect(rec.category).toBe('document');
  });

  it('checks the PAIR, not each half', async () => {
    // `registration_certificate` is a real key under BOTH vehicle and business,
    // so each half of `identity/registration_certificate` is individually
    // valid and the combination does not exist.
    modelReply = reply([{
      kind: 'record',
      fileIndices: [0],
      candidates: [{ moduleKey: 'identity', documentKey: 'registration_certificate' }],
    }]);

    const [rec] = (await scan()).proposedRecords;

    expect(rec.extractedData).toMatchObject({ moduleKey: 'other', documentKey: 'uncategorized' });
  });

  it('lands an unclassifiable page in the catch-all, which is a real destination', async () => {
    // `other/uncategorized` belongs to the `documents` scope, so the row still
    // appears somewhere a member can open it and re-file it by hand.
    modelReply = reply([{ kind: 'record', fileIndices: [0], candidates: [] }]);

    const [rec] = (await scan()).proposedRecords;

    expect(rec.extractedData).toMatchObject({ moduleKey: 'other', documentKey: 'uncategorized' });
    expect(rec.category).toBe('document');
  });

  it('still accepts a top-level pair, the shape the prompt used to ask for', async () => {
    modelReply = reply([{
      kind: 'record',
      fileIndices: [0],
      extractedData: { moduleKey: 'vehicle', documentKey: 'puc_certificate' },
    }]);

    const [rec] = (await scan()).proposedRecords;

    expect(rec.category).toBe('vehicle');
  });
});

describe('the two destinations that own no category', () => {
  it('keeps todo and emergency_contact unfiled and unpaired', async () => {
    modelReply = reply([
      { kind: 'todo', fileIndices: [0], extractedData: { task: 'Renew passport' } },
      { kind: 'emergency_contact', fileIndices: [0], extractedData: { name: 'Dr Rao' } },
    ]);

    const [todo, contact] = (await scan()).proposedRecords;

    expect(todo.category).toBe('todo');
    expect(todo.extractedData.moduleKey).toBeUndefined();
    expect(contact.category).toBe('emergency_contact');
    expect(contact.extractedData.moduleKey).toBeUndefined();
  });
});

describe('what it does with the model rather than to it', () => {
  it('lifts a holderName the model nested inside extractedData', async () => {
    // Asked for as a sibling; a model told to emit a key beside a nested object
    // puts it inside often enough that leaving it there would save the person's
    // name as a FIELD of the record, which "Belongs to" already answers.
    modelReply = reply([{
      kind: 'record',
      fileIndices: [0],
      candidates: [{ moduleKey: 'identity', documentKey: 'aadhaar_card' }],
      extractedData: { holderName: 'Lakshmi Krishnan' },
    }]);

    const [rec] = (await scan()).proposedRecords;

    expect(rec.holderName).toBe('Lakshmi Krishnan');
    expect(rec.extractedData.holderName).toBeUndefined();
  });

  it('survives a record with no fileIndices and no extractedData', async () => {
    // Both are read unguarded downstream; a model that omits either used to
    // throw and lose the whole batch.
    modelReply = reply([{ kind: 'record', candidates: [{ moduleKey: 'education', documentKey: 'degree_diploma' }] }]);

    const [rec] = (await scan()).proposedRecords;

    expect(rec.fileIndices).toEqual([]);
    expect(rec.category).toBe('document');
  });
});
