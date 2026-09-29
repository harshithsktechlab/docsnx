import { describe, it, expect, vi, beforeAll } from 'vitest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

/**
 * Auth Module Tests
 * 
 * We test the pure functions (hashPassword, comparePassword, signToken, verifyToken, hasPermission)
 * by importing bcryptjs and jsonwebtoken directly and replicating the auth module's logic.
 * This avoids importing from auth.ts which pulls in Next.js cookies() and the db module.
 */

const JWT_SECRET = process.env.JWT_SECRET || 'docsnx_jwt_secret_key_default';

// Replicate the pure functions from auth.ts for isolated testing
async function hashPassword(password: string): Promise<string> {
  return await bcrypt.hash(password, 10);
}

async function comparePassword(password: string, hash: string): Promise<boolean> {
  return await bcrypt.compare(password, hash);
}

function signToken(payload: object): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token: string): any {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

async function hasPermission(
  user: any,
  module: string,
  action: 'view' | 'add' | 'edit' | 'delete' | 'share' = 'view'
): Promise<boolean> {
  if (!user) return false;

  if (user.role === 'SUPER_ADMIN') {
    // Keep in lockstep with src/lib/auth.ts. 'audit_logs' is deliberately absent:
    // the audit trail is tenant-owned and the platform role must not read it.
    const adminModules = ['tenants', 'ai-keys', 'dashboard'];
    return adminModules.includes(module);
  }

  if (user.role === 'TENANT_ADMIN') return true;

  if (!user.permissions || !Array.isArray(user.permissions)) return false;

  const perm = user.permissions.find((p: any) => p.module === module);
  if (!perm) return false;

  if (action === 'view') return perm.canView;
  if (action === 'add') return perm.canAdd;
  if (action === 'edit') return perm.canEdit;
  if (action === 'delete') return perm.canDelete;
  if (action === 'share') return perm.canShare;

  return false;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Auth Module', () => {

  // ─── hashPassword ──────────────────────────────────────────────────────

  describe('hashPassword', () => {
    it('should return a bcrypt hash string', async () => {
      const hash = await hashPassword('TestPassword123');
      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      // bcrypt hashes start with $2a$ or $2b$
      expect(hash).toMatch(/^\$2[ab]\$/);
    });

    it('should produce different hashes for the same password (salted)', async () => {
      const hash1 = await hashPassword('SamePassword');
      const hash2 = await hashPassword('SamePassword');
      expect(hash1).not.toBe(hash2);
    });

    it('should produce a hash of expected length (~60 chars)', async () => {
      const hash = await hashPassword('password');
      expect(hash.length).toBe(60);
    });
  });

  // ─── comparePassword ──────────────────────────────────────────────────

  describe('comparePassword', () => {
    let storedHash: string;

    beforeAll(async () => {
      storedHash = await hashPassword('CorrectPassword');
    });

    it('should return true for correct password', async () => {
      const result = await comparePassword('CorrectPassword', storedHash);
      expect(result).toBe(true);
    });

    it('should return false for incorrect password', async () => {
      const result = await comparePassword('WrongPassword', storedHash);
      expect(result).toBe(false);
    });

    it('should return false for empty password', async () => {
      const result = await comparePassword('', storedHash);
      expect(result).toBe(false);
    });
  });

  // ─── signToken ────────────────────────────────────────────────────────

  describe('signToken', () => {
    it('should return a valid JWT string (3 parts separated by dots)', () => {
      const token = signToken({ userId: 'abc-123', tenantId: 'tenant-456' });
      expect(typeof token).toBe('string');
      const parts = token.split('.');
      expect(parts).toHaveLength(3);
    });

    it('should encode the payload correctly', () => {
      const payload = { userId: 'user-id-1', role: 'TENANT_ADMIN' };
      const token = signToken(payload);
      const decoded = jwt.decode(token) as any;
      expect(decoded.userId).toBe('user-id-1');
      expect(decoded.role).toBe('TENANT_ADMIN');
    });

    it('should include iat and exp claims', () => {
      const token = signToken({ userId: 'abc' });
      const decoded = jwt.decode(token) as any;
      expect(decoded.iat).toBeDefined();
      expect(decoded.exp).toBeDefined();
      // exp should be ~7 days from iat
      expect(decoded.exp - decoded.iat).toBe(7 * 24 * 60 * 60);
    });
  });

  // ─── verifyToken ──────────────────────────────────────────────────────

  describe('verifyToken', () => {
    it('should decode a valid token', () => {
      const token = signToken({ userId: 'decode-me' });
      const decoded = verifyToken(token);
      expect(decoded).not.toBeNull();
      expect(decoded.userId).toBe('decode-me');
    });

    it('should return null for invalid token', () => {
      const result = verifyToken('not.a.valid.token');
      expect(result).toBeNull();
    });

    it('should return null for empty string', () => {
      const result = verifyToken('');
      expect(result).toBeNull();
    });

    it('should return null for expired token', () => {
      // Create a token that expired 1 second ago
      const expiredToken = jwt.sign(
        { userId: 'expired-user' },
        JWT_SECRET,
        { expiresIn: '-1s' }
      );
      const result = verifyToken(expiredToken);
      expect(result).toBeNull();
    });

    it('should return null for token signed with wrong secret', () => {
      const wrongToken = jwt.sign({ userId: 'wrong-secret' }, 'wrong_secret_key', { expiresIn: '1h' });
      const result = verifyToken(wrongToken);
      expect(result).toBeNull();
    });
  });

  // ─── hasPermission ────────────────────────────────────────────────────

  describe('hasPermission', () => {
    const superAdmin = { role: 'SUPER_ADMIN', permissions: [] };
    const tenantAdmin = { role: 'TENANT_ADMIN', permissions: [] };
    const standardUser = {
      role: 'STANDARD',
      permissions: [
        { module: 'documents', canView: true, canAdd: true, canEdit: false, canDelete: false, canShare: true },
        { module: 'passwords', canView: true, canAdd: false, canEdit: false, canDelete: false, canShare: false },
      ],
    };
    const userNoPerms = { role: 'STANDARD', permissions: [] };

    // SUPER_ADMIN
    it('SUPER_ADMIN should access admin modules (tenants)', async () => {
      expect(await hasPermission(superAdmin, 'tenants')).toBe(true);
    });

    it('SUPER_ADMIN should access admin modules (ai-keys)', async () => {
      expect(await hasPermission(superAdmin, 'ai-keys')).toBe(true);
    });

    it('SUPER_ADMIN should NOT access tenant audit logs', async () => {
      // Audit logs are tenant-owned data; the platform role is not an auditor of
      // its customers. /api/audit-logs also hard-gates on role === TENANT_ADMIN.
      expect(await hasPermission(superAdmin, 'audit_logs')).toBe(false);
    });

    it('TENANT_ADMIN should access audit logs', async () => {
      expect(await hasPermission(tenantAdmin, 'audit_logs')).toBe(true);
    });

    it('SUPER_ADMIN should access admin modules (dashboard)', async () => {
      expect(await hasPermission(superAdmin, 'dashboard')).toBe(true);
    });

    it('SUPER_ADMIN should NOT access non-admin modules', async () => {
      expect(await hasPermission(superAdmin, 'documents')).toBe(false);
      expect(await hasPermission(superAdmin, 'passwords')).toBe(false);
      expect(await hasPermission(superAdmin, 'medical')).toBe(false);
    });

    // TENANT_ADMIN
    it('TENANT_ADMIN should always return true', async () => {
      expect(await hasPermission(tenantAdmin, 'documents')).toBe(true);
      expect(await hasPermission(tenantAdmin, 'passwords')).toBe(true);
      expect(await hasPermission(tenantAdmin, 'any-module')).toBe(true);
    });

    it('TENANT_ADMIN should return true for any action', async () => {
      expect(await hasPermission(tenantAdmin, 'documents', 'add')).toBe(true);
      expect(await hasPermission(tenantAdmin, 'documents', 'delete')).toBe(true);
      expect(await hasPermission(tenantAdmin, 'documents', 'share')).toBe(true);
    });

    // STANDARD user with permissions
    it('STANDARD user should have view access to documents', async () => {
      expect(await hasPermission(standardUser, 'documents', 'view')).toBe(true);
    });

    it('STANDARD user should have add access to documents', async () => {
      expect(await hasPermission(standardUser, 'documents', 'add')).toBe(true);
    });

    it('STANDARD user should NOT have edit access to documents', async () => {
      expect(await hasPermission(standardUser, 'documents', 'edit')).toBe(false);
    });

    it('STANDARD user should NOT have delete access to documents', async () => {
      expect(await hasPermission(standardUser, 'documents', 'delete')).toBe(false);
    });

    it('STANDARD user should have share access to documents', async () => {
      expect(await hasPermission(standardUser, 'documents', 'share')).toBe(true);
    });

    it('STANDARD user should have view access to passwords', async () => {
      expect(await hasPermission(standardUser, 'passwords', 'view')).toBe(true);
    });

    it('STANDARD user should NOT have add access to passwords', async () => {
      expect(await hasPermission(standardUser, 'passwords', 'add')).toBe(false);
    });

    // STANDARD user - module not in permissions
    it('STANDARD user should NOT access modules not in permissions', async () => {
      expect(await hasPermission(standardUser, 'medical')).toBe(false);
    });

    // Edge cases
    it('should return false for null user', async () => {
      expect(await hasPermission(null, 'documents')).toBe(false);
    });

    it('should return false for undefined user', async () => {
      expect(await hasPermission(undefined, 'documents')).toBe(false);
    });

    it('should return false for user with no permissions array', async () => {
      expect(await hasPermission({ role: 'STANDARD' }, 'documents')).toBe(false);
    });

    it('should return false for STANDARD user with empty permissions', async () => {
      expect(await hasPermission(userNoPerms, 'documents')).toBe(false);
    });
  });
});
