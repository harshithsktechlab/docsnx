import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as schema from '../src/db/schema';

/**
 * Database Schema Validation Tests
 * Verifies all Drizzle table exports, standard columns, tenant-scoping, and relations.
 */

// ─── Table Exports ───────────────────────────────────────────────────────────

/**
 * The 30 tables that remain after migration 0019 dropped the fifteen
 * per-module record tables. Their records are `documents` rows now — see
 * tests/moduleVocabulary.test.ts for the module set that replaced them.
 *
 * The thirtieth is `credit_transactions`, added by 0029 to give tenants a
 * history behind `tenants.ai_credits_balance`.
 */
const expectedTables = [
  'tenants',
  'users',
  'permissions',
  'profiles',
  'documentCategories',
  'documents',
  'passwords',
  'auditLogs',
  'apiKeys',
  'aiApiKeys',
  'systemConfigs',
  'tenantAiUsages',
  'creditTransactions',
  'emergencyContacts',
  'todos',
  'notifications',
  'trialUsedEmails',
  'subscriptionPlans',
  'addons',
  'tenantAddons',
  'payments',
  'invoices',
  'aiAnalysisCache',
  'discountCodes',
  'discountUsages',
  // Vault — two-tier field encryption.
  'tenantEncryptionKeys',
  'userVaultKeys',
  'documentCategoryFields',
  'documentCategoryFieldOverrides',
  'vaultJsonFiles',
] as const;

// Tables that MUST have tenantId for tenant isolation
const tenantScopedTables = [
  'documents',
  'passwords',
  'auditLogs',
  'tenantAiUsages',
  'creditTransactions',
  'emergencyContacts',
  'todos',
  'notifications',
  'tenantAddons',
  'payments',
  'invoices',
  'aiAnalysisCache',
  'discountUsages',
  // Vault. These hold wrapped key material and Drive pointers — a missing
  // tenantId here would let one tenant enumerate another's.
  'tenantEncryptionKeys',
  'userVaultKeys',
  'vaultJsonFiles',
] as const;

// Tables that DON'T have updatedAt (audit/log-style tables)
const tablesWithoutUpdatedAt = [
  'auditLogs',
  'tenantAiUsages',
  // Append-only ledger: a row that can be edited is not a ledger. A
  // correction is a new compensating row, never a mutation.
  'creditTransactions',
  'notifications',
  'trialUsedEmails',
  'discountUsages',
  // Key rows are immutable once written: rotation inserts a new version and
  // marks the old one retiring, rather than mutating key material in place.
  'tenantEncryptionKeys',
] as const;

// Expected relation exports
const expectedRelations = [
  'usersRelations',
  'documentsRelations',
  'documentCategoriesRelations',
  'permissionsRelations',
  'profilesRelations',
  'todosRelations',
  'passwordsRelations',
  'paymentsRelations',
  'invoicesRelations',
  'auditLogsRelations',
  'creditTransactionsRelations',
  'aiAnalysisCacheRelations',
  'addonsRelations',
  'tenantAddonsRelations',
  'discountUsagesRelations',
  'discountCodesRelations',
  'tenantEncryptionKeysRelations',
  'userVaultKeysRelations',
  'documentCategoryFieldsRelations',
  'documentCategoryFieldOverridesRelations',
  'vaultJsonFilesRelations',
] as const;

