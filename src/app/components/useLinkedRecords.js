'use client';

/**
 * The records a `record_link` field may point at — one category's list, read
 * through the same permission-checked endpoint the sub-category page uses.
 *
 * Shared by the picker, the item list's "Locker" column and the locker
 * inventory panel, which all want the same list at the same moment. A module
 * cache keyed by workspace + category collapses them into one request, the way
 * src/hooks/useMembers.ts does for members.
 *
 * `forbidden` is a distinct state, not an empty list: a member who may not
 * view lockers must be told so, not shown "no lockers".
 */
import { useCallback, useEffect, useState } from 'react';
import { useWorkspaceApi } from '@/lib/net/useWorkspaceApi';

const MAX_AGE_MS = 30_000;
const cache = new Map();

/** Something a person can pick from: "Locker 12 · SBI · MG Road". */
export function linkedRecordLabel(record) {
  if (!record) return '';
  const f = record.fields || {};
  const parts = [record.title];
  if (f.bank_name) parts.push(f.bank_name);
  if (f.branch_name) parts.push(f.branch_name);
  if (record.display?.number && record.display.number !== '-') parts.push(record.display.number);
  return parts.filter(Boolean).join(' · ');
}

/** Forget a category's cached list — after a record in it is added or removed. */
export function invalidateLinkedRecords(target) {
  for (const key of cache.keys()) {
    if (key.endsWith(`|${target.moduleKey}/${target.documentKey}`)) cache.delete(key);
  }
}

export function useLinkedRecords(target) {
  const { api, companyId } = useWorkspaceApi();
  const moduleKey = target?.moduleKey;
  const documentKey = target?.documentKey;
  const key = `${companyId || ''}|${moduleKey}/${documentKey}`;
  const [state, setState] = useState(() => cache.get(key)?.state
    ?? { records: [], loaded: false, forbidden: false });

  const load = useCallback(async (force = false) => {
    if (!moduleKey || !documentKey) return;
    const hit = cache.get(key);
    if (!force && hit) {
      if (hit.inFlight) { setState(await hit.inFlight); return; }
      if (Date.now() - hit.at < MAX_AGE_MS) { setState(hit.state); return; }
    }
    const inFlight = (async () => {
      const { res, json } = await api(`/api/modules/${moduleKey}/${documentKey}?limit=1000`);
      if (res.ok) return { records: Array.isArray(json.records) ? json.records : [], loaded: true, forbidden: false };
      return { records: [], loaded: true, forbidden: res.status === 403 };
    })();
    cache.set(key, { ...(hit || {}), inFlight });
    const next = await inFlight;
    cache.set(key, { state: next, at: Date.now(), inFlight: null });
    setState(next);
  }, [api, key, moduleKey, documentKey]);

  useEffect(() => { load(); }, [load]);

  return { ...state, refresh: () => load(true) };
}
