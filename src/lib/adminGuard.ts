/**
 * The platform-role gate the /api/admin/* routes share.
 *
 * Extracted when the second super-admin route appeared. It is four lines, and
 * four lines is exactly the size of thing that gets copied with one word
 * changed — `!==` for `===`, `role` for `user.role` — and then guards nothing.
 * There is one copy, so there is one thing to audit.
 *
 * Returns the user or null. Deliberately NOT a Response: the caller writes its
 * own 403 body, and a guard that returns a response is one a caller can forget
 * to return.
 *
 * ── WHY NOT hasPermission ──────────────────────────────────────────────────
 * `hasPermission` answers for TENANT roles, against a tenant's permission rows.
 * SUPER_ADMIN is a PLATFORM role with a deny-by-default allowlist of its own
 * (see src/lib/auth.ts), and the taxonomy is global reference data that belongs
 * to no tenant. The question here is simply "is this the platform operator", and
 * asking it directly is clearer than inventing a permission key nobody holds.
 */
import { getUserFromRequest } from '@/lib/auth';

export async function requireSuperAdmin(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user || user.role !== 'SUPER_ADMIN') return null;
  return user;
}

/** The one wording, so two admin screens cannot report the same refusal twice. */
export const SUPER_ADMIN_ONLY = 'Access denied. Super Admin only.';