describe('Database Schema Validation', () => {

  // ─── 1. Table Exports ─────────────────────────────────────────────────────

  describe('Table Exports', () => {
    it.each(expectedTables)('should export the "%s" table', (tableName) => {
      const table = (schema as any)[tableName];
      expect(table).toBeDefined();
      // Drizzle tables have a Symbol for table name
      expect(typeof table).toBe('object');
    });

    it('should export the roleEnum', () => {
      expect(schema.roleEnum).toBeDefined();
    });
  });

  // ─── 2. Standard Columns (id, createdAt) ──────────────────────────────────

  describe('Standard Columns - id (UUID) + createdAt', () => {
    it.each(expectedTables)(
      '"%s" should have id and createdAt columns',
      (tableName) => {
        const table = (schema as any)[tableName];
        expect(table.id, `${tableName}.id is missing`).toBeDefined();
        expect(table.createdAt, `${tableName}.createdAt is missing`).toBeDefined();
      }
    );
  });

  describe('Standard Columns - updatedAt', () => {
    const tablesWithUpdatedAt = expectedTables.filter(
      (t) => !(tablesWithoutUpdatedAt as readonly string[]).includes(t)
    );

    it.each(tablesWithUpdatedAt)(
      '"%s" should have updatedAt column',
      (tableName) => {
        const table = (schema as any)[tableName];
        expect(table.updatedAt, `${tableName}.updatedAt is missing`).toBeDefined();
      }
    );
  });

  // ─── 3. Tenant-scoped tables must have tenantId ───────────────────────────

  describe('Tenant Isolation - tenantId column', () => {
    it.each(tenantScopedTables)(
      '"%s" should have a tenantId column for tenant isolation',
      (tableName) => {
        const table = (schema as any)[tableName];
        expect(table.tenantId, `${tableName}.tenantId is missing — tenant isolation violation!`).toBeDefined();
      }
    );
  });

  // ─── 4. Non-tenant tables should NOT have tenantId ────────────────────────

  describe('Non-tenant tables', () => {
    const nonTenantTables = [
      'permissions',
      'profiles',
      'apiKeys',
      'aiApiKeys',
      'systemConfigs',
      'trialUsedEmails',
      'subscriptionPlans',
      'addons',
      'discountCodes',
    ] as const;

    it.each(nonTenantTables)(
      '"%s" should NOT have a tenantId column (not tenant-scoped)',
      (tableName) => {
        const table = (schema as any)[tableName];
        expect(table.tenantId).toBeUndefined();
      }
    );
  });

  // ─── 5. Relation Exports ──────────────────────────────────────────────────

  describe('Relation Definitions', () => {
    it.each(expectedRelations)(
      'should export "%s" relation',
      (relationName) => {
        const relation = (schema as any)[relationName];
        expect(relation, `${relationName} is not exported`).toBeDefined();
      }
    );
  });

  // ─── 6. Specific Table Shape Checks ───────────────────────────────────────

  describe('Users table shape', () => {
    it('should have email, passwordHash, role, tenantId', () => {
      expect(schema.users.email).toBeDefined();
      expect(schema.users.passwordHash).toBeDefined();
      expect(schema.users.role).toBeDefined();
      expect(schema.users.tenantId).toBeDefined();
    });
  });

  describe('Tenants table shape', () => {
    it('should have name, subscriptionPlanId, aiCreditsBalance', () => {
      expect(schema.tenants.name).toBeDefined();
      expect(schema.tenants.subscriptionPlanId).toBeDefined();
      expect(schema.tenants.aiCreditsBalance).toBeDefined();
    });
  });

  describe('Documents table shape', () => {
    it('should have title, categoryId, filePath, mimeType', () => {
      expect(schema.documents.title).toBeDefined();
      expect(schema.documents.categoryId).toBeDefined();
      expect(schema.documents.filePath).toBeDefined();
      expect(schema.documents.mimeType).toBeDefined();
    });

    it('should have dropped the legacy `category` varchar', () => {
      // It mirrored the dotted documentCategories.code, which 0012 removed;
      // 0015 deleted LEGACY_CATEGORY_MAP and 0016 dropped the column. Every row
      // now resolves through category_id or the denormalised pair.
      expect((schema.documents as any).category).toBeUndefined();
    });

    it('should allow the file columns to be null, and count pages', () => {
      // `documents` holds every module's records now, and a bank account or an
      // investment has no file at all.
      expect(schema.documents.filePath.notNull).toBe(false);
      expect(schema.documents.fileName.notNull).toBe(false);
      expect(schema.documents.mimeType.notNull).toBe(false);
      // One uploaded file is one record; its PAGES are an array on Drive. This
      // is the only part of that surfaced in Postgres.
      expect(schema.documents.pageCount).toBeDefined();
      expect(schema.documents.pageCount.notNull).toBe(true);
      // fileSize stays NOT NULL — checkStorageLimit SUMs it, and a NULL would
      // poison the total.
      expect(schema.documents.fileSize.notNull).toBe(true);
    });

    it('should carry the denormalised category key as TWO columns', () => {
      // They name the Drive folder (Documents/<module_key>/<document_key>/) and
      // are bound into the file's AAD. A single joined column would be
      // ambiguous — see the registration_certificate collision.
      expect(schema.documents.categoryModuleKey).toBeDefined();
      expect(schema.documents.categoryDocumentKey).toBeDefined();
      expect((schema.documents as any).categoryCode).toBeUndefined();
    });
  });

  // ─── Global reference tables ──────────────────────────────────────────────

  describe('documentCategories (global reference table)', () => {
    it('should have NO tenantId — the 83 rows are identical for every tenant', () => {
      // Dropped in drizzle/0006_document_categories_drop_tenant.sql. Re-adding
      // it would resurrect per-tenant custom categories, which the resolver, the
      // backup restore and the bulk-scan dropdown all now assume cannot exist.
      expect((schema.documentCategories as any).tenantId).toBeUndefined();
    });

    it('should be keyed by (moduleKey, documentKey), not a dotted code', () => {
      // `code` was dropped in
      // drizzle/0012_document_categories_composite_key.sql — its first half
      // only duplicated module_key. Re-adding it would reintroduce the dotted
      // string in the Drive layout and the crypto AAD.
      expect(schema.documentCategories.moduleKey).toBeDefined();
      expect(schema.documentCategories.documentKey).toBeDefined();
      expect((schema.documentCategories as any).code).toBeUndefined();
    });

    it('should have moduleNo, the display names and the isSystem/isActive flags', () => {
      expect(schema.documentCategories.moduleNo).toBeDefined();
      expect(schema.documentCategories.moduleName).toBeDefined();
      expect(schema.documentCategories.documentName).toBeDefined();
      expect((schema.documentCategories as any).name).toBeUndefined();
      expect(schema.documentCategories.isSystem).toBeDefined();
      expect(schema.documentCategories.isActive).toBeDefined();
    });

    it('should NOT have deletedAt — retire a category with isActive instead', () => {
      expect((schema.documentCategories as any).deletedAt).toBeUndefined();
    });

    it('should carry NO group tier — 0022 added one and 0023 deleted it', () => {
      // The 14-module master document table IS what that tier was describing, so
      // keeping both would be two names for one idea: a group spanned modules,
      // its label differed per (module, group) pair, and two group keys collided
      // with real module keys.
      expect((schema.documentCategories as any).groupKey).toBeUndefined();
      expect((schema.documentCategories as any).groupNo).toBeUndefined();
      expect((schema.documentCategories as any).groupName).toBeUndefined();
    });

    it('should NOT let anything but the pair into the category identity', () => {
      // The unique key stays (moduleKey, documentKey). A third column in that
      // index would make the same documentKey insertable twice per module and
      // break the one-category-one-Drive-folder assumption the vault relies on.
      // Asserted against the declaration text because Drizzle's index config is
      // not re-readable once built.
      const src = readFileSync(join(__dirname, '..', 'src', 'db', 'schema.ts'), 'utf8');
      const decl = src.match(/uniqueIndex\("document_categories_key_idx"\)\.on\(([^)]*)\)/);
      expect(decl, 'document_categories_key_idx declaration not found').toBeTruthy();
      expect(decl![1].replace(/\s+/g, ' ').trim()).toBe('table.moduleKey, table.documentKey');
      expect(decl![1]).not.toMatch(/group/i);
    });
  });

  describe('Permissions table shape', () => {
    it('should carry the sub-category grain added by 0024', () => {
      // NULL = the module default; a string = an override for that one
      // sub-category. Nullable is the whole design: overrides are meant to be
      // rare, and a NOT NULL column would force one row per (user, category).
      expect(schema.permissions.documentKey).toBeDefined();
      expect(schema.permissions.documentKey.notNull).toBe(false);
    });

    it('should make uniqueness NULL-safe', () => {
      // In Postgres NULLs are distinct, so a plain three-column unique index
      // would let one user hold five conflicting module-default rows and
      // hasPermission would silently pick whichever came back first.
      const src = readFileSync(join(__dirname, '..', 'src', 'db', 'schema.ts'), 'utf8');
      const decl = src.match(/uniqueIndex\("permissions_user_module_doc_idx"\)[\s\S]{0,200}?\);/);
      expect(decl, 'permissions_user_module_doc_idx declaration not found').toBeTruthy();
      expect(decl![0]).toContain('table.userId');
      expect(decl![0]).toContain('table.module');
      expect(decl![0]).toContain('coalesce');
    });
  });

  describe('Passwords table shape', () => {
    it('should have title, passwordEncrypted, username', () => {
      expect(schema.passwords.title).toBeDefined();
      expect(schema.passwords.passwordEncrypted).toBeDefined();
      expect(schema.passwords.username).toBeDefined();
    });
  });

  describe('Payments table shape', () => {
    it('should have razorpay fields, amount, status', () => {
      expect(schema.payments.razorpayOrderId).toBeDefined();
      expect(schema.payments.razorpayPaymentId).toBeDefined();
      expect(schema.payments.amount).toBeDefined();
      expect(schema.payments.status).toBeDefined();
    });
  });

  describe('AuditLogs table shape', () => {
    it('should have action, details, ipAddress', () => {
      expect(schema.auditLogs.action).toBeDefined();
      expect(schema.auditLogs.details).toBeDefined();
      expect(schema.auditLogs.ipAddress).toBeDefined();
    });

    it('should have userAgent and entityType/entityId for filtering and record history', () => {
      expect(schema.auditLogs.userAgent).toBeDefined();
      expect(schema.auditLogs.entityType).toBeDefined();
      expect(schema.auditLogs.entityId).toBeDefined();
    });

    it('should NOT have updatedAt (log table)', () => {
      expect((schema.auditLogs as any).updatedAt).toBeUndefined();
    });

    it('should NOT have deletedAt — the trail is append-only', () => {
      expect((schema.auditLogs as any).deletedAt).toBeUndefined();
    });
  });

  describe('Credit transactions table shape', () => {
    it('should have the columns the ledger is read by', () => {
      expect(schema.creditTransactions.tenantId).toBeDefined();
      expect(schema.creditTransactions.userId).toBeDefined();
      expect(schema.creditTransactions.amount).toBeDefined();
      expect(schema.creditTransactions.balanceAfter).toBeDefined();
      expect(schema.creditTransactions.reason).toBeDefined();
      expect(schema.creditTransactions.description).toBeDefined();
    });

    it('should NOT have deletedAt or updatedAt — the ledger is append-only', () => {
      expect((schema.creditTransactions as any).deletedAt).toBeUndefined();
      expect((schema.creditTransactions as any).updatedAt).toBeUndefined();
    });

    it('should allow a null userId — webhook and cron movements have no user', () => {
      expect(schema.creditTransactions.userId.notNull).toBe(false);
      expect(schema.creditTransactions.tenantId.notNull).toBe(true);
    });
  });

  describe('New 6 Record Modules table shape', () => {
    it('no longer defines the fifteen per-module record tables', () => {
      // Dropped by migration 0019. Their records are `documents` rows,
      // distinguished by `category_module_key`.
      //
      // Asserted as ABSENT rather than simply deleted from the list above,
      // because re-adding one would be a silent regression: the row would live
      // in a table with no RLS policy and no vault, which is exactly the state
      // seven of these were in before they were removed.
      for (const gone of [
        'medicalRecords', 'bankInfos', 'creditCards', 'tradingDemats', 'vehicles',
        'licMediclaims', 'investments', 'warrantyAmcs', 'contractAgreements',
        'taxCompliances', 'willsEstates', 'loansDebts', 'utilityBills',
        'corporateCompliances', 'employmentPayrolls',
      ]) {
        expect((schema as Record<string, unknown>)[gone], `${gone} is back`).toBeUndefined();
      }
    });

    it('keeps `documents` as the one record table, with the category key on it', () => {
      expect(schema.documents.categoryModuleKey).toBeDefined();
      expect(schema.documents.categoryDocumentKey).toBeDefined();
      expect(schema.documents.categoryId).toBeDefined();
      expect(schema.documents.tenantId).toBeDefined();
    });
  });
});
