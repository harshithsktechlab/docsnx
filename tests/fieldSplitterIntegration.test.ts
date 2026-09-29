/**
 * ── THE B4 REGRESSION GUARD ────────────────────────────────────────────────
 *
 * `splitRecordFields` decides what gets encrypted by intersecting a record's
 * keys with the category's encrypt list. The list is snake_case taxonomy
 * fieldKeys; every module route used to hand it the raw camelCase form body.
 * The intersection was empty, so the sealed tier came out EMPTY and every PII
 * value was written to the Drive JSON in the clear — for every module, on every
 * write, silently.
 *
 * These tests push a realistic legacy body through the real pipeline
 * (`toTaxonomyRecord` → `splitRecordFields` with the compiled-in policy) and
 * assert the sealed tier is non-empty and holds the values it should. If the
 * key vocabularies ever drift apart again, this fails instead of leaking.
 *
 * Deliberately uses `encryptedFieldsFor` (the compiled-in policy) rather than
 * `loadEncryptionPolicy` (which hits the DB): the invariant under test is about
 * key names, and it must hold with no database at all.
 */
import { describe, it, expect } from 'vitest';
import { toTaxonomyRecord, toLegacyRecord } from '@/lib/records/normalize';
import { loadEncryptionPolicy, splitRecordFields } from '@/lib/vault/fieldSplitter';
import { BASELINE_SEALED_KEYS, encryptedFieldsFor } from '@/lib/documentCategoryFields';
import { resolveModuleCategory } from '@/lib/vault/moduleCategoryMap';
import { MAPPED_MODULES } from '@/lib/records/fieldMap';

/**
 * A realistic body per module, in the exact camelCase the existing routes and
 * pages send — see each module's route.ts. `expectSealed` names the taxonomy
 * keys whose values must end up encrypted.
 */
const CASES: Record<string, { body: Record<string, unknown>; expectSealed: string[] }> = {
  medical: {
    body: { patientName: 'Ramesh Sharma', recordType: 'prescription', date: '2026-03-04',
            doctorName: 'Dr Iyer', hospitalName: 'Apollo', details: 'BP medication, 3 months' },
    expectSealed: ['patient_name', 'notes'],
  },
  vehicles: {
    body: { vehicleName: 'Honda City', vehicleNumber: 'MH12AB1234', ownerName: 'Ramesh Sharma',
            registrationDate: '2021-04-01', insuranceExpiry: '2026-11-30', pucExpiry: '2026-09-12',
            fitnessExpiry: '2031-04-01', serviceNotes: 'clutch replaced' },
    expectSealed: ['registration_number', 'owner_name', 'notes'],
  },
  lic_mediclaim: {
    body: { policyType: 'lic', companyName: 'LIC of India', policyName: 'Jeevan Anand',
            policyNumber: '123456789', insuredPerson: 'Ramesh Sharma', sumAssured: '1000000',
            premiumAmount: '24000', premiumDueDate: '2026-09-01' },
    expectSealed: ['policy_number', 'sum_assured', 'premium_amount'],
  },
  warranty: {
    body: { applianceName: 'Refrigerator', company: 'Samsung', type: 'warranty',
            purchaseDate: '2024-01-10', expiryDate: '2027-01-10',
            supportContact: '18001234567', notes: 'extended plan' },
    expectSealed: ['support_contact', 'notes'],
  },
  rentals: {
    body: { type: 'rental', title: 'Flat 302 Lease', provider: 'Mr Deshmukh',
            accountNumber: 'AGR-9981', startDate: '2025-06-01', endDate: '2026-05-31',
            amount: '28000', billingCycle: 'monthly', notes: 'deposit 2 months' },
    expectSealed: ['landlord_name', 'agreement_number', 'monthly_rent', 'notes'],
  },
  tax_compliance: {
    body: { title: 'TDS FY25-26', formType: 'tds', assessmentYear: '2026-27',
            acknowledgementNumber: 'ACK99887766', taxableAmount: '850000', taxPaid: '62000' },
    expectSealed: ['certificate_number', 'taxable_value', 'tax_paid'],
  },
  wills_estate: {
    body: { title: 'Last Will', documentType: 'will', testatorName: 'Ramesh Sharma',
            executorName: 'Suresh Sharma', executionDate: '2025-02-11', nominees: 'Priya, Amit' },
    expectSealed: ['executor_name', 'beneficiary_names'],
  },
  loans_debt: {
    body: { title: 'Home Loan', lenderName: 'HDFC', loanType: 'homeloan',
            loanAccountNumber: 'HL00112233', principalAmount: '4500000',
            emiAmount: '38000', interestRate: '8.4', maturityDate: '2041-03-01' },
    expectSealed: ['loan_account_number', 'loan_amount', 'emi_amount'],
  },
  utility_bills: {
    body: { title: 'March Electricity', providerName: 'MSEDCL', serviceType: 'electricity',
            consumerNumber: '170012345678', billAmount: '2480', dueDate: '2026-04-12' },
    expectSealed: ['consumer_number', 'bill_amount'],
  },
  employment_payroll: {
    body: { title: 'Offer Letter', employerName: 'Acme Corp', employeeName: 'Ramesh Sharma',
            documentType: 'offer', designation: 'Engineer', issueDate: '2025-01-06' },
    expectSealed: ['employee_name'],
  },
  bank_info: {
    body: { bankName: 'HDFC Bank', accountNumber: '50100123456789', accountType: 'savings',
            ifscCode: 'HDFC0001234', branch: 'Baner', customerId: 'CUST9988',
            netBankingUsername: 'ramesh.s' },
    expectSealed: ['account_number', 'ifsc_code', 'customer_id', 'net_banking_username'],
  },
  trading: {
    body: { brokerName: 'Zerodha', clientId: 'ZD1234', dematAccountNumber: '1208160012345678',
            loginUsername: 'ramesh', nomineeName: 'Priya Sharma', details: 'primary account' },
    expectSealed: ['client_id', 'demat_account_number', 'login_username', 'nominee_name', 'notes'],
  },
  investments: {
    body: { title: 'Parag Parikh Flexi', recordType: 'mutualfund', purchaseDate: '2023-05-01',
            purchaseValue: '200000', currentValue: '318000', quantity: '3450.221' },
    expectSealed: ['current_value', 'units_held'],
  },
};

