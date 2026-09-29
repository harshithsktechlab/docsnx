'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   useMembers — ONE members list per page, however many pickers there are ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── WHY A SHARED STORE ─────────────────────────────────────────────────────
 * `<HolderSelect>` used to run its own `fetch('/api/members')` in its own
 * effect. That is invisible on a form with one picker and awful on the Power
 * Scan grid, which renders ONE PER ROW — a twenty-document batch fired twenty
 * identical requests for the same twenty-byte answer.
 *
 * It also made the "+ add a member" button impossible to do correctly: a member
 * added from row 3 would appear in row 3's dropdown and nowhere else, because
 * every other row held its own private copy of the list. Refreshing them all
 * means they must all be reading the SAME list.
 *
 * So: module-level state, a subscriber set, and one in-flight promise that
 * concurrent callers join rather than duplicate.
 *
 * ── NEVER BLOCKS THE FORM IT SITS IN ───────────────────────────────────────
 * A failed fetch leaves the previous list exactly as it was and resolves
 * quietly. "All members" stays selectable, the surrounding form stays usable,
 * and nothing throws. This is deliberate and predates the store — see the
 * original comment in HolderSelect.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { withCompany } from '@/lib/net/useWorkspaceApi';

export interface Member {
  id: string;
  name: string;
}

export interface MembersSnapshot {
  members: Member[];
  /**
   * Whether THIS user may create members. Answered by `/api/members` rather
   * than inferred here, so the picker does not need a second `/api/auth/me`
   * round-trip per instance. It gates RENDERING only — `POST /api/users` is
   * TENANT_ADMIN-gated server-side and refuses a forged request regardless.
   */
  canAddMembers: boolean;
  /** True once a fetch has succeeded at least once. */
  loaded: boolean;
}

/**
 * How stale the list may be before a window-focus refresh actually re-fetches.
 *
 * Tab focus fires on every alt-tab, not only on the return trip from the
 * Members tab. Without a floor, idly clicking between windows would re-fetch
 * on each one.
 */
const FOCUS_MAX_AGE_MS = 2000;

/**
 * ── ONE LIST PER WORKSPACE ─────────────────────────────────────────────────
 * `/api/members` answers for the workspace on the request: the household's
 * members, or ONE company's. A single module-level list would hand a company's
 * picker the household (the request went out without `?companyId=`), and after
 * a switch it would show one company's employees under another's records. So
 * the store is keyed by company, `''` being the household.
 */
interface Entry {
  snapshot: MembersSnapshot;
  lastFetchedAt: number;
  inFlight: Promise<MembersSnapshot> | null;
  subscribers: Set<(next: MembersSnapshot) => void>;
}

const EMPTY: MembersSnapshot = { members: [], canAddMembers: false, loaded: false };
const entries = new Map<string, Entry>();

function entryFor(companyId: string | null | undefined): Entry {
  const key = companyId || '';
  let entry = entries.get(key);
  if (!entry) {
    entry = { snapshot: EMPTY, lastFetchedAt: 0, inFlight: null, subscribers: new Set() };
    entries.set(key, entry);
  }
  return entry;
}

function publish(entry: Entry, next: MembersSnapshot) {
  entry.snapshot = next;
  for (const notify of entry.subscribers) notify(entry.snapshot);
}

/**
 * Fetch the list, or hand back the cached one if it is fresh enough.
 *
 * @param maxAgeMs `0` forces a re-fetch; the default reuses any loaded list.
 * @param companyId The workspace, or null/absent for the household.
 */
export function loadMembers(
  { maxAgeMs = Infinity, companyId = null }: { maxAgeMs?: number; companyId?: string | null } = {},
): Promise<MembersSnapshot> {
  const entry = entryFor(companyId);
  // Concurrent callers JOIN the request rather than adding one. This is what
  // collapses twenty grid rows asking at once into a single GET.
  if (entry.inFlight) return entry.inFlight;
  if (entry.snapshot.loaded && Date.now() - entry.lastFetchedAt < maxAgeMs) {
    return Promise.resolve(entry.snapshot);
  }

  entry.inFlight = (async () => {
    try {
      const res = await fetch(withCompany('/api/members', companyId || null));
      if (res.ok) {
        const json = await res.json();
        entry.lastFetchedAt = Date.now();
        publish(entry, {
          members: Array.isArray(json.members) ? json.members : [],
          canAddMembers: !!json.canAddMembers,
          loaded: true,
        });
      }
      // A non-OK answer leaves the previous list untouched — see the header.
    } catch {
      // As does a network failure.
    } finally {
      entry.inFlight = null;
    }
    return entry.snapshot;
  })();

  return entry.inFlight;
}

/**
 * Watch one workspace's list. Returns the unsubscribe.
 *
 * Exported rather than kept private to the hook so the store can be driven
 * without React — which is how its "one refresh reaches everyone" property is
 * asserted directly instead of through a rendered tree.
 */
export function subscribe(
  listener: (next: MembersSnapshot) => void,
  companyId: string | null = null,
): () => void {
  const entry = entryFor(companyId);
  entry.subscribers.add(listener);
  return () => { entry.subscribers.delete(listener); };
}

export function useMembers({ refreshOnFocus = true }: { refreshOnFocus?: boolean } = {}) {
  // Read from the path, like every workspace-scoped call: each caller already
  // renders inside the workspace whose members it wants.
  const params = useParams() as { companyId?: string } | null;
  const companyId = params?.companyId || null;
  const [state, setState] = useState<MembersSnapshot>(() => entryFor(companyId).snapshot);
  // Subscribers are notified with the new snapshot directly, so React never
  // reads a torn value between the module state and this component's copy.
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const notify = (next: MembersSnapshot) => {
      if (mounted.current) setState(next);
    };
    // A switch of workspace must not show the previous one's list meanwhile.
    setState(entryFor(companyId).snapshot);
    const unsubscribe = subscribe(notify, companyId);
    // A list already loaded by a sibling picker is reused; the first picker to
    // mount is the only one that causes a request.
    loadMembers({ companyId }).then(notify);
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [companyId]);

  useEffect(() => {
    if (!refreshOnFocus) return undefined;
    const onFocus = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      loadMembers({ maxAgeMs: FOCUS_MAX_AGE_MS, companyId });
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refreshOnFocus, companyId]);

  const refresh = useCallback(() => loadMembers({ maxAgeMs: 0, companyId }), [companyId]);

  return {
    members: state.members,
    canAddMembers: state.canAddMembers,
    loaded: state.loaded,
    refresh,
  };
}
