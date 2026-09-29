import './loadEnv';
import { eq } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { tenants } from '../src/db/schema';
import {
  type Drive,
  DRIVE_FOLDER_NAME,
  FOLDER_MIME_TYPE,
  escapeDriveQueryValue,
  getTenantDriveClient,
  withDriveRetry,
} from '../src/lib/googleDrive';
import { auditOperatorDriveAccess } from '../src/lib/vault/operatorAudit';

/**
 * READ-ONLY: where do a tenant's records PHYSICALLY live on Drive, versus where
 * the database says they do?
 *
 * A company PAN uploaded from `/business/<companyId>/documents` was found at
 * `Personal/Documents/biz_registration/pan_card`, with no `Business/` folder in
 * the tenant's Drive at all. Reading the code does not explain that: `companyId`
 * is threaded from `resolveUtilityCompany` through `createRecord` to
 * `storeRecordInVault` without being dropped, and a NULL one would have been
 * refused by `documentManagerContext` before anything was written. So one of the
 * assumptions is wrong, and this prints the facts rather than guessing which.
 *
 * Three questions, in order:
 *
 *   1. Does each row's `company_id` agree with the folder its bytes are in?
 *      Answered by walking `parents` from the stored file id up to My Drive —
 *      the only authority on where a file actually is. A path is never derived
 *      from the DB here; that is the thing under suspicion.
 *   2. Is there more than one folder named `DocsNX_Data`? `ensureDriveFolder`
 *      searches by name with no parent constraint and `pageSize: 1`, so under
 *      `drive.file` scope it can bind to a different root than the one being
 *      looked at — which would explain a "missing" Business folder that exists
 *      perfectly well somewhere else.
 *   3. Was the row written before or after the Personal/Business deploy?
 *      A pre-deploy row in the personal tree is expected debris, not a bug.
 *
 * ── IT MUST NOT CREATE ANYTHING ────────────────────────────────────────────
 * No `ensureFolderPath`, no `ensureSubfolder`, no `ensureDriveFolder`: each ends
 * in `files.create`, and a diagnostic that conjures the folder it was sent to
 * look for reports success at exactly the wrong moment. Only `files.get` and
 * `files.list` appear below.
 *
 *   npx tsx scripts/diagnose_company_drive_placement.ts --tenant <uuid> [--deployed-at <iso>]
 */

const args = process.argv.slice(2);
const tenantArg = args.includes('--tenant') ? args[args.indexOf('--tenant') + 1] : null;
const deployedAt = args.includes('--deployed-at')
  ? new Date(args[args.indexOf('--deployed-at') + 1])
  : null;

if (!tenantArg) {
  console.error('usage: npx tsx scripts/diagnose_company_drive_placement.ts --tenant <uuid>');
  process.exit(1);
}

/** Cache: the parent walk revisits the same folders for every file. */
const nodes = new Map<string, { name: string; parents: string[]; trashed: boolean } | null>();

async function node(drive: Drive, fileId: string) {
  if (nodes.has(fileId)) return nodes.get(fileId)!;
  try {
    const { data } = await withDriveRetry(() =>
      drive.files.get({ fileId, fields: 'id, name, parents, trashed, mimeType' })
    );
    const value = {
      name: data.name ?? '(unnamed)',
      parents: data.parents ?? [],
      trashed: Boolean(data.trashed),
    };
    nodes.set(fileId, value);
    return value;
  } catch {
    nodes.set(fileId, null);
    return null;
  }
}

/**
 * The real path of a Drive object, walked upward from the object itself.
 *
 * Stops at the first parentless node (My Drive) and guards on a depth ceiling:
 * a cycle is impossible in Drive's model but a malformed response should not
 * hang a diagnostic someone is running during an incident.
 */
async function physicalPath(drive: Drive, fileId: string): Promise<string> {
  const segments: string[] = [];
  let current: string | null = fileId;

  for (let depth = 0; current && depth < 20; depth += 1) {
    const found: { name: string; parents: string[]; trashed: boolean } | null =
      await node(drive, current);
    if (!found) return segments.length ? `?/${segments.reverse().join('/')}` : '(not found)';
    segments.push(found.trashed ? `${found.name} [TRASHED]` : found.name);
    current = found.parents[0] ?? null;
  }

  return segments.reverse().join('/');
}

