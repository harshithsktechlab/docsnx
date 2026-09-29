/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   FIELD VALIDATION — the rules the add form and the POST route share     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The sub-category add form is generated from a category's stored spec, and its
 * rules travel with it. Two things must hold, and neither is visible by
 * clicking around:
 *
 *  1. The rules must accept what is actually printed on Indian documents. A
 *     validator that rejects a real PAN is not "strict", it is a wall between a
 *     user and their own record — so the positive cases here are the point, not
 *     the negative ones.
 *  2. Every `pattern` in the dictionary must COMPILE. Patterns are strings
 *     because they are serialised into `document_category_fields.fields`, and a
 *     malformed one is silently skipped at runtime (see `compile`), which would
 *     turn a validation rule into no rule at all with nothing in the logs.
 */
import { describe, it, expect } from 'vitest';
import {
  FORM_HIDDEN_KEYS,
  formFields,
  isBlank,
  isValid,
  normaliseCustomFields,
  validateField,
  validateRecord,
} from '@/lib/records/fieldValidation';
import { buildTaxonomyRecord } from '@/lib/records/categoryFormBody';
import {
  DOCUMENT_CATEGORY_FIELD_SEED,
  FIELD_FORMATS,
  type FieldSpec,
} from '@/lib/documentCategoryFields';

const spec = (over: Partial<FieldSpec> = {}): FieldSpec => ({
  fieldKey: 'pan_number',
  fieldLabel: 'PAN Number',
  dataType: 'text',
  isPii: true,
  validation: FIELD_FORMATS.pan_number,
  ...over,
});

/** Yesterday / tomorrow as YYYY-MM-DD, so the date rules can be exercised. */
const dayOffset = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

describe('required', () => {
  it('is the ONLY rule an empty value can break', () => {
    // Running a pattern against '' would put an error under every field the
    // moment the form opened, before the user had typed anything.
    expect(validateField(spec({ isRequired: false }), '')).toBeNull();
    expect(validateField(spec({ isRequired: false }), '   ')).toBeNull();
    expect(validateField(spec({ isRequired: true }), '')).toMatch(/required/i);
  });

  it('treats whitespace as blank — a space is not an answer', () => {
    expect(isBlank('   ')).toBe(true);
    expect(validateField(spec({ isRequired: true }), '  ')).toMatch(/required/i);
  });
});

describe('formats that must accept real documents', () => {
  it('accepts a well-formed PAN in either case, rejects a mistyped one', () => {
    expect(validateField(spec(), 'ABCDE1234F')).toBeNull();
    expect(validateField(spec(), 'abcde1234f')).toBeNull();
    expect(validateField(spec(), 'ABCD1234F')).toMatch(/PAN/);
    expect(validateField(spec(), 'ABCDE1234')).toMatch(/PAN/);
  });

  it('accepts Aadhaar with or without the spaces people type', () => {
    const aadhaar = spec({
      fieldKey: 'aadhaar_number',
      fieldLabel: 'Aadhaar Number',
      validation: FIELD_FORMATS.aadhaar_number,
    });
    expect(validateField(aadhaar, '1234 5678 9012')).toBeNull();
    expect(validateField(aadhaar, '123456789012')).toBeNull();
    expect(validateField(aadhaar, '12345678901')).toMatch(/12 digits/);
  });

  it('accepts an IFSC and a GSTIN as printed', () => {
    const ifsc = spec({ fieldKey: 'ifsc_code', fieldLabel: 'IFSC', validation: FIELD_FORMATS.ifsc_code });
    expect(validateField(ifsc, 'HDFC0001234')).toBeNull();
    expect(validateField(ifsc, 'HDFC1001234')).toMatch(/IFSC/);

    const gstin = spec({ fieldKey: 'gstin', fieldLabel: 'GSTIN', validation: FIELD_FORMATS.gstin });
    expect(validateField(gstin, '27ABCDE1234F1Z5')).toBeNull();
    expect(validateField(gstin, '27ABCDE1234F1X5')).toMatch(/GSTIN/);
  });
});

describe('numbers', () => {
  const amount = spec({
    fieldKey: 'premium_amount', fieldLabel: 'Premium', dataType: 'currency',
    isPii: true, validation: { min: 0 },
  });

  it('accepts what users actually type — commas, spaces, a rupee sign', () => {
    expect(validateField(amount, '1,25,000')).toBeNull();
    expect(validateField(amount, '₹ 4500')).toBeNull();
  });

  it('rejects a negative amount and a non-number', () => {
    expect(validateField(amount, '-100')).toMatch(/negative/i);
    expect(validateField(amount, 'twelve')).toMatch(/number/i);
  });
});

