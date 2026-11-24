import { describe, it, expect, vi } from 'vitest';
import { blindIndex } from '@/lib/fieldCrypto';
import { DOCUMENT_CATEGORY_SEED } from '@/lib/documentCategories';
import { CLIENT_CATEGORY_SEED } from '@/lib/clientCategories';

const loaded: { value: any } = { value: null };
vi.mock('@/lib/db', () => ({ db: {}, withTenant: vi.fn(async () => loaded.value) }));
vi.mock('@/lib/taxonomyRegistry', () => ({
  taxonomyRows: async () => [...DOCUMENT_CATEGORY_SEED, ...CLIENT_CATEGORY_SEED].map((r) => ({ ...r, isSystem: true })),
}));

const { applyScanOwners, individualClientStanza, individualSourceKeys, loadScanOwnerContext } = await import('@/lib/clients/scanOwners');

const ctx = {
  companyId: 'co-1',
  own: { name: 'Sharma Advisory', legalName: 'Sharma Advisory Services Pvt Ltd', pan: 'AAACS1234K', gstin: '27AAACS1234K1Z5' },
  clients: [
    { id: 'c-raj', clientType: 'individual' as const, displayName: 'Rajesh Kumar', panHash: blindIndex('ABCPK1234F') },
    { id: 'c-acme', clientType: 'company' as const, displayName: 'Acme Traders Pvt Ltd', gstinHash: blindIndex('29AABCA1234D1Z7') },
  ],
  enabled: {
    individual: new Set(['identity-pan_card']),
    company: new Set(['biz_tax-gst_registration']),
  },
};

const rec = (mod: string, doc: string, extra: Record<string, unknown> = {}) => ({
  title: 'T', kind: 'record', fileIndices: [0], category: 'document',
  extractedData: { moduleKey: mod, documentKey: doc }, ...extra,
});

describe('individualClientStanza', () => {
  it('lists only the ticked personal subcategories, in the model\'s heading format', async () => {
    const stanza = await individualClientStanza(ctx as any);
    expect(stanza).toContain('DOCUMENTS OF AN INDIVIDUAL CLIENT');
    expect(stanza).toContain('(moduleKey: "identity")');
    expect(stanza).toContain('"pan_card": PAN Card');
    expect(stanza).not.toContain('aadhaar_card');
    expect(stanza).not.toContain('biz_tax');
    // No client name, number or id ever reaches the prompt.
    expect(stanza).not.toContain('Rajesh');
    expect(stanza).not.toContain('c-raj');
  });

  it('is empty when nothing is ticked for individuals', async () => {
    const none = { ...ctx, enabled: { individual: new Set<string>(), company: new Set<string>() } };
    expect(await individualClientStanza(none as any)).toBe('');
    expect((await individualSourceKeys(none as any)).size).toBe(0);
  });
});

describe('applyScanOwners', () => {
  it("files a known client's PAN card under that client's category", async () => {
    const records = [rec('identity', 'pan_card', {
      ownerName: 'Rajesh Kumar', ownerType: 'individual', ownerIds: { pan: 'ABCPK1234F' },
    })];
    const payload = await applyScanOwners(records, ctx as any);
    expect(records[0].extractedData).toMatchObject({ moduleKey: 'biz_client_individual', documentKey: 'identity-pan_card' });
    expect((records[0] as any).clientId).toBe('c-raj');
    expect((records[0] as any).sourcePair).toEqual({ moduleKey: 'identity', documentKey: 'pan_card' });
    expect((records[0] as any).ownerProposal).toMatchObject({ kind: 'client', owner: 'individual', via: 'id', attention: false });
    expect(payload.clients).toHaveLength(2);
    expect(payload.categoryNames['biz_client_individual/identity-pan_card']).toBe('PAN Card');
  });

  it("files a company client's GST certificate under the company-client category", async () => {
    const records = [rec('biz_tax', 'gst_registration', { ownerName: 'Acme Traders', ownerType: 'company', ownerIds: { gstin: '29AABCA1234D1Z7' } })];
    await applyScanOwners(records, ctx as any);
    expect(records[0].extractedData).toMatchObject({ moduleKey: 'biz_client_company', documentKey: 'biz_tax-gst_registration' });
    expect((records[0] as any).clientType).toBe('company');
  });

  it("leaves the company's own document exactly where the classifier put it", async () => {
    const records = [rec('biz_tax', 'gst_registration', { ownerName: 'Sharma Advisory Services Private Limited', ownerType: 'company', ownerIds: { gstin: '27AAACS1234K1Z5' } })];
    await applyScanOwners(records, ctx as any);
    expect(records[0].extractedData).toMatchObject({ moduleKey: 'biz_tax', documentKey: 'gst_registration' });
    expect((records[0] as any).clientId).toBeUndefined();
    expect((records[0] as any).ownerProposal).toMatchObject({ kind: 'own', owner: 'own', attention: false });
  });

  it('asks for a person nobody recognises: individual category, no client, needs attention, prefill ready', async () => {
    const records = [rec('identity', 'pan_card', { ownerName: 'Vikram Singh', ownerType: 'individual', ownerIds: { pan: 'ZZZPS9999Z' } })];
    await applyScanOwners(records, ctx as any);
    const p = (records[0] as any).ownerProposal;
    expect(records[0].extractedData.moduleKey).toBe('biz_client_individual');
    expect((records[0] as any).clientId).toBeUndefined();
    expect(p).toMatchObject({ kind: 'unknown', owner: 'individual', attention: true });
    expect(p.read).toMatchObject({ name: 'Vikram Singh', type: 'individual', ids: { pan: 'ZZZPS9999Z' } });
  });

  it("never blocks a company's OWN-style document: an unrecognised name stays under the company, with a hint only", async () => {
    const records = [rec('biz_tax', 'gst_registration', { ownerName: 'Gamma Exports', ownerType: 'company' })];
    await applyScanOwners(records, ctx as any);
    // Exactly where the classifier put it — what the scan did before this feature.
    expect(records[0].extractedData).toMatchObject({ moduleKey: 'biz_tax', documentKey: 'gst_registration' });
    expect((records[0] as any).ownerProposal).toMatchObject({ kind: 'unknown', owner: 'own', attention: false });
    expect((records[0] as any).ownerProposal.reason).toContain('Gamma Exports');
  });

  it('does not nag about a company document that names nobody', async () => {
    const records = [rec('biz_other', 'uncategorized')];
    await applyScanOwners(records, ctx as any);
    expect((records[0] as any).ownerProposal).toMatchObject({ owner: 'own', attention: false });
  });

  it('says why when a client document type is not ticked, and files it under Others', async () => {
    const records = [rec('biz_registration', 'certificate_of_incorporation', {
      ownerName: 'Acme Traders Private Limited', ownerType: 'company', ownerIds: { gstin: '29AABCA1234D1Z7' },
    })];
    await applyScanOwners(records, ctx as any);
    expect(records[0].extractedData).toMatchObject({ moduleKey: 'biz_client_company', documentKey: 'uncategorized' });
    expect((records[0] as any).ownerProposal.pairNote).toBe('not_enabled');
    expect((records[0] as any).ownerProposal.noteText).toContain('Configure');
  });

  it('lifts owner keys a model nested inside extractedData, and skips todos', async () => {
    const records = [
      rec('identity', 'pan_card', { extractedData: { moduleKey: 'identity', documentKey: 'pan_card', ownerName: 'Rajesh Kumar', ownerType: 'individual' } }),
      { title: 'x', kind: 'todo', extractedData: {} },
    ];
    await applyScanOwners(records as any, ctx as any);
    expect((records[0] as any).ownerName).toBe('Rajesh Kumar');
    expect((records[0] as any).extractedData.ownerName).toBeUndefined();
    expect((records[0] as any).clientId).toBe('c-raj');
    expect((records[1] as any).ownerProposal).toBeUndefined();
  });
});

