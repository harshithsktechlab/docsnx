import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  tenants,
  users,
  profiles,
  documents,
  documentCategories,
  passwords,
  todos,
  emergencyContacts,
} from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { eq } from 'drizzle-orm';
import { and } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { readJsonStore } from '@/lib/vault/vaultRecords';
import { RECORD_SCOPE_KEYS } from '@/lib/records/registry';
import { DOCUMENT_CATEGORY_FIELD_SEED } from '@/lib/documentCategoryFields';
import { decryptField } from '@/lib/fieldCrypto';
import { visibleDocument } from '@/lib/records/documentVisibility';

export async function GET(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const gate = requireActivePlan(user);
    if (gate) return gate;

    if (user.role !== 'TENANT_ADMIN') {
      return NextResponse.json({ error: 'Only Tenant Admins can export data.' }, { status: 403 });
    }

    const tId = user.tenantId;

    // Fetch all tenant data
    const tenantData = await db.query.tenants.findFirst({ where: eq(tenants.id, tId) });
    const usersData = await db.query.users.findMany({ where: eq(users.tenantId, tId) });
    
    // For profiles, we need to get profiles of users in this tenant.
    const userIds = usersData.map(u => u.id);
    let profilesData: any[] = [];
    if (userIds.length > 0) {
       profilesData = await Promise.all(userIds.map(id => db.query.profiles.findFirst({ where: eq(profiles.userId, id) })));
       profilesData = profilesData.filter(Boolean);
    }

    // ── The record modules ────────────────────────────────────────────────
    // Every module's records are `documents` rows, grouped here by module so
    // the export keeps its per-module shape.
    //
    // DPDPA is an ACCESS request: the point is that the person can READ what is
    // held about them. So each record is rendered with its human field LABELS
    // and its values decrypted — a raw dump of snake_case taxonomy keys and
    // ciphertext would satisfy the letter of the export and none of its purpose.
    const records: Record<string, unknown[]> = {};
    for (const mod of RECORD_SCOPE_KEYS) records[mod] = [];

    const recordRows = await withTenant(tId, async (tx) =>
      tx.select({
        id: documents.id,
        title: documents.title,
        module: documents.categoryModuleKey,
        documentKey: documents.categoryDocumentKey,
        categoryName: documentCategories.documentName,
        fileName: documents.fileName,
        fileSize: documents.fileSize,
        pageCount: documents.pageCount,
        holderId: documents.holderId,
        userId: documents.userId,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
      })
        .from(documents)
        .leftJoin(documentCategories, eq(documentCategories.id, documents.categoryId))
        .where(and(eq(documents.tenantId, tId), visibleDocument())),
    );

    // One store read per (module, category) present, rather than per record.
    const byStore = new Map<string, { module: string; key: any; rows: any[] }>();
    for (const r of recordRows) {
      if (!r.module || !r.documentKey) continue;
      const k = `${r.module}/${r.documentKey}`;
      const e = byStore.get(k);
      if (e) e.rows.push(r);
      else byStore.set(k, {
        module: r.module,
        key: { moduleKey: r.module, documentKey: r.documentKey },
        rows: [r],
      });
    }

    const ctx = { tenant: (user as any).tenant, tenantId: tId, userId: user.id };
    for (const { module: mod, key, rows } of byStore.values()) {
      let stored: Record<string, any> = {};
      try {
        const { store } = await readJsonStore(ctx as any, mod as any, key);
        stored = store.records ?? {};
      } catch {
        // Unreadable store: the row's own metadata still goes in the export
        // rather than the record being omitted from an access request.
      }

      const labels = new Map(
        DOCUMENT_CATEGORY_FIELD_SEED
          .filter((f) => f.moduleKey === key.moduleKey && f.documentKey === key.documentKey)
          .map((f) => [f.fieldKey, f.fieldLabel]),
      );

      for (const row of rows) {
        const record = stored[row.id];
        const fields: Record<string, unknown> = {};

        // Open tier: readable as stored.
        for (const [k, v] of Object.entries(record?.open ?? {})) {
          fields[labels.get(k) ?? k] = v;
        }
        // Sealed tier: DECRYPTED. This is the data subject's own data, and an
        // access request that returns ciphertext discloses nothing.
        for (const [k, v] of Object.entries(record?.sealed ?? {})) {
          fields[labels.get(k) ?? k] = typeof v === 'string' ? decryptField(v) : v;
        }

        (records[mod] ??= []).push({
          id: row.id,
          title: record?.name ?? row.title,
          category: row.categoryName,
          fileName: record?.fileName ?? row.fileName,
          fileSize: row.fileSize,
          pageCount: row.pageCount,
          holderId: row.holderId,
          ownerId: row.userId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          fields,
        });
      }
    }

    // These three keep tables of their own — they are not record modules.
    const todosData = await db.query.todos.findMany({ where: eq(todos.tenantId, tId) });
    const emergencyData = await db.query.emergencyContacts.findMany({ where: eq(emergencyContacts.tenantId, tId) });
    const passwordsData = await db.query.passwords.findMany({ where: eq(passwords.tenantId, tId) });

    const exportBlob = {
      generatedAt: new Date().toISOString(),
      compliance: 'DPDPA 2023 Data Principal Access Request',
      tenant: tenantData,
      users: usersData,
      profiles: profilesData,
      records: {
        ...records,
        passwords: passwordsData,
        todos: todosData,
        emergencyContacts: emergencyData,
      },
    };

    return NextResponse.json(exportBlob);
  } catch (error) {
    console.error('Data Export Error:', error);
    return NextResponse.json({ error: 'Failed to export data' }, { status: 500 });
  }
}