describe('dates', () => {
  it('rejects a date of birth in the future', () => {
    const dob = spec({
      fieldKey: 'date_of_birth', fieldLabel: 'Date of Birth', dataType: 'date',
      validation: FIELD_FORMATS.date_of_birth,
    });
    expect(validateField(dob, dayOffset(-1))).toBeNull();
    // Today must pass: a birth registered the same day is a real case.
    expect(validateField(dob, dayOffset(0))).toBeNull();
    expect(validateField(dob, dayOffset(1))).toMatch(/future/i);
  });

  it('rejects an unparseable date', () => {
    const d = spec({ fieldKey: 'issue_date', fieldLabel: 'Issue Date', dataType: 'date', validation: {} });
    expect(validateField(d, 'not a date')).toMatch(/valid date/i);
  });
});

describe('cross-field rules', () => {
  const specs: FieldSpec[] = [
    { fieldKey: 'valid_from', fieldLabel: 'Valid From', dataType: 'date', isPii: false },
    {
      fieldKey: 'valid_to', fieldLabel: 'Valid To', dataType: 'date', isPii: false,
      validation: FIELD_FORMATS.valid_to,
    },
  ];

  it('refuses a validity window that ends before it starts', () => {
    const errors = validateRecord(specs, { valid_from: '2026-01-01', valid_to: '2025-01-01' });
    expect(errors.valid_to).toMatch(/on or after/i);
    expect(isValid(errors)).toBe(false);
  });

  it('accepts the same day for both ends', () => {
    expect(isValid(validateRecord(specs, { valid_from: '2026-01-01', valid_to: '2026-01-01' }))).toBe(true);
  });

  it('skips the rule when the other field is blank — there is nothing to compare', () => {
    // Guessing here would put an error on a field the user filled in correctly,
    // because of one they have not filled in at all.
    expect(isValid(validateRecord(specs, { valid_to: '2025-01-01' }))).toBe(true);
  });
});

describe('validateRecord', () => {
  it('ignores keys the spec does not declare', () => {
    // The write path drops them, so an error here would point at an input the
    // form never rendered.
    const errors = validateRecord([spec({ isRequired: true })], {
      pan_number: 'ABCDE1234F',
      something_else: 'whatever',
    });
    expect(isValid(errors)).toBe(true);
  });
});

describe('custom fields', () => {
  it('drops rows with no label — an unlabelled value is unreadable later', () => {
    expect(normaliseCustomFields([
      { label: 'Locker no.', value: '4471' },
      { label: '', value: 'orphan' },
      { label: 'Branch', value: '  ' },
    ])).toEqual([{ label: 'Locker no.', value: '4471' }]);
  });

  it('accepts the JSON string the multipart path sends, and null for nothing', () => {
    expect(normaliseCustomFields('[{"label":"A","value":"B"}]')).toEqual([{ label: 'A', value: 'B' }]);
    expect(normaliseCustomFields('not json')).toBeNull();
    expect(normaliseCustomFields([])).toBeNull();
    expect(normaliseCustomFields(undefined)).toBeNull();
  });
});