describe('loadScanOwnerContext — configuring comes first', () => {
  const BOTH = { chosen: true, individual: true, company: true };
  const company = { name: 'Sharma Advisory' };
  const clientRows = [
    { id: 'c-raj', clientType: 'individual', displayName: 'Rajesh Kumar', panHash: null, gstinHash: null, cinHash: null },
    { id: 'c-acme', clientType: 'company', displayName: 'Acme Traders', panHash: null, gstinHash: null, cinHash: null },
  ];

  it('is null — the scan is untouched — when clients exist but nothing is ticked', async () => {
    loaded.value = { tickedIndividual: [], tickedCompany: [], types: BOTH, rows: clientRows, co: company, profile: null };
    expect(await loadScanOwnerContext({ tenantId: 't1' }, 'co-1')).toBeNull();
  });

  it('is null for a company with no clients and nothing ticked', async () => {
    loaded.value = { tickedIndividual: [], tickedCompany: [], types: BOTH, rows: [], co: company, profile: null };
    expect(await loadScanOwnerContext({ tenantId: 't1' }, 'co-1')).toBeNull();
  });

  it('only knows clients of a kind that has something ticked', async () => {
    loaded.value = { tickedIndividual: ['identity-pan_card'], tickedCompany: [], types: BOTH, rows: clientRows, co: company, profile: null };
    const ctx = await loadScanOwnerContext({ tenantId: 't1' }, 'co-1');
    expect(ctx!.clients.map((c) => c.id)).toEqual(['c-raj']);
    expect([...ctx!.enabled.company]).toEqual([]);
  });

  it('ignores ticks for a kind the company does not keep — and null when nothing kept is ticked', async () => {
    const ONLY_COMPANY = { chosen: true, individual: false, company: true };
    // Individuals are ticked but not kept: invisible, and so is every individual client.
    loaded.value = { tickedIndividual: ['identity-pan_card'], tickedCompany: ['biz_tax-gst_registration'], types: ONLY_COMPANY, rows: clientRows, co: company, profile: null };
    const ctx = await loadScanOwnerContext({ tenantId: 't1' }, 'co-1');
    expect([...ctx!.enabled.individual]).toEqual([]);
    expect([...ctx!.enabled.company]).toEqual(['biz_tax-gst_registration']);
    expect(ctx!.clients.map((c) => c.id)).toEqual(['c-acme']);

    // Everything ticked is for a kind that is not kept: the scan is untouched.
    loaded.value = { tickedIndividual: ['identity-pan_card'], tickedCompany: [], types: ONLY_COMPANY, rows: clientRows, co: company, profile: null };
    expect(await loadScanOwnerContext({ tenantId: 't1' }, 'co-1')).toBeNull();
  });

  it('is null while nothing has been chosen, however much is ticked', async () => {
    loaded.value = { tickedIndividual: ['identity-pan_card'], tickedCompany: [], types: { chosen: false, individual: false, company: false }, rows: clientRows, co: company, profile: null };
    expect(await loadScanOwnerContext({ tenantId: 't1' }, 'co-1')).toBeNull();
  });
});
