/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   "This account was deleted" — said once, from one place                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * An admin erases their workspace from Settings, forgets, and a week later
 * signs in again. Until now the answer was "Invalid credentials" — true, and
 * useless — and /forgot-password answered with its generic "if the email
 * exists" sentence while sending nothing. The account is gone: /api/account/
 * delete hard-deletes the tenant and `users` cascades with it. What survives
 * is one `deleted_accounts` row per member, and that row is enough to say
 * WHEN and to whom it happened.
 *
 * Login and forgot-password call `findErasedAccount` on a MISS — after the
 * live `users` lookup found nothing — and answer with `erasedAccountResponse`
 * when it finds a row. Never on a wrong password: a live account is not
 * erased, and this must not become a second oracle about one.
 *
 * ── THIS IS A DELIBERATE DISCLOSURE ────────────────────────────────────────
 * Both routes are otherwise careful to answer identically for a known and an
 * unknown identifier. This answer is not identical: anyone can now learn
 * that an address or number ONCE had an account here, and when it was erased.
 * That was chosen with eyes open — a person locked out of an account they
 * forgot they deleted needs to be told, from any device, not just the browser
 * that did the deleting. What it reveals is bounded to the date, the role and
 * the workspace name; `name` and `phone_number` are ciphertext in that table
 * and are never selected here. Both callers sit behind `authRateLimiter`.
 *
 * ── NOT INSIDE withTenant, AND CANNOT BE ───────────────────────────────────
 * The tenant no longer exists, so there is no id to set `app.tenant_id` to.
 * `deleted_accounts` carries no RLS policy for exactly that reason (see the
 * schema note and tests/rlsCoverage.test.ts) — this is the one reader the
 * table has, and it reads three plain columns by an indexed key.
 */
import { NextResponse } from 'next/server';
import { desc, eq, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db';
import { deletedAccounts } from '@/db/schema';
import { blindIndex } from '@/lib/fieldCrypto';
import { formatDate } from '@/lib/dateHelper';
import { isEmailIdentifier, toDialString } from '@/lib/phone';

export interface ErasedAccount {
  erasedAt: Date;
  role: 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'STANDARD';
  tenantName: string | null;
}

/**
 * The most recent erasure this identifier was part of, or `null`.
 *
 * Email matches the cleartext `email` column (lower-cased, the way every
 * writer stores it). A mobile number is normalised through `toDialString`
 * and matched on `phone_dial_index`, the keyed hash the erasure routes write
 * (0062) — the number itself is ciphertext and cannot be matched.
 *
 * Newest first: someone can register, erase and register again with the same
 * address, and the date worth telling them is the last one.
 */
export async function findErasedAccount(identifier: string | null | undefined): Promise<ErasedAccount | null> {
  const trimmed = (identifier || '').trim();
  if (!trimmed) return null;

  let predicate: SQL;
  if (isEmailIdentifier(trimmed)) {
    predicate = eq(deletedAccounts.email, trimmed.toLowerCase());
  } else {
    const dial = toDialString(trimmed);
    if (!dial) return null;
    const key = blindIndex(dial);
    if (!key) return null;
    predicate = eq(deletedAccounts.phoneDialIndex, key);
  }

  const [row] = await db
    .select({
      erasedAt: deletedAccounts.erasedAt,
      role: deletedAccounts.role,
      tenantName: deletedAccounts.tenantName,
    })
    .from(deletedAccounts)
    .where(predicate)
    .orderBy(desc(deletedAccounts.erasedAt))
    .limit(1);

  return row ?? null;
}

/**
 * The sentence the person reads. Two shapes, because two different things
 * happened to them: an admin erased the account themselves; a member had the
 * workspace they belonged to erased by its admin, and may not know.
 */
export function erasedAccountMessage(erased: ErasedAccount): string {
  const when = formatDate(erased.erasedAt);
  const on = when ? ` on ${when}` : '';
  if (erased.role === 'STANDARD') {
    const which = erased.tenantName ? `The workspace "${erased.tenantName}"` : 'The workspace';
    return `${which} this account belonged to was permanently deleted by its admin${on}. `
      + 'There is nothing to sign in to — ask them, or create your own account.';
  }
  return `This account was permanently deleted${on}. There is nothing to sign in to — `
    + 'create a new account to start over.';
}

/**
 * 410 Gone: the resource existed and was deliberately removed, which is the
 * exact case and is not 401 (wrong secret) or 404 (never here). The flag is
 * what the login and forgot-password pages branch on; the identifier is
 * echoed so a Register link can start from what they typed.
 */
export function erasedAccountResponse(erased: ErasedAccount, identifier: string): NextResponse {
  return NextResponse.json({
    error: erasedAccountMessage(erased),
    accountErased: true,
    erasedAt: erased.erasedAt.toISOString(),
    role: erased.role,
    identifier,
  }, { status: 410 });
}
