/**
 * The members store exists to make N pickers behave like one list.
 *
 * These assert the two properties that the "+ add a member" button depends on
 * and that the old per-instance fetch did not have: concurrent readers cause
 * ONE request, and a refresh reaches every reader. The third is the rule that
 * predates the store — a failed fetch must leave the form usable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ok = (body: unknown) => ({ ok: true, json: async () => body });

async function freshStore() {
  vi.resetModules();
  return import('./useMembers');
}

describe('members store', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('collapses concurrent callers into a single request', async () => {
    const { loadMembers } = await freshStore();
    (fetch as any).mockResolvedValue(
      ok({ success: true, members: [{ id: 'a', name: 'Anita' }], canAddMembers: true }),
    );

    // Twenty Power Scan rows mounting in the same tick.
    const results = await Promise.all(Array.from({ length: 20 }, () => loadMembers()));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.members.length === 1)).toBe(true);
    expect(results[0].canAddMembers).toBe(true);
  });

  it('serves a loaded list from cache, and re-fetches when forced', async () => {
    const { loadMembers } = await freshStore();
    (fetch as any).mockResolvedValue(ok({ success: true, members: [], canAddMembers: false }));

    await loadMembers();
    await loadMembers();
    expect(fetch).toHaveBeenCalledTimes(1);

    await loadMembers({ maxAgeMs: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('notifies every subscriber when a refresh brings in a new member', async () => {
    const { loadMembers, subscribe } = await freshStore();
    (fetch as any).mockResolvedValue(ok({ success: true, members: [], canAddMembers: true }));
    await loadMembers();

    const seen: string[][] = [[], []];
    subscribe((s) => seen[0].push(...s.members.map((m) => m.name)));
    subscribe((s) => seen[1].push(...s.members.map((m) => m.name)));

    (fetch as any).mockResolvedValue(
      ok({ success: true, members: [{ id: 'b', name: 'Rajesh Kumar' }], canAddMembers: true }),
    );
    await loadMembers({ maxAgeMs: 0 });

    expect(seen[0]).toEqual(['Rajesh Kumar']);
    expect(seen[1]).toEqual(['Rajesh Kumar']);
  });

  it('keeps the list it had when a fetch fails, and never throws', async () => {
    const { loadMembers } = await freshStore();
    (fetch as any).mockResolvedValue(
      ok({ success: true, members: [{ id: 'a', name: 'Anita' }], canAddMembers: false }),
    );
    await loadMembers();

    (fetch as any).mockRejectedValue(new Error('offline'));
    const afterNetworkError = await loadMembers({ maxAgeMs: 0 });
    expect(afterNetworkError.members).toEqual([{ id: 'a', name: 'Anita' }]);

    (fetch as any).mockResolvedValue({ ok: false, json: async () => ({ error: 'nope' }) });
    const after403 = await loadMembers({ maxAgeMs: 0 });
    expect(after403.members).toEqual([{ id: 'a', name: 'Anita' }]);
  });

  it('keeps one list per workspace, and asks each for its own', async () => {
    // A company's picker listing the household — or another company's staff —
    // is the failure this guards: the lists must never bleed into each other.
    const { loadMembers, subscribe } = await freshStore();
    (fetch as any).mockImplementation(async (url: string) => ok(url.includes('companyId=acme')
      ? { success: true, members: [{ id: 'd', name: 'Director' }], canAddMembers: true }
      : { success: true, members: [{ id: 'h', name: 'Household' }], canAddMembers: true }));

    const acmeSeen: string[] = [];
    subscribe((snap) => acmeSeen.push(...snap.members.map((m) => m.name)), 'acme');

    const household = await loadMembers();
    const acme = await loadMembers({ companyId: 'acme' });

    expect(fetch).toHaveBeenCalledWith('/api/members');
    expect(fetch).toHaveBeenCalledWith('/api/members?companyId=acme');
    expect(household.members.map((m) => m.name)).toEqual(['Household']);
    expect(acme.members.map((m) => m.name)).toEqual(['Director']);
    // The company's subscriber heard only the company's list.
    expect(acmeSeen).toEqual(['Director']);
  });
});
