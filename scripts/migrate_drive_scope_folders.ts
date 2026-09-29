import './loadEnv';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { tenants } from '../src/db/schema';
import {
  type Drive,
  DRIVE_FOLDER_NAME,
  FOLDER_MIME_TYPE,
  escapeDriveQueryValue,
  ensureSubfolder,
  getTenantDriveClient,
  moveDriveFile,
  withDriveRetry,
} from '../src/lib/googleDrive';
import {
  FOLDER_BUSINESS,
  FOLDER_DOCUMENTS,
  FOLDER_JSON,
  FOLDER_PERSONAL,
} from '../src/lib/vault/vaultNaming';

/**
 * Moves each tenant's Drive vault into the account-scoped layout.
 *
 *   BEFORE                          AFTER
 *   /DocsNX_Data/                   /DocsNX_Data/
 *   ├── Documents/…                 ├── Personal/
 *   ├── JSON/…                      │   ├── Documents/…
 *   ├── business/<companyId>/…      │   └── JSON/…
 *   └── <module>.enc.json           ├── Business/<companyId>/…
 *                                   └── <module>.enc.json   (left alone)
 *
 * ── WHY THIS TOUCHES NO DATABASE ROW ──────────────────────────────────────
 * The DB stores LEAF folder ids — `vault_json_files.drive_folder_id` points at
 * `JSON/Identity`, and `documents` stores a file id with no folder at all. This
 * script re-parents the TOP-LEVEL `Documents` and `JSON` folders, so every leaf
 * keeps its id and only its ancestry changes. `business` → `Business` is a
 * rename in place, which also preserves the id. Nothing stored goes stale, so
 * there is nothing to update and no window where the DB and Drive disagree.
 *
 * Renaming rather than creating-and-moving matters for the same reason: making
 * a new `Business` folder and moving each company into it would work too, but
 * it would orphan any id cached against the old folder.
 *
 * The bytes are never read. Path is not part of the AES-GCM associated data
 * (see `fileAad`/`storeAad`), so a move needs no re-encryption.
 *
 * ── RUN IT WITH THE SERVICE STOPPED ───────────────────────────────────────
 * A write landing between the move and the new code starting would build a
 * second tree at the old path. `writeStore` self-heals a store whose pointer
 * folder went stale, but that is the safety net, not the plan:
 *
 *   sudo systemctl stop docsnx
 *   npm run build
 *   npx tsx scripts/migrate_drive_scope_folders.ts --dry-run
 *   npx tsx scripts/migrate_drive_scope_folders.ts
 *   sudo systemctl start docsnx
 *
 * Idempotent: a second run finds everything in place and moves nothing.
 *
 * `--reverse` undoes it, which a rollback to the pre-business build REQUIRES —
 * see `toRootLayout`.
 *
 *   npx tsx scripts/migrate_drive_scope_folders.ts [--dry-run] [--reverse] [--tenant <uuid>]
 */

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const reverse = args.includes('--reverse');
const onlyTenant = args.includes('--tenant') ? args[args.indexOf('--tenant') + 1] : null;
const prefix = dryRun ? '[dry-run] ' : '';

interface TenantOutcome {
  tenantId: string;
  moved: string[];
  merged: string[];
  skipped: string | null;
}

/**
 * Finds a child folder by EXACT name, WITHOUT creating one.
 *
 * `ensureSubfolder` is the usual way to resolve a folder and is wrong here: its
 * last resort is `files.create`, so probing for a folder that may not exist
 * would leave an empty `Documents` at the root of every already-migrated
 * tenant — the exact debris this script exists to remove.
 *
 * It also lists and compares in JS rather than asking Drive for `name='…'`,
 * because this script turns on a distinction Drive's query language may not
 * make: `business` and `Business`. If that comparison were case-INSENSITIVE the
 * rename below would find the folder it was about to create, conclude the work
 * was done, and silently skip every tenant. Listing once and matching exactly
 * does not depend on which way Drive behaves.
 */
async function findSubfolder(
  drive: Drive,
  parentId: string,
  name: string
): Promise<string | null> {
  const matches = (await listChildren(drive, parentId))
    .filter((child) => child.name === name && child.mimeType === FOLDER_MIME_TYPE);

  if (matches.length > 1) {
    throw new Error(
      `${name} exists twice under ${parentId}; merge them by hand before re-running.`
    );
  }
  return matches[0]?.id ?? null;
}

/** The tenant's /DocsNX_Data, or null. Never creates one — see `findSubfolder`. */
async function findRootFolder(
  drive: Drive,
  cachedFolderId: string | null
): Promise<string | null> {
  if (cachedFolderId) {
    try {
      const { data } = await drive.files.get({ fileId: cachedFolderId, fields: 'id, trashed' });
      if (data?.id && !data.trashed) return data.id;
    } catch {
      // Gone, trashed, or a dead grant — fall through to the search.
    }
  }

  const { data } = await withDriveRetry(() =>
    drive.files.list({
      q: `mimeType='${FOLDER_MIME_TYPE}' `
        + `and name='${escapeDriveQueryValue(DRIVE_FOLDER_NAME)}' and trashed=false`,
      fields: 'files(id)',
      spaces: 'drive',
      pageSize: 1,
    })
  );
  return data.files?.[0]?.id ?? null;
}

