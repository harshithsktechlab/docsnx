'use client';

/**
 * One client: their basic info, then THEIR DOCUMENTS as the same table the Document
 * Manager shows (ClientDocuments). The "Sub-categories" button opens a page of every
 * document type with its count; "Add document" asks which type, then opens that
 * type's add form.
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, Building2, LayoutGrid, Pencil, RefreshCw, Settings2, Trash2, UserRound } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import PageContainer from '@/app/components/PageContainer';
import { useWorkspaceApi } from '@/lib/net/useWorkspaceApi';
import { clientGetMe, clientCan } from '@/lib/clientAuth';
import { CLIENT_MODULE_BY_TYPE } from '@/lib/clientCategories';
import ClientFormDialog from '@/app/components/clients/ClientFormDialog';
import ClientDocuments from '@/app/components/clients/ClientDocuments';
import ClientAddDocument from '@/app/components/clients/ClientAddDocument';

const LABELS = {
  dateOfBirth: 'Date of birth', mobile: 'Mobile', email: 'Email', panNumber: 'PAN', aadhaarNumber: 'Aadhaar',
  entityType: 'Entity type', registrationNumber: 'CIN / LLPIN', gstNumber: 'GSTIN', tanNumber: 'TAN',
  contactPerson: 'Contact person', address: 'Address', notes: 'Notes',
};

export default function ClientDetail() {
  const { clientId } = useParams();
  const { api, companyId } = useWorkspaceApi();
  const router = useRouter();
  const prefix = `/business/${companyId}`;

  const [user, setUser] = useState(null);
  const [client, setClient] = useState(null);
  const [groups, setGroups] = useState([]);
  const [state, setState] = useState('loading'); // loading | ready | denied
  const [editOpen, setEditOpen] = useState(false);
  // Filling blank details from the client's documents is in flight.
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    clientGetMe().then((d) => { if (!cancelled && d?.success) setUser(d.user); });
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async () => {
    const detail = await api(`/api/clients/${clientId}`);
    if (!detail.json.success) { setState('denied'); return; }
    const c = detail.json.client;
    setClient(c);
    const cfg = await api(`/api/clients/subcategories?type=${c.clientType}`);
    setGroups(cfg.json.success ? cfg.json.groups : []);
    setState('ready');
  }, [api, clientId]);

  useEffect(() => { load(); }, [load]);

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
    return <PageContainer className="gap-4"><Skeleton className="h-24 rounded-xl" /><Skeleton className="h-48 rounded-xl" /></PageContainer>;
  }

  const type = client.clientType;
  const moduleKey = CLIENT_MODULE_BY_TYPE[type];
  const canEdit = clientCan(user, moduleKey, null, 'edit');
  const canDelete = clientCan(user, moduleKey, null, 'delete');
  const Icon = type === 'company' ? Building2 : UserRound;
  const info = Object.entries(client.details || {}).filter(([, v]) => v);

  // Configuring comes first: with nothing ticked for this kind of client, no
  // document can be added — not even under Others — so the page says so and offers
  // the way forward instead of a grid of tiles that all refuse.
  const configuredCount = groups.reduce((n, g) => n + g.items.filter((i) => i.enabled).length, 0);
  const notConfigured = configuredCount === 0;

  const refresh = async () => {
    setRefreshing(true);
    const { json } = await api(`/api/clients/${clientId}/refresh`, { method: 'POST' });
    setRefreshing(false);
    if (!json.success) { toast.error(json.error || 'Could not update from documents.'); return; }
    if (json.filled?.length > 0) {
      toast.success(`Filled from documents: ${json.filled.join(', ')}.`);
      await load();
    } else {
      toast('Nothing new to fill in — the documents on file do not state anything this client is missing.');
    }
  };

  const remove = async () => {
    if (!window.confirm(`Remove ${client.displayName}? This cannot be undone.`)) return;
    const { json } = await api(`/api/clients/${clientId}`, { method: 'DELETE' });
    if (!json.success) { toast.error(json.error || 'Could not remove this client.'); return; }
    toast.success('Client removed.');
    router.push(`${prefix}/clients`);
  };

  return (
    <PageContainer className="gap-5">
      <div className="flex flex-col gap-2">
        <button type="button" onClick={() => router.push(`${prefix}/clients`)}
          className="flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-primary w-fit">
          <ArrowLeft size={12} /> Client Documents
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <span className="w-11 h-11 rounded-2xl bg-primary/10 text-primary flex items-center justify-center shrink-0"><Icon size={20} /></span>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-foreground truncate">{client.displayName}</h1>
            <p className="text-xs text-muted-foreground">{type === 'company' ? 'Company client' : 'Individual client'}</p>
          </div>
          <div className="flex gap-2">
            {canEdit && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={refresh} disabled={refreshing}
                title="Fill any blank details (PAN, date of birth, GSTIN…) from this client's documents">
                <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> Update from documents
              </Button>
            )}
            {canEdit && <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setEditOpen(true)}><Pencil size={13} /> Edit</Button>}
            {canDelete && <Button variant="outline" size="sm" className="gap-1.5 text-destructive" onClick={remove}><Trash2 size={13} /> Remove</Button>}
          </div>
        </div>
      </div>

      {info.length > 0 && (
        <Card>
          <CardContent className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3">
            {info.map(([k, v]) => (
              <div key={k} className="flex flex-col min-w-0">
                <span className="text-xs text-muted-foreground">{LABELS[k] || k}</span>
                <span className="text-sm text-foreground break-words whitespace-pre-wrap">{v}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold text-foreground">Documents</h2>
        <div className="flex items-center gap-2">
          {canEdit && (
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => router.push(`${prefix}/clients/configure?type=${type}`)}>
              <Settings2 size={13} /> Configure
            </Button>
          )}
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => router.push(`${prefix}/clients/${clientId}/subcategories`)}
            title="See every document type kept for this client">
            <LayoutGrid size={13} /> Sub-categories
          </Button>
          <ClientAddDocument
            clientId={clientId}
            companyId={companyId}
            groups={groups}
            canAdd={clientCan(user, moduleKey, null, 'add')}
            blockedMessage={notConfigured ? 'Choose the document types for this kind of client first (Configure).' : null}
          />
        </div>
      </div>

      {notConfigured && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="p-4 flex flex-wrap items-center gap-3">
            <p className="text-sm text-foreground flex-1 min-w-[220px]">
              Set up first: choose the document types you keep for {type === 'company' ? 'company' : 'individual'} clients.
              Documents can be added for {client.displayName} once that is done.
            </p>
            {canEdit && (
              <Button size="sm" onClick={() => router.push(`${prefix}/clients/configure?type=${type}`)}>Configure now</Button>
            )}
          </CardContent>
        </Card>
      )}

      <ClientDocuments client={client} user={user} />

      <ClientFormDialog open={editOpen} onOpenChange={setEditOpen} type={type} clientId={clientId} onSaved={load} />
    </PageContainer>
  );
}
