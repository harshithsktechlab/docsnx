/**
 * The resolution layer behind /admin/document-fields.
 *
 * Pure — no DB. What matters here is not that a value can be overridden, but
 * the three-state rule underneath it: NULL means "the operator expressed no
 * view", which is a different thing from `false`. Collapse the two and Reset
 * becomes impossible, every "turn this off" silently fails, and a row that only
 * ever meant "unset" freezes a field against future dictionary changes.
 */
import { describe, it, expect } from 'vitest';
import { applyOverrides, applyPolicyOverrides } from '../src/lib/records/fieldOverrides';
import { toTaxonomyRecord } from '../src/lib/records/normalize';
import type { FieldSpec } from '../src/lib/documentCategoryFields';

const SPECS: FieldSpec[] = [
  { fieldKey: 'document_title', fieldLabel: 'Document Title', dataType: 'text', isPii: false, isRequired: true },
  {
    fieldKey: 'pan_number', fieldLabel: 'PAN Number', dataType: 'text', isPii: true,
    isRequired: true, isIdentifier: true,
    validation: { pattern: '^[A-Z]{5}[0-9]{4}[A-Z]$', message: 'Five letters, four digits, a letter' },
  },
  { fieldKey: 'father_name', fieldLabel: "Father's Name", dataType: 'text', isPii: true },
  { fieldKey: 'issue_date', fieldLabel: 'Issue Date', dataType: 'date', isPii: false },
  { fieldKey: 'notes', fieldLabel: 'Notes', dataType: 'longtext', isPii: true, isPrinted: false },
];

const map = (o: Record<string, any>) => new Map(Object.entries(o));
const byKey = (specs: readonly FieldSpec[], key: string) => specs.find((f) => f.fieldKey === key);

describe('applyOverrides', () => {
  it('returns the specs untouched when nothing is configured', () => {
    expect(applyOverrides(SPECS, new Map())).toBe(SPECS);
  });

  it('treats null as "no view expressed"', () => {
    const out = applyOverrides(SPECS, map({
      pan_number: { isPii: null, isRequired: null, fieldLabel: null, dataType: null },
    }));
    const pan = byKey(out, 'pan_number')!;
    expect(pan.isPii).toBe(true);
    expect(pan.isRequired).toBe(true);
    expect(pan.fieldLabel).toBe('PAN Number');
    expect(pan.dataType).toBe('text');
  });

  it('lets false override a true default', () => {
    // The `??` vs `||` trap this helper is written against: `false || true` is
    // `true`, so a `||` here would make every "turn this off" silently fail —
    // and the operator would have no way to tell it had not worked.
    const out = applyOverrides(SPECS, map({
      pan_number: { isRequired: false, isIdentifier: false },
    }));
    const pan = byKey(out, 'pan_number')!;
    expect(pan.isRequired).toBe(false);
    expect(pan.isIdentifier).toBe(false);
  });

  it('lets true override a false default', () => {
    const out = applyOverrides(SPECS, map({ issue_date: { isPii: true, isRequired: true } }));
    const d = byKey(out, 'issue_date')!;
    expect(d.isPii).toBe(true);
    expect(d.isRequired).toBe(true);
  });

  it('renames a label but ignores a blank one', () => {
    const out = applyOverrides(SPECS, map({
      father_name: { fieldLabel: "Parent's Name" },
      issue_date: { fieldLabel: '   ' },
    }));
    expect(byKey(out, 'father_name')!.fieldLabel).toBe("Parent's Name");
    // A blank input should not blank the form — it reads as "unset".
    expect(byKey(out, 'issue_date')!.fieldLabel).toBe('Issue Date');
  });

  it('accepts a real data type and ignores an invented one', () => {
    const out = applyOverrides(SPECS, map({
      issue_date: { dataType: 'text' },
      father_name: { dataType: 'wingdings' },
    }));
    expect(byKey(out, 'issue_date')!.dataType).toBe('text');
    // A type nothing can render would break the form at render time; the column
    // is operator-editable, so it is filtered rather than trusted.
    expect(byKey(out, 'father_name')!.dataType).toBe('text');
  });

  it('merges validation over the compiled rule instead of replacing it', () => {
    // An operator adding a placeholder must not discard the pattern that makes
    // a PAN a PAN.
    const out = applyOverrides(SPECS, map({
      pan_number: { validation: { example: 'ABCDE1234F', maxLength: 10 } },
    }));
    const v = byKey(out, 'pan_number')!.validation!;
    expect(v.example).toBe('ABCDE1234F');
    expect(v.maxLength).toBe(10);
    expect(v.pattern).toBe('^[A-Z]{5}[0-9]{4}[A-Z]$');
    expect(v.message).toBe('Five letters, four digits, a letter');
  });

  it('drops a regex an operator tried to smuggle through validation', () => {
    // `pattern` is not in the editable subset: a bad anchored regex silently
    // rejects every value a user types, and the same key is validated
    // identically across the categories that share it.
    const out = applyOverrides(SPECS, map({
      pan_number: { validation: { pattern: '^nope$', message: 'no', example: 'ABCDE1234F' } },
    }));
    const v = byKey(out, 'pan_number')!.validation!;
    expect(v.pattern).toBe('^[A-Z]{5}[0-9]{4}[A-Z]$');
    expect(v.example).toBe('ABCDE1234F');
  });

  it('removes a hidden field from the spec entirely', () => {
    // Dropping rather than flagging is what makes "retired" mean something: the
    // spec is the allowlist buildTaxonomyRecord filters a submitted body
    // through, so an absent field is one the form does not render AND the write
    // path does not accept.
    const out = applyOverrides(SPECS, map({ father_name: { isHidden: true } }));
    expect(out.map((f) => f.fieldKey)).not.toContain('father_name');
    expect(out).toHaveLength(SPECS.length - 1);
  });

  it('keeps declaration order until an ordering override exists', () => {
    const untouched = applyOverrides(SPECS, map({ pan_number: { isRequired: false } }));
    expect(untouched.map((f) => f.fieldKey)).toEqual(SPECS.map((f) => f.fieldKey));

    const reordered = applyOverrides(SPECS, map({
      document_title: { sortOrder: 40 },
      pan_number: { sortOrder: 30 },
      father_name: { sortOrder: 20 },
      issue_date: { sortOrder: 10 },
      notes: { sortOrder: 50 },
    }));
    expect(reordered.map((f) => f.fieldKey))
      .toEqual(['issue_date', 'father_name', 'pan_number', 'document_title', 'notes']);
  });

  it('ignores an override for a field the category does not declare', () => {
    const out = applyOverrides(SPECS, map({ not_a_field: { isPii: true } }));
    expect(out.map((f) => f.fieldKey)).toEqual(SPECS.map((f) => f.fieldKey));
  });
});

