/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   FIELDS A SUPER ADMIN ADDED, AND THE TYPES THAT NEEDED A LIST           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * /admin/document-fields could only ever ADJUST a field the compiled dictionary
 * declared: `applyOverrides` mapped over the compiled specs, and the PUT route
 * refused any fieldKey the category did not declare. An operator who needed one
 * more field on a document type had no answer at all.
 *
 * The fix is one line in `applyOverrides` — an append pass for rows marked
 * `isCustom` — and that line is load-bearing far beyond itself: its result is
 * what `loadCategoryFieldSpec` returns, and that is the single door the add
 * form, the Documents Manager upload form, the Power Scan review grid,
 * `validateRecord`, `identifierFields`, `ocrFieldKeys` and
 * `buildTaxonomyRecord` all read.
 *
 * These tests pin the parts of that where being wrong is expensive: what gets
 * sealed, what the form is allowed to accept, and what a key may be called.
 */
import { describe, it, expect } from 'vitest';
import { applyOverrides, applyPolicyOverrides } from '@/lib/records/fieldOverrides';
import { validateField, parseMultiValue } from '@/lib/records/fieldValidation';
import { coerceExtracted } from '@/lib/records/autofillCoerce';
import { ocrFieldKeys, identifierFields } from '@/lib/documentCategoryFields';
import { toTaxonomyRecordFromFields } from '@/lib/records/normalize';
import {
  customFieldKey, isCustomFieldKey, tripsCredentialFilter,
} from '@/lib/records/customFieldKey';
import type { FieldSpec } from '@/lib/documentCategoryFields';

const SPECS: FieldSpec[] = [
  { fieldKey: 'document_title', fieldLabel: 'Document Title', dataType: 'text', isPii: false, isRequired: true },
  { fieldKey: 'pan_number', fieldLabel: 'PAN Number', dataType: 'text', isPii: true, isIdentifier: true },
];

const map = (o: Record<string, any>) => new Map(Object.entries(o));
const byKey = (specs: readonly FieldSpec[], key: string) => specs.find((f) => f.fieldKey === key);

/** A custom row as the POST route writes one. */
const custom = (over: Record<string, unknown> = {}) => ({
  isCustom: true,
  fieldLabel: 'Regional Office Code',
  dataType: 'text',
  isPii: true,
  isRequired: false,
  isPrinted: true,
  isIdentifier: false,
  ...over,
});

describe('a field an operator added', () => {
  it('is appended to the category spec', () => {
    const out = applyOverrides(SPECS, map({ cf_regional_office_code: custom() }));

    expect(out).toHaveLength(3);
    expect(byKey(out, 'cf_regional_office_code')).toMatchObject({
      fieldLabel: 'Regional Office Code', dataType: 'text', isCustom: true,
    });
  });

  it('lands after the dictionary fields, not in the middle of them', () => {
    // The sort reads a missing sortOrder as 0, so an appended field with none
    // would jump to the TOP the first time an operator reordered anything.
    const ordered: FieldSpec[] = SPECS.map((s, i) => ({ ...s, sortOrder: (i + 1) * 10 } as FieldSpec));
    const out = applyOverrides(ordered, map({
      cf_regional_office_code: custom(),
      // Something else moved, so the re-sort runs.
      pan_number: { sortOrder: 20 },
    }));

    expect(out[out.length - 1].fieldKey).toBe('cf_regional_office_code');
  });

  it('is dropped when hidden, like any other retired field', () => {
    const out = applyOverrides(SPECS, map({
      cf_regional_office_code: custom({ isHidden: true }),
    }));

    expect(byKey(out, 'cf_regional_office_code')).toBeUndefined();
  });

  it('is refused when it cannot be rendered', () => {
    // The 0041 CHECK makes this unreachable through the API, but this function
    // also reads rows written by hand. A spec entry with no label is a form
    // that throws while rendering.
    const out = applyOverrides(SPECS, map({
      cf_broken: { isCustom: true, dataType: 'text' },
      cf_worse: { isCustom: true, fieldLabel: 'X', dataType: 'not-a-type' },
    }));

    expect(out).toHaveLength(2);
  });

  it('does not appear twice when its key is also a dictionary key', () => {
    const out = applyOverrides(SPECS, map({
      pan_number: { ...custom(), fieldLabel: 'PAN' },
    }));

    expect(out.filter((f) => f.fieldKey === 'pan_number')).toHaveLength(1);
  });
});

