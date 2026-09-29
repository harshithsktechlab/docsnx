import './loadEnv';
import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { deletedAccounts } from '../src/db/schema';
import { blindIndex, decryptField } from '../src/lib/fieldCrypto';
import { toDialString } from '../src/lib/phone';

/**
 * Gives every existing `deleted_accounts` row its `phone_dial_index` (0062).
 *
 * The column is `blindIndex(phone_dial)`, written by the erasure routes from
 * the user row they are about to delete. Rows retained before 0062 have the
 * number only as `phone_number` ciphertext, so the key has to be derived here:
 * decrypt → `toDialString` (the same normalisation `users.phone_dial` carries)
 * → `blindIndex`. Without it a person who erased their account before this
 * shipped and later signs in with their mobile is told "Invalid credentials"
 * rather than that the account was deleted — the one thing the lookup exists
 * to say.
 *
 * Idempotent: only rows where the index is still NULL and a number is
 * retained are touched, so it can be re-run. A retained number that does not
 * normalise (junk from before 0039) is counted and left NULL — there is no
 * dial string it could ever be matched against.
 *
 * ── IT NEVER PRINTS A NUMBER ──────────────────────────────────────────────
 * Not the plaintext, not the index. Counts and row ids only.
 *
 *   npx tsx scripts/backfill_deleted_accounts_phone_dial_index.ts [--apply]
 */

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const prefix = apply ? '' : '[dry-run] ';

async function main() {
  const rows = await db
    .select({ id: deletedAccounts.id, phoneNumber: deletedAccounts.phoneNumber })
    .from(deletedAccounts)
    .where(and(isNull(deletedAccounts.phoneDialIndex), isNotNull(deletedAccounts.phoneNumber)));

  console.log(`${prefix}${rows.length} retained row(s) without a phone_dial_index`);

  let indexed = 0;
  let unusable = 0;
  for (const row of rows) {
    const dial = toDialString(decryptField(row.phoneNumber));
    if (!dial) {
      unusable += 1;
      console.log(`${prefix}  ${row.id}: retained number does not normalise — left NULL`);
      continue;
    }
    if (apply) {
      await db
        .update(deletedAccounts)
        .set({ phoneDialIndex: blindIndex(dial) })
        .where(eq(deletedAccounts.id, row.id));
    }
    indexed += 1;
  }

  console.log(`${prefix}${indexed} row(s) ${apply ? 'indexed' : 'would be indexed'}, ${unusable} unusable`);
  if (!apply) console.log('Re-run with --apply to write.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
