/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ONLY ONE AUTOFILL OUTCOME MAY PICK A CATEGORY                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `/api/documents/autofill` answers `success: true` in three different senses,
 * and the Documents Manager upload form used to treat all three as "select
 * this category":
 *
 *  · a category the member may file under              → select it
 *  · a category with a `notice` — classified, but the member may NOT add
 *    there, and the category is only sent so the message can NAME it
 *  · the catch-all, which is the model saying it does not know
 *
 * Selecting either of the last two put an id into <CategorySelect> that its
 * (permission-filtered) option list does not contain. Radix renders a value it
 * has no item for as an EMPTY trigger rather than as its placeholder — so the
 * sub-category went blank — and `uploadCategory` never resolved, so the effect
 * that owns the "Reading document..." flag returned early on every render and
 * the form could never be saved. That is the bug these assertions exist to
 * keep fixed.
 */
import { describe, it, expect } from 'vitest';
import {
  FAILED_MESSAGE,
  UNAVAILABLE_CATEGORY_MESSAGE,
  UNCLASSIFIED_MESSAGE,
  resolveAutofillOutcome,
} from '@/lib/records/autofillOutcome';
import { UNCATEGORIZED } from '@/lib/documentCategories';

const PAN = {
  id: '11111111-1111-4111-8111-111111111111',
  moduleKey: 'identity',
  documentKey: 'pan_card',
  moduleName: 'Identity',
  documentName: 'PAN Card',
};

const OPTIONS = [PAN];

/** The shape the route returns on a clean, permitted classification. */
function permittedResponse(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    category: PAN,
    title: 'PAN Card',
    holderId: 'member-1',
    holderName: 'Ramya Krishnan',
    fields: { pan_number: 'ABCDE1234F' },
    pagesRead: 1,
    pagesTotal: 1,
    ...overrides,
  };
}

