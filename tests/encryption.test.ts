import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

/**
 * Encryption Module Tests
 * 
 * We replicate the encrypt/decrypt logic from src/lib/encryption.js to test
 * the encryption algorithm in isolation without requiring environment-specific imports.
 */

const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'docsnx_aes256_secret_key_32_bytes_long_!';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getKey(): Buffer {
  return crypto.scryptSync(ENCRYPTION_SECRET, 'salt-family-os', 32);
}

function encrypt(text: string): string {
  if (!text) return '';
  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = getKey();
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const tag = cipher.getAuthTag().toString('hex');

    return `${iv.toString('hex')}:${tag}:${encrypted}`;
  } catch (error) {
    console.error('Encryption failed:', error);
    throw new Error('Encryption failed');
  }
}

function decrypt(ciphertext: string): string {
  if (!ciphertext) return '';
  try {
    const parts = ciphertext.split(':');
    if (parts.length !== 3) return ciphertext;

    const [ivHex, tagHex, encryptedHex] = parts;

    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');

    const key = getKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    console.error('Decryption failed:', error);
    return '[Decryption Failed]';
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Encryption Module', () => {

  // ─── encrypt ──────────────────────────────────────────────────────────

  describe('encrypt', () => {
    it('should return empty string for empty input', () => {
      expect(encrypt('')).toBe('');
    });

    it('should return empty string for null-ish input', () => {
      expect(encrypt(null as any)).toBe('');
      expect(encrypt(undefined as any)).toBe('');
    });

    it('should return iv:tag:encrypted format', () => {
      const result = encrypt('hello');
      const parts = result.split(':');
      expect(parts).toHaveLength(3);
      // IV is 12 bytes = 24 hex chars
      expect(parts[0]).toHaveLength(24);
      // Auth tag is 16 bytes = 32 hex chars
      expect(parts[1]).toHaveLength(32);
      // Encrypted hex should be non-empty
      expect(parts[2].length).toBeGreaterThan(0);
    });

    it('should produce different ciphertexts for the same plaintext (random IV)', () => {
      const ct1 = encrypt('hello');
      const ct2 = encrypt('hello');
      expect(ct1).not.toBe(ct2);
    });

    it('should only contain hex characters and colons', () => {
      const result = encrypt('test data');
      expect(result).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    });
  });

  // ─── decrypt ──────────────────────────────────────────────────────────

  describe('decrypt', () => {
    it('should return empty string for empty input', () => {
      expect(decrypt('')).toBe('');
    });

    it('should return empty string for null-ish input', () => {
      expect(decrypt(null as any)).toBe('');
      expect(decrypt(undefined as any)).toBe('');
    });

    it('should return input as-is if not in iv:tag:encrypted format', () => {
      expect(decrypt('plain text without colons')).toBe('plain text without colons');
    });

    it('should return input as-is for single-colon strings (not 3 parts)', () => {
      expect(decrypt('part1:part2')).toBe('part1:part2');
    });

    it('should return [Decryption Failed] for tampered ciphertext', () => {
      const original = encrypt('hello');
      const parts = original.split(':');
      // Tamper with the encrypted data
      parts[2] = 'ff'.repeat(parts[2].length / 2);
      const tampered = parts.join(':');
      const result = decrypt(tampered);
      expect(result).toBe('[Decryption Failed]');
    });
  });

  // ─── Round-trip ───────────────────────────────────────────────────────

  describe('Round-trip (encrypt → decrypt)', () => {
    it('should round-trip "hello"', () => {
      const encrypted = encrypt('hello');
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe('hello');
    });

    it('should round-trip an empty string (via empty → empty)', () => {
      const encrypted = encrypt('');
      expect(encrypted).toBe('');
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe('');
    });

    it('should round-trip a long string (1000 chars)', () => {
      const longStr = 'A'.repeat(1000);
      const encrypted = encrypt(longStr);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(longStr);
    });

    it('should round-trip unicode characters', () => {
      const unicode = '你好世界 🌍 مرحبا العالم こんにちは世界';
      const encrypted = encrypt(unicode);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(unicode);
    });

    it('should round-trip special characters', () => {
      const special = '!@#$%^&*()_+-=[]{}|;:\'",.<>?/\\`~';
      const encrypted = encrypt(special);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(special);
    });

    it('should round-trip JSON string', () => {
      const jsonStr = JSON.stringify({ password: 'MyS3cur3P@ss!', pin: '1234', notes: 'Important' });
      const encrypted = encrypt(jsonStr);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(jsonStr);
      expect(JSON.parse(decrypted)).toEqual({ password: 'MyS3cur3P@ss!', pin: '1234', notes: 'Important' });
    });

    it('should round-trip multiline text', () => {
      const multiline = 'Line 1\nLine 2\nLine 3\tTabbed';
      const encrypted = encrypt(multiline);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(multiline);
    });

    it('should round-trip a very long string (10KB)', () => {
      const longStr = crypto.randomBytes(5000).toString('hex'); // ~10KB
      const encrypted = encrypt(longStr);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(longStr);
    });
  });
});