describe('what a custom field does to the encryption policy', () => {
  it('seals when the operator marked it encrypted', () => {
    // THE point of putting custom fields in the overrides table: this function
    // was written before they existed and needed no change to seal one.
    const out = applyPolicyOverrides(['pan_number'], map({
      cf_regional_office_code: custom({ isPii: true }),
    }));

    expect(out).toContain('cf_regional_office_code');
  });

  it('seals when the operator expressed no view at all', () => {
    // For a dictionary field, null means "use the compiled policy". A custom
    // field has no compiled policy, so the only safe reading is SEAL — and it
    // must match `customSpec`'s default, or a field would claim to be sealed on
    // the spec while the policy left it in the open tier.
    const out = applyPolicyOverrides([], map({
      cf_regional_office_code: custom({ isPii: null }),
    }));

    expect(out).toContain('cf_regional_office_code');
  });

  it('stays open when the operator explicitly opened it', () => {
    const out = applyPolicyOverrides([], map({
      cf_regional_office_code: custom({ isPii: false }),
    }));

    expect(out).not.toContain('cf_regional_office_code');
  });

  it('agrees with the spec it produces', () => {
    const overrides = map({ cf_x: custom({ isPii: null }) });
    const spec = byKey(applyOverrides(SPECS, overrides), 'cf_x')!;
    const policy = applyPolicyOverrides([], overrides);

    expect(spec.isPii).toBe(true);
    expect(policy).toContain('cf_x');
  });
});

describe('a custom field reaches the rest of the pipeline', () => {
  const specs = applyOverrides(SPECS, map({
    cf_regional_office_code: custom({ isIdentifier: false }),
    cf_secret_note: custom({ fieldLabel: 'Note', isPrinted: false }),
  }));

  it('is asked for by a scan when it is printed on the document', () => {
    expect(ocrFieldKeys(specs)).toContain('cf_regional_office_code');
  });

  it('is not asked for when the operator turned scanning off', () => {
    expect(ocrFieldKeys(specs)).not.toContain('cf_secret_note');
  });

  it('can be the category identifier', () => {
    const withId = applyOverrides(SPECS, map({
      cf_regional_office_code: custom({ isIdentifier: true }),
    }));

    expect(identifierFields(withId)).toContain('cf_regional_office_code');
  });

  it('is accepted and sealed by the write path', () => {
    const out = toTaxonomyRecordFromFields(specs as any, {
      cf_regional_office_code: 'MUM-04',
      cf_not_declared: 'should be dropped',
    });

    expect(out.record.cf_regional_office_code).toBe('MUM-04');
    expect(out.record.cf_not_declared).toBeUndefined();
    expect(out.mustSeal).toContain('cf_regional_office_code');
  });
});

describe('a custom date can drive follow-ups', () => {
  const dated = (isReminder?: boolean) => [{
    fieldKey: 'cf_renewal', fieldLabel: 'Renewal', dataType: 'date', isPii: false,
    ...(isReminder === undefined ? {} : { isReminder }),
  }] as any;

  it('does not, by default — REMINDER_FIELD_KEYS does not know the key', () => {
    const out = toTaxonomyRecordFromFields(dated(), { cf_renewal: '2030-01-01' });

    expect(out.reminders).toHaveLength(0);
    expect(out.nextDueAt).toBeNull();
  });

  it('does, once the operator says so', () => {
    const out = toTaxonomyRecordFromFields(dated(true), { cf_renewal: '2030-01-01' });

    expect(out.reminders).toHaveLength(1);
    expect(out.nextDueAt).not.toBeNull();
  });

  it('and a shipped reminder date can be turned OFF', () => {
    const off = [{
      fieldKey: 'expiry_date', fieldLabel: 'Expiry', dataType: 'date',
      isPii: false, isReminder: false,
    }] as any;

    expect(toTaxonomyRecordFromFields(off, { expiry_date: '2030-01-01' }).reminders)
      .toHaveLength(0);
  });
});

