/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   NAMING A CATEGORY — the three checks that happen before a row exists   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A `(moduleKey, documentKey)` pair is immutable once anything is filed under
 * it: it names the Drive folder the ciphertext lives in and is bound into that
 * ciphertext's AAD. So everything here is checked BEFORE the row is written,
 * because afterwards there is no correcting it.
 *
 * The collision rule is the one worth stating twice: `taken` must include
 * RETIRED rows. A retired category is a tombstone whose records still point at
 * it, and reissuing its key would file new records into an old category's folder
 * — silently merging two things somebody deliberately separated.
 */
import { describe, it, expect } from 'vitest';
import { labelError, taxonomyKeyFrom } from '@/lib/records/taxonomyKey';
import { isSafeKeyPart } from '@/lib/vault/vaultNaming';
import { maskSensitiveText } from '@/lib/aiPrivacyMasker';
import { hasPermission } from '@/lib/auth';

describe('taxonomyKeyFrom', () => {
  it('slugifies a label the way the taxonomy spells its keys', () => {
    expect(taxonomyKeyFrom('Gift Deed', [])).toBe('gift_deed');
    expect(taxonomyKeyFrom('  Power of Attorney  ', [])).toBe('power_of_attorney');
    expect(taxonomyKeyFrom('GST Returns (GSTR filings)', [])).toBe('gst_returns_gstr_filings');
  });

  it('never reissues a key, including a retired one', () => {
    // The caller passes every key in the module, active and inactive alike.
    expect(taxonomyKeyFrom('PAN Card', ['pan_card'])).toBe('pan_card_2');
    expect(taxonomyKeyFrom('PAN Card', ['pan_card', 'pan_card_2'])).toBe('pan_card_3');
  });

  it('appends the suffix so the readable part survives', () => {
    const key = taxonomyKeyFrom('Gift Deed', ['gift_deed'])!;
    expect(key.startsWith('gift_deed')).toBe(true);
  });

  it('always produces a legal Drive path segment', () => {
    // Not a restatement of the rule — the storage layer's own predicate. A key
    // that fails there is one whose records could never be stored.
    for (const label of ['Gift Deed', 'ITR / Form 16', '  ..//..  ', 'Ünïcödé Nàme x9']) {
      const key = taxonomyKeyFrom(label, []);
      if (key !== null) expect(isSafeKeyPart(key), `${label} → ${key}`).toBe(true);
    }
  });

  it('refuses a label with nothing to build a key from', () => {
    for (const label of ['', '   ', '???', '—', '🎉']) {
      expect(taxonomyKeyFrom(label, []), label).toBeNull();
    }
  });

  it('cannot overflow the column, however long the label', () => {
    const key = taxonomyKeyFrom('a'.repeat(400), [])!;
    expect(key.length).toBeLessThanOrEqual(60);
    expect(isSafeKeyPart(key)).toBe(true);
  });

  it('leaves room for the suffix, so uniquifying cannot overflow either', () => {
    const long = 'Business Registration Certificate for Shop and Establishment Purposes';
    const base = taxonomyKeyFrom(long, [])!;
    const next = taxonomyKeyFrom(long, [base])!;
    expect(next.length).toBeLessThanOrEqual(60);
    expect(isSafeKeyPart(next)).toBe(true);
  });
});

describe('labelError — the AI masking rule, enforced instead of documented', () => {
  /**
   * Category names are rendered verbatim into the classification prompt, and
   * that prompt goes through `maskSensitiveText`. A name the masker rewrites
   * would reach the model as `[EMAIL-MASKED]`, so the model would be offered a
   * category whose name is a placeholder — and nothing anywhere would say why.
   */
  it('refuses a name the AI masker would rewrite', () => {
    for (const bad of [
      'Invoices for billing@acme.com',
      'Account 123456789012 statements',
      'Card ABCDE1234F papers',
    ]) {
      expect(labelError(bad), bad).toMatch(/personal data|masked|reword/i);
      // The reason it is refused, stated independently of the implementation.
      expect(maskSensitiveText(bad)).not.toBe(bad);
    }
  });

  it('accepts every name the shipped taxonomy already uses', async () => {
    // The compiled names have always had to satisfy this rule by hand. If the
    // check refused one of them it would be stricter than the taxonomy itself.
    const { DOCUMENT_CATEGORY_SEED } = await import('@/lib/documentCategories');
    for (const row of DOCUMENT_CATEGORY_SEED) {
      expect(labelError(row.documentName), row.documentName).toBeNull();
      expect(labelError(row.moduleName), row.moduleName).toBeNull();
    }
  });

  it('refuses an empty name', () => {
    expect(labelError('   ')).toMatch(/name/i);
  });

  it('allows ordinary names with digits in them', () => {
    // The masker's account-number rule is 9+ digits; a short number is fine and
    // several shipped categories carry one ("Form 16", "GSTR").
    expect(labelError('Form 16 and 26AS')).toBeNull();
    expect(labelError('Gift Deed 2024')).toBeNull();
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHY A NEW SUB-CATEGORY NEEDS NO PERMISSION WORK                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * This is the property the whole "add a sub-category" feature rests on, and it
 * is a property of `hasPermission`, not of anything added for it: a permission
 * row with a NULL `document_key` is a MODULE-level grant, and it answers for
 * every sub-category of that module — including ones that did not exist when the
 * row was written.
 *
 * That is why members' permissions never need backfilling for a new
 * sub-category, and why a new MODULE is a different and much larger change: it
 * has no row to inherit from, so `hasPermission` denies it outright to every
 * STANDARD member (TENANT_ADMIN short-circuits to true, which is precisely how
 * that class of bug stays invisible in manual testing).
 */
describe('a category created at runtime inherits its module\'s permissions', () => {
  /**
   * A permission row as the database actually stores it — every flag present.
   * `hasPermission` returns the column value directly, so a fixture that omitted
   * one would be testing `undefined`, not a denial.
   */
  const row = (over: any) => ({
    canView: false, canAdd: false, canEdit: false, canDelete: false, canShare: false, ...over,
  });
  const member = (permissions: any[]) => ({ role: 'STANDARD', permissions } as any);

  it('is granted by a module-level row', async () => {
    const user = member([
      row({ module: 'property_legal', documentKey: null, canView: true, canAdd: true }),
    ]);
    expect(await hasPermission(user, 'property_legal', 'view', 'gift_deed')).toBe(true);
    expect(await hasPermission(user, 'property_legal', 'add', 'gift_deed')).toBe(true);
    // Not a blanket yes: the row's own flags still decide.
    expect(await hasPermission(user, 'property_legal', 'delete', 'gift_deed')).toBe(false);
  });

  it('is denied when the module is denied', async () => {
    const user = member([row({ module: 'property_legal', documentKey: null })]);
    expect(await hasPermission(user, 'property_legal', 'view', 'gift_deed')).toBe(false);
  });

  it('does not leak across modules', async () => {
    const user = member([row({ module: 'property_legal', documentKey: null, canView: true })]);
    expect(await hasPermission(user, 'identity', 'view', 'gift_deed')).toBe(false);
  });

  it('is still overridable per sub-category once a row names it', async () => {
    // The admin can deny the new category specifically, exactly as for a shipped
    // one — the sub-category row wins over the module row.
    const user = member([
      row({ module: 'property_legal', documentKey: null, canView: true }),
      row({ module: 'property_legal', documentKey: 'gift_deed' }),
    ]);
    expect(await hasPermission(user, 'property_legal', 'view', 'gift_deed')).toBe(false);
    expect(await hasPermission(user, 'property_legal', 'view', 'will_nomination')).toBe(true);
  });
});
