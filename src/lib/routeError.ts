/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE 500 THAT TELLS BOTH SIDES SOMETHING                                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * 116 of the 135 route files ended their catch block with the same two lines:
 *
 *     console.error('Create document error:', error);
 *     return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
 *
 * Which gives the user a phrase from an HTTP spec and gives support a console
 * line they cannot connect to it. When someone reports "it said internal server
 * error at about four o'clock", finding the matching entry means reading every
 * error the box logged in that window across every tenant — and the tenant
 * cannot be narrowed down, because the message carries nothing.
 *
 * A short reference on both ends closes that. The user quotes six characters;
 * support greps six characters. That is the whole idea.
 *
 * ── WHY THE MESSAGE NAMES THE OPERATION ────────────────────────────────────
 * "Internal Server Error" leaves the user unable to answer the only question
 * they have: is my data safe? Naming what failed — "Something failed at our end
 * while saving this record" — and stating that nothing was changed answers it.
 * A 500 from a write path has already rolled back (every write runs inside
 * `withTenant`'s transaction), so that statement is true, not reassurance.
 *
 * ── WHAT IT MUST NOT DO ────────────────────────────────────────────────────
 * Put the error text in the response. A thrown Postgres error quotes the SQL
 * and the failing row; a Drive error names file ids; a decryption failure names
 * key material. All of that belongs in the journal, none of it in a body a
 * browser can read. `error.message` is therefore logged and never returned.
 */
import { NextResponse } from 'next/server';

/**
 * Six characters of base36. Not a uuid: this gets read aloud, typed into a
 * support chat, and copied off a phone screenshot, and a uuid survives none of
 * those. ~2 billion values is far more than enough to disambiguate the handful
 * of failures in any window someone would search.
 */
function reference(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

/**
 * Log a fault with a quotable reference and answer with a sentence.
 *
 * `operation` is a gerund phrase naming what was being attempted, from the
 * user's point of view — 'saving this medical record', 'loading your
 * documents'. It becomes both the log prefix and the message, so the two cannot
 * describe different things.
 *
 *   } catch (error) {
 *     const vault = vaultErrorResponse(error);   if (vault) return vault;
 *     return serverError(error, 'saving this medical record');
 *   }
 *
 * ALWAYS placed last in a catch chain: the specific mappers
 * (`vaultErrorResponse`, `storageLimitResponse`, `driveReauthResponse`,
 * `uploadTypeResponse`, the `dbErrors` predicates) each answer with something
 * the user can act on, and reaching here means none of them recognised it —
 * which is the definition of a fault at our end.
 */
export function serverError(error: unknown, operation: string): NextResponse {
  const ref = reference();
  // One line, greppable by reference, with the stack attached for the operator.
  console.error(`[route-error ${ref}] ${operation}:`, error);
  return NextResponse.json(
    {
      // Read by `apiErrorMessage` (src/lib/net/apiErrorMessage.ts) like every
      // other route's `error` key, so no page needs to know this shape.
      error: `Something failed at our end while ${operation}. Nothing was changed.`,
      reference: ref,
    },
    { status: 500 },
  );
}

/**
 * The same, for a route that has nothing better to say about what it was doing.
 *
 * Exists so converting a route is never blocked on inventing a phrase — but
 * prefer `serverError` with a real operation, because "this request" is one
 * step better than "Internal Server Error" and the named version is several.
 */
export function serverErrorResponse(error: unknown, context = 'this request'): NextResponse {
  return serverError(error, `handling ${context}`);
}
