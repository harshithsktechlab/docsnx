import { describe, it, expect } from 'vitest';
import {
  clientDetailsForEdit, clientForList, parseClientDetails, prepareClientRow,
} from '@/lib/clients/clientData';
import { blindIndex } from '@/lib/fieldCrypto';
import { isCiphertext } from '@/lib/fieldCrypto';

describe('parseClientDetails', () => {
  it('normalises PAN / GSTIN case and spacing and accepts a clean individual form', () => {
    const r = parseClientDetails('individual', {
      mobile: '+91 98765 43210', email: 'a@b.co', panNumber: ' abcde 1234f ', dateOfBirth: '1990-01-02',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.details.panNumber).toBe('ABCDE1234F');
  });

  it('drops cleared (empty) fields rather than storing empty strings', () => {
    const r = parseClientDetails('individual', { mobile: '', panNumber: '', notes: 'x' });
    expect(r.ok && r.details).toEqual({ notes: 'x' });
  });

  it('rejects a malformed PAN, GSTIN and email with a readable message', () => {
    expect(parseClientDetails('individual', { panNumber: 'NOPE' })).toMatchObject({ ok: false });
    expect(parseClientDetails('company', { gstNumber: '123' })).toMatchObject({ ok: false });
    expect(parseClientDetails('individual', { email: 'not-an-email' })).toMatchObject({ ok: false });
  });

  it('is strict: an unknown key is refused, and a company-only key is refused on an individual', () => {
    expect(parseClientDetails('individual', { surprise: 'x' })).toMatchObject({ ok: false });
    expect(parseClientDetails('individual', { gstNumber: '27ABCDE1234F1Z5' })).toMatchObject({ ok: false });
    expect(parseClientDetails('company', { gstNumber: '27ABCDE1234F1Z5' })).toMatchObject({ ok: true });
  });
});

describe('prepareClientRow', () => {
  const details = { panNumber: 'ABCDE1234F', gstNumber: '27ABCDE1234F1Z5', registrationNumber: 'U12345MH2020PTC123456', mobile: '9876543210' };

  it('seals the identifiers, leaves the rest readable, and round-trips', () => {
    const row = prepareClientRow('Acme Traders Pvt Ltd', details);
    expect(isCiphertext(row.details.panNumber as string)).toBe(true);
    expect(isCiphertext(row.details.gstNumber as string)).toBe(true);
    // CIN is a public register entry and stays plaintext, like company_profiles.
    expect(row.details.registrationNumber).toBe('U12345MH2020PTC123456');
    expect(row.details.mobile).toBe('9876543210');
    expect(clientDetailsForEdit(row.details)).toEqual(details);
  });

  it('derives blind indexes that match the same value in any case and spacing', () => {
    const row = prepareClientRow('Acme', details);
    expect(row.panHash).toBe(blindIndex('abcde 1234f'));
    expect(row.gstinHash).toBe(blindIndex('27ABCDE1234F1Z5'));
    expect(row.cinHash).toBe(blindIndex('U12345MH2020PTC123456'));
  });

  it('leaves a hash null when there is no identifier, and normalises the name', () => {
    const row = prepareClientRow('  Rajesh   Kumar (HUF) ', { mobile: '9876543210' });
    expect(row.panHash).toBeNull();
    expect(row.nameNorm).toBe('rajesh kumar');
    expect(row.displayName).toBe('Rajesh   Kumar (HUF)');
  });
});

describe('clientForList', () => {
  it('never carries a full identifier', () => {
    const row = prepareClientRow('Acme', { panNumber: 'ABCDE1234F', gstNumber: '27ABCDE1234F1Z5' });
    const item = clientForList({ id: 'x', clientType: 'company', displayName: 'Acme', details: row.details });
    expect(JSON.stringify(item)).not.toContain('ABCDE1234F');
    expect(JSON.stringify(item)).not.toContain('27ABCDE1234F1Z5');
    expect(item.panMasked).toMatch(/234F$/);
  });
});
