/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   classifyDocument — A NEAR MISS IS NOT AN UNCLASSIFIED DOCUMENT         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The single-document upload path classifies before it reads: nothing can ask
 * the right questions of a PAN card until something has said it IS a PAN card.
 * That made this one call the whole flow's single point of failure, and it used
 * to be all-or-nothing — one (moduleKey, documentKey) pair, and anything not
 * exactly seeded became the catch-all, which the form shows as "could not work
 * out the category" and fills in NOTHING.
 *
 * Models miss that way constantly, and not by being wrong about the document:
 * `identity/pan` (abbreviated), `bank_investments/bank_statements` (a real key,
 * but `business` is the module that owns it). Both plainly recognised the
 * document; both produced a blank form.
 *
 * So the prompt asks for up to three, best first, and the first genuinely
 * seeded pair wins. These assert that selection — the fallback stays reachable
 * for a document that really fits nothing, and it stops being where a spelling
 * mistake lands.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** What the model "returns" for the next call. Set per test. */
let modelAnswer = '{}';
/**
 * Answers for CONSECUTIVE calls, when a test is about the retry.
 *
 * `classifyDocument` may call the model twice — once, and once more only if
 * nothing it proposed was a real category. A single `modelAnswer` cannot
 * express "missed, then hit", which is the whole behaviour under test here.
 */
let modelAnswers: string[] = [];

// The request object is typed in so `mock.calls[n][0]` can be read — the
// assertions below are about WHAT was sent, not only about the answer.
const generateContent = vi.fn(async (_req?: { contents?: unknown[] }) => ({
  text: modelAnswers.length > 0 ? modelAnswers.shift()! : modelAnswer,
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
}));

vi.mock('@/lib/aiKeyManager', () => ({
  // The rotation wrapper's only job here is to hand the callback a client. The
  // pool, the credits and the backoff are aiKeyManager's own tests.
  executeTenantWithRotation: async (_tenantId: string, _action: string, fn: any) => fn({
    provider: 'gemini',
    model: 'gemini-test',
    client: {
      models: {
        countTokens: async () => ({ totalTokens: 100 }),
        generateContent,
      },
    },
  }),
  AI_ERROR_CODES: {},
  AI_ERROR_MESSAGES: {},
}));

const { classifyDocument } = await import('@/lib/ai');

const PAGES = [{ base64: 'aGk=', mimeType: 'image/jpeg', fileName: 'scan.jpg', pageNumber: 1 }];

const classify = () => classifyDocument(PAGES, 't1', 'u1');
/** The same call from inside a company workspace. */
const classifyInCompany = () => classifyDocument(PAGES, 't1', 'u1', 'business');