describe('an isIdentifier override is also an answer about duplicates', () => {
  // `identifiesRecord` is the operator's explicit "does this field decide
  // duplicates?", and `dedupeIdentifierFields` reads it ahead of its own rule.
  // It has to be stamped from a boolean and ONLY from a boolean: a NULL row
  // carries no view, and stamping `false` for it would freeze the field
  // against the rule on the strength of a value that only ever meant "unset".
  it('stamps true, even when the dictionary already says identifier', () => {
    // The dictionary flag is per KEY; the duplicate decision is per RECORD. An
    // override that merely repeats the flag is exactly how an operator confirms
    // an optional identifier — so it must not be dropped as a no-op.
    const out = applyOverrides(SPECS, map({ pan_number: { isIdentifier: true } }));
    expect(byKey(out, 'pan_number')!.identifiesRecord).toBe(true);
  });

  it('stamps false', () => {
    const out = applyOverrides(SPECS, map({ pan_number: { isIdentifier: false } }));
    const pan = byKey(out, 'pan_number')!;
    expect(pan.isIdentifier).toBe(false);
    expect(pan.identifiesRecord).toBe(false);
  });

  it('stamps nothing for null', () => {
    const out = applyOverrides(SPECS, map({ pan_number: { isIdentifier: null, isRequired: false } }));
    expect(byKey(out, 'pan_number')!.identifiesRecord).toBeUndefined();
    expect('identifiesRecord' in byKey(out, 'pan_number')!).toBe(false);
  });

  it('stamps a custom field from its own row', () => {
    const custom = {
      isCustom: true, fieldLabel: 'Licence Number', dataType: 'text', isIdentifier: true,
    };
    const out = applyOverrides(SPECS, map({ licence_number: custom }));
    expect(byKey(out, 'licence_number')!.identifiesRecord).toBe(true);
    const unset = applyOverrides(SPECS, map({ licence_number: { ...custom, isIdentifier: null } }));
    expect(byKey(unset, 'licence_number')!.identifiesRecord).toBeUndefined();
  });
});

describe('an alertDaysBefore override', () => {
  it('reaches the effective spec, so the follow-up builder reads it', () => {
    const out = applyOverrides(SPECS, map({ issue_date: { alertDaysBefore: 60 } }));
    expect((byKey(out, 'issue_date') as any).alertDaysBefore).toBe(60);
  });

  it('treats null as "no view expressed" and leaves the shipped answer', () => {
    const out = applyOverrides(SPECS, map({ issue_date: { alertDaysBefore: null } }));
    expect((byKey(out, 'issue_date') as any).alertDaysBefore).toBeUndefined();
  });

  it('keeps 0 — "tell me on the day" is a real answer, not an empty one', () => {
    const out = applyOverrides(SPECS, map({ issue_date: { alertDaysBefore: 0 } }));
    expect((byKey(out, 'issue_date') as any).alertDaysBefore).toBe(0);
  });

  it('ignores a stored value out of range rather than applying it', () => {
    // Hand-edited JSONB or a row written before the CHECK constraint. Falling
    // back to the dictionary is right; 9,999 days is not a reminder.
    const out = applyOverrides(SPECS, map({ issue_date: { alertDaysBefore: 9999 } }));
    expect((byKey(out, 'issue_date') as any).alertDaysBefore).toBeUndefined();
  });
});

