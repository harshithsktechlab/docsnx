import { describe, it, expect, vi, beforeEach } from 'vitest';
import { blindIndex } from '@/lib/fieldCrypto';
import { clientDetailsForEdit, prepareClientRow } from '@/lib/clients/clientData';

let row: any;
let conflict: string | null;
let boom = false;
const updates: any[] = [];
const audits: any[] = [];

vi.mock('@/lib/db', () => ({
  withTenant: async (_t: string, fn: any) => {
    if (boom) throw new Error('db down');
    return fn({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }) }),
      update: () => ({ set: (v: any) => ({ where: async () => { updates.push(v); } }) }),
    });
  },
}));
vi.mock('@/lib/audit', async () => ({
  ...(await vi.importActual<any>('@/lib/auditActions')),
  writeAudit: vi.fn(async (e: any) => { audits.push(e); }),
}));
vi.mock('@/lib/clients/clientConflicts', () => ({ findClientConflict: vi.fn(async () => conflict) }));

const { detailsFromRecord, fillBlanks, fillClientFromRecord } = await import('@/lib/clients/clientAutofill');

const PAN_CARD = { moduleKey: 'biz_client_individual', documentKey: 'identity-pan_card' };
const USER = { id: 'u1', tenantId: 't1' };

const clientRow = (details: Record<string, string> = {}, type = 'individual', name = 'Ram Das') => ({
  id: 'c1', clientType: type, displayName: name, details: prepareClientRow(name, details).details,
});

beforeEach(() => { row = clientRow(); conflict = null; boom = false; updates.length = 0; audits.length = 0; });

describe('detailsFromRecord — what a document may say about its owner', () => {
  it("takes a PAN card's PAN and date of birth, through the client category's SOURCE", () => {
    const f = detailsFromRecord('individual', PAN_CARD, { pan_number: 'ABCPD1234E', date_of_birth: '1985-08-15', father_name: 'Shyam Das' });
    expect(f.details).toEqual({ panNumber: 'ABCPD1234E', dateOfBirth: '1985-08-15' });
    expect(f.details).not.toHaveProperty('father_name');
  });

  it('cuts a stored timestamp to its date, and ignores a date it cannot read', () => {
    expect(detailsFromRecord('individual', PAN_CARD, { date_of_birth: '1985-08-15T00:00:00.000Z' }).details.dateOfBirth).toBe('1985-08-15');
    expect(detailsFromRecord('individual', PAN_CARD, { date_of_birth: '15 August 1985' }).details).toEqual({});
  });

  it('takes an Aadhaar number and address from an Aadhaar card, and DOB from a passport', () => {
    const a = detailsFromRecord('individual', { moduleKey: 'biz_client_individual', documentKey: 'identity-aadhaar_card' },
      { aadhaar_number: '2345 6789 0123', address: '12 MG Road', date_of_birth: '1990-01-02' });
    expect(a.details).toEqual({ aadhaarNumber: '2345 6789 0123', address: '12 MG Road', dateOfBirth: '1990-01-02' });
    expect(detailsFromRecord('individual', { moduleKey: 'biz_client_individual', documentKey: 'identity-passport' },
      { passport_number: 'A1234567', date_of_birth: '1990-01-02' }).details).toEqual({ dateOfBirth: '1990-01-02' });
  });

  it('takes a GSTIN from a GST certificate, and the PAN a GSTIN embeds', () => {
    const f = detailsFromRecord('company', { moduleKey: 'biz_client_company', documentKey: 'biz_tax-gst_registration' }, { gstin: '29AABCA1234D1Z7' });
    expect(f.details).toEqual({ gstNumber: '29AABCA1234D1Z7', panNumber: 'AABCA1234D' });
  });

  it('takes a CIN from a certificate of incorporation, and a PAN from a business PAN card', () => {
    expect(detailsFromRecord('company', { moduleKey: 'biz_client_company', documentKey: 'biz_registration-certificate_of_incorporation' },
      { cin_number: 'U51909KA2021PTC123456' }).details).toEqual({ registrationNumber: 'U51909KA2021PTC123456' });
    expect(detailsFromRecord('company', { moduleKey: 'biz_client_company', documentKey: 'biz_registration-pan_card' },
      { pan_number: 'AABCA1234D' }).details).toEqual({ panNumber: 'AABCA1234D' });
  });

  it("does not trust a PAN on a category that merely MENTIONS one (a loan form's guarantor)", () => {
    const loan = { moduleKey: 'biz_client_individual', documentKey: 'bank_investments-loan_agreements' };
    expect(detailsFromRecord('individual', loan, { pan_number: 'ZZZPG9999Z' }).details).toEqual({});
  });

  it('is empty, not a crash, for a category with no mapping, no fields, or the wrong kind of client', () => {
    expect(detailsFromRecord('individual', { moduleKey: 'biz_client_individual', documentKey: 'uncategorized' }, { pan_number: 'ABCPD1234E' }).details).toEqual({});
    expect(detailsFromRecord('individual', PAN_CARD, null).details).toEqual({});
    // A company client has no personal-document mapping.
    expect(detailsFromRecord('company', PAN_CARD, { pan_number: 'ABCPD1234E' }).details).toEqual({});
  });
});