describe('legacy body -> taxonomy keys -> sealed tier', () => {
  it('has a case for every mapped module except documents', () => {
    expect(new Set(Object.keys(CASES)))
      .toEqual(new Set(MAPPED_MODULES.filter((m) => m !== 'documents')));
  });

  for (const [module, { body, expectSealed }] of Object.entries(CASES)) {
    it(`${module}: seals the expected fields`, () => {
      const categoryKey = resolveModuleCategory(module, body, null);
      const { record } = toTaxonomyRecord(module, categoryKey, body);
      const { sealed, open } = splitRecordFields(encryptedFieldsFor(categoryKey), record);

      // The bug, stated as an assertion.
      expect(
        Object.keys(sealed).length,
        `${module} sealed NOTHING — the key vocabularies have drifted apart again`
      ).toBeGreaterThan(0);

      for (const key of expectSealed) {
        expect(sealed, `${module}: expected '${key}' in the sealed tier`).toHaveProperty(key);
      }
      // And nothing sealed leaked into the open half.
      for (const key of expectSealed) {
        expect(open, `${module}: '${key}' must not also be open`).not.toHaveProperty(key);
      }
    });
  }

  it('documents: seals a PAN card scan under its ID category', () => {
    const categoryKey = { moduleKey: 'identity', documentKey: 'pan_card' };
    const body = { documentNumber: 'ABCDE1234F', idHolderName: 'Ramesh Sharma',
                   fatherName: 'Mahesh Sharma', dob: '1980-07-19' };
    const { record } = toTaxonomyRecord('documents', categoryKey, body);
    const { sealed, open } = splitRecordFields(encryptedFieldsFor(categoryKey), record);

    expect(sealed).toHaveProperty('pan_number', 'ABCDE1234F');
    expect(sealed).toHaveProperty('father_name', 'Mahesh Sharma');
    expect(sealed).toHaveProperty('date_of_birth', '1980-07-19');
    // The holder's own name stays readable so lists keep their label.
    expect(open).toHaveProperty('holder_name', 'Ramesh Sharma');
  });

  it('derives blind indexes, masks and reminders alongside the split', () => {
    const body = { title: 'March Electricity', providerName: 'MSEDCL', serviceType: 'electricity',
                   consumerNumber: '170012345678', billAmount: '2480', dueDate: '2026-04-12' };
    const categoryKey = resolveModuleCategory('utility_bills', body, null);
    const n = toTaxonomyRecord('utility_bills', categoryKey, body);

    expect(n.searchHashes.consumer_number).toEqual(expect.any(String));
    expect(n.masked.consumer_number).toContain('5678');
    expect(n.masked.consumer_number).not.toContain('170012');
    expect(n.reminders).toHaveLength(1);
    expect(n.reminders[0]).toMatchObject({ key: 'due_date', label: 'Bill Due', resolved: false });
    expect(n.nextDueAt).toBe(n.reminders[0].date);
  });

  it('marks a paid bill resolved so it stops nagging, but keeps the reminder', () => {
    const body = { consumerNumber: '170012345678', serviceType: 'electricity',
                   dueDate: '2026-04-12', isPaid: true };
    const categoryKey = resolveModuleCategory('utility_bills', body, null);
    const n = toTaxonomyRecord('utility_bills', categoryKey, body);

    expect(n.reminders).toHaveLength(1);
    expect(n.reminders[0].resolved).toBe(true);
    expect(n.nextDueAt).toBeNull();
  });

  it('keeps an OVERDUE date in nextDueAt — lapsed is exactly what must be shouted about', () => {
    const body = { vehicleNumber: 'MH12AB1234', insuranceExpiry: '2020-01-01' };
    const categoryKey = resolveModuleCategory('vehicles', body, null);
    const n = toTaxonomyRecord('vehicles', categoryKey, body);

    expect(n.nextDueAt).toBe(new Date('2020-01-01').toISOString());
  });

  it('emits one reminder per renewal for a vehicle, on a single record', () => {
    const body = { vehicleNumber: 'MH12AB1234', insuranceExpiry: '2026-11-30',
                   pucExpiry: '2026-09-12', fitnessExpiry: '2031-04-01',
                   nextServiceDate: '2026-08-20' };
    const categoryKey = resolveModuleCategory('vehicles', body, null);
    const n = toTaxonomyRecord('vehicles', categoryKey, body);

    expect(n.reminders.map((r) => r.label).sort())
      .toEqual(['Fitness', 'Insurance', 'PUC', 'Service']);
    expect(n.nextDueAt).toBe(new Date('2026-08-20').toISOString());
  });

  it('round-trips back to the legacy vocabulary', () => {
    const body = { providerName: 'MSEDCL', serviceType: 'electricity', consumerNumber: '17001234' };
    const categoryKey = resolveModuleCategory('utility_bills', body, null);
    const { record } = toTaxonomyRecord('utility_bills', categoryKey, body);
    const back = toLegacyRecord('utility_bills', categoryKey, record);

    expect(back.providerName).toBe('MSEDCL');
    expect(back.consumerNumber).toBe('17001234');
  });
});

