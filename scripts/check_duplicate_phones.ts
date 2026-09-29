/**
 * READ-ONLY: will drizzle/0039 be able to make mobile numbers unique?
 *
 * 0039 adds `users_phone_dial_uq` so a mobile number can identify exactly one
 * account at the sign-in box. If two live accounts normalise to the same
 * number, the migration aborts on purpose — picking a winner silently would
 * decide, without anyone looking, which of two real people keeps the ability to
 * sign in with their phone.
 *
 * Run this FIRST. It performs the same normalisation the migration does, in the
 * database, and prints every colliding group with enough detail to decide what
 * to do — never a password hash, never a full number.
 *
 *   npx tsx scripts/check_duplicate_phones.ts
 *
 * Exit 0 = safe to migrate. Exit 1 = collisions listed above; resolve them
 * (correct the wrong number, or clear it) and run again.
 *
 * SELECTs only. It writes nothing, and it is safe to point at production —
 * where the secrets are TPM-sealed systemd credentials, so it has to be run
 * through systemd to get DATABASE_URL; see scripts/loadEnv.ts:
 *
 *   sudo systemd-run --pty --same-dir --wait --uid=azureuser \
 *     --property=LoadCredentialEncrypted=DATABASE_URL:/etc/docsnx/credentials/DATABASE_URL.cred \
 *     npx tsx scripts/check_duplicate_phones.ts
 */
import './loadEnv';
import { sql } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { maskEmail, maskPhone } from '../src/lib/dataMasking';

/**
 * The normalisation, expressed once, in SQL.
 *
 * Deliberately NOT `toDialString` called from TypeScript over a fetched list:
 * this must report exactly what the migration's own CASE expression will
 * compute, including any disagreement between the two. If this script and the
 * migration ever diverge, a green run here followed by a failed migration is
 * the symptom — and copying the migration's SQL verbatim is what makes that
 * essentially impossible.
 */
const DIAL = sql`CASE
  WHEN phone_number IS NULL OR btrim(phone_number) = '' THEN NULL
  WHEN btrim(phone_number) LIKE '+%' THEN
    CASE
      WHEN length(regexp_replace(phone_number, '\\D', '', 'g')) >= 10
        THEN regexp_replace(phone_number, '\\D', '', 'g')
      ELSE NULL
    END
  WHEN length(regexp_replace(phone_number, '\\D', '', 'g')) = 10
    THEN '91' || regexp_replace(phone_number, '\\D', '', 'g')
  WHEN length(regexp_replace(phone_number, '\\D', '', 'g')) < 10 THEN NULL
  ELSE regexp_replace(phone_number, '\\D', '', 'g')
END`;

interface Row {
  dial: string;
  id: string;
  email: string;
  name: string;
  phone_number: string;
  tenant_name: string | null;
  role: string;
}

async function main() {
  // Live rows only — the unique index is partial on deleted_at IS NULL, so a
  // closed account sharing a number with an open one is not a collision.
  const { rows } = (await db.execute(sql`
    WITH dialled AS (
      SELECT u.id, u.email, u.name, u.phone_number, u.role, u.tenant_id,
             ${DIAL} AS dial
      FROM users u
      WHERE u.deleted_at IS NULL
    )
    SELECT d.dial, d.id, d.email, d.name, d.phone_number, d.role,
           t.name AS tenant_name
    FROM dialled d
    LEFT JOIN tenants t ON t.id = d.tenant_id
    WHERE d.dial IS NOT NULL
      AND d.dial IN (
        SELECT dial FROM dialled
        WHERE dial IS NOT NULL
        GROUP BY dial HAVING count(*) > 1
      )
    ORDER BY d.dial, d.email
  `)) as unknown as { rows: Row[] };

  // Worth reporting separately: a number that is present but too short to
  // normalise. The migration stores NULL for it, so it never collides — but the
  // person also cannot sign in with it, and they will report that as a bug.
  const { rows: unusable } = (await db.execute(sql`
    SELECT count(*)::int AS n
    FROM users
    WHERE deleted_at IS NULL
      AND phone_number IS NOT NULL AND btrim(phone_number) <> ''
      AND (${DIAL}) IS NULL
  `)) as unknown as { rows: { n: number }[] };

  const unusableCount = unusable[0]?.n ?? 0;
  if (unusableCount > 0) {
    console.log(
      `\n⚠  ${unusableCount} live account(s) hold a phone number too short to dial.\n` +
      `   These do NOT block the migration (they store NULL), but those members\n` +
      `   will not be able to sign in with their mobile until it is corrected.\n`
    );
  }

  if (rows.length === 0) {
    console.log('✅ No duplicate mobile numbers among live accounts — 0039 can create the unique index.');
    return;
  }

  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const group = groups.get(row.dial) ?? [];
    group.push(row);
    groups.set(row.dial, group);
  }

  console.log(
    `\n❌ ${groups.size} mobile number(s) are shared by more than one live account.\n` +
    `   drizzle/0039 will abort until each is resolved.\n`
  );

  for (const [dial, members] of groups) {
    console.log(`  ${maskPhone(dial)}  (${members.length} accounts)`);
    for (const m of members) {
      console.log(
        `    · ${m.name} <${maskEmail(m.email)}>  ${m.role}` +
        `  tenant="${m.tenant_name ?? '—'}"  id=${m.id}`
      );
    }
    console.log('');
  }

  console.log(
    'For each group, decide which account keeps the number, then clear or correct\n' +
    'the others — via /users in the app, or:\n' +
    "  UPDATE users SET phone_number = NULL WHERE id = '<uuid>';\n"
  );

  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('check_duplicate_phones failed:', error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