describe('choice fields', () => {
  const select = (options: Array<{ value: string; label: string }>, over = {}) => ({
    fieldKey: 'cf_fuel', fieldLabel: 'Fuel', dataType: 'select', isPii: false, options, ...over,
  }) as any;

  const OPTIONS = [
    { value: 'petrol', label: 'Petrol' },
    { value: 'diesel', label: 'Diesel' },
    { value: 'ev', label: 'Electric' },
  ];

  it('accepts a listed choice', () => {
    expect(validateField(select(OPTIONS), 'diesel')).toBeNull();
  });

  it('refuses one that is not listed', () => {
    expect(validateField(select(OPTIONS), 'cng')).toMatch(/one of the listed choices/);
  });

  it('degrades to free text while the operator has not added options', () => {
    // A half-built field must not lock every record of the category out of
    // editing. The form makes the same concession, so the two agree.
    expect(validateField(select([]), 'anything')).toBeNull();
  });

  it('still enforces required', () => {
    expect(validateField(select(OPTIONS, { isRequired: true }), '')).toMatch(/required/);
  });

  describe('choosing several', () => {
    const multi = (over = {}) => ({
      fieldKey: 'cf_addons', fieldLabel: 'Add-ons', dataType: 'multiselect',
      isPii: false, options: OPTIONS, ...over,
    }) as any;

    it('accepts a JSON array of listed choices', () => {
      expect(validateField(multi(), '["petrol","ev"]')).toBeNull();
    });

    it('refuses an array holding a choice that is gone', () => {
      expect(validateField(multi(), '["petrol","cng"]')).toMatch(/no longer offered/);
    });

    it('treats an empty array as empty, not as a value', () => {
      // `isBlank` cannot see it — '[]' is a two-character string — so a
      // mandatory multiselect would otherwise be satisfied by choosing nothing.
      expect(validateField(multi({ isRequired: true }), '[]')).toMatch(/required/);
      expect(validateField(multi(), '[]')).toBeNull();
    });

    it('reads a bare string as one choice', () => {
      // What a value written when the field was still `text` looks like.
      // Refusing it would make those records uneditable rather than fixable.
      expect(parseMultiValue('petrol')).toEqual(['petrol']);
      expect(validateField(multi(), 'petrol')).toBeNull();
    });
  });

  describe('what a scan is allowed to fill in', () => {
    it('snaps an answer whose casing and spacing differ', () => {
      expect(coerceExtracted(select(OPTIONS), ' E V ')).toBe('ev');
    });

    it('accepts the label where it differs from the stored value', () => {
      // The prompt asks for values, but a model reading "Electric" off the page
      // returns the word it saw often enough to matter.
      expect(coerceExtracted(select(OPTIONS), 'Electric')).toBe('ev');
    });

    it('drops an answer that matches nothing', () => {
      // This file's rule: dropping beats guessing. An answer outside the list
      // is the model substituting its vocabulary for the operator's.
      expect(coerceExtracted(select(OPTIONS), 'CNG')).toBeNull();
    });

    it('returns a multiselect as the JSON array the form stores', () => {
      const spec = { ...select(OPTIONS), dataType: 'multiselect' };

      expect(coerceExtracted(spec, 'Petrol, Electric')).toBe('["petrol","ev"]');
      expect(coerceExtracted(spec, ['diesel'])).toBe('["diesel"]');
    });

    it('keeps the choices it could read and drops the ones it could not', () => {
      const spec = { ...select(OPTIONS), dataType: 'multiselect' };

      expect(coerceExtracted(spec, 'Petrol, Hydrogen')).toBe('["petrol"]');
    });
  });
});

