import './loadEnv';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { tenants } from '../src/db/schema';
import {
  type Drive,
  ensureFolderPath,
  escapeDriveQueryValue,
  getTenantDriveContext,
  moveDriveFile,
  withDriveRetry,
} from '../src/lib/googleDrive';
import { documentFolderPath } from '../src/lib/vault/vaultNaming';
import { auditOperatorDriveAccess } from '../src/lib/vault/operatorAudit';

/**
 * Moves every encrypted document file to the folder its OWN metadata says it
 * belongs in.
 *
 * `writeStore` re-parents a JSON store whose pointer folder has gone stale.
 * Document files have no equivalent and cannot easily have one: `documents`
 * records a `file_drive_id` and no folder, and reads go by that id, so a file
 * in the wrong tree still opens perfectly. Nothing surfaces the mistake. That
 * is how a company's PAN card sat in `Personal/Documents/biz_registration/`
 * for hours looking completely healthy.
 *
 * ── WHY appProperties AND NOT THE DATABASE ────────────────────────────────
 * Every page is stamped by `documentAppProperties` with `dnx_tenant`,
 * `dnx_company`, `dnx_mk` and `dnx_dk`. Three consequences, all of which the
 * `documents` table cannot give us:
 *
 *   · Multi-page records. Only page one is in `documents.file_drive_id`; the
 *     rest are referenced inside the ENCRYPTED store, so a DB-driven sweep
 *     would silently fix one page of a five-page record.
 *   · No decryption. The properties are plaintext metadata beside the
 *     ciphertext, so this needs no vault key and cannot corrupt anything.
 *   · They survive a rename. A filename does not identify a file after the
 *     owner has been rearranging their own Drive; `appProperties` do.
 *
 * The file therefore states where it belongs and the folder tree states where
 * it is. This reconciles the two, and the file's own stamp wins.
 *
 * ── TRASHED FILES ARE INCLUDED, DELIBERATELY ──────────────────────────────
 * `findFilesByAppProperty` filters `trashed=false`, which is right for an
 * orphan sweep and wrong here: a file stranded in a deleted DocsNX_Data root is
 * exactly what most needs rescuing, and `moveDriveFile` clears `trashed` as it
 * re-parents. So this walks the listing itself.
 *
 *   npx tsx scripts/refile_misplaced_documents.ts [--tenant <uuid>] [--apply]
 */

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const onlyTenant = args.includes('--tenant') ? args[args.indexOf('--tenant') + 1] : null;
const prefix = apply ? '' : '[dry-run] ';

interface TaggedFile {
  id: string;
  name: string;
  parents: string[];
  trashed: boolean;
  props: Record<string, string>;
}

/** Every file this app stamped for one tenant, trashed ones included. */
async function taggedFiles(drive: Drive, tenantId: string): Promise<TaggedFile[]> {
  const files: TaggedFile[] = [];
  let pageToken: string | undefined;

  do {
    const { data } = await withDriveRetry(() =>
      drive.files.list({
        q: `appProperties has { key='dnx_tenant' and value='${escapeDriveQueryValue(tenantId)}' }`,
        fields: 'nextPageToken, files(id, name, parents, trashed, appProperties)',
        spaces: 'drive',
        pageSize: 100,
        pageToken,
      })
    );
    for (const file of data.files ?? []) {
      if (!file.id) continue;
      files.push({
        id: file.id,
        name: file.name ?? '(unnamed)',
        parents: file.parents ?? [],
        trashed: Boolean(file.trashed),
        props: (file.appProperties ?? {}) as Record<string, string>,
      });
    }
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);

  return files;
}

/** Folder-name cache: one `files.get` per folder, not per file inside it. */
const folderNames = new Map<string, { name: string; parents: string[] } | null>();

async function folder(drive: Drive, id: string) {
  if (folderNames.has(id)) return folderNames.get(id)!;
  try {
    const { data } = await withDriveRetry(() =>
      drive.files.get({ fileId: id, fields: 'id, name, parents' })
    );
    const value = { name: data.name ?? '?', parents: data.parents ?? [] };
    folderNames.set(id, value);
    return value;
  } catch {
    folderNames.set(id, null);
    return null;
  }
}

/**
 * The folder names between the tenant's root and this file, root-exclusive.
 *
 * Returns null when the walk never reaches `rootId` — the file is under some
 * other tree (a trashed root, most likely), which counts as misplaced.
 */
