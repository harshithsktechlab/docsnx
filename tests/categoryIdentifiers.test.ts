/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT MAKES TWO RECORDS THE SAME ONE — declared per SUB-CATEGORY        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The answer used to be `RECORD_SCOPES[scope].dedupeFields`, keyed by legacy
 * scope. That is the wrong axis twice over: the app is addressed as modules and
 * sub-categories, a scope spans a dozen of them and answered for all at once,
 * and seven scopes answered "nothing" — so nothing in them was ever compared.
 *
 * It is now `isIdentifier` on the sub-category's own field spec, stamped at
 * seed time and read through `identifierFields()`. These guard the two things
 * that decide whether a duplicate is noticed at all: which fields count, and
 * what happens when the stored spec predates the flag.
 */
import { describe, it, expect } from 'vitest';
import {
  CATEGORY_IDENTIFIERS,
  dedupeBlocker,
  dedupeIdentifierFields,
  DOCUMENT_CATEGORY_FIELD_SEED,
  RECURRING_SUBJECT_IDENTIFIERS,
  IDENTIFIER_FIELD_KEYS,
  identifierFields,
  fieldsFor,
  type FieldSpec,
} from '@/lib/documentCategoryFields';

const spec = (fieldKey: string, over: Partial<FieldSpec> = {}): FieldSpec => ({
  fieldKey, fieldLabel: fieldKey, dataType: 'text', isPii: true, ...over,
});

describe('reading a spec', () => {
  it('takes the fields that declare themselves identifiers', () => {
    expect(identifierFields([
      spec('passport_number', { isIdentifier: true }),
      spec('father_name', { isIdentifier: false }),
      spec('notes', { isIdentifier: false }),
    ])).toEqual(['passport_number']);
  });

  it('lets a category turn one off', () => {
    // The escape hatch. An explicit `false` means the category has thought
    // about it, so the key list must not override it back on.
    expect(identifierFields([
      spec('policy_number', { isIdentifier: false }),
      spec('claim_number', { isIdentifier: true }),
    ])).toEqual(['claim_number']);
  });

  it('reports none when a category has decided it has none', () => {
    // A prescription carries no number identifying it. Its spec says so, and
    // the title and filename arms are the whole rule there.
    expect(identifierFields([
      spec('doctor_name', { isIdentifier: false }),
      spec('notes', { isIdentifier: false }),
    ])).toEqual([]);
  });
});

describe('a spec stored before the flag existed', () => {
  // `document_category_fields.fields` is seeded data. A database seeded before
  // `isIdentifier` carries specs where NO field declares it. Reading that
  // literally would mean no category anywhere has an identifier and every
  // duplicate goes unnoticed — which is the bug this replaced. So a spec that
  // mentions the flag nowhere is treated as not knowing about it.
  it('falls back to the key list rather than reporting none', () => {
    expect(identifierFields([
      spec('passport_number'),
      spec('father_name'),
    ])).toEqual(['passport_number']);
  });

  it('stops falling back as soon as ONE field declares the flag', () => {
    // A spec that mentions it has been seeded, so it is taken at its word —
    // including its silence about the other fields. Without this an operator
    // could never turn an identifier off.
    expect(identifierFields([
      spec('passport_number'),
      spec('claim_number', { isIdentifier: true }),
    ])).toEqual(['claim_number']);
  });
});

