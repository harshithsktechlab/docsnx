import crypto from 'crypto';

const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET;
if (!ENCRYPTION_SECRET) {
  throw new Error('ENCRYPTION_SECRET environment variable is missing.');
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

// Derive a 32-byte key from the secret and a random salt
function getKey(salt: Buffer) {
  return crypto.scryptSync(ENCRYPTION_SECRET!, salt, KEY_LENGTH);
}

export function encrypt(text: string | null | undefined): string {
  if (!text) return '';
  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = getKey(salt);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const tag = cipher.getAuthTag().toString('hex');
    
    // Format: iv:salt:tag:encrypted
    return `${iv.toString('hex')}:${salt.toString('hex')}:${tag}:${encrypted}`;
  } catch (error) {
    console.error('Encryption failed:', error);
    throw new Error('Encryption failed');
  }
}

export function decrypt(ciphertext: string | null | undefined): string {
  if (!ciphertext) return '';
  try {
    const parts = ciphertext.split(':');
    
    // Old format (iv:tag:encrypted)
    if (parts.length === 3) {
      const [ivHex, tagHex, encryptedHex] = parts;
      const iv = Buffer.from(ivHex, 'hex');
      const tag = Buffer.from(tagHex, 'hex');
      const encrypted = Buffer.from(encryptedHex, 'hex');
      
      const key = crypto.scryptSync(ENCRYPTION_SECRET!, 'salt-family-os', KEY_LENGTH);
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    }
    
    // New format (iv:salt:tag:encrypted)
    if (parts.length === 4) {
      const [ivHex, saltHex, tagHex, encryptedHex] = parts;
      
      const iv = Buffer.from(ivHex, 'hex');
      const salt = Buffer.from(saltHex, 'hex');
      const tag = Buffer.from(tagHex, 'hex');
      const encrypted = Buffer.from(encryptedHex, 'hex');
      
      const key = getKey(salt);
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    }
    
    return ciphertext; // Return plain text if not encrypted or malformed
  } catch (error) {
    console.error('Decryption failed:', error);
    return '[Decryption Failed]';
  }
}
