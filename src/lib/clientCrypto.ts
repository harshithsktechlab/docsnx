/**
 * Client-Side Zero-Knowledge Encryption Hub (Web Crypto API)
 * 
 * Uses PBKDF2 (100,000 iterations + SHA-256) to derive an AES-256-GCM key
 * entirely inside the user's browser memory. Plaintext data and the master
 * passphrase never leave the browser.
 */

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH_BITS = 256;

/**
 * Derives a Zero-Knowledge AES-256-GCM CryptoKey from a Master Passphrase and Tenant Salt.
 */
export async function deriveZeroKnowledgeKey(passphrase: string, saltHex: string): Promise<CryptoKey> {
  if (typeof window === 'undefined' || !window.crypto?.subtle) {
    throw new Error('Web Crypto API is only available in secure browser contexts');
  }

  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  // Convert hex salt to Uint8Array
  const saltBytes = hexToBytes(saltHex || '646f63736e785f7a6b5f73616c743136');

  return window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes as any,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_LENGTH_BITS },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts a string or JSON object using AES-256-GCM.
 * Returns formatted ciphertext string: "ivHex:ciphertextHex"
 */
export async function encryptZeroKnowledge(
  payload: string | Record<string, any>,
  key: CryptoKey
): Promise<string> {
  const enc = new TextEncoder();
  const plaintextString = typeof payload === 'string' ? payload : JSON.stringify(payload);

  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encryptedBuffer = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintextString)
  );

  return `${bytesToHex(iv)}:${bytesToHex(new Uint8Array(encryptedBuffer))}`;
}

/**
 * Decrypts a Zero-Knowledge ciphertext string produced by encryptZeroKnowledge.
 */
export async function decryptZeroKnowledge(
  ciphertext: string,
  key: CryptoKey
): Promise<string> {
  const parts = ciphertext.split(':');
  if (parts.length !== 2) {
    throw new Error('Invalid Zero-Knowledge ciphertext format');
  }

  const [ivHex, encryptedHex] = parts;
  const iv = hexToBytes(ivHex);
  const encryptedBytes = hexToBytes(encryptedHex);

  const decryptedBuffer = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as any },
    key,
    encryptedBytes as any
  );

  const dec = new TextDecoder();
  return dec.decode(decryptedBuffer);
}

/**
 * Encrypts binary Blob/File data for zero-knowledge Google Drive or cloud upload.
 */
export async function encryptFileBlobZeroKnowledge(
  file: Blob,
  key: CryptoKey
): Promise<{ encryptedBlob: Blob; ivHex: string }> {
  const arrayBuffer = await file.arrayBuffer();
  const iv = window.crypto.getRandomValues(new Uint8Array(12));

  const encryptedBuffer = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    arrayBuffer
  );

  return {
    encryptedBlob: new Blob([encryptedBuffer], { type: 'application/octet-stream' }),
    ivHex: bytesToHex(iv),
  };
}

// Utility functions
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.replace(/[^0-9a-fA-F]/g, '');
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16);
  }
  return bytes;
}