describe('resolveAutofillOutcome', () => {
  it('selects the category when the member may file under it', () => {
    const outcome = resolveAutofillOutcome(permittedResponse(), { categoryOptions: OPTIONS });

    expect(outcome.kind).toBe('apply');
    expect(outcome.categoryId).toBe(PAN.id);
    expect(outcome.fields).toEqual({ pan_number: 'ABCDE1234F' });
    expect(outcome.message).toBe('');
  });

  it('carries the category’s own names on apply, so a later mismatch can name it', () => {
    // A caller whose OWN `categoryOptions` later rejects this id (taxonomy
    // drift) still has to say WHAT it rejected — these are that fact.
    const outcome = resolveAutofillOutcome(permittedResponse(), { categoryOptions: OPTIONS });

    expect(outcome.moduleName).toBe(PAN.moduleName);
    expect(outcome.documentName).toBe(PAN.documentName);
  });

  it('leaves the names blank on every outcome that is not apply', () => {
    for (const body of [
      permittedResponse({ notice: 'not for you' }),
      permittedResponse({ unclassified: true, fields: {} }),
      { success: false, error: 'nope' },
    ]) {
      const outcome = resolveAutofillOutcome(body, { categoryOptions: OPTIONS });
      expect(outcome.moduleName).toBe('');
      expect(outcome.documentName).toBe('');
    }
  });

  it('never selects a category the route attached a notice to', () => {
    const notice = 'This looks like PAN Card, which you do not have permission to add.';
    const outcome = resolveAutofillOutcome(
      permittedResponse({ notice, fields: {} }),
      // Present in the list, so ONLY the notice can be what refuses it — the
      // server's answer must win even when the client's list would allow it.
      { categoryOptions: OPTIONS },
    );

    expect(outcome.kind).toBe('notPermitted');
    expect(outcome.categoryId).toBe('');
    expect(outcome.message).toBe(notice);
  });

  it('treats the catch-all as "could not classify", not as a category', () => {
    const outcome = resolveAutofillOutcome(
      permittedResponse({
        category: {
          id: '22222222-2222-4222-8222-222222222222',
          moduleKey: UNCATEGORIZED.moduleKey,
          documentKey: UNCATEGORIZED.documentKey,
        },
      }),
      // Offered — a tenant admin holds every category, Others included. Being
      // ABLE to file there is not a reason to file there by default.
      {
        categoryOptions: [
          ...OPTIONS,
          {
            id: '22222222-2222-4222-8222-222222222222',
            moduleKey: UNCATEGORIZED.moduleKey,
            documentKey: UNCATEGORIZED.documentKey,
          },
        ],
      },
    );

    expect(outcome.kind).toBe('unclassified');
    expect(outcome.categoryId).toBe('');
    expect(outcome.message).toBe(UNCLASSIFIED_MESSAGE);
  });

  it('reads the route\u2019s own unclassified flag, not only the catch-all keys', () => {
    // The route now SAYS it could not place the document, and skips the second
    // AI call when it says so. The keys still decide on an older deployment
    // that does not send the flag — this asserts the newer signal is honoured
    // even when the category looks like an ordinary one.
    const outcome = resolveAutofillOutcome(
      permittedResponse({ unclassified: true, fields: {} }),
      { categoryOptions: OPTIONS },
    );

    expect(outcome.kind).toBe('unclassified');
    expect(outcome.categoryId).toBe('');
  });

  it('keeps the title and the holder when it could not place the document', () => {
    // Both are true whatever the document turns out to be, and the form fills
    // them in before asking the user for a category. Dropping them here is how
    // an unclassified read became a completely blank form.
    const outcome = resolveAutofillOutcome(
      permittedResponse({ unclassified: true, fields: {} }),
      { categoryOptions: OPTIONS },
    );

    expect(outcome.title).toBe('PAN Card');
    expect(outcome.holderId).toBe('member-1');
    expect(outcome.holderName).toBe('Ramya Krishnan');
  });

  it('keeps the title and the holder when the member may not file there', () => {
    const outcome = resolveAutofillOutcome(
      permittedResponse({ notice: 'This looks like PAN Card, which…', fields: {} }),
      { categoryOptions: OPTIONS },
    );

    expect(outcome.kind).toBe('notPermitted');
    expect(outcome.title).toBe('PAN Card');
    expect(outcome.holderId).toBe('member-1');
  });

  it('refuses a category the picker has no option for', () => {
    const outcome = resolveAutofillOutcome(permittedResponse(), { categoryOptions: [] });

    expect(outcome.kind).toBe('notPermitted');
    expect(outcome.categoryId).toBe('');
    expect(outcome.message).toBe(UNAVAILABLE_CATEGORY_MESSAGE);
  });

  it('trusts the server while the master list has not loaded', () => {
    // `null` is "not loaded yet" and must not be read as "offers nothing" —
    // otherwise a scan that lands before the list would be refused outright.
    const outcome = resolveAutofillOutcome(permittedResponse(), { categoryOptions: null });

    expect(outcome.kind).toBe('apply');
    expect(outcome.categoryId).toBe(PAN.id);
  });

  it('reports a failed read with the route’s own words', () => {
    const outcome = resolveAutofillOutcome(
      { success: false, error: 'The document could not be read this time.' },
      { categoryOptions: OPTIONS },
    );

    expect(outcome.kind).toBe('failed');
    expect(outcome.categoryId).toBe('');
    expect(outcome.message).toBe('The document could not be read this time.');
  });

  it('falls back to a sentence of its own when there is no answer at all', () => {
    for (const body of [null, undefined, {}, { success: true, category: null }]) {
      const outcome = resolveAutofillOutcome(body as never, { categoryOptions: OPTIONS });
      expect(outcome.kind).toBe('failed');
      expect(outcome.message).toBe(FAILED_MESSAGE);
    }
  });

  it('keeps the title and the holder whatever became of the category', () => {
    // They are worth having on every outcome: a document the user has to file
    // by hand still names itself and still names a person.
    for (const body of [
      permittedResponse({ notice: 'not for you' }),
      permittedResponse({
        category: { id: 'x', moduleKey: UNCATEGORIZED.moduleKey, documentKey: UNCATEGORIZED.documentKey },
      }),
    ]) {
      const outcome = resolveAutofillOutcome(body, { categoryOptions: OPTIONS });
      expect(outcome.title).toBe('PAN Card');
      expect(outcome.holderId).toBe('member-1');
      expect(outcome.holderName).toBe('Ramya Krishnan');
    }
  });

  it('never carries field values on an outcome that selects nothing', () => {
    // The values are keyed to a category's spec. Applied against a category the
    // user then picks by hand, they would land in the wrong inputs or be
    // dropped silently.
    const outcome = resolveAutofillOutcome(
      permittedResponse({ notice: 'not for you' }),
      { categoryOptions: OPTIONS },
    );
    expect(outcome.fields).toEqual({});
  });
});
