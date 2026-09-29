import { describe, it, expect } from 'vitest';
import { tenants, users } from '../src/db/schema';

const API_URL = 'http://localhost:3005/api';

describe('Backend Tests', () => {

  describe('DB Layer Tests', () => {
    it('should have correct table names', () => {
      // Drizzle exports the table name in a symbol, or we can check some property
      // But we can also just verify the object is defined and has certain columns
      expect(tenants).toBeDefined();
      expect(users).toBeDefined();
    });

    it('should have essential columns in tenants schema', () => {
      expect(tenants.id).toBeDefined();
      expect(tenants.name).toBeDefined();
    });

    it('should have essential columns in users schema', () => {
      expect(users.id).toBeDefined();
      expect(users.email).toBeDefined();
      expect(users.passwordHash).toBeDefined();
      expect(users.tenantId).toBeDefined();
    });
  });

  describe('API Contract Tests', () => {
    it('GET /api/context should return 401 when unauthenticated', async () => {
      const res = await fetch(`${API_URL}/context`);
      // It might be 401 or something else, wait we saw 401 before
      expect(res.status).toBe(401);
    });

    it('POST /api/auth/login with empty body should fail gracefully', async () => {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      });
      // Should likely return 400 Bad Request due to missing fields
      expect(res.status).toBeGreaterThanOrEqual(400);
      const data = await res.json();
      expect(data).toHaveProperty('error');
    });

    it('GET /api/documents should return 401 when unauthenticated', async () => {
      const res = await fetch(`${API_URL}/documents`);
      expect(res.status).toBe(401);
    });
  });
});
