/**
 * Who may use /activate (0071): a STANDARD member, in a live tenant, with
 * sign-in on, who has not set their own password yet. Everyone else is
 * answered exactly as an unknown identifier is.
 */
import { isSignInDisabled } from '@/lib/account/signInDisabled';

export const SET_PASSWORD_TTL_MS = 15 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;

export function canActivate(user: {
  role: string;
  activatedAt?: Date | string | null;
  signInDisabledAt?: Date | string | null;
  deletedAt?: Date | string | null;
  tenant?: { isActive?: boolean | null } | null;
} | null | undefined): boolean {
  if (!user) return false;
  if (user.role !== 'STANDARD') return false;
  if (user.activatedAt) return false;
  if (user.deletedAt) return false;
  if (user.tenant && user.tenant.isActive === false) return false;
  return !isSignInDisabled(user as any);
}

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 128) return 'Use at most 128 characters.';
  return null;
}