describe('fillBlanks — blanks only, and only what looks right', () => {
  const found = (d: Record<string, string>) => ({ details: d, labels: { panNumber: 'PAN', dateOfBirth: 'date of birth' } });

  it('fills what is blank and normalises it', () => {
    const r = fillBlanks('individual', {}, found({ panNumber: 'abcpd 1234e', dateOfBirth: '1985-08-15' }));
    expect(r.merged).toEqual({ panNumber: 'ABCPD1234E', dateOfBirth: '1985-08-15' });
    expect(r.changed.sort()).toEqual(['dateOfBirth', 'panNumber']);
  });

  it('NEVER overwrites a value that is already there', () => {
    const r = fillBlanks('individual', { panNumber: 'ZZZPZ9999Z', dateOfBirth: '1990-01-01' }, found({ panNumber: 'ABCPD1234E', dateOfBirth: '1985-08-15' }));
    expect(r.changed).toEqual([]);
    expect(r.merged).toEqual({ panNumber: 'ZZZPZ9999Z', dateOfBirth: '1990-01-01' });
  });

  it('drops one bad value without losing the good ones', () => {
    const r = fillBlanks('individual', {}, found({ panNumber: 'NOT-A-PAN', dateOfBirth: '1985-08-15' }));
    expect(r.changed).toEqual(['dateOfBirth']);
    expect(r.merged).not.toHaveProperty('panNumber');
  });
});

describe('fillClientFromRecord', () => {
  it('copies a saved PAN card onto the client — sealed, hashed — and audits the FIELDS only', async () => {
    const labels = await fillClientFromRecord(USER, 'co-1', 'c1', PAN_CARD, { pan_number: 'ABCPD1234E', date_of_birth: '1985-08-15' });
    expect(labels.sort()).toEqual(['PAN', 'date of birth']);
    expect(updates).toHaveLength(1);
    // Sealed at rest, and findable by its blind index for the next scan.
    expect(updates[0].details.panNumber).not.toContain('ABCPD1234E');
    expect(updates[0].panHash).toBe(blindIndex('ABCPD1234E'));
    expect(clientDetailsForEdit(updates[0].details)).toMatchObject({ panNumber: 'ABCPD1234E', dateOfBirth: '1985-08-15' });
    // The trail says what was filled, never what it is.
    expect(JSON.stringify(audits[0])).not.toMatch(/ABCPD1234E|1985/);
    expect(audits[0].details).toContain('filled from a document');
    expect(audits[0].details).toContain('PAN');
  });

  it('leaves a client who already has the value alone — no write, no audit', async () => {
    row = clientRow({ panNumber: 'ZZZPZ9999Z', dateOfBirth: '1990-01-01' });
    expect(await fillClientFromRecord(USER, 'co-1', 'c1', PAN_CARD, { pan_number: 'ABCPD1234E', date_of_birth: '1985-08-15' })).toEqual([]);
    expect(updates).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('does not copy a PAN another client already holds', async () => {
    conflict = '"Sita" already has the same PAN, GSTIN or registration number.';
    expect(await fillClientFromRecord(USER, 'co-1', 'c1', PAN_CARD, { pan_number: 'ABCPD1234E' })).toEqual([]);
    expect(updates).toHaveLength(0);
  });

  it('does nothing for a document that states nothing about its owner', async () => {
    expect(await fillClientFromRecord(USER, 'co-1', 'c1', { moduleKey: 'biz_client_individual', documentKey: 'uncategorized' }, { pan_number: 'ABCPD1234E' })).toEqual([]);
    expect(updates).toHaveLength(0);
  });

  it('is never fatal: a database failure returns nothing and does not throw', async () => {
    boom = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(fillClientFromRecord(USER, 'co-1', 'c1', PAN_CARD, { pan_number: 'ABCPD1234E' })).resolves.toEqual([]);
    spy.mockRestore();
  });

  it('fills a company client from its GST certificate: GSTIN and the PAN inside it', async () => {
    row = clientRow({}, 'company', 'Acme Traders Pvt Ltd');
    const labels = await fillClientFromRecord(USER, 'co-1', 'c1', { moduleKey: 'biz_client_company', documentKey: 'biz_tax-gst_registration' }, { gstin: '29AABCA1234D1Z7' });
    expect(labels.sort()).toEqual(['GSTIN', 'PAN']);
    expect(updates[0].gstinHash).toBe(blindIndex('29AABCA1234D1Z7'));
    expect(updates[0].panHash).toBe(blindIndex('AABCA1234D'));
  });
});