async function segmentsBelowRoot(
  drive: Drive,
  parentId: string,
  rootId: string,
): Promise<string[] | null> {
  const segments: string[] = [];
  let current: string | null = parentId;

  for (let depth = 0; current && depth < 20; depth += 1) {
    if (current === rootId) return segments.reverse();
    const found: { name: string; parents: string[] } | null = await folder(drive, current);
    if (!found) return null;
    segments.push(found.name);
    current = found.parents[0] ?? null;
  }
  return null;
}

async function sweepTenant(tenant: any): Promise<{ checked: number; moved: number }> {
  const context = await getTenantDriveContext(tenant);
  if (!context) {
    console.log(`  SKIP  ${tenant.name} (${tenant.id}): no usable Drive credentials`);
    return { checked: 0, moved: 0 };
  }
  const { drive, folderId: root } = context;

  const files = await taggedFiles(drive, tenant.id);
  if (files.length === 0) return { checked: 0, moved: 0 };

  let moved = 0;

  for (const file of files) {
    const moduleKey = file.props.dnx_mk;
    const documentKey = file.props.dnx_dk;
    // No category stamp means this predates `documentAppProperties` — there is
    // nothing to compare against, so it is left alone rather than guessed at.
    if (!moduleKey || !documentKey) continue;

    // Absent means personal. `documentAppProperties` OMITS the key rather than
    // writing '', so `?? null` here reproduces the same decision the write made.
    const companyId = file.props.dnx_company ?? null;

    let expected: string[];
    try {
      expected = documentFolderPath({ moduleKey, documentKey }, { companyId });
    } catch (error) {
      // A malformed stamp (a non-UUID company, a category with a path separator)
      // must not be turned into a folder tree. Report and move on.
      console.log(`  BAD STAMP  ${file.id}: ${error instanceof Error ? error.message : error}`);
      continue;
    }

    const actual = file.parents[0]
      ? await segmentsBelowRoot(drive, file.parents[0], root)
      : null;

    const inPlace = actual !== null
      && actual.length === expected.length
      && actual.every((segment, i) => segment === expected[i])
      && !file.trashed;

    if (inPlace) continue;

    const where = actual ? actual.join('/') : '(outside this root)';
    const state = file.trashed ? ' [TRASHED]' : '';
    console.log(`  MOVE  ${expected.join('/')}${state}\n        was: ${where}`);

    if (apply) {
      const target = await ensureFolderPath(drive, root, expected);
      // `moveDriveFile` also clears `trashed`, which is what rescues a file
      // stranded in a deleted root.
      await moveDriveFile(drive, file.id, file.parents[0] ?? target, target);
    }
    moved += 1;
  }

  await auditOperatorDriveAccess({
    tenantId: tenant.id,
    scriptPath: process.argv[1],
    argv: args,
    inspected: files.length,
    changed: apply ? moved : 0,
  });

  return { checked: files.length, moved };
}

async function main() {
  const rows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      googleDriveTokens: tenants.googleDriveTokens,
      googleDriveFolderId: tenants.googleDriveFolderId,
    })
    .from(tenants)
    .where(
      onlyTenant
        ? eq(tenants.id, onlyTenant)
        : and(eq(tenants.googleDriveEnabled, true), isNotNull(tenants.googleDriveTokens))
    );

  console.log(`${prefix}sweeping ${rows.length} tenant(s) for misplaced document files\n`);

  let checked = 0;
  let moved = 0;

  for (const row of rows) {
    try {
      console.log(`${row.name ?? 'unnamed'} (${row.id})`);
      const result = await sweepTenant(row);
      checked += result.checked;
      moved += result.moved;
      if (result.checked === 0) {
        // Said out loud: silence here reads as "not checked" when it means
        // "this tenant has stored no document files yet".
        console.log('  ok — no stamped document files on Drive');
      } else if (result.moved === 0) {
        console.log(`  ok — ${result.checked} file(s), all correctly filed`);
      }
    } catch (error) {
      // One tenant's ambiguous root or dead grant must not stop the sweep.
      console.error(`  FAIL  ${error instanceof Error ? error.message : error}`);
    }
  }

  console.log(
    `\n${prefix}${checked} file(s) checked, ${moved} ${apply ? 'moved' : 'to move'}.`
  );
  if (!apply && moved > 0) console.log('Re-run with --apply to move them.');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
