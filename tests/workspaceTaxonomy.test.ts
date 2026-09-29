/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A WORKSPACE OFFERS ONE TAXONOMY, AND ONLY ITS OWN                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `documents` carries a CHECK constraint (`documents_account_scope_ck`) pairing
 * `company_id` with `account_scope`. So this is not a presentation preference:
 * a `biz_*` record with no company and a personal record WITH one are both rows
 * Postgres refuses to store.
 *
 * Which means every list a workspace offers has to be filtered by it — the
 * Document Manager's module filter and upload picker, the categories a query may
 * match, the taxonomy Power Scan shows the model, the scan's write gate, the
 * bulk delete and the bulk download. That was seven copies of one comparison,
 * and a copy that gets inverted reads as "my documents are gone" on one side and
 * "why is Medical in my company?" on the other.
 *
 * Now it is one rule, tested here. The seven callers are asserted against the
 * real taxonomy below so an inverted call site fails as a wrong LIST, not only
 * as a wrong boolean.
 */
import { describe, it, expect } from 'vitest';
import {
  belongsToWorkspace,
  keysForWorkspace,
  isBusinessModule,
  BUSINESS_CATEGORY_MODULES,
  PERSONAL_CATEGORY_MODULES,
  DOCUMENT_CATEGORY_MODULES,
} from '@/lib/documentCategories';

const COMPANY = '3f4e0b2a-0000-4000-8000-000000000001';

describe('belongsToWorkspace', () => {
  it('gives the household the personal modules', () => {
    for (const m of PERSONAL_CATEGORY_MODULES) {
      expect(belongsToWorkspace(m.moduleKey, null), m.moduleKey).toBe(true);
      expect(belongsToWorkspace(m.moduleKey, COMPANY), m.moduleKey).toBe(false);
    }
  });

  it('gives a company the business modules', () => {
    expect(BUSINESS_CATEGORY_MODULES.length).toBe(14);
    for (const m of BUSINESS_CATEGORY_MODULES) {
      expect(belongsToWorkspace(m.moduleKey, COMPANY), m.moduleKey).toBe(true);
      expect(belongsToWorkspace(m.moduleKey, null), m.moduleKey).toBe(false);
    }
  });

  it('treats every absent-company spelling as the household', () => {
    // Call sites hand it `useParams()` output, a destructured `{ companyId }`
    // and a URL match — which produce null, undefined and '' respectively.
    for (const absent of [null, undefined, '']) {
      expect(belongsToWorkspace('identity', absent), String(absent)).toBe(true);
      expect(belongsToWorkspace('biz_tax', absent), String(absent)).toBe(false);
    }
  });

  it('partitions the whole master table between the two, with no module in both', () => {
    // The property the seven call sites actually rely on: filtering by workspace
    // never drops a module and never shows one twice.
    const personal = DOCUMENT_CATEGORY_MODULES.filter((m) => belongsToWorkspace(m.moduleKey, null));
    const business = DOCUMENT_CATEGORY_MODULES.filter((m) => belongsToWorkspace(m.moduleKey, COMPANY));
    expect(personal.length + business.length).toBe(DOCUMENT_CATEGORY_MODULES.length);
    expect(personal.some((m) => business.includes(m))).toBe(false);
  });

  it('puts the catch-all on the household side', () => {
    // `other/uncategorized` is where an unclassifiable household scan lands.
    // A company has no equivalent, which is why its Power Scan returns no
    // category at all rather than falling back — see scanWorkspaceScope.test.ts.
    expect(belongsToWorkspace('other', null)).toBe(true);
    expect(belongsToWorkspace('other', COMPANY)).toBe(false);
  });
});

describe('keysForWorkspace', () => {
  const KEYS = [
    { moduleKey: 'identity', documentKey: 'pan_card' },
    { moduleKey: 'biz_tax', documentKey: 'gst_returns' },
    { moduleKey: 'health_medical', documentKey: 'records_prescriptions' },
    { moduleKey: 'biz_licenses', documentKey: 'trade_license' },
  ];

  it('keeps the household to personal categories', () => {
    expect(keysForWorkspace(KEYS, null).map((k) => k.moduleKey))
      .toEqual(['identity', 'health_medical']);
  });

  it('keeps a company to business categories', () => {
    expect(keysForWorkspace(KEYS, COMPANY).map((k) => k.moduleKey))
      .toEqual(['biz_tax', 'biz_licenses']);
  });

  it('preserves order and the rest of each key', () => {
    // Callers pass permission keys through this and then match documents on
    // them, so a dropped `documentKey` would silently widen a query.
    expect(keysForWorkspace(KEYS, COMPANY)).toEqual([
      { moduleKey: 'biz_tax', documentKey: 'gst_returns' },
      { moduleKey: 'biz_licenses', documentKey: 'trade_license' },
    ]);
  });

  it('returns an empty list rather than everything when nothing matches', () => {
    // The direction that matters: an empty permitted set makes a route answer
    // 403, which is visible. Falling back to the unfiltered list would not be.
    const personalOnly = [{ moduleKey: 'identity', documentKey: 'pan_card' }];
    expect(keysForWorkspace(personalOnly, COMPANY)).toEqual([]);
    expect(keysForWorkspace([], null)).toEqual([]);
  });
});

describe('the rule agrees with isBusinessModule', () => {
  it('is exactly "is this module business, and is this workspace a company"', () => {
    for (const m of DOCUMENT_CATEGORY_MODULES) {
      expect(belongsToWorkspace(m.moduleKey, COMPANY)).toBe(isBusinessModule(m.moduleKey));
      expect(belongsToWorkspace(m.moduleKey, null)).toBe(!isBusinessModule(m.moduleKey));
    }
  });
});
