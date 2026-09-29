/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   AN API CALL THAT CARRIES ITS WORKSPACE                                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Passwords, to-dos and important contacts render from ONE page component in
 * both accounts, at `/todos` and at `/business/<companyId>/todos`. Which rows it
 * shows, and which account a new row is written into, is decided entirely by
 * whether `?companyId=` rides along on the request.
 *
 * There are fifteen such call sites across the three pages. Appending the query
 * by hand at each is precisely the change that gets made at fourteen: the
 * fifteenth then reads or writes the household's data from inside a company
 * workspace, renders perfectly, and tells no one. So the workspace is bound
 * ONCE, here, and the pages call `api(...)` exactly as they called `apiCall`.
 *
 * The id is read from `useParams`, i.e. from the path — not from state, not from
 * a cookie — so two companies can be open in two tabs and a refresh lands where
 * the user was. Outside the dynamic route `useParams` yields no `companyId`,
 * which is the personal account, and the URL goes out untouched: the personal
 * request is byte-identical to what it was before this hook existed.
 *
 * None of this is a permission. The id in the path is untrusted and is re-proven
 * server-side by `hasCompanyAccess` on every request — see `resolveUtilityCompany`.
 */
'use client';

import { useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { apiCall, type ApiCallResult, type ApiRequestOptions } from './apiRequest';

/** The company whose workspace the current route is, or `null` for personal. */
export function useWorkspaceCompanyId(): string | null {
  const params = useParams();
  const raw = params?.companyId;
  const id = Array.isArray(raw) ? raw[0] : raw;
  return typeof id === 'string' && id ? id : null;
}

/**
 * Appends the company to a same-origin API path.
 *
 * Exported for the tests, and because a couple of call sites build their URL
 * outside a component. Keeps any query the caller already has, and appends
 * nothing at all when there is no company — so the personal request shape is
 * unchanged.
 */
export function withCompany(url: string, companyId: string | null): string {
  if (!companyId) return url;
  const [path, hash] = url.split('#');
  const joiner = path.includes('?') ? '&' : '?';
  return `${path}${joiner}companyId=${encodeURIComponent(companyId)}${hash ? `#${hash}` : ''}`;
}

export interface WorkspaceApi {
  /** `apiCall` with the workspace already on it. */
  api: <T = any>(url: string, init?: ApiRequestOptions, options?: any) => Promise<ApiCallResult<T>>;
  /** The active company, for the handful of places that must branch on it. */
  companyId: string | null;
  /** True in a company workspace. */
  inCompany: boolean;
}

export function useWorkspaceApi(): WorkspaceApi {
  const companyId = useWorkspaceCompanyId();

  const api = useCallback(
    <T = any>(url: string, init?: ApiRequestOptions, options?: any) =>
      apiCall<T>(withCompany(url, companyId), init, options),
    [companyId],
  );

  return useMemo(
    () => ({ api, companyId, inCompany: Boolean(companyId) }),
    [api, companyId],
  );
}
