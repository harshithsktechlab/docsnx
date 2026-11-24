'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   CONFIGURE CLIENT SUBCATEGORIES — which documents do you keep?          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Individual clients list every PERSONAL subcategory (PAN card, passport, policies,
 * ITR…); company clients list every BUSINESS one (registration, GST, contracts…).
 * The user ticks the ones they actually work with and saves. Only ticked ones are
 * offered when adding or scanning a client's documents.
 *
 * Grouped by the module each derives from, with a Select-all per group, because a
 * 110-row flat checklist is not something anyone completes. Unticking never
 * touches documents already filed — it only stops the subcategory being offered.
 *
 * The page asks before throwing away unsaved ticks (tab switch, Cancel).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, Building2, Search, UserRound } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import PageContainer from '@/app/components/PageContainer';
import { useWorkspaceApi } from '@/lib/net/useWorkspaceApi';

export default function ClientConfigure({ initialType = 'individual' }) {
  const { api, companyId } = useWorkspaceApi();
  const router = useRouter();
  const back = `/business/${companyId}/clients`;

  const [type, setType] = useState(initialType === 'company' ? 'company' : 'individual');
  // Which kinds of client this company keeps. Only those can be configured, so only
  // those are offered; `null` while loading.
  const [types, setTypes] = useState(null);
  const [groups, setGroups] = useState(null);
  const [saved, setSaved] = useState(new Set());
  const [selected, setSelected] = useState(new Set());
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { json } = await api('/api/clients/types');
      if (!cancelled) setTypes(json.success ? json : { chosen: false, individual: false, company: false });
    })();
    return () => { cancelled = true; };
  }, [api]);

  const available = useMemo(
    () => (types?.chosen ? ['individual', 'company'].filter((t) => types[t]) : []),
    [types],
  );
  // Opened for a kind this company does not keep: go to one it does.
  useEffect(() => {
    if (available.length > 0 && !available.includes(type)) setType(available[0]);
  }, [available, type]);

  const load = useCallback(async (t) => {
    setGroups(null);
    setError('');
    const { json } = await api(`/api/clients/subcategories?type=${t}`);
    if (!json.success) { setError(json.error || 'Could not load the document types.'); setGroups([]); return; }
    const on = new Set(json.groups.flatMap((g) => g.items.filter((i) => i.enabled).map((i) => i.documentKey)));
    setGroups(json.groups);
    setSaved(on);
    setSelected(new Set(on));
  }, [api]);

  useEffect(() => { if (available.includes(type)) load(type); }, [load, type, available]);

  const dirty = useMemo(() => {
    if (saved.size !== selected.size) return true;
    for (const k of selected) if (!saved.has(k)) return true;
    return false;
  }, [saved, selected]);

  const confirmDiscard = () => !dirty || window.confirm('You have unsaved changes. Discard them?');

  const switchType = (next) => {
    if (next === type) return;
    if (!confirmDiscard()) return;
    setType(next);
    setFilter('');
  };

  const toggle = (key) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const toggleGroup = (group, on) => setSelected((prev) => {
    const next = new Set(prev);
    for (const item of group.items) { if (on) next.add(item.documentKey); else next.delete(item.documentKey); }
    return next;
  });

  const q = filter.trim().toLowerCase();
  const visible = useMemo(() => (groups || [])
    .map((g) => ({
      ...g,
      items: q && !g.moduleName.toLowerCase().includes(q)
        ? g.items.filter((i) => i.documentName.toLowerCase().includes(q))
        : g.items,
    }))
    .filter((g) => g.items.length > 0), [groups, q]);

  const save = async () => {
    setSaving(true);
    setError('');
    const { json } = await api(`/api/clients/subcategories?type=${type}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [...selected] }),
    });
    setSaving(false);
    if (!json.success) { setError(json.error || 'Could not save.'); return; }
    toast.success(`Saved — ${json.enabledCount} document type${json.enabledCount === 1 ? '' : 's'} selected.`);
    setSaved(new Set(selected));
    router.push(back);
  };

  const noun = type === 'company' ? 'company' : 'individual';

  return (
    <PageContainer className="gap-5 pb-24">
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => { if (confirmDiscard()) router.push(back); }}
          className="flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-primary w-fit"
        >
          <ArrowLeft size={12} /> Client Documents
        </button>
        <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-foreground">Configure document types</h1>
        <p className="text-sm text-muted-foreground">
          Tick the documents you keep for {noun} clients. Only these are offered when you add or scan a client&apos;s
          documents. Unticking a type never removes documents already filed under it.
        </p>
      </div>

      {available.length > 1 && (
        <Tabs value={type} onValueChange={switchType}>
          <TabsList>
            <TabsTrigger value="individual" className="gap-1.5"><UserRound size={13} /> Individual</TabsTrigger>
            <TabsTrigger value="company" className="gap-1.5"><Building2 size={13} /> Company</TabsTrigger>
          </TabsList>
        </Tabs>
      )}

      {types && available.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Choose which kinds of client this company keeps first — go back to Client Documents.
        </p>
      )}

      <div className="relative max-w-sm">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a document type" className="pl-9" aria-label="Find a document type" />
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {groups === null ? (
        // Nothing will ever load for a company that keeps no kind of client yet.
        types && available.length === 0 ? null : (
          <div className="flex flex-col gap-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 rounded-xl" />)}</div>
        )
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">{q ? 'No document types match.' : 'No document types are available.'}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {visible.map((g) => {
            // Counted over the group's FULL list, not the filtered view, so the
            // header tick means the same thing while a search is narrowing it.
            const full = groups.find((x) => x.moduleKey === g.moduleKey) || g;
            const on = full.items.filter((i) => selected.has(i.documentKey)).length;
            const all = on === full.items.length;
            return (
              <Card key={g.moduleKey}>
                <CardContent className="p-4 flex flex-col gap-3">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <Checkbox
                      checked={all ? true : on > 0 ? 'indeterminate' : false}
                      onCheckedChange={(v) => toggleGroup(full, v === true)}
                      aria-label={`Select all ${g.moduleName}`}
                    />
                    <span className="font-semibold text-foreground flex-1">{g.moduleName}</span>
                    <span className="text-xs text-muted-foreground">{on}/{full.items.length}</span>
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 pl-7">
                    {g.items.map((item) => (
                      <label key={item.documentKey} className="flex items-start gap-2.5 text-sm cursor-pointer">
                        <Checkbox
                          className="mt-0.5"
                          checked={selected.has(item.documentKey)}
                          onCheckedChange={() => toggle(item.documentKey)}
                        />
                        <span className="text-foreground/90">{item.documentName}</span>
                      </label>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <div className="fixed bottom-0 inset-x-0 z-30 border-t border-border bg-background/95 backdrop-blur px-4 py-3 flex items-center gap-3 justify-end">
        <span className="text-sm text-muted-foreground mr-auto">{selected.size} selected{dirty ? ' · unsaved changes' : ''}</span>
        <Button variant="outline" onClick={() => { if (confirmDiscard()) router.push(back); }} disabled={saving}>Cancel</Button>
        <Button onClick={save} disabled={saving || !dirty || groups === null || available.length === 0}>{saving ? 'Saving…' : 'Save'}</Button>
      </div>
    </PageContainer>
  );
}