/**
 * ── THE POLICY FALLBACK, WHEN THERE IS NO ROW ──────────────────────────────
 *
 * `loadEncryptionPolicy` answers from `document_category_fields`. When it finds
 * no row it falls back to the compiled-in policy — which knows only the SEEDED
 * categories, and correctly answers [] for anything else.
 *
 * Returning that verbatim would mean "seal nothing": a record written under an
 * unknown or retired category would land in the open tier in the clear, in
 * full. drizzle/0035 deletes the policy rows of the 15 categories 0023 retired,
 * so this branch is the one that would answer for them; the sealed baseline is
 * the floor that makes that deletion safe rather than disarming.
 *
 * A stub executor rather than a database: the invariant is about what the
 * function returns when the query comes back empty, which is exactly what a
 * real DB would never let us set up on demand.
 */
describe('loadEncryptionPolicy fallback', () => {
  /**
   * Mimics the drizzle select chain for the TWO shapes loadEncryptionPolicy
   * issues, which is the whole subtlety of this double.
   *
   *   the policy row → …innerJoin().where().limit(1)   resolves via `limit`
   *   the overrides  → …innerJoin().where()            awaited directly
   *
   * The second is why the chain is thenable: `loadFieldOverrides` has no
   * `.limit()`, so a stub that only implements `limit` hands it the chain
   * object and it fails on `rows.map`. Both terminals are modelled so a change
   * to either query fails loudly here rather than silently resolving to
   * something shaped wrong.
   */
  const executorReturning = (rows: unknown[], overrides: unknown[] = []) => {
    const chain: any = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(rows),
      then: (ok: any, err: any) => Promise.resolve(overrides).then(ok, err),
    };
    return { select: () => chain } as any;
  };

  it('seals the baseline for a category the compiled policy does not know', async () => {
    const policy = await loadEncryptionPolicy(
      executorReturning([]),
      // Retired by 0023 and dropped from the seed — `encryptedFieldsFor`
      // answers [] for this pair, which is the whole point.
      { moduleKey: 'bank_info', documentKey: 'miscellaneous' },
    );

    expect(encryptedFieldsFor({ moduleKey: 'bank_info', documentKey: 'miscellaneous' }))
      .toEqual([]);
    // …yet the policy is not empty. Free text a user typed is never open.
    expect(policy.length).toBeGreaterThan(0);
    for (const key of BASELINE_SEALED_KEYS) {
      expect(policy, `${key} must be sealed even with no policy row`).toContain(key);
    }
  });

  it('still returns the compiled policy for a seeded category with no row', async () => {
    const key = { moduleKey: 'identity', documentKey: 'pan_card' };
    const policy = await loadEncryptionPolicy(executorReturning([]), key);

    // The floor ADDS to the compiled answer; it never replaces it.
    for (const field of encryptedFieldsFor(key)) expect(policy).toContain(field);
    expect(policy).toContain('pan_number');
  });

  it('raises a stored list to the baseline without dropping what it names', async () => {
    const policy = await loadEncryptionPolicy(
      // A row from before `custom_fields` was baseline — 0025's exact scenario.
      executorReturning([{ encryptedFields: 'pan_number,father_name' }]),
      { moduleKey: 'identity', documentKey: 'pan_card' },
    );

    expect(policy).toContain('pan_number');
    expect(policy).toContain('father_name');
    for (const key of BASELINE_SEALED_KEYS) expect(policy).toContain(key);
  });

  it('honours an operator override that seals an open field', async () => {
    // The config screen's whole point: a category can be told to seal something
    // the dictionary leaves open, without a deploy.
    const key = { moduleKey: 'identity', documentKey: 'pan_card' };
    expect(encryptedFieldsFor(key)).not.toContain('issue_date');

    const policy = await loadEncryptionPolicy(
      executorReturning(
        [{ encryptedFields: 'pan_number,father_name' }],
        [{ fieldKey: 'issue_date', isPii: true }],
      ),
      key,
    );
    expect(policy).toContain('issue_date');
    // …without dropping what the stored list already named.
    expect(policy).toContain('pan_number');
    expect(policy).toContain('father_name');
  });

  it('refuses an operator override that would unseal free text', async () => {
    // withBaseline runs AFTER the overrides, and this is the assertion that
    // pins that order. If it ever inverts, a super admin could open `notes` —
    // the one field whose contents nobody declared — platform-wide, and the
    // only symptom would be user-typed text arriving in the clear.
    const policy = await loadEncryptionPolicy(
      executorReturning(
        [{ encryptedFields: 'pan_number,notes,custom_fields' }],
        [{ fieldKey: 'notes', isPii: false }, { fieldKey: 'custom_fields', isPii: false }],
      ),
      { moduleKey: 'identity', documentKey: 'pan_card' },
    );
    for (const key of BASELINE_SEALED_KEYS) {
      expect(policy, `${key} was unsealed by an override`).toContain(key);
    }
  });

  it('leaves an unset override alone', async () => {
    // null means "no view expressed". A row of nulls must change nothing —
    // `??` not `||`, or every "turn this off" would silently fail.
    const key = { moduleKey: 'identity', documentKey: 'pan_card' };
    const policy = await loadEncryptionPolicy(
      executorReturning(
        [{ encryptedFields: 'pan_number,father_name' }],
        [{ fieldKey: 'pan_number', isPii: null, isRequired: null }],
      ),
      key,
    );
    expect(policy).toContain('pan_number');
    expect(policy).toContain('father_name');
  });

  it('seals the free text that remains on the floor, and only that', () => {
    // `custom_fields` came off the sealed floor in drizzle/0038 by decision;
    // `notes` did not. Asserting both in one case is what keeps the change
    // honest — a broad edit that took notes with it would fail here.
    const policy = [...BASELINE_SEALED_KEYS];
    const { sealed, open } = splitRecordFields(policy, {
      notes: 'account 918273645510, PIN 4417',
      custom_fields: '[{"label":"UPI","value":"raj@okaxis"}]',
      issue_date: '2024-01-01',
    });

    expect(sealed.notes).toBeDefined();
    expect(open.custom_fields).toBeDefined();
    expect(sealed.custom_fields).toBeUndefined();
    expect(open.issue_date).toBe('2024-01-01');
  });

  it('refuses an operator override that would ENCRYPT custom_fields', async () => {
    // The mirror of the "cannot unseal notes" case above. Both floors are
    // enforced in withBaseline, after the overrides, so the config screen
    // cannot move either key in its forbidden direction.
    const policy = await loadEncryptionPolicy(
      executorReturning(
        [{ encryptedFields: 'pan_number,notes' }],
        [{ fieldKey: 'custom_fields', isPii: true }],
      ),
      { moduleKey: 'identity', documentKey: 'pan_card' },
    );
    expect(policy).not.toContain('custom_fields');
    expect(policy).toContain('notes');
    expect(policy).toContain('pan_number');
  });
});
