/**
 * Save a viewer rotation INTO the stored file, falling back to the old
 * display-only preference for a type the server cannot rewrite (HEIC, TIFF…).
 *
 * `request(url, init)` is whatever the caller already uses to talk to the API —
 * it must resolve `{ ok, status, json }`. The three call sites differ in how
 * they bind the company, so that binding stays with them.
 *
 * Resolves `{ mode: 'file', fileSize }` when the bytes were rewritten (the
 * preference is reset to 0 server-side) or `{ mode: 'view' }` when only the
 * display preference was saved. Throws on any other failure.
 */
export async function applyRotation(request, docId, degrees) {
  const turn = (((Math.round(degrees / 90) % 4) + 4) % 4) * 90;
  if (turn === 0) {
    // Back to upright: nothing to rewrite, just clear any remembered preference.
    const cleared = await request(`/api/documents/${docId}/rotation`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rotation: 0 }),
    });
    if (!cleared.ok || !cleared.json?.success) throw new Error(cleared.json?.error || 'Could not save the rotation');
    return { mode: 'view', rotation: 0 };
  }

  const applied = await request(`/api/documents/${docId}/rotation/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ degrees: turn }),
    // One Drive round trip per page; the default 45s is too short for a big scan.
    timeoutMs: 120_000,
  });
  if (applied.ok && applied.json?.success) {
    return { mode: 'file', rotation: 0, fileSize: applied.json.fileSize };
  }

  if (applied.status === 415) {
    const saved = await request(`/api/documents/${docId}/rotation`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rotation: turn }),
    });
    if (!saved.ok || !saved.json?.success) throw new Error(saved.json?.error || 'Could not save the rotation');
    return { mode: 'view', rotation: turn };
  }

  throw new Error(applied.json?.error || 'Could not save the rotation');
}

/** Adapts `useWorkspaceApi().api` (`{ res, json }`) to the shape above. */
export function fromWorkspaceApi(api) {
  return async (url, init) => {
    const { res, json } = await api(url, init);
    return { ok: Boolean(res?.ok), status: res?.status ?? 0, json };
  };
}