/** Every child of a folder — id, name and type — following pagination. */
async function listChildren(
  drive: Drive,
  parentId: string
): Promise<Array<{ id: string; name: string; mimeType: string }>> {
  const children: Array<{ id: string; name: string; mimeType: string }> = [];
  let pageToken: string | undefined;
  do {
    const { data } = await withDriveRetry(() =>
      drive.files.list({
        q: `'${parentId}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id, name, mimeType)',
        spaces: 'drive',
        pageSize: 100,
        pageToken,
      })
    );
    for (const file of data.files ?? []) {
      if (file.id && file.name) {
        children.push({ id: file.id, name: file.name, mimeType: file.mimeType ?? '' });
      }
    }
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  return children;
}

/**
 * Moves `name` from `fromParent` into `toParent`.
 *
 * When a folder of that name already exists at the destination — a tenant that
 * was written to after a partial migration — the two are MERGED by moving the
 * old folder's children across, rather than creating two same-named siblings
 * that no later lookup could choose between. The emptied folder is left behind
 * for an operator to inspect; this script never deletes anything.
 */
async function relocate(
  drive: Drive,
  name: string,
  fromParent: string,
  toParent: string,
  outcome: TenantOutcome
): Promise<void> {
  const source = await findSubfolder(drive, fromParent, name);
  if (!source) return; // Already migrated, or this tenant never had one.

  const destination = await findSubfolder(drive, toParent, name);

  if (!destination) {
    if (!dryRun) await moveDriveFile(drive, source, fromParent, toParent);
    outcome.moved.push(name);
    return;
  }

  const children = await listChildren(drive, source);
  for (const child of children) {
    if (!dryRun) await moveDriveFile(drive, child.id, source, destination);
  }
  outcome.merged.push(`${name} (${children.length} children)`);
}

async function migrateTenant(
  tenantId: string,
  folderId: string | null,
  tokens: unknown
): Promise<TenantOutcome> {
  const outcome: TenantOutcome = { tenantId, moved: [], merged: [], skipped: null };

  const client = getTenantDriveClient(tenantId, tokens);
  if (!client) {
    outcome.skipped = 'no usable credentials — the tenant must reconnect Drive';
    return outcome;
  }
  const { drive } = client;

  const root = await findRootFolder(drive, folderId);
  if (!root) {
    outcome.skipped = `no /${DRIVE_FOLDER_NAME} folder — nothing has been synced yet`;
    return outcome;
  }

  return reverse
    ? await toRootLayout(drive, root, outcome)
    : await toScopedLayout(drive, root, outcome);
}

/** The forward direction: root → Personal/, business → Business. */
async function toScopedLayout(
  drive: Drive,
  root: string,
  outcome: TenantOutcome
): Promise<TenantOutcome> {
  // ── 1. business → Business ────────────────────────────────────────────────
  // A rename, so every company folder id underneath stays valid. Done first:
  // it cannot collide with step 2, and leaving it until after a failed move
  // would strand the root in a half-capitalised state.
  const legacyBusiness = await findSubfolder(drive, root, 'business');
  if (legacyBusiness) {
    const already = await findSubfolder(drive, root, FOLDER_BUSINESS);
    if (already && already !== legacyBusiness) {
      // Both spellings exist. Move the companies across rather than pick one.
      const companies = await listChildren(drive, legacyBusiness);
      for (const company of companies) {
        if (!dryRun) await moveDriveFile(drive, company.id, legacyBusiness, already);
      }
      outcome.merged.push(`business → ${FOLDER_BUSINESS} (${companies.length} companies)`);
    } else if (!already) {
      if (!dryRun) {
        await withDriveRetry(() =>
          drive.files.update({ fileId: legacyBusiness, requestBody: { name: FOLDER_BUSINESS } })
        );
      }
      outcome.moved.push(`business → ${FOLDER_BUSINESS}`);
    }
  }

  // ── 2. Documents/ and JSON/ → Personal/ ───────────────────────────────────
  // Only create `Personal` if there is in fact something to put in it, so a
  // business-only tenant does not gain an empty personal folder. That is the
  // one-folder-per-account-type rule the layout promises.
  const hasPersonalContent =
    (await findSubfolder(drive, root, FOLDER_DOCUMENTS)) !== null
    || (await findSubfolder(drive, root, FOLDER_JSON)) !== null;

  if (hasPersonalContent) {
    // `ensureSubfolder` is right here, unlike the probes above: we have just
    // established there is content to file, so creating it is the intent.
    let personal = await findSubfolder(drive, root, FOLDER_PERSONAL);
    if (!personal) {
      outcome.moved.push(`create ${FOLDER_PERSONAL}/`);
      if (!dryRun) personal = await ensureSubfolder(drive, root, FOLDER_PERSONAL);
    }

    for (const name of [FOLDER_DOCUMENTS, FOLDER_JSON]) {
      if (personal) {
        await relocate(drive, name, root, personal, outcome);
      } else if (await findSubfolder(drive, root, name)) {
        // Dry run, and Personal/ does not exist yet — so there is nothing it
        // could collide with and every folder found is a plain move.
        outcome.moved.push(name);
      }
    }
  }

  return outcome;
}

/**
 * The inverse, for rolling back to the pre-business build.
 *
 * `scripts/rollback_business_account.mjs` restores the DATABASE and nothing
 * else. The old build resolves personal stores at `DocsNX_Data/Documents/…` and
 * `DocsNX_Data/JSON/…`, and it has no self-heal — pointed at the scoped layout
 * it would create empty folders at the root and the tenant's vault would look
 * EMPTY. So a rollback is two steps, this one first:
 *
 *     npx tsx scripts/migrate_drive_scope_folders.ts --reverse
 *     node scripts/rollback_business_account.mjs
 *
 * `Personal/` is left behind once emptied: deleting a folder in someone's Drive
 * is not this script's call, and an empty one is harmless.
 */
async function toRootLayout(
  drive: Drive,
  root: string,
  outcome: TenantOutcome
): Promise<TenantOutcome> {
  const personal = await findSubfolder(drive, root, FOLDER_PERSONAL);
  if (personal) {
    for (const name of [FOLDER_DOCUMENTS, FOLDER_JSON]) {
      await relocate(drive, name, personal, root, outcome);
    }
  }

  // Back to lowercase, so the pre-business build's `business` lookups resolve.
  const scoped = await findSubfolder(drive, root, FOLDER_BUSINESS);
  if (scoped && !(await findSubfolder(drive, root, 'business'))) {
    if (!dryRun) {
      await withDriveRetry(() =>
        drive.files.update({ fileId: scoped, requestBody: { name: 'business' } })
      );
    }
    outcome.moved.push(`${FOLDER_BUSINESS} → business`);
  }

  return outcome;
}

async function main() {
  const rows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      googleDriveFolderId: tenants.googleDriveFolderId,
      googleDriveTokens: tenants.googleDriveTokens,
    })
    .from(tenants)
    .where(
      onlyTenant
        ? eq(tenants.id, onlyTenant)
        : and(eq(tenants.googleDriveEnabled, true), isNotNull(tenants.googleDriveTokens))
    );

  if (rows.length === 0) {
    console.log('no tenants with a Drive grant — nothing to migrate.');
    return;
  }

  const direction = reverse
    ? 'BACK to the pre-business root layout'
    : 'to the Personal/Business layout';
  console.log(`${prefix}migrating ${rows.length} tenant(s) ${direction}\n`);

  const outcomes: TenantOutcome[] = [];
  for (const row of rows) {
    try {
      const outcome = await migrateTenant(row.id, row.googleDriveFolderId, row.googleDriveTokens);
      outcomes.push(outcome);

      const label = `${row.name ?? 'unnamed'} (${row.id})`;
      if (outcome.skipped) {
        console.log(`  SKIP  ${label}: ${outcome.skipped}`);
      } else if (outcome.moved.length === 0 && outcome.merged.length === 0) {
        console.log(`  ok    ${label}: already in the ${reverse ? 'root' : 'scoped'} layout`);
      } else {
        const parts = [...outcome.moved, ...outcome.merged.map((m) => `MERGE ${m}`)];
        console.log(`  ${prefix ? 'plan' : 'done'}  ${label}: ${parts.join(', ')}`);
      }
    } catch (error) {
      // One tenant's dead grant or odd folder state must not stop the rest.
      console.error(`  FAIL  ${row.id}:`, error instanceof Error ? error.message : error);
      outcomes.push({ tenantId: row.id, moved: [], merged: [], skipped: 'failed' });
    }
  }

  const changed = outcomes.filter((o) => o.moved.length || o.merged.length).length;
  const skipped = outcomes.filter((o) => o.skipped).length;
  const merged = outcomes.filter((o) => o.merged.length).length;

  console.log(
    `\n${prefix}${changed} tenant(s) changed, ${skipped} skipped, `
    + `${outcomes.length - changed - skipped} already current.`
  );
  if (merged > 0) {
    console.log(
      `${merged} tenant(s) needed a MERGE — they were written to after a partial\n`
      + `migration. The emptied folders are left in place; check them, then delete.`
    );
  }
  if (dryRun) console.log('\nnothing was changed. Re-run without --dry-run to apply.');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