describe('text types with a shape', () => {
  const shaped = (dataType: string) => ({
    fieldKey: 'cf_x', fieldLabel: 'X', dataType, isPii: false,
  }) as any;

  it('checks an email', () => {
    expect(validateField(shaped('email'), 'ops@example.com')).toBeNull();
    expect(validateField(shaped('email'), 'ops@example')).toMatch(/email address/);
  });

  it('accepts phone numbers as people actually write them', () => {
    // When a rule and reality disagree, reality is right — this file's own note.
    for (const value of ['+91 98765 43210', '(022) 2222-3333', '9876543210']) {
      expect(validateField(shaped('phone'), value)).toBeNull();
    }
    expect(validateField(shaped('phone'), 'call me')).toMatch(/phone number/);
  });

  it('does not insist a web address carries a scheme', () => {
    expect(validateField(shaped('url'), 'example.com')).toBeNull();
    expect(validateField(shaped('url'), 'https://sub.example.co.in/x')).toBeNull();
    expect(validateField(shaped('url'), 'not a url')).toMatch(/web address/);
  });

  it('checks a time', () => {
    expect(validateField(shaped('time'), '14:30')).toBeNull();
    expect(validateField(shaped('time'), '25:00')).toMatch(/time like/);
  });
});

describe('naming a field an operator invented', () => {
  it('prefixes the key, so it can never collide with the dictionary', () => {
    const key = customFieldKey("Agent's Email Address", []);

    expect(key).toBe('cf_agent_s_email_address');
    expect(isCustomFieldKey(key!)).toBe(true);
  });

  it('is not `custom_`, which would collide with the baseline custom_fields', () => {
    expect(customFieldKey('Fields', [])).not.toBe('custom_fields');
  });

  it('uniquifies rather than overwriting an existing field', () => {
    // Overwriting would silently take over the ciphertext already stored under
    // that key in every tenant's vault.
    expect(customFieldKey('Office', ['cf_office'])).toBe('cf_office_2');
    expect(customFieldKey('Office', ['cf_office', 'cf_office_2'])).toBe('cf_office_3');
  });

  it('refuses a label with nothing to make a key from', () => {
    expect(customFieldKey('!!!', [])).toBeNull();
    expect(customFieldKey('   ', [])).toBeNull();
  });

  it('stays inside the column', () => {
    expect(customFieldKey('x'.repeat(500), [])!.length).toBeLessThanOrEqual(100);
  });
});

describe('the credential-name guard', () => {
  /**
   * `prepareAiPayload` DELETES any key whose folded name holds a credential
   * word. An open field named this way would vanish from every AI payload with
   * nothing anywhere to say why, so it is caught when the field is named.
   */
  it('catches the words that would make a field disappear', () => {
    for (const label of ['Login PIN', 'API Token', 'Recovery Secret', 'Card CVV']) {
      const key = customFieldKey(label, [])!;
      expect(tripsCredentialFilter(key)).toBeTruthy();
    }
  });

  it('leaves an ordinary field alone', () => {
    for (const label of ['Regional Office Code', 'Branch Name', 'Renewal Date']) {
      expect(tripsCredentialFilter(customFieldKey(label, [])!)).toBeNull();
    }
  });

  it('does not eat a word that merely CONTAINS a short one', () => {
    // `pin` inside `cin_or_llpin` — a company identifier printed on every MoA.
    // The masker narrowed this rule for exactly that reason; so does this.
    expect(tripsCredentialFilter('cf_cin_or_llpin')).toBeNull();
    expect(tripsCredentialFilter('cf_upi_pin')).toBe('pin');
  });
});
