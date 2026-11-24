import { describe, it, expect } from 'vitest';
import { mapPairForOwner, noteMessage, type EnabledClientKeys } from '@/lib/clients/ownerCategory';

const ENABLED: EnabledClientKeys = {
  individual: new Set(['identity-pan_card', 'insurance-health_policies']),
  company: new Set(['biz_tax-gst_registration']),
};
const PAN = { moduleKey: 'identity', documentKey: 'pan_card' };
const GST = { moduleKey: 'biz_tax', documentKey: 'gst_registration' };
const AADHAAR = { moduleKey: 'identity', documentKey: 'aadhaar_card' };
const ANY_BIZ_CATCHALL = { moduleKey: 'biz_other', documentKey: 'uncategorized' };

describe('mapPairForOwner', () => {
  it("keeps a business pair for the company's own documents", () => {
    expect(mapPairForOwner(GST, 'own', ENABLED)).toEqual({ pair: GST, note: 'exact' });
  });

  it('files a personal pair under the business catch-all for the company itself', () => {
    expect(mapPairForOwner(PAN, 'own', ENABLED)).toEqual({
      pair: { moduleKey: 'biz_other', documentKey: 'uncategorized' }, note: 'no_equivalent',
    });
  });

  it('derives the individual-client category for a ticked personal pair', () => {
    expect(mapPairForOwner(PAN, 'individual', ENABLED)).toEqual({
      pair: { moduleKey: 'biz_client_individual', documentKey: 'identity-pan_card' }, note: 'exact',
    });
  });

  it('falls back to the client catch-all, saying why, when the pair is not ticked or has no twin', () => {
    expect(mapPairForOwner(AADHAAR, 'individual', ENABLED)).toEqual({
      pair: { moduleKey: 'biz_client_individual', documentKey: 'uncategorized' }, note: 'not_enabled',
    });
    expect(mapPairForOwner(GST, 'individual', ENABLED).note).toBe('no_equivalent');
    expect(mapPairForOwner(PAN, 'company', ENABLED).note).toBe('no_equivalent');
  });

  it('derives the company-client category for a ticked business pair', () => {
    expect(mapPairForOwner(GST, 'company', ENABLED)).toEqual({
      pair: { moduleKey: 'biz_client_company', documentKey: 'biz_tax-gst_registration' }, note: 'exact',
    });
  });

  it("finds a person's PAN card when the classifier named the BUSINESS one — same document key, ticked", () => {
    const biz = { moduleKey: 'biz_registration', documentKey: 'pan_card' };
    expect(mapPairForOwner(biz, 'individual', ENABLED)).toEqual({
      pair: { moduleKey: 'biz_client_individual', documentKey: 'identity-pan_card' }, note: 'exact',
    });
  });

  it('does not guess between two ticked types that share a document key, or when none is ticked', () => {
    const biz = { moduleKey: 'biz_registration', documentKey: 'pan_card' };
    const two = { ...ENABLED, individual: new Set(['identity-pan_card', 'tax_compliance-pan_card']) };
    expect(mapPairForOwner(biz, 'individual', two).note).toBe('no_equivalent');
    const none = { ...ENABLED, individual: new Set<string>() };
    expect(mapPairForOwner(biz, 'individual', none)).toMatchObject({ note: 'no_equivalent', pair: { documentKey: 'uncategorized' } });
  });

  it('works the other way: a company client\'s document the classifier named from the personal list', () => {
    const personalGst = { moduleKey: 'tax_compliance', documentKey: 'gst_registration' };
    const enabledCo = { ...ENABLED, company: new Set(['biz_tax-gst_registration']) };
    expect(mapPairForOwner(personalGst, 'company', enabledCo).note).toBe('exact');
  });

  it('sends a catch-all to the matching client catch-all', () => {
    expect(mapPairForOwner(ANY_BIZ_CATCHALL, 'company', ENABLED)).toEqual({
      pair: { moduleKey: 'biz_client_company', documentKey: 'uncategorized' }, note: 'exact',
    });
  });

  it('re-mapping a client pair starts from its source, so changing owner never compounds', () => {
    const asClient = { moduleKey: 'biz_client_individual', documentKey: 'identity-pan_card' };
    expect(mapPairForOwner(asClient, 'own', ENABLED).note).toBe('no_equivalent');
    expect(mapPairForOwner(asClient, 'individual', ENABLED).note).toBe('exact');
  });
});

describe('noteMessage', () => {
  it('is empty for an exact home and explains the others in words', () => {
    expect(noteMessage('exact', 'PAN Card', 'individual')).toBe('');
    expect(noteMessage('not_enabled', 'PAN Card', 'individual')).toContain('Configure');
    expect(noteMessage('no_equivalent', 'PAN Card', 'own')).toContain('personal document type');
  });
});