beforeEach(() => {
  vi.clearAllMocks();
  modelAnswers = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Every classify now reports its outcome on one line, so the success path
  // would otherwise print through the whole suite.
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('classifyDocument', () => {
  it('takes the first candidate, when the first candidate is real', () => {
    modelAnswer = JSON.stringify({
      candidates: [
        { moduleKey: 'identity', documentKey: 'pan_card' },
        { moduleKey: 'business', documentKey: 'pan_tan' },
      ],
      title: 'PAN Card',
      holderName: 'Ramya Krishnan',
    });

    return classify().then((out: any) => {
      expect(out.moduleKey).toBe('identity');
      expect(out.documentKey).toBe('pan_card');
      expect(out.title).toBe('PAN Card');
      expect(out.holderName).toBe('Ramya Krishnan');
    });
  });

  it('falls through a misspelled first choice to a real second one', async () => {
    // The exact failure this exists for: the model knew what it was looking at
    // and abbreviated the key. All-or-nothing turned that into a blank form.
    modelAnswer = JSON.stringify({
      candidates: [
        { moduleKey: 'identity', documentKey: 'pan' },
        { moduleKey: 'identity', documentKey: 'pan_card' },
      ],
      title: 'PAN Card',
    });

    const out: any = await classify();

    expect(out.moduleKey).toBe('identity');
    expect(out.documentKey).toBe('pan_card');
  });

  it('rejects a real key paired with the wrong module, and keeps looking', async () => {
    // `registration_certificate` exists — under `vehicle`, not `identity`. Each
    // half is valid and the PAIR is not, which is why the check is on the pair.
    //
    // Both candidates are personal on purpose. This case used to reach across
    // to `biz_finance/bank_statements`, and cannot any more: the household's
    // classifier is shown the personal taxonomy only, so a business pair is now
    // discarded here rather than filed — a business record cannot exist without
    // a company, so it was never a destination this call could reach. See the
    // company case below for the same rule in the other direction.
    modelAnswer = JSON.stringify({
      candidates: [
        { moduleKey: 'identity', documentKey: 'registration_certificate' },
        { moduleKey: 'vehicle', documentKey: 'registration_certificate' },
      ],
    });

    const out: any = await classify();

    expect(out.moduleKey).toBe('vehicle');
    expect(out.documentKey).toBe('registration_certificate');
  });

  it('will not file a business pair from the household', async () => {
    // A trade licence read on the household's upload form. It has nowhere to go
    // — a `biz_*` record with no company is a row the CHECK constraint refuses
    // — so it lands in the catch-all and the member re-files it from the
    // company's own workspace.
    modelAnswer = JSON.stringify({
      candidates: [{ moduleKey: 'biz_licenses', documentKey: 'trade_license' }],
    });

    const out: any = await classify();

    expect(out.moduleKey).toBe('other');
    expect(out.documentKey).toBe('uncategorized');
  });

  it('files a business pair when it IS a company asking', async () => {
    modelAnswer = JSON.stringify({
      candidates: [{ moduleKey: 'biz_licenses', documentKey: 'trade_license' }],
    });

    const out: any = await classifyInCompany();

    expect(out.moduleKey).toBe('biz_licenses');
    expect(out.documentKey).toBe('trade_license');
  });

  it('leaves a company\u2019s unplaceable document unplaced, not in the catch-all', async () => {
    // `other/uncategorized` is a HOUSEHOLD module, so it is not a destination a
    // company can use. An empty pair is what makes the upload form ask the
    // member to choose — see `/api/documents/autofill`, which turns it into a
    // 422 saying exactly that.
    modelAnswer = JSON.stringify({
      candidates: [{ moduleKey: 'identity', documentKey: 'pan_card' }],
    });

    const out: any = await classifyInCompany();

    expect(out.moduleKey).toBe('');
    expect(out.documentKey).toBe('');
  });

  it('still accepts the older single-pair answer shape', async () => {
    // A model given a new schema answers the old one often enough that dropping
    // support for it would be a regression nobody could see in review.
    modelAnswer = JSON.stringify({
      moduleKey: 'identity', documentKey: 'passport', title: 'Passport',
    });

    const out: any = await classify();

    expect(out.documentKey).toBe('passport');
  });

  it('falls back to Uncategorized only when NO candidate is seeded', async () => {
    modelAnswer = JSON.stringify({
      candidates: [
        { moduleKey: 'identity', documentKey: 'library_card' },
        { moduleKey: 'made_up', documentKey: 'nonsense' },
      ],
    });

    const out: any = await classify();

    expect(out.moduleKey).toBe('other');
    expect(out.documentKey).toBe('uncategorized');
    // Logged, so the invention rate stays visible before anyone trusts this.
    expect(console.warn).toHaveBeenCalled();
  });

  it('answers Uncategorized, and is not accused of inventing it, when the model insists', async () => {
    // The catch-all IS a seeded pair, so it validates like any other. A model
    // that honestly says "this fits nothing" has not hallucinated anything and
    // must not be logged as if it had — otherwise the warning stops meaning
    // anything. What IS logged is the outcome: a document that ended in the
    // catch-all is a blank sub-category on the upload form, and how often that
    // happens was previously invisible from outside the browser.
    modelAnswer = JSON.stringify({
      candidates: [{ moduleKey: 'other', documentKey: 'uncategorized' }],
    });

    const out: any = await classify();

    expect(out.documentKey).toBe('uncategorized');
    const warned = (console.warn as any).mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(warned).toContain('did not place');
    expect(warned).not.toContain('unknown');
    expect(warned).not.toContain('refused');
  });

  /**
   * ── DECLINING TO FILE IS A FAILURE, NOT AN ANSWER ───────────────────────
   * The fallback validates like any other pair, so it used to end the call —
   * and the user saw a blank sub-category and pressed the button again, paying
   * for a whole second upload, rasterisation and classify to ask the identical
   * question. It earns the same in-call retry a refused pair does.
   */
  it('asks again when the model answers the fallback, and takes a real second answer', async () => {
    modelAnswers = [
      JSON.stringify({ candidates: [{ moduleKey: 'other', documentKey: 'uncategorized' }], title: 'Scan' }),
      JSON.stringify({
        candidates: [{ moduleKey: 'health_medical', documentKey: 'records_prescriptions' }],
        title: 'Prescription',
      }),
    ];

    const out: any = await classify();

    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(out.moduleKey).toBe('health_medical');
    expect(out.documentKey).toBe('records_prescriptions');
    expect(out.title).toBe('Prescription');
    // The correction says what it is correcting, without naming a pair as
    // unknown — the fallback is not a misspelling.
    const second = (generateContent.mock.calls[1][0] as any).contents as any[];
    expect(second[second.length - 1]).toContain('the fallback');
  });

  it('appends the HUF suffix to a name the document carries it with', async () => {
    modelAnswer = JSON.stringify({
      candidates: [{ moduleKey: 'identity', documentKey: 'pan_card' }],
      title: 'PAN Card HUF',
      holderName: 'Krishnan Family',
    });

    const out: any = await classify();

    expect(out.holderName).toContain('(HUF)');
  });

  it('asks the model for ranked candidates and for the fallback last', async () => {
    modelAnswer = JSON.stringify({ candidates: [{ moduleKey: 'identity', documentKey: 'pan_card' }] });

    await classify();

    const prompt = (generateContent.mock.calls[0][0] as any).contents[0] as string;
    expect(prompt).toContain('"candidates"');
    expect(prompt).toMatch(/BEST FIRST/);
    // The fallback is stated as a last resort in substance rather than as a
    // headed paragraph naming its keys before the list — a named escape hatch
    // is one the model reaches for.
    expect(prompt).toContain('The FIRST candidate must be a real entry');
    expect(prompt).toContain('never the answer for a document you were able to read');
    // The boundary statements that separate neighbouring modules — one source,
    // rendered into both prompts. This is the personal list, so assert a
    // personal hint; `REGISTERED ENTITY` belonged to the `business` module 0050
    // retired, and the business boundaries now render into the business prompt.
    expect(prompt).toContain('Not a company');
  });

  /**
   * ── THE FILENAME REACHES THE MODEL ──────────────────────────────────────
   * The batch scanner has always ended its prompt with a manifest naming every
   * file; this path sent bare page images, and that missing signal is why the
   * SAME document filed correctly through Power Scan and landed in the
   * catch-all here.
   */
  it('names the pages it is sending, like the batch scanner does', async () => {
    modelAnswer = JSON.stringify({ candidates: [{ moduleKey: 'identity', documentKey: 'pan_card' }] });

    await classifyDocument(
      [
        { base64: 'aGk=', mimeType: 'image/jpeg', fileName: 'Salary Slip March (Page 1).jpg', pageNumber: 1 },
        { base64: 'aGk=', mimeType: 'image/jpeg', fileName: 'Salary Slip March (Page 2).jpg', pageNumber: 2 },
      ] as any,
      't1',
      'u1',
    );

    const contents = (generateContent.mock.calls[0][0] as any).contents as any[];
    const manifest = contents[contents.length - 1];
    expect(manifest).toContain('Salary Slip March (Page 1).jpg');
    expect(manifest).toContain('Salary Slip March (Page 2).jpg');
    expect(manifest).toContain('Page 2');
  });

  /**
   * ── ONE RETRY, AND ONLY WHEN IT WOULD OTHERWISE FAIL ────────────────────
   * A classify that places nothing shows the user a blank sub-category, and
   * what they did about it was press the button again — a second upload, a
   * second rasterisation and a second billed call to ask the same question.
   */
  it('asks a second time when nothing it proposed exists, and takes that answer', async () => {
    modelAnswers = [
      JSON.stringify({ candidates: [{ moduleKey: 'payroll', documentKey: 'payslip' }], title: 'Payslip' }),
      JSON.stringify({
        candidates: [{ moduleKey: 'employment', documentKey: 'salary_slips' }],
        title: 'Salary Slip',
        holderName: 'Ramya Krishnan',
      }),
    ];

    const out: any = await classify();

    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(out.moduleKey).toBe('employment');
    expect(out.documentKey).toBe('salary_slips');
    // The retry's own answer wins whole — it is the one that placed the file.
    expect(out.title).toBe('Salary Slip');
    expect(out.holderName).toBe('Ramya Krishnan');
    // The correction names what was refused, so the second ask cannot spend
    // itself repeating the first.
    const second = (generateContent.mock.calls[1][0] as any).contents as any[];
    expect(second[second.length - 1]).toContain('payroll/payslip');
  });

  it('does not ask twice when the first answer was real', async () => {
    modelAnswer = JSON.stringify({ candidates: [{ moduleKey: 'identity', documentKey: 'pan_card' }] });

    await classify();

    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  /**
   * `recordTenantAiUsage` bills from these. Reporting one call's tokens for two
   * would under-report the tenant's own spend on the screens that explain it.
   */
  it('bills both attempts when it retried', async () => {
    modelAnswers = [
      JSON.stringify({ candidates: [{ moduleKey: 'payroll', documentKey: 'payslip' }] }),
      JSON.stringify({ candidates: [{ moduleKey: 'employment', documentKey: 'salary_slips' }] }),
    ];

    const out: any = await classify();

    expect(out.promptTokens).toBe(20);
    expect(out.completionTokens).toBe(10);
  });

  it('keeps the first answer when the retry misses too', async () => {
    modelAnswers = [
      JSON.stringify({ candidates: [{ moduleKey: 'payroll', documentKey: 'payslip' }], title: 'Payslip', holderName: 'Ramya' }),
      JSON.stringify({ candidates: [{ moduleKey: 'hr', documentKey: 'pay' }], title: '' }),
    ];

    const out: any = await classify();

    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(out.documentKey).toBe('uncategorized');
    // The title and the holder are true whatever the category came to, and the
    // form still uses them.
    expect(out.title).toBe('Payslip');
    expect(out.holderName).toBe('Ramya');
    expect(console.warn).toHaveBeenCalled();
  });

  /**
   * ── THE LOG NAMES ONLY WHAT IT ASKED ABOUT ──────────────────────────────
   * The loop stops at the first real pair, so the candidates after it were
   * never tested. Reporting them as unknown is how production logs came to
   * accuse the model of inventing `employment/salary_slips` — an active row in
   * the master table whose only crime was being the second choice.
   */
  it('never reports a candidate it did not test as unknown', async () => {
    modelAnswer = JSON.stringify({
      candidates: [
        { moduleKey: 'bank_investments', documentKey: 'itr_form16' },
        { moduleKey: 'employment', documentKey: 'salary_slips' },
        { moduleKey: 'tax_compliance', documentKey: 'tds_certificates' },
      ],
    });

    const out: any = await classify();

    expect(out.documentKey).toBe('itr_form16');
    expect(console.warn).not.toHaveBeenCalled();
    const logged = (console.log as any).mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(logged).not.toContain('salary_slips');
    expect(logged).not.toContain('tds_certificates');
  });
});