describe('applyPolicyOverrides', () => {
  const POLICY = ['pan_number', 'father_name', 'notes', 'custom_fields'];

  it('returns the list untouched when nothing is configured', () => {
    expect(applyPolicyOverrides(POLICY, new Map())).toEqual(POLICY);
  });

  it('seals a field the dictionary leaves open', () => {
    const out = applyPolicyOverrides(POLICY, map({ issue_date: { isPii: true } }));
    expect(out).toContain('issue_date');
    // Declaration order first, the newly sealed key appended.
    expect(out.slice(0, POLICY.length)).toEqual(POLICY);
  });

  it('opens a field the dictionary seals', () => {
    const out = applyPolicyOverrides(POLICY, map({ father_name: { isPii: false } }));
    expect(out).not.toContain('father_name');
    expect(out).toContain('pan_number');
  });

  it('ignores a null, which is not the same as false', () => {
    const out = applyPolicyOverrides(POLICY, map({ father_name: { isPii: null } }));
    expect(out).toEqual(POLICY);
  });

  it('does not itself protect the baseline — its caller does', () => {
    // Stated as a test so the division of responsibility is explicit: this
    // function honours what it is told, and `withBaseline` in fieldSplitter.ts
    // is what puts `notes` and `custom_fields` back. Asserting the floor here
    // instead would hide the fact that the ORDER of those two calls is the
    // actual guarantee.
    const out = applyPolicyOverrides(POLICY, map({ notes: { isPii: false } }));
    expect(out).not.toContain('notes');
  });
});

/**
 * ── THE OTHER HALF OF THE ROUND TRIP ───────────────────────────────────────
 *
 * An override is only configuration until a write path reads it. `isReminder`
 * is the one flag with two readers — the spec-driven path reads it off the
 * spec, and the eighteen legacy routes had a mapping table instead — so the
 * screen could say a field raises a follow-up while half the writes disagreed.
 *
 * `warranty` is the sharp case: its `expiryDate` mapping declares a reminder
 * and its `purchaseDate` mapping does not.
 */
describe('an isReminder override reaches the legacy write path', () => {
  const WARRANTY: FieldSpec[] = [
    { fieldKey: 'product_name', fieldLabel: 'Product Name', dataType: 'text', isPii: false },
    { fieldKey: 'purchase_date', fieldLabel: 'Purchase Date', dataType: 'date', isPii: false },
    { fieldKey: 'warranty_expiry', fieldLabel: 'Warranty Expiry', dataType: 'date', isPii: false },
  ];
  const CATEGORY = { moduleKey: 'warranty_amc', documentKey: 'appliance_warranties' };
  const BODY = {
    applianceName: 'Fridge',
    purchaseDate: '2024-01-10',
    expiryDate: '2027-01-09',
  };
  const write = (overrides: Record<string, any>) =>
    toTaxonomyRecord('warranty', CATEGORY, BODY, [],
      applyOverrides(WARRANTY, map(overrides)));

  it('leaves the mapping table in charge when no view is expressed', () => {
    const out = write({});
    expect(out.reminders.map((r) => r.key)).toEqual(['warranty_expiry']);
    expect(out.nextDueAt).toBe(new Date('2027-01-09').toISOString());
  });

  it('raises a follow-up for a date the mapping never declared one for', () => {
    const out = write({ purchase_date: { isReminder: true } });
    expect(out.reminders.map((r) => r.key).sort())
      .toEqual(['purchase_date', 'warranty_expiry']);
    // The field's own label — the words the operator gave it, not a mapping's.
    expect(out.reminders.find((r) => r.key === 'purchase_date')!.label)
      .toBe('Purchase Date');
    // …and the follow-up query follows the earliest of the two.
    expect(out.nextDueAt).toBe(new Date('2024-01-10').toISOString());
  });

  it('switches off one the mapping raised', () => {
    const out = write({ warranty_expiry: { isReminder: false } });
    expect(out.reminders).toEqual([]);
    expect(out.nextDueAt).toBeNull();
  });

  it('ignores a tick on a field that holds no date', () => {
    const out = write({ product_name: { isReminder: true } });
    expect(out.reminders.map((r) => r.key)).toEqual(['warranty_expiry']);
  });
});
