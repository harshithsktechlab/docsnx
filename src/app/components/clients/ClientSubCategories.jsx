'use client';

/**
 * All the sub-categories for ONE client, as a page of their own — the grid the
 * client page used to carry, now behind the "Sub-categories" button so the
 * documents table can come first.
 *
 * The tiles are the types this company has TICKED for this kind of client
 * (Configure), plus the catch-all, plus any un-ticked one that still holds
 * documents — hiding those would hide the documents. A tile opens the ordinary
 * sub-category workspace, scoped to this client by the path.
 */
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import PageContainer from '@/app/components/PageContainer';
import { useWorkspaceApi } from '@/lib/net/useWorkspaceApi';
import { CLIENT_CATCH_ALL_KEY } from '@/lib/clientCategories';

export default function ClientSubCategories() {
  const { clientId } = useParams();
  const { api, companyId } = useWorkspaceApi();
  const router = useRouter();
  const prefix = `/business/${companyId}`;

  const [client, setClient] = useState(null);
  const [counts, setCounts] = useState({});
  const [groups, setGroups] = useState([]);
  const [state, setState] = useState('loading'); // loading | ready | denied

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const detail = await api(`/api/clients/${clientId}`);
      if (cancelled) return;
      if (!detail.json.success) { setState('denied'); return; }
      const c = detail.json.client;
      const [cnt, cfg] = await Promise.all([
        api(`/api/clients/${clientId}/counts`),
        api(`/api/clients/subcategories?type=${c.clientType}`),
      ]);
      if (cancelled) return;
      setClient(c);
      setCounts(cnt.json.success ? cnt.json.counts : {});
      setGroups(cfg.json.success ? cfg.json.groups : []);
      setState('ready');
    })();
    return () => { cancelled = true; };
  }, [api, clientId]);

  const back = () => router.push(`${prefix}/clients/${clientId}`);

  if (state === 'denied') {
    return (
      <PageContainer className="max-w-lg py-16 items-center text-center gap-4">
        <h1 className="text-lg font-bold text-foreground">This client is not available</h1>
        <p className="text-sm text-muted-foreground">It may have been removed, or you may not have access to it.</p>
        <Button variant="outline" className="gap-2" onClick={() => router.push(`${prefix}/clients`)}><ArrowLeft size={14} /> Back to clients</Button>
      </PageContainer>
    );
  }
  if (state === 'loading' || !client) {
    return <PageContainer className="gap-4"><Skeleton className="h-16 rounded-xl" /><Skeleton className="h-48 rounded-xl" /></PageContainer>;
  }

  const tileGroups = groups
    .map((g) => ({ ...g, items: g.items.filter((i) => i.enabled || (counts[i.documentKey] || 0) > 0) }))
    .filter((g) => g.items.length > 0);
  const catchAllCount = counts[CLIENT_CATCH_ALL_KEY] || 0;
  const configured = groups.some((g) => g.items.some((i) => i.enabled));
  const open = (documentKey) => router.push(`${prefix}/clients/${clientId}/${documentKey}`);

  return (
    <PageContainer className="gap-5">
      <div className="flex flex-col gap-2">
        <button type="button" onClick={back}
          className="flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-primary w-fit">
          <ArrowLeft size={12} /> {client.displayName}
        </button>
        <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-foreground">Sub-categories</h1>
        <p className="text-xs text-muted-foreground">Every kind of document kept for {client.displayName}, with how many each holds.</p>
      </div>

      {tileGroups.map((g) => (
        <div key={g.moduleKey} className="flex flex-col gap-2">
          <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{g.moduleName}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {g.items.map((i) => (
              <Tile key={i.documentKey} name={i.documentName} count={counts[i.documentKey] || 0} muted={!i.enabled} onOpen={() => open(i.documentKey)} />
            ))}
          </div>
        </div>
      ))}

      {(configured || catchAllCount > 0) && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Other</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <Tile name="Others" count={catchAllCount} onOpen={() => open(CLIENT_CATCH_ALL_KEY)} />
          </div>
        </div>
      )}

      {!configured && catchAllCount === 0 && (
        <p className="text-sm text-muted-foreground">No document types are set up for this kind of client yet. Use Configure on the client page to choose them.</p>
      )}
    </PageContainer>
  );
}

function Tile({ name, count, muted = false, onOpen }) {
  return (
    <button type="button" onClick={onOpen}
      className="text-left rounded-xl border border-border bg-card p-3.5 flex items-center gap-3 hover:border-primary/50 hover:bg-accent/30 transition-colors">
      <span className="w-9 h-9 rounded-lg bg-muted text-muted-foreground flex items-center justify-center shrink-0"><FileText size={16} /></span>
      <span className="flex flex-col min-w-0 flex-1">
        <span className="text-sm font-semibold text-foreground truncate">{name}</span>
        {muted && <span className="text-2xs text-muted-foreground">Not currently selected</span>}
      </span>
      <span className="text-sm font-bold text-foreground">{count}</span>
    </button>
  );
}