describe('the seeded rules themselves', () => {
  it('every pattern in the dictionary compiles', () => {
    // A pattern that throws is skipped at runtime rather than failing closed,
    // so it would silently become no validation at all.
    for (const row of DOCUMENT_CATEGORY_FIELD_SEED) {
      const pattern = row.validation?.pattern;
      if (!pattern) continue;
      expect(() => new RegExp(pattern), `${row.moduleKey}/${row.documentKey}.${row.fieldKey}`).not.toThrow();
    }
  });

  it('every pattern rule carries a message a user can act on', () => {
    for (const [key, rule] of Object.entries(FIELD_FORMATS)) {
      if (!rule.pattern) continue;
      expect(rule.message, key).toBeTruthy();
    }
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A RULE MAY ONLY LAND ON A FIELD THE FORM RENDERS                       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `holder_name` is answered by the "Belongs to" picker and `custom_fields` by
 * the free-text rows, so neither is rendered as an input by any form in the app.
 *
 * A super admin could nonetheless mark either MANDATORY on
 * /admin/document-fields, and on a live tenant one of them did:
 * identity/aadhaar_card.holder_name. Every save of that sub-category then failed
 * with the error attached to a field that is nowhere on screen —
 *
 *   · POST /api/modules/:m/:d and POST /api/documents answered 400 "Please
 *     correct the highlighted fields", highlighting nothing;
 *   · the bulk-scan grid refused the whole batch with "1 record needs attention
 *     — check the fields marked below" and marked none.
 *
 * — and since the refusal happens BEFORE `createRecord`, the duplicate check
 * never ran at all. A working duplicate check looked like a missing one.
 *
 * The rule these guard: never judged, always STORED.
 */
describe('the fields no form renders as an input', () => {
  const hidden: FieldSpec[] = [
    { fieldKey: 'document_title', fieldLabel: 'Document Title', dataType: 'text', isPii: false, isRequired: true },
    { fieldKey: 'holder_name', fieldLabel: 'Holder Name', dataType: 'text', isPii: false, isRequired: true },
    { fieldKey: 'custom_fields', fieldLabel: 'Additional Details', dataType: 'longtext', isPii: false, isRequired: true },
    { fieldKey: 'cards', fieldLabel: 'Linked Cards', dataType: 'longtext', isPii: true, isRequired: true },
  ];

  it('names exactly the keys <CategoryFieldInputs> refuses to render', () => {
    // The list is the contract between the validator and the form. If one grows
    // a key the other does not, the bug above comes straight back.
    //
    // `cards` joined the list for a DIFFERENT reason from the other two: it has
    // a better control (<LinkedCardRows>), not no control at all. So unlike
    // them it IS still judged — asserted two tests down.
    expect([...FORM_HIDDEN_KEYS].sort()).toEqual(['cards', 'custom_fields', 'holder_name']);
  });

  /**
   * The exception the comment above is about. The other two hidden keys are
   * never the subject of a message, because there is nowhere on screen to put
   * one. `cards` has somewhere — the card rows — so a card with an impossible
   * number must still be refused, and named.
   */
  it('judges `cards` anyway, since it owns a control that can show the message', () => {
    const errors = validateRecord(formFields(hidden), {
      document_title: 'HDFC Savings',
      cards: JSON.stringify({ cards: [{ id: 'c1', cardNumber: '4111' }] }),
    });
    expect(errors.cards).toBe('Card 1: Card number must be 12 to 19 digits');
    // And the other two stay unjudged even though this spec marks them required.
    expect(errors.holder_name).toBeUndefined();
    expect(errors.custom_fields).toBeUndefined();
  });

  it('cannot be made mandatory — the record still validates', () => {
    // Not a vacuous assertion: over the WHOLE spec — which is what the route
    // used to pass — the same record fails on both keys. That is the 400 nobody
    // could act on, and the toast that marked nothing.
    const unfiltered = validateRecord(hidden, { document_title: 'Aadhaar' });
    expect(unfiltered.holder_name).toMatch(/required/i);
    expect(unfiltered.custom_fields).toMatch(/required/i);

    const { fieldErrors } = buildTaxonomyRecord(hidden, { document_title: 'Aadhaar' });

    expect(isValid(fieldErrors)).toBe(true);
    expect(fieldErrors.holder_name).toBeUndefined();
    expect(fieldErrors.custom_fields).toBeUndefined();
  });

  it('is still STORED — the allowlist is the whole spec, not the visible half', () => {
    // The point of the fix is that the values keep flowing. Dropping them here
    // would leave a field the encryption policy classifies with nothing to seal.
    const { record } = buildTaxonomyRecord(hidden, {
      document_title: 'Aadhaar',
      holder_name: 'Ramya',
      custom_fields: [{ label: 'Enrolment no.', value: '1234' }],
    });

    expect(record.holder_name).toBe('Ramya');
    expect(record.custom_fields).toBe('[{"label":"Enrolment no.","value":"1234"}]');
  });

  it('does not weaken a rule on a field that IS rendered', () => {
    // The other override on that live category was `address` required, and that
    // one has an input and must keep working.
    const { fieldErrors } = buildTaxonomyRecord(
      [...hidden, { fieldKey: 'address', fieldLabel: 'Address', dataType: 'longtext', isPii: true, isRequired: true }],
      { document_title: 'Aadhaar' },
    );

    expect(fieldErrors.address).toMatch(/required/i);
  });

  it('formFields leaves everything else alone, in spec order', () => {
    expect(formFields(hidden).map((f) => f.fieldKey)).toEqual(['document_title']);
    expect(formFields(null)).toEqual([]);
  });
});
