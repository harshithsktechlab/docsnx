import './loadEnv';
import { eq, isNotNull } from 'drizzle-orm';
import { db, withTenant } from '../src/lib/db';
import { tenants } from '../src/db/schema';
import { serializeDriveTokens } from '../src/lib/googleDrive';

/**
 * Re-encrypts any Google Drive OAuth token still stored as plaintext.
 *
 * Drive tokens are encrypted at rest — `serializeDriveTokens` runs on both
 * write paths (the OAuth callback and `persistDriveTokens`). But
 * `parseDriveTokens` also *transparently accepts a legacy plaintext object*,
 * and no backfill was ever written. Rows that predate encryption were only ever
 * migrated by attrition: `persistDriveTokens` fires on Google's `tokens` refresh
 * event, so an ACTIVE tenant re-encrypts itself the first time their access
 * token expires. A dormant tenant never does.
 *
 * The consequence is one row holding a live Google refresh token in the clear,
 * indefinitely, in a column everything else treats as secret. This closes it.
 *
 * ── HOW A PLAINTEXT ROW IS RECOGNISED ─────────────────────────────────────
 * The column is `jsonb`, and both shapes live in it: encryption produces a JSON
 * *string*, the legacy path stored a JSON *object*. So `typeof === 'string'`
 * means already encrypted and `'object'` means not — exactly the test
 * `parseDriveTokens` makes, deliberately, so the two cannot drift apart.
 *
 * ── IT NEVER PRINTS A TOKEN ───────────────────────────────────────────────
 * Not the value, not a prefix, not a length. A script written to fix a secret
 * leaking into the database must not leak it into a terminal or a log file on
 * the way past. Only counts and tenant ids appear below.
 *
 *   npx tsx scripts/encrypt_legacy_drive_tokens.ts [--apply]
 */

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const prefix = apply ? '' : '[dry-run] ';

async function main() {
  const rows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      googleDriveTokens: tenants.googleDriveTokens,
    })
    .from(tenants)
    .where(isNotNull(tenants.googleDriveTokens));

  // `typeof` on the parsed jsonb, matching `parseDriveTokens`. A string is
  // ciphertext; anything else is the legacy object.
  const plaintext = rows.filter((row) => typeof row.googleDriveTokens !== 'string');
  const encrypted = rows.length - plaintext.length;

  console.log(
    `${prefix}${rows.length} tenant(s) hold Drive tokens — `
    + `${encrypted} encrypted, ${plaintext.length} PLAINTEXT`
  );

  if (plaintext.length === 0) {
    console.log('nothing to do. Every stored Drive token is encrypted at rest.');
    return;
  }

  for (const row of plaintext) {
    console.log(`  PLAINTEXT  ${row.name ?? 'unnamed'} (${row.id})`);
  }

  if (!apply) {
    console.log(`\n${prefix}re-run with --apply to encrypt them in place.`);
    return;
  }

  let done = 0;
  for (const row of plaintext) {
    const sealed = serializeDriveTokens(row.googleDriveTokens);
    if (!sealed) {
      console.error(`  FAILED to serialise ${row.id}; left untouched`);
      continue;
    }
    await withTenant(row.id, async (tx) => {
      await tx
        .update(tenants)
        .set({ googleDriveTokens: sealed, updatedAt: new Date() })
        .where(eq(tenants.id, row.id));
    });
    done += 1;
  }

  console.log(
    `\nencrypted ${done} token(s) in place. The grants themselves are unchanged —`
    + `\nno tenant needs to reconnect.`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    // Deliberately not `console.error(error)` with the row in scope: a pg error
    // can echo the offending value, which here is the very thing being hidden.
    console.error(error instanceof Error ? error.message : 'failed');
    process.exit(1);
  });
