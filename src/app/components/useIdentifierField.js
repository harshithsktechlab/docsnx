'use client';

import { useEffect, useState } from 'react';
import { apiCall } from '@/lib/net/apiRequest';
import { useWorkspaceCompanyId, withCompany } from '@/lib/net/useWorkspaceApi';

/**
 * What THIS sub-category calls its identifying number.
 *
 * ── WHY A FORM NEEDS TO ASK ────────────────────────────────────────────────
 * The Document Manager's upload form and the bulk-scan review screen both ask
 * for one number before knowing what kind of document it is, and both labelled
 * it "ID / Document Number" — a label that is wrong for almost every category
 * it is used with. A driving licence has a License Number, a challan has a
 * Challan Number, an electricity bill a Consumer Number. Worse than cosmetic:
 * the server now files that value under whichever field the category calls its
 * identifier, so a form saying "Document Number" was naming a field that does
 * not exist while the value went somewhere else.
 *
 * `GET /api/modules/:moduleKey/:documentKey/fields` already answers this — it
 * returns the category's spec AND its `identifierFields` — so this is a read of
 * something that exists rather than a new endpoint. The browser still never
 * holds the taxonomy; it asks about the one category in front of the user.
 *
 * ── THE CACHE ──────────────────────────────────────────────────────────────
 * Module-level, and shared by every caller. The bulk-scan review renders one of
 * these per scanned record, and forty rows of the same category must not be
 * forty requests. In-flight promises are cached too, so rows that mount
 * together coalesce into one.
 */
const cache = new Map();

/**
 * @param companyId the workspace the question is being asked in, or null for the
 *   household. It is part of the cache key AND of the request: `/api/modules/*`
 *   is gated by `gateCompany`, which refuses a `biz_*` module with no company,
 *   so a personal-shaped request would cache a null answer for a business
 *   category and the grid would keep its generic "Document Number" label.
 */
function loadIdentifier(moduleKey, documentKey, companyId) {
  const cacheKey = `${companyId || 'personal'}:${moduleKey}/${documentKey}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const pending = (async () => {
    const { res, json } = await apiCall(
      withCompany(`/api/modules/${moduleKey}/${documentKey}/fields`, companyId),
    );
    // A member with `add` but not `view` on this category gets a 403. Not an
    // error worth surfacing — the caller falls back to its generic label.
    if (!res.ok || !json.success) return null;

    const [identifierKey] = json.identifierFields ?? [];
    if (!identifierKey) {
      // A category that identifies nothing — a salary slip, a checkup report.
      // Distinct from "we could not find out", and the caller shows this by
      // hiding the field rather than by labelling it.
      return { key: null, label: null };
    }
    const spec = (json.fields ?? []).find((f) => f.fieldKey === identifierKey);
    return { key: identifierKey, label: spec?.fieldLabel ?? null };
  })().catch(() => null);

  cache.set(cacheKey, pending);
  return pending;
}

/**
 * @param moduleKey    the selected category's module, or falsy before one is picked
 * @param documentKey  its sub-category
 * @returns `{ label, hasIdentifier, resolved }` — `resolved` false while nothing
 *          is selected or the answer is still in flight, which is when a caller
 *          should keep whatever generic label it started with.
 */
export function useIdentifierField(moduleKey, documentKey) {
  const [state, setState] = useState({ label: null, hasIdentifier: true, resolved: false });
  // Read from the path, like every other workspace-aware control: this hook is
  // used by the Document Manager's upload form and by the bulk-scan grid, both
  // of which render in either account.
  const companyId = useWorkspaceCompanyId();

  useEffect(() => {
    if (!moduleKey || !documentKey) {
      setState({ label: null, hasIdentifier: true, resolved: false });
      return undefined;
    }
    let cancelled = false;
    setState((prev) => ({ ...prev, resolved: false }));
    loadIdentifier(moduleKey, documentKey, companyId).then((answer) => {
      if (cancelled) return;
      // A failed lookup leaves `hasIdentifier` true: hiding the input because a
      // request 403'd would silently drop a number the user meant to record.
      if (!answer) {
        setState({ label: null, hasIdentifier: true, resolved: false });
        return;
      }
      setState({ label: answer.label, hasIdentifier: Boolean(answer.key), resolved: true });
    });
    return () => { cancelled = true; };
  }, [moduleKey, documentKey, companyId]);

  return state;
}
