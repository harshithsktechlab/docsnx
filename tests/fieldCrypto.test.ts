import { describe, it, expect } from 'vitest';
import {
  encryptField,
  decryptField,
  blindIndex,
  isCiphertext,
  hashToken,
  encryptFields,
  decryptFields,
} from '@/lib/fieldCrypto';

describe('fieldCrypto.encryptField / decryptField', () => {
  it('round-trips a value through encryption', () => {
    const ct = encryptField('1234567890');
    expect(ct).not.toBeNull();
    expect(ct).not.toBe('1234567890');
    expect(isCiphertext(ct!)).toBe(true);
    expect(decryptField(ct)).toBe('1234567890');
  });

  it('returns null for null/undefined/empty', () => {
    expect(encryptField(null)).toBeNull();
    expect(encryptField(undefined)).toBeNull();
    expect(encryptField('')).toBeNull();
    expect(decryptField(null)).toBeNull();
    expect(decryptField('')).toBeNull();
  });

  it('is idempotent — does not double-encrypt ciphertext', () => {
    const once = encryptField('HDFC00001234');
    const twice = encryptField(once);
    expect(twice).toBe(once);
    expect(decryptField(twice)).toBe('HDFC00001234');
  });

  it('produces different ciphertext for the same input (random IV/salt)', () => {
    expect(encryptField('same')).not.toBe(encryptField('same'));
  });

  it('encryptFields / decryptFields operate on named keys only', () => {
    const enc = encryptFields({ a: 'secret', b: 'plain' }, ['a']);
    expect(enc.b).toBe('plain');
    expect(isCiphertext(enc.a as string)).toBe(true);
    const dec = decryptFields(enc, ['a']);
    expect(dec.a).toBe('secret');
  });
});

describe('fieldCrypto.blindIndex', () => {
  it('is deterministic for the same normalized value', () => {
    expect(blindIndex('1234 5678')).toBe(blindIndex('12345678'));
    expect(blindIndex('abc123')).toBe(blindIndex('ABC123'));
  });

  it('differs for different values and is null for empty', () => {
    expect(blindIndex('a')).not.toBe(blindIndex('b'));
    expect(blindIndex('')).toBeNull();
    expect(blindIndex(null)).toBeNull();
  });

  it('does not leak the plaintext', () => {
    const idx = blindIndex('SENSITIVE1234');
    expect(idx).not.toContain('SENSITIVE');
    expect(idx).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('fieldCrypto.isCiphertext', () => {
  it('detects the iv:salt:tag:ct shape', () => {
    expect(isCiphertext(encryptField('x')!)).toBe(true);
  });
  it('rejects plaintext and hashes', () => {
    expect(isCiphertext('hello')).toBe(false);
    expect(isCiphertext('12345678')).toBe(false);
    expect(isCiphertext(hashToken('otp')!)).toBe(false); // single hex group, no colons
    expect(isCiphertext(null)).toBe(false);
  });
});

describe('fieldCrypto.hashToken', () => {
  it('is deterministic and one-way', () => {
    const h = hashToken('654321');
    expect(h).toBe(hashToken('654321'));
    expect(h).not.toBe('654321');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(null)).toBeNull();
  });
});
