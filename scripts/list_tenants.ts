import './loadEnv';
import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { db, withTenant } from '../src/lib/db';
import {
  auditLogs,
  companies,
  documents,
  passwords,
  tenants,
  users,
  vaultJsonFiles,
} from '../src/db/schema';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   READ-ONLY: every workspace on this database, and what it holds         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 *   npx tsx scripts/list_tenants.ts
 *
 * Written to answer the only question that must be settled before
 * `scripts/delete_tenant.ts` is pointed at anything: WHICH workspace. An
 * erasure is irreversible and cascades through every tenant-scoped table, so
 * the id has to be read off a row someone recognised — never inferred from a
 * name typed into a chat.
 *
 * ── WHAT IT PRINTS, AND WHAT IT REFUSES TO ─────────────────────────────────
 * Enough to identify a workspace — its name, its admin's address, when it was
 * created, how much is in it — and nothing else. No record bodies, no
 * filenames, no sealed fields, no `password_hash`, no Drive tokens. A listing
 * is not a place to copy a vault into a terminal scrollback.
 *
 * ── WHY THE COUNTS GO THROUGH `withTenant` ─────────────────────────────────
 * `documents`, `passwords`, `audit_logs` and friends carry FORCE ROW LEVEL
 * SECURITY. A bare `db.select()` without `app.tenant_id` set returns ZERO rows
 * — not an error, zero rows — so a listing built that way would report every
 * workspace as empty and make an erasure look harmless. `withTenant` sets the
 * session var; the explicit `eq(table.tenantId, …)` predicate is there because
 * AGENTS.md §6 requires both and because it keeps the query honest if this ever
 * runs as a role that bypasses RLS (it currently does — DATABASE_URL is
 * `postgres`).
 *
 * Counts are of LIVE rows: `deleted_at IS NULL`. A soft-deleted document is
 * still a row the cascade will erase, so the summary line reports the raw total
 * too where the two differ.
 *
 * Writes nothing. Safe to run against production, which is what it is for.
 */

interface TenantCounts {
  members: number;
  documentsLive: number;
  documentsTotal: number;
  passwordsLive: number;
  passwordsTotal: number;
  vaultStores: number;
  companies: number;
  auditLogs: number;
}

async function countsFor(tenantId: string): Promise<TenantCounts> {
  return withTenant(tenantId, async (tx) => {
    const one = async (rows: Promise<{ value: number }[]>) => (await rows)[0]?.value ?? 0;

    return {
      members: await one(
        tx.select({ value: count() }).from(users).where(eq(users.tenantId, tenantId)),
      ),
      documentsLive: await one(
        tx.select({ value: count() }).from(documents)
          .where(and(eq(documents.tenantId, tenantId), isNull(documents.deletedAt))),
      ),
      documentsTotal: await one(
        tx.select({ value: count() }).from(documents).where(eq(documents.tenantId, tenantId)),
      ),
      passwordsLive: await one(
        tx.select({ value: count() }).from(passwords)
          .where(and(eq(passwords.tenantId, tenantId), isNull(passwords.deletedAt))),
      ),
      passwordsTotal: await one(
        tx.select({ value: count() }).from(passwords).where(eq(passwords.tenantId, tenantId)),
      ),
      vaultStores: await one(
        tx.select({ value: count() }).from(vaultJsonFiles)
          .where(eq(vaultJsonFiles.tenantId, tenantId)),
      ),
      companies: await one(
        tx.select({ value: count() }).from(companies).where(eq(companies.tenantId, tenantId)),
      ),
      auditLogs: await one(
        tx.select({ value: count() }).from(auditLogs).where(eq(auditLogs.tenantId, tenantId)),
      ),
    };
  });
}

/**
 * The address a human would recognise the workspace by. The TENANT_ADMIN's
 * sign-in address first — `email` is nullable since 0040, so fall through to
 * the billing contact and finally to the phone number, which every member has.
 */
async function identityFor(tenantId: string) {
  return withTenant(tenantId, async (tx) => {
    const admins = await tx
      .select({
        name: users.name,
        email: users.email,
        phoneNumber: users.phoneNumber,
        role: users.role,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.tenantId, tenantId))
      .orderBy(asc(users.createdAt));

    const admin =
      admins.find((u) => u.role === 'TENANT_ADMIN') ??
      admins.find((u) => u.role === 'SUPER_ADMIN') ??
      admins[0];

    return {
      admin,
      hasSuperAdmin: admins.some((u) => u.role === 'SUPER_ADMIN'),
    };
  });
}

function stamp(value: Date | null | undefined): string {
  return value ? new Date(value).toISOString().slice(0, 16).replace('T', ' ') : '—';
}

async function main() {
  const rows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      accountType: tenants.accountType,
      isActive: tenants.isActive,
      deletedAt: tenants.deletedAt,
      createdAt: tenants.createdAt,
      billingEmail: tenants.billingEmail,
      contactName: tenants.contactName,
      googleDriveEnabled: tenants.googleDriveEnabled,
      googleDriveFolderId: tenants.googleDriveFolderId,
      googleAccountEmail: tenants.googleAccountEmail,
      // Never the tokens themselves — only whether a live grant exists, since
      // that decides whether the erasure has Drive work to do.
      hasDriveGrant: sql<boolean>`(${tenants.googleDriveTokens} is not null)`,
    })
    .from(tenants)
    .orderBy(asc(tenants.createdAt));

  console.log(`\n${rows.length} workspace(s) on this database\n${'═'.repeat(72)}`);

  for (const t of rows) {
    const c = await countsFor(t.id);
    const { admin, hasSuperAdmin } = await identityFor(t.id);

    const flags = [
      t.isActive ? null : 'INACTIVE',
      t.deletedAt ? `SOFT-DELETED ${stamp(t.deletedAt)}` : null,
      hasSuperAdmin ? '⚠ HOLDS A SUPER_ADMIN — platform workspace' : null,
    ].filter(Boolean);

    console.log(`\n${t.name}`);
    console.log(`  id            ${t.id}`);
    console.log(`  account       ${t.accountType}   created ${stamp(t.createdAt)}`);
    console.log(
      `  admin         ${admin?.email ?? t.billingEmail ?? '(no address)'}` +
        `   ${admin?.name ?? t.contactName ?? ''}` +
        `${admin?.phoneNumber ? `   ${admin.phoneNumber}` : ''}`,
    );
    console.log(
      `  holds         ${c.members} member(s), ` +
        `${c.documentsLive} document(s)${c.documentsTotal !== c.documentsLive ? ` (+${c.documentsTotal - c.documentsLive} deleted)` : ''}, ` +
        `${c.passwordsLive} password(s)${c.passwordsTotal !== c.passwordsLive ? ` (+${c.passwordsTotal - c.passwordsLive} deleted)` : ''}, ` +
        `${c.companies} compan${c.companies === 1 ? 'y' : 'ies'}, ` +
        `${c.vaultStores} vault store(s), ${c.auditLogs} audit row(s)`,
    );
    console.log(
      `  drive         ${
        t.hasDriveGrant
          ? `linked${t.googleAccountEmail ? ` as ${t.googleAccountEmail}` : ''}` +
            `${t.googleDriveFolderId ? ', /DocsNX_Data present' : ', no folder recorded'}`
          : t.googleDriveEnabled
            ? 'enabled but NOT granted'
            : 'not linked'
      }`,
    );
    if (flags.length) console.log(`  flags         ${flags.join('  ·  ')}`);
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log('Pick the id above, then dry-run the erasure:');
  console.log('  npx tsx scripts/delete_tenant.ts --tenant <uuid>\n');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