function ageLabel(at: Date | null | undefined): string {
  if (!at) return '';
  if (!deployedAt) return ` (${at.toISOString()})`;
  return at < deployedAt
    ? ` (${at.toISOString()} — BEFORE deploy)`
    : ` (${at.toISOString()} — after deploy)`;
}

async function main() {
  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, tenantArg!),
    columns: {
      id: true, name: true, accountType: true,
      googleDriveFolderId: true, googleDriveTokens: true,
    },
  });

  if (!tenant) {
    console.error(`no tenant ${tenantArg}`);
    process.exit(1);
  }

  console.log(`tenant ${tenant.name} (${tenant.id}) — account_type=${tenant.accountType}`);
  console.log(`cached root folder id: ${tenant.googleDriveFolderId ?? '(none)'}\n`);

  const client = getTenantDriveClient(tenant.id, tenant.googleDriveTokens);
  if (!client) {
    console.error('no usable Drive credentials for this tenant.');
    process.exit(1);
  }
  const { drive } = client;

  // ── 1. How many roots? ────────────────────────────────────────────────────
  // The unconstrained search `ensureDriveFolder` itself performs. If this
  // returns more than one, reads and writes can bind to different trees and
  // every other section below is being read in the wrong context.
  //
  // TRASHED ONES INCLUDED, deliberately. `ensureDriveFolder` skips a trashed
  // cached folder and creates a fresh root — correct in itself, but the rows
  // already in the database still point INTO the trashed tree, and nothing
  // reconciles them. The tenant's vault is then split across two roots with no
  // error anywhere. A search that filtered `trashed=false` would show one root
  // and call that healthy.
  const { data: roots } = await withDriveRetry(() =>
    drive.files.list({
      q: `mimeType='${FOLDER_MIME_TYPE}' `
        + `and name='${escapeDriveQueryValue(DRIVE_FOLDER_NAME)}'`,
      fields: 'files(id, name, parents, trashed)',
      spaces: 'drive',
      pageSize: 10,
    })
  );
  const rootList = roots.files ?? [];
  const live = rootList.filter((r) => !r.trashed);
  console.log(`── folders named ${DRIVE_FOLDER_NAME}: ${rootList.length} (${live.length} live) ──`);
  for (const root of rootList) {
    const cached = root.id === tenant.googleDriveFolderId ? '  <-- the cached one' : '';
    const state = root.trashed ? ' [TRASHED]' : '';
    console.log(`  ${root.id}${state}  at ${await physicalPath(drive, root.id!)}${cached}`);
    // What each root holds, so a split vault is visible at a glance.
    const { data: kids } = await withDriveRetry(() =>
      drive.files.list({
        q: `'${root.id}' in parents`,
        fields: 'files(name, mimeType, trashed)',
        spaces: 'drive',
        pageSize: 50,
      })
    );
    for (const kid of kids.files ?? []) {
      console.log(`      ${kid.mimeType === FOLDER_MIME_TYPE ? 'dir ' : 'file'} ${kid.name}${kid.trashed ? ' [TRASHED]' : ''}`);
    }
  }
  // Only a second LIVE root is a problem. Trashed leftovers are the debris of
  // past deletions: once no pointer references them (see the verdict below)
  // they are inert, and Drive purges them after thirty days.
  if (live.length > 1) {
    console.log('  !! MORE THAN ONE LIVE ROOT — the vault is split; rows point into both.');
  } else if (rootList.length > 1) {
    console.log(`  (${rootList.length - 1} trashed leftover root(s); harmless once nothing points at them)`);
  }

  // ── 2. What is directly under the cached root? ────────────────────────────
  if (tenant.googleDriveFolderId) {
    const { data } = await withDriveRetry(() =>
      drive.files.list({
        q: `'${tenant.googleDriveFolderId}' in parents and trashed=false`,
        fields: 'files(id, name, mimeType)',
        spaces: 'drive',
        pageSize: 100,
      })
    );
    console.log('\n── children of the cached root ──');
    for (const child of data.files ?? []) {
      const kind = child.mimeType === FOLDER_MIME_TYPE ? 'dir ' : 'file';
      console.log(`  ${kind} ${child.name}`);
    }
    if (!(data.files ?? []).length) console.log('  (empty)');
  }

  // ── 3. Every business-ish row, and where its bytes really are ─────────────
  // Raw SQL rather than the Drizzle query builder: this reads columns across
  // two tables with no relation defined between them, and the point is to see
  // exactly what is stored, unfiltered by any application-level scoping.
  const docs = await db.execute<any>(`
    SELECT id, company_id, account_scope, category_module_key, category_document_key,
           file_drive_id, json_drive_id, created_at, updated_at, title
      FROM documents
     WHERE tenant_id = '${tenant.id}'
       AND deleted_at IS NULL
       AND (company_id IS NOT NULL OR category_module_key LIKE 'biz\\_%')
     ORDER BY created_at
  ` as any);

  const docRows: any[] = (docs as any).rows ?? docs;
  console.log(`\n── documents with a company, or a biz_* category: ${docRows.length} ──`);
  for (const row of docRows) {
    console.log(`\n  "${row.title}"  ${row.category_module_key}/${row.category_document_key}`);
    console.log(`    company_id   : ${row.company_id ?? 'NULL'}   account_scope=${row.account_scope}`);
    console.log(`    created      :${ageLabel(row.created_at && new Date(row.created_at))}`);
    if (row.file_drive_id) {
      console.log(`    file lives at: ${await physicalPath(drive, row.file_drive_id)}`);
    } else {
      console.log('    file lives at: (no file_drive_id)');
    }
    if (row.json_drive_id) {
      console.log(`    json lives at: ${await physicalPath(drive, row.json_drive_id)}`);
    }
  }

  const pointers = await db.execute<any>(`
    SELECT company_id, module, category_module_key, category_document_key,
           drive_file_id, drive_folder_id, revision, created_at, updated_at
      FROM vault_json_files
     WHERE tenant_id = '${tenant.id}'
       AND (company_id IS NOT NULL OR module LIKE 'biz\\_%')
     ORDER BY module, created_at
  ` as any);

  const pointerRows: any[] = (pointers as any).rows ?? pointers;
  console.log(`\n── vault_json_files pointers with a company, or a biz_* module: ${pointerRows.length} ──`);
  for (const row of pointerRows) {
    console.log(`\n  ${row.module}  ${row.category_module_key}/${row.category_document_key}`);
    console.log(`    company_id   : ${row.company_id ?? 'NULL'}   revision=${row.revision}`);
    console.log(`    updated      :${ageLabel(row.updated_at && new Date(row.updated_at))}`);
    console.log(`    store lives at: ${await physicalPath(drive, row.drive_file_id)}`);
    console.log(`    folder_id says: ${await physicalPath(drive, row.drive_folder_id)}`);
  }

  // ── 4. The verdict, stated rather than left to be inferred ────────────────
  console.log('\n── verdict ──');
  const misfiled = [
    ...docRows.filter((r) => r.company_id).map((r) => ({ what: `document "${r.title}"`, id: r.file_drive_id })),
    ...pointerRows.filter((r) => r.company_id).map((r) => ({ what: `store ${r.module}`, id: r.drive_file_id })),
  ].filter((r) => r.id);

  let wrong = 0;
  for (const item of misfiled) {
    const path = await physicalPath(drive, item.id);
    if (!path.includes('/Business/') && !path.includes('/business/')) {
      console.log(`  MISFILED: ${item.what} has a company but sits at ${path}`);
      wrong += 1;
    }
  }
  if (wrong === 0 && misfiled.length > 0) {
    console.log('  every company-scoped object is under a Business folder.');
  }
  if (misfiled.length === 0) {
    console.log('  no company-scoped Drive objects exist for this tenant at all.');
  }
  if (live.length > 1) {
    console.log('  and there is MORE THAN ONE LIVE DocsNX_Data root — resolve that first.');
  }

  // Reading a tenant's folder tree is an act worth recording, even read-only.
  await auditOperatorDriveAccess({
    tenantId: tenant.id,
    scriptPath: process.argv[1],
    argv: args,
    inspected: nodes.size,
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
