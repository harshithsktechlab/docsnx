import { describe, it, expect } from 'vitest';
import { blindIndex } from '@/lib/fieldCrypto';
import { matchOwner, normaliseOwnerIds, type ClientCandidate, type OwnCompany } from '@/lib/clients/ownerMatch';

const OWN: OwnCompany = {
  name: 'Sharma Advisory', legalName: 'Sharma Advisory Services Pvt Ltd',
  pan: 'AAACS1234K', gstin: '27AAACS1234K1Z5', cin: 'U74999MH2015PTC123456',
};

const client = (over: Partial<ClientCandidate> & Pick<ClientCandidate, 'id' | 'clientType' | 'displayName'>): ClientCandidate => ({
  panHash: null, gstinHash: null, cinHash: null, ...over,
});

const RAJESH = client({ id: 'c-raj', clientType: 'individual', displayName: 'Rajesh Kumar', panHash: blindIndex('ABCPK1234F') });
const PRIYA = client({ id: 'c-priya', clientType: 'individual', displayName: 'Priya Nair' });
const ACME = client({
  id: 'c-acme', clientType: 'company', displayName: 'Acme Traders Pvt Ltd',
  panHash: blindIndex('AABCA1234D'), gstinHash: blindIndex('29AABCA1234D1Z7'),
});
const CLIENTS = [RAJESH, PRIYA, ACME];

describe('normaliseOwnerIds', () => {
  it('keeps only values that look like what they are named', () => {
    const ids = normaliseOwnerIds({ pan: 'abcde 1234f', gstin: 'not a gstin', cin: 'x', tan: 'ABCD12345E' });
    expect(ids).toEqual({ pan: 'ABCDE1234F', gstin: '', cin: '', tan: 'ABCD12345E' });
  });

  it('derives the PAN a GSTIN embeds when none was read separately', () => {
    expect(normaliseOwnerIds({ gstin: '29AABCA1234D1Z7' }).pan).toBe('AABCA1234D');
    // ...but never overrides one that was read.
    expect(normaliseOwnerIds({ pan: 'ZZZZZ9999Z', gstin: '29AABCA1234D1Z7' }).pan).toBe('ZZZZZ9999Z');
  });

  it('tolerates a missing or malformed read', () => {
    expect(normaliseOwnerIds(null)).toEqual({ pan: '', gstin: '', cin: '', tan: '' });
    expect(normaliseOwnerIds({ pan: 123 as any })).toEqual({ pan: '', gstin: '', cin: '', tan: '' });
  });
});

describe('matchOwner — identifiers first', () => {
  it("recognises the company's own GSTIN, PAN and CIN", () => {
    for (const ownerIds of [{ gstin: OWN.gstin }, { pan: OWN.pan }, { cin: OWN.cin }]) {
      const m = matchOwner({ ownerName: 'Someone Else', ownerIds }, OWN, CLIENTS);
      expect(m).toMatchObject({ kind: 'own', via: 'id' });
    }
  });

  it('matches a client by PAN, ignoring a misleading name and type', () => {
    const m = matchOwner({ ownerName: 'R. Kumar', ownerType: 'company', ownerIds: { pan: 'abcpk1234f' } }, OWN, CLIENTS);
    expect(m).toMatchObject({ kind: 'client', clientId: 'c-raj', via: 'id' });
  });

  it('matches a company client from a GST certificate through the embedded PAN', () => {
    const onlyPan = client({ id: 'c-pan', clientType: 'company', displayName: 'Beta Ltd', panHash: blindIndex('AABCB5678E') });
    const m = matchOwner({ ownerIds: { gstin: '29AABCB5678E1Z2' } }, OWN, [onlyPan]);
    expect(m).toMatchObject({ kind: 'client', clientId: 'c-pan', via: 'id' });
  });

  it('is unknown when one identifier points at two clients, or at the company AND a client', () => {
    const twin = client({ id: 'c-twin', clientType: 'individual', displayName: 'Twin', panHash: RAJESH.panHash });
    expect(matchOwner({ ownerIds: { pan: 'ABCPK1234F' } }, OWN, [RAJESH, twin]).kind).toBe('unknown');
    const sameAsOwn = client({ id: 'c-own', clientType: 'company', displayName: 'Dup', panHash: blindIndex(OWN.pan!) });
    expect(matchOwner({ ownerIds: { pan: OWN.pan } }, OWN, [sameAsOwn]).kind).toBe('unknown');
  });

  it('ignores a number that is not shaped like the identifier it was filed as', () => {
    const m = matchOwner({ ownerName: '', ownerIds: { pan: '123456789012' } }, OWN, CLIENTS);
    expect(m.kind).toBe('unknown');
  });
});

describe('matchOwner — names', () => {
  it("matches the company's name despite legal form and a shortened word", () => {
    expect(matchOwner({ ownerName: 'Sharma Advisory Services Private Limited', ownerType: 'company' }, OWN, CLIENTS))
      .toMatchObject({ kind: 'own', via: 'name' });
    expect(matchOwner({ ownerName: 'SHARMA ADVISORY' }, OWN, CLIENTS)).toMatchObject({ kind: 'own' });
  });

  it('matches an individual client by exact and by close name', () => {
    expect(matchOwner({ ownerName: 'Rajesh Kumar', ownerType: 'individual' }, OWN, CLIENTS))
      .toMatchObject({ kind: 'client', clientId: 'c-raj', via: 'name' });
    expect(matchOwner({ ownerName: 'Mr. Rajesh Kumar', ownerType: 'individual' }, OWN, CLIENTS))
      .toMatchObject({ kind: 'client', clientId: 'c-raj' });
  });

  it('matches a company client by name', () => {
    expect(matchOwner({ ownerName: 'Acme Traders Private Limited', ownerType: 'company' }, OWN, CLIENTS))
      .toMatchObject({ kind: 'client', clientId: 'c-acme', clientType: 'company' });
  });

  it('lets the owner type narrow the search: a person is never the company', () => {
    const m = matchOwner({ ownerName: 'Sharma Advisory', ownerType: 'individual' }, OWN, CLIENTS);
    expect(m.kind).toBe('unknown');
  });

  it('is unknown when a name matches both the company and a client', () => {
    const lookalike = client({ id: 'c-sharma', clientType: 'company', displayName: 'Sharma Advisory Group' });
    const m = matchOwner({ ownerName: 'Sharma Advisory', ownerType: 'company' }, OWN, [lookalike]);
    expect(m.kind).toBe('unknown');
  });

  it('is unknown for a stranger, and says so in words', () => {
    const m = matchOwner({ ownerName: 'Vikram Singh', ownerType: 'individual' }, OWN, CLIENTS);
    expect(m).toMatchObject({ kind: 'unknown', via: null });
    expect(m.reason).toContain('Vikram Singh');
  });

  it('is unknown, not a crash, when nothing was read', () => {
    expect(matchOwner({}, OWN, CLIENTS).kind).toBe('unknown');
    expect(matchOwner({ ownerName: 42 as any }, OWN, [])).toMatchObject({ kind: 'unknown' });
  });
});