describe('what the seed stamps', () => {
  const seedFor = (moduleKey: string, documentKey: string) =>
    DOCUMENT_CATEGORY_FIELD_SEED.filter(
      (r) => r.moduleKey === moduleKey && r.documentKey === documentKey,
    );

  it('marks a passport by its number', () => {
    const passport = seedFor('identity', 'passport');
    expect(passport.length).toBeGreaterThan(0);
    expect(identifierFields(passport)).toContain('passport_number');
  });

  it('never marks the title, which every record has and none is unique by', () => {
    for (const row of DOCUMENT_CATEGORY_FIELD_SEED) {
      if (row.fieldKey === 'document_title' || row.fieldKey === 'notes') {
        expect(row.isIdentifier).not.toBe(true);
      }
    }
  });

  it('leaves out the keys that identify a person, a company or a place', () => {
    // The sharp edge of declaring by field key. `employee_id` is on every
    // payslip of a job and `ifsc_code` on every account at a branch — treating
    // either as an identifier would collapse a filing cabinet into one sheet.
    for (const key of ['employee_id', 'customer_id', 'beneficiary_id', 'ifsc_code',
                       'roll_number', 'serial_number', 'dose_number',
                       'property_id', 'khata_number', 'survey_number']) {
      expect(IDENTIFIER_FIELD_KEYS.has(key)).toBe(false);
    }
  });

  it('still identifies a PAN card by its PAN, where that is the document', () => {
    // `pan_number` is excluded globally — an ITR form merely quotes it — so the
    // PAN card category has to say so itself. This is the override doing its job.
    expect(IDENTIFIER_FIELD_KEYS.has('pan_number')).toBe(false);
    expect(CATEGORY_IDENTIFIERS.identity.pan_card).toContain('pan_number');
    expect(identifierFields(seedFor('identity', 'pan_card'))).toContain('pan_number');
  });

  it('does not make a PAN quoted elsewhere identify that document too', () => {
    // The whole point of the per-category override: the same key, two meanings.
    // Many ITR filings share one PAN, and folding them into one record would
    // destroy every year but the last.
    const itr = seedFor('bank_investments', 'itr_form16');
    if (itr.some((f) => f.fieldKey === 'pan_number')) {
      expect(identifierFields(itr)).not.toContain('pan_number');
    }
  });

  it('carries the stamp into the compiled fallback, overrides included', () => {
    // `loadCategoryFieldSpec` falls back to `fieldsFor` when the stored column
    // is empty — a database that has not been re-seeded. That fallback is built
    // from the stamped seed, so it keeps the PER-CATEGORY overrides too. If it
    // were built from the raw dictionary instead, a PAN card would silently
    // lose its identifier on exactly the databases least likely to be noticed.
    const passport = fieldsFor({ moduleKey: 'identity', documentKey: 'passport' });
    expect(identifierFields(passport)).toContain('passport_number');
    expect(passport.find((f) => f.fieldKey === 'passport_number')?.isIdentifier).toBe(true);

    const panCard = fieldsFor({ moduleKey: 'identity', documentKey: 'pan_card' });
    expect(panCard.find((f) => f.fieldKey === 'pan_number')?.isIdentifier).toBe(true);
    expect(identifierFields(panCard)).toContain('pan_number');
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ...AND WHICH OF THOSE ACTUALLY REFUSES A WRITE                         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `identifierFields` above answers "is this field indexed, masked and shown in
 * the Number column". It was also answering "does a match here mean this IS
 * that record", and those are not the same question.
 *
 * A car's `registration_number` is declared by four categories. Its RC states
 * it; the PUC certificate and the insurance policy QUOTE it. Because the stamp
 * is per KEY, all four were identifiers — and duplicate arm 1 reaches across
 * the whole permitted set, so saving a PUC was refused as a duplicate of the
 * RC, with keep-both correctly withheld for what was never an identifier clash.
 *
 * `dedupeIdentifierFields` is the narrower answer arm 1 now reads: an
 * identifier that is REQUIRED in its category, minus the required ones that
 * name a durable subject rather than the document.
 */
describe('which identifiers decide a duplicate', () => {
  const seedFor = (moduleKey: string, documentKey: string) =>
    DOCUMENT_CATEGORY_FIELD_SEED.filter(
      (r) => r.moduleKey === moduleKey && r.documentKey === documentKey,
    );
  const dedupeFor = (moduleKey: string, documentKey: string) =>
    dedupeIdentifierFields(seedFor(moduleKey, documentKey), { moduleKey, documentKey });
  /** Every seeded sub-category, once — the seed is one row PER FIELD. */
  const categoryKeys = [...new Map(
    DOCUMENT_CATEGORY_FIELD_SEED.map((r) => [
      `${r.moduleKey}/${r.documentKey}`,
      { moduleKey: r.moduleKey, documentKey: r.documentKey },
    ]),
  ).values()];

  it('keeps the number a category is actually identified by', () => {
    // The rule must not simply switch arm 1 off. An RC IS its registration
    // number, a PUC IS its certificate number, and two of either really are one
    // record.
    expect(dedupeFor('vehicle', 'registration_certificate')).toContain('registration_number');
    expect(dedupeFor('vehicle', 'puc_certificate')).toContain('certificate_number');
    expect(dedupeFor('insurance', 'vehicle_policies')).toContain('policy_number');
  });

  it('does not let one car collapse its own paperwork into one record', () => {
    // The reported bug, stated as the invariant it broke: an RC, a PUC and an
    // insurance policy for the SAME car share a registration number and must
    // still be three records. Only the RC may be identified by it.
    expect(dedupeFor('vehicle', 'puc_certificate')).not.toContain('registration_number');
    expect(dedupeFor('insurance', 'vehicle_policies')).not.toContain('registration_number');
    // ...while the field is still indexed and searchable everywhere it appears,
    // which is the whole reason for keeping the two lists apart.
    expect(identifierFields(seedFor('vehicle', 'puc_certificate'))).toContain('registration_number');
    expect(identifierFields(seedFor('insurance', 'vehicle_policies'))).toContain('registration_number');
  });

  it('does not make a purchase invoice a duplicate of the RC', () => {
    // Same shape, different key: both quote the vehicle's `chassis_number`.
    expect(dedupeFor('vehicle', 'purchase_invoice')).not.toContain('chassis_number');
    expect(dedupeFor('vehicle', 'purchase_invoice')).toContain('invoice_number');
  });

  it('lets a recurring bill be filed every month', () => {
    // `consumer_number` is REQUIRED on a utility bill and really is the meter's
    // identity — so the required rule alone does not save it, and this is what
    // RECURRING_SUBJECT_IDENTIFIERS is for. Without it, January's electricity
    // bill is overwritten by February's.
    for (const key of ['electricity', 'gas', 'water']) {
      expect(dedupeFor('utility_bills', key)).not.toContain('consumer_number');
      expect(identifierFields(seedFor('utility_bills', key))).toContain('consumer_number');
    }
  });

  it('lets one account keep more than one statement', () => {
    expect(dedupeFor('bank_investments', 'bank_statements_passbooks')).not.toContain('account_number');
    expect(dedupeFor('bank_investments', 'cheque_books')).not.toContain('account_number');
    // A UAN is one per person for life — the same trap `employment/salary_slips`
    // already avoids with a literal `isIdentifier: false`.
    expect(dedupeFor('bank_investments', 'epf_ppf_nps_statements')).not.toContain('uan_number');
    expect(dedupeFor('employment', 'epf_uan_documents')).not.toContain('uan_number');
  });

  it('never names a field the category leaves optional', () => {
    // The general half of the rule, over every seeded category: an
    // identifier-keyed field a category does not require is a quotation of some
    // other record's identity. A category identified by a number asks for it.
    for (const { moduleKey, documentKey } of categoryKeys) {
      // The catch-all is exempt and says so — see `dedupeIdentifierFields`.
      if (moduleKey === 'other' && documentKey === 'uncategorized') continue;
      const specs = seedFor(moduleKey, documentKey);
      const required = new Set(
        specs.filter((f) => f.isRequired === true).map((f) => f.fieldKey),
      );
      for (const key of dedupeIdentifierFields(specs, { moduleKey, documentKey })) {
        expect(
          required.has(key),
          `${moduleKey}/${documentKey}: '${key}' decides duplicates but is optional`,
        ).toBe(true);
      }
    }
  });

  it('never names a field the category does not declare at all', () => {
    for (const { moduleKey, documentKey } of categoryKeys) {
      const specs = seedFor(moduleKey, documentKey);
      const declared = new Set(specs.map((f) => f.fieldKey));
      for (const key of dedupeIdentifierFields(specs, { moduleKey, documentKey })) {
        expect(declared.has(key)).toBe(true);
      }
    }
  });

  it('keeps the opt-out list from rotting', () => {
    // Every entry must name a field that WOULD otherwise decide duplicates. An
    // entry that no longer does is either a typo or a spec change nobody
    // followed through, and either way it is silently doing nothing.
    for (const [moduleKey, categories] of Object.entries(RECURRING_SUBJECT_IDENTIFIERS)) {
      for (const [documentKey, keys] of Object.entries(categories)) {
        const specs = seedFor(moduleKey, documentKey);
        expect(specs.length, `${moduleKey}/${documentKey} is not a seeded category`)
          .toBeGreaterThan(0);
        for (const key of keys) {
          const field = specs.find((f) => f.fieldKey === key);
          expect(field, `${moduleKey}/${documentKey}: '${key}' is not declared`).toBeTruthy();
          expect(field?.isRequired, `${moduleKey}/${documentKey}: '${key}' is not required`).toBe(true);
          expect(identifierFields(specs), `${moduleKey}/${documentKey}: '${key}' is not an identifier`)
            .toContain(key);
        }
      }
    }
  });
});

describe('the catch-all, which has no required fields to reason from', () => {
  const specs = DOCUMENT_CATEGORY_FIELD_SEED.filter(
    (r) => r.moduleKey === 'other' && r.documentKey === 'uncategorized',
  );
  const key = { moduleKey: 'other', documentKey: 'uncategorized' };

  it('keeps every identifier it has', () => {
    // `unionOfEveryCategory` strips `isRequired` from all of them deliberately,
    // so the required rule would zero this category out and stop arm 1 noticing
    // that the same passport was filed here twice.
    expect(specs.length).toBeGreaterThan(0);
    expect(dedupeIdentifierFields(specs, key)).toEqual(identifierFields(specs));
    expect(dedupeIdentifierFields(specs, key).length).toBeGreaterThan(0);
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE OPERATOR'S EXPLICIT ANSWER BEATS THE RULE                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `identifiesRecord` is stamped on a spec by `applyOverrides` from an override
 * row whose `is_identifier` is true or false — an operator's view, expressed on
 * /admin/document-fields. The rule above only ever guesses for the fields
 * nobody has touched; where there is a stamp, it is the whole answer.
 */
describe('an explicit answer from the admin screen', () => {
  const seedFor = (moduleKey: string, documentKey: string) =>
    DOCUMENT_CATEGORY_FIELD_SEED.filter(
      (r) => r.moduleKey === moduleKey && r.documentKey === documentKey,
    );
  /** The seed with one field's stamp set, as `applyOverrides` would leave it. */
  const stamped = (
    moduleKey: string, documentKey: string, fieldKey: string, identifiesRecord: boolean,
  ) => seedFor(moduleKey, documentKey).map((f) => (
    f.fieldKey === fieldKey ? { ...f, isIdentifier: true, identifiesRecord } : f
  ));

  it('lets an optional identifier decide duplicates', () => {
    // A PUC really is quoting the car's number, and the rule is right to leave
    // it out. But the operator may know better for their deployment, and
    // saying so must not also require them to make the field Mandatory.
    const key = { moduleKey: 'vehicle', documentKey: 'puc_certificate' };
    expect(dedupeIdentifierFields(seedFor(key.moduleKey, key.documentKey), key))
      .not.toContain('registration_number');
    expect(dedupeIdentifierFields(stamped('vehicle', 'puc_certificate', 'registration_number', true), key))
      .toContain('registration_number');
  });

  it('beats the recurring-subject exclusion', () => {
    // The exclusion is a default for the common case, not a lock. One account
    // number per statement row is a legitimate way to run a vault.
    const key = { moduleKey: 'bank_investments', documentKey: 'bank_statements_passbooks' };
    expect(dedupeIdentifierFields(stamped(key.moduleKey, key.documentKey, 'account_number', true), key))
      .toContain('account_number');
  });

  it('lets a required identifier stop deciding duplicates', () => {
    // The reverse: the RC IS its registration number by the rule, and the
    // operator can still say no. `isIdentifier` stays true here because the
    // stamp is the only thing under test — in practice an untick clears both.
    const key = { moduleKey: 'vehicle', documentKey: 'registration_certificate' };
    expect(dedupeIdentifierFields(seedFor(key.moduleKey, key.documentKey), key))
      .toContain('registration_number');
    expect(dedupeIdentifierFields(stamped(key.moduleKey, key.documentKey, 'registration_number', false), key))
      .not.toContain('registration_number');
  });

  it('changes nothing for fields without a stamp', () => {
    // The rule keeps deciding every untouched field, so a single override on
    // one field cannot loosen the category around it.
    const key = { moduleKey: 'vehicle', documentKey: 'puc_certificate' };
    const before = dedupeIdentifierFields(seedFor(key.moduleKey, key.documentKey), key);
    const after = dedupeIdentifierFields(stamped(key.moduleKey, key.documentKey, 'registration_number', true), key);
    expect(after.filter((k) => k !== 'registration_number')).toEqual([...before]);
  });

  it('applies to a business category exactly as to a personal one', () => {
    // Every business identifier is optional by design, so by the rule NO
    // business category is deduplicated by arm 1. A GST registration is one
    // per GSTIN and an operator can say so; GST returns stay untouched.
    const key = { moduleKey: 'biz_tax', documentKey: 'gst_registration' };
    expect(dedupeIdentifierFields(seedFor(key.moduleKey, key.documentKey), key)).toEqual([]);
    expect(dedupeIdentifierFields(stamped(key.moduleKey, key.documentKey, 'gstin', true), key))
      .toEqual(['gstin']);
    const returns = { moduleKey: 'biz_tax', documentKey: 'gst_returns' };
    expect(dedupeIdentifierFields(seedFor(returns.moduleKey, returns.documentKey), returns)).toEqual([]);
  });

  it('cannot decide on a field that is not indexed', () => {
    // A stamp on a field `identifierFields` leaves out is unreachable through
    // the API (an untick clears both), but a hand-written row must not produce
    // a comparison against a blind index that was never written.
    const key = { moduleKey: 'vehicle', documentKey: 'puc_certificate' };
    const specs = seedFor(key.moduleKey, key.documentKey).map((f) => (
      f.fieldKey === 'registration_number' ? { ...f, isIdentifier: false, identifiesRecord: true } : f
    ));
    expect(dedupeIdentifierFields(specs, key)).not.toContain('registration_number');
  });

  it('leaves the catch-all alone', () => {
    const key = { moduleKey: 'other', documentKey: 'uncategorized' };
    const specs = seedFor(key.moduleKey, key.documentKey);
    expect(dedupeIdentifierFields(specs, key)).toEqual(identifierFields(specs));
  });
});

describe('why the rule says no', () => {
  // What the admin screen shows beside a ticked identifier that decides
  // nothing, in the rule's own vocabulary.
  it('names the optional half', () => {
    expect(dedupeBlocker(
      { fieldKey: 'registration_number', isRequired: false },
      { moduleKey: 'vehicle', documentKey: 'puc_certificate' },
    )).toBe('optional');
  });

  it('names the exclusion, which outranks being required', () => {
    expect(dedupeBlocker(
      { fieldKey: 'consumer_number', isRequired: true },
      { moduleKey: 'utility_bills', documentKey: 'electricity' },
    )).toBe('recurringSubject');
  });

  it('has nothing to say about a field the rule accepts', () => {
    expect(dedupeBlocker(
      { fieldKey: 'registration_number', isRequired: true },
      { moduleKey: 'vehicle', documentKey: 'registration_certificate' },
    )).toBeNull();
  });
});
