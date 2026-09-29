/**
 * Every module-keyed lookup in the app must answer for every module.
 *
 * The consolidation left one name doing many jobs — taxonomy `module_key`,
 * `hasPermission` key, vault folder, audit entity, AI profile. That is the
 * point, but it also means a table that covers only SOME modules now fails
 * silently rather than loudly: `/api/analysis` began handing six modules a
 * generic AI profile the moment it started passing module names, because
 * `aiProfiles` was still keyed by the old scan vocabulary and the miss falls
 * through to a default instead of throwing.
 *
 * These assertions are cheap and catch exactly that class of gap.
 */
import { describe, it, expect } from 'vitest';
import { RECORD_SCOPE_KEYS, recordScopeConfig } from '@/lib/records/registry';
import { getAIProfile } from '@/lib/aiProfiles';
import { ACTIONS, recordAction } from '@/lib/auditActions';
import { MODULE_COLORS, DOCUMENT_CATEGORY_MODULES } from '@/lib/documentCategories';
import { MODULE_FOLDER } from '@/lib/vault/vaultNaming';
import { MODULE_CATEGORY } from '@/lib/vault/moduleCategoryMap';
import { MODULE_FIELD_MAP } from '@/lib/records/fieldMap';

describe('every module is reachable in every module-keyed table', () => {
  it('has a non-generic AI profile', () => {
    // A generic profile is a silent quality loss, not an error — which is
    // precisely why it needs asserting.
    const generic = RECORD_SCOPE_KEYS.filter(
      (m) => getAIProfile(m).name === 'General Record');
    expect(generic, 'these modules get the fallback AI profile').toEqual([]);
  });

  it('has a canonical audit action', () => {
    const missing = RECORD_SCOPE_KEYS.filter(
      (m) => !(ACTIONS as Record<string, unknown>)[m]);
    expect(missing, 'these modules have no ACTIONS entry').toEqual([]);
  });

  it('builds the same action string either way', () => {
    // `recordAction` exists because the generic handler learns the module from
    // the URL and cannot write `ACTIONS.<module>` literally. The two must agree,
    // or the audit log gains a second spelling per module.
    for (const m of RECORD_SCOPE_KEYS) {
      const canonical = (ACTIONS as Record<string, any>)[m];
      expect(recordAction(m, 'create')).toBe(canonical.create);
      expect(recordAction(m, 'update')).toBe(canonical.update);
      expect(recordAction(m, 'delete')).toBe(canonical.delete);
    }
  });

  it('gives every SCOPE a category policy and a registry config', () => {
    // Scope-keyed: these translate a PAGE's own vocabulary — its `recordType`
    // values — so they answer per page.
    for (const m of RECORD_SCOPE_KEYS) {
      expect(MODULE_CATEGORY[m], `${m} has no category policy`).toBeDefined();
      expect(recordScopeConfig(m), `${m} has no registry config`).toBeDefined();
    }
  });

  it('gives every LEGACY scope a field map', () => {
    // Deliberately not every scope. MODULE_FIELD_MAP translates the camelCase
    // body a pre-consolidation page sends into snake_case taxonomy keys; the 14
    // business scopes were built against the generic /modules pages and post
    // taxonomy keys already, so an entry for them would map each key to itself.
    //
    // The risk this test really guards — PII landing in the open tier because a
    // camelCase key missed the encrypt list — does not arise for them: with no
    // translation step the key IS the taxonomy key, and `splitRecordFields`
    // intersects it with the category's encrypt list directly.
    for (const m of RECORD_SCOPE_KEYS.filter((s) => !s.startsWith('biz_'))) {
      expect(MODULE_FIELD_MAP[m], `${m} has no field map`).toBeDefined();
    }
  });

  it('gives every taxonomy MODULE a colour and a Drive folder', () => {
    // Module-keyed, and deliberately not scope-keyed: a colour labels a category
    // and a Drive folder holds one, and both follow the category's module. Since
    // 0023 one page can span two modules, so asking these per page would leave
    // half the categories unanswered.
    for (const m of DOCUMENT_CATEGORY_MODULES.map((x) => x.moduleKey)) {
      expect(MODULE_COLORS[m], `${m} has no colour`).toBeDefined();
      expect((MODULE_FOLDER as Record<string, string>)[m], `${m} has no Drive folder`).toBeDefined();
    }
  });

  it('still resolves the AI SCAN vocabulary, which is deliberately separate', () => {
    // Those tokens are part of the prompt contract in src/lib/ai.js and are
    // chosen for the model, not for us. They are translated, not renamed — so
    // both spellings have to keep working.
    const scanCategories = [
      'document', 'medical', 'bank', 'vehicle', 'lic_mediclaim', 'investment',
      'warranty_amc', 'contract_agreement', 'tax_compliance', 'will_estate',
      // `corporate_compliance` left the vocabulary with the personal `business`
      // module it served (0050). Company paperwork is classified into the
      // business taxonomy now, which the scanner reaches by module key.
      'loan_debt', 'utility_bill', 'employment_payroll', 'trading',
    ];
    const generic = scanCategories.filter((c) => getAIProfile(c).name === 'General Record');
    expect(generic, 'these scan categories lost their AI profile').toEqual([]);
  });
});
