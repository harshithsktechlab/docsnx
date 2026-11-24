'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   CLIENT DOCUMENTS — /business/<companyId>/clients                       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * For agents, advisers, consultants and anyone who keeps documents for CLIENTS
 * as well as for their own company. Two kinds of client, one tab each:
 *
 *   Individual   a person — PAN card, policies, ITR, … (the personal subcategories)
 *   Company      a company — registration, GST, contracts, … (the business ones)
 *
 * A company keeps one kind, or both, and says which the first time this page is
 * opened (ClientTypeChooser; only a workspace admin can). Only the chosen kind(s)
 * are drawn: one kind has no tab strip at all, both have the two tabs. Until it is
 * chosen there is nothing else to do here.
 *
 * Each tab offers:
 *   Configure subcategories   choose which of those subcategories this company
 *                             actually uses for that kind of client
 *   Add client                basic info for a new client
 *
 * Nothing is ticked until the user configures it, so a first visit says so
 * rather than showing an empty page with no explanation.
 *
 * The clients are a LIST by name (A to Z, ordered by the API): Name, Contact number
 * and Email, the whole row opening the client. Contact number and email move under
 * the name on a narrow screen rather than disappearing. No identifiers (PAN, GSTIN)
 * are listed — they are on the client's own page.
 *
 * Not a permission anywhere: the company is in the path, and every request
 * re-proves it. The tab, the buttons and the empty states are courtesy.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Plus, Search, Settings2, UserRound, Building2, AlertTriangle, Users } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import PageContainer from '@/app/components/PageContainer';
import { useWorkspaceApi } from '@/lib/net/useWorkspaceApi';
import { clientGetMe, clientCan } from '@/lib/clientAuth';
import { CLIENT_MODULE_BY_TYPE } from '@/lib/clientCategories';
import ClientFormDialog from '@/app/components/clients/ClientFormDialog';
import ClientTypeChooser from '@/app/components/clients/ClientTypeChooser';

const TYPE_STORAGE_KEY = 'docsnx.clients.type';


export default function ClientsHome() {
  const { api, companyId } = useWorkspaceApi();
  const router = useRouter();
  const prefix = `/business/${companyId}`;

  const [user, setUser] = useState(null);
  const [type, setType] = useState('individual');
  const [query, setQuery] = useState('');
  const [clients, setClients] = useState(null);
  const [enabledCount, setEnabledCount] = useState(null);
  const [error, setError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  // Which kinds of client this company keeps: `null` while loading, otherwise
  // `{ chosen, individual, company, canChange }` from /api/clients/types.
  const [types, setTypes] = useState(null);
  const [changing, setChanging] = useState(false);

  // Remember the last tab. A per-viewer convenience, so a blocked or empty
  // storage simply means it opens on Individual.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(TYPE_STORAGE_KEY);
      if (saved === 'individual' || saved === 'company') setType(saved);
    } catch { /* storage unavailable */ }
  }, []);
  const chooseType = (next) => {
    setType(next);
    setQuery('');
    try { window.localStorage.setItem(TYPE_STORAGE_KEY, next); } catch { /* ignore */ }
  };

  useEffect(() => {
    let cancelled = false;
    clientGetMe().then((data) => { if (!cancelled && data?.success) setUser(data.user); });
    return () => { cancelled = true; };
  }, []);

  const loadTypes = useCallback(async () => {
    const { json } = await api('/api/clients/types');
    setTypes(json.success
      ? json
      : { chosen: false, individual: false, company: false, canChange: false, error: json.error || 'Could not load.' });
  }, [api]);
  useEffect(() => { loadTypes(); }, [loadTypes]);

  /** The kinds this company keeps, in tab order. */
  const available = useMemo(
    () => (types?.chosen ? ['individual', 'company'].filter((t) => types[t]) : []),
    [types],
  );
  // The remembered tab may be a kind that is not (or no longer) kept.
  useEffect(() => {
    if (available.length > 0 && !available.includes(type)) setType(available[0]);
  }, [available, type]);

  const moduleKey = CLIENT_MODULE_BY_TYPE[type];
  const canView = clientCan(user, moduleKey, null, 'view');
  const canAdd = clientCan(user, moduleKey, null, 'add');
  const canConfigure = clientCan(user, moduleKey, null, 'edit');

  const load = useCallback(async () => {
    // Nothing to load until the company has chosen, and never for a kind it does not keep.
    if (!available.includes(type)) return;
    setClients(null);
    setError('');
    const q = query.trim() ? `&q=${encodeURIComponent(query.trim())}` : '';
    const [list, config] = await Promise.all([
      api(`/api/clients?type=${type}${q}`),
      api(`/api/clients/subcategories?type=${type}`),
    ]);
    if (!list.json.success) { setError(list.json.error || 'Could not load clients.'); setClients([]); return; }
    setClients(list.json.clients || []);
    setEnabledCount(config.json.success ? config.json.enabledCount : null);
  }, [api, type, query, available]);

  // Debounced on the search box only; a tab change reloads at once because the
  // query is cleared with it.
  useEffect(() => {
    const t = setTimeout(load, query ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  const noun = type === 'company' ? 'company' : 'individual';
  const Icon = type === 'company' ? Building2 : UserRound;
  const needsConfig = enabledCount === 0;

  const rows = useMemo(() => clients || [], [clients]);

  return (
    <PageContainer className="gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-foreground">Client Documents</h1>
        <p className="text-sm text-muted-foreground">
          Documents you keep for your clients — individuals and companies — separate from this company&apos;s own.
        </p>
      </div>

      {/* Loading: nothing is drawn that might flash the wrong tabs. */}
      {types === null && <Skeleton className="h-24 rounded-xl" />}

      {/* Not chosen yet. A workspace admin picks; everyone else is told who can. */}
      {types && !types.chosen && (
        types.canChange ? (
          <ClientTypeChooser initial={types} onSaved={(saved) => setTypes(saved)} />
        ) : (
          <Card>
            <CardContent className="p-8 flex flex-col items-center gap-2 text-center">
              <span className="w-12 h-12 rounded-2xl bg-muted flex items-center justify-center text-muted-foreground"><Users size={22} /></span>
              <p className="font-semibold text-foreground">Client Documents is not set up yet</p>
              <p className="text-sm text-muted-foreground">
                {types.error || 'Ask a workspace admin to choose which kinds of client this company keeps — individuals, companies or both.'}
              </p>
            </CardContent>
          </Card>
        )
      )}

      {/* An admin changing the choice (the server refuses turning off a kind that has clients). */}
      {types?.chosen && changing && (
        <ClientTypeChooser
          initial={types}
          onCancel={() => setChanging(false)}
          onSaved={(saved) => { setTypes(saved); setChanging(false); }}
        />
      )}

      {types?.chosen && !changing && (
      <>
      {available.length > 1 ? (
        <Tabs value={type} onValueChange={chooseType}>
          <TabsList>
            <TabsTrigger value="individual" className="gap-1.5"><UserRound size={13} /> Individual</TabsTrigger>
            <TabsTrigger value="company" className="gap-1.5"><Building2 size={13} /> Company</TabsTrigger>
          </TabsList>
        </Tabs>
      ) : (
        <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <Icon size={13} /> {noun === 'company' ? 'Company' : 'Individual'} clients
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${noun} clients`}
            className="pl-9"
            aria-label={`Search ${noun} clients`}
          />
        </div>
        <div className="flex flex-wrap gap-2 ml-auto">
          {types?.canChange && (
            <Button variant="ghost" className="gap-2" onClick={() => setChanging(true)}>
              <Users size={15} /> Change client types
            </Button>
          )}
          {canConfigure && (
            <Button variant="outline" className="gap-2" onClick={() => router.push(`${prefix}/clients/configure?type=${type}`)}>
              <Settings2 size={15} /> Configure subcategories
              {enabledCount ? <span className="text-xs text-muted-foreground">({enabledCount})</span> : null}
            </Button>
          )}
          {canAdd && (
            <Button className="gap-2" onClick={() => setFormOpen(true)}>
              <Plus size={15} /> Add client
            </Button>
          )}
        </div>
      </div>

      {needsConfig && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="p-4 flex flex-wrap items-center gap-3">
            <AlertTriangle size={18} className="text-amber-500 shrink-0" />
            <p className="text-sm text-foreground flex-1 min-w-[220px]">
              No document types are selected for {noun} clients yet. Choose the ones you work with — only those are offered
              when you add or scan a client&apos;s documents.
            </p>
            {canConfigure && (
              <Button size="sm" onClick={() => router.push(`${prefix}/clients/configure?type=${type}`)}>Choose now</Button>
            )}
          </CardContent>
        </Card>
      )}

      {user && !canView && (
        <p className="text-sm text-muted-foreground">You do not have access to {noun} clients. Ask a workspace admin to grant it.</p>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {clients === null ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 rounded-lg" />)}
        </div>
      ) : rows.length === 0 && !error ? (
        <Card>
          <CardContent className="p-8 flex flex-col items-center gap-2 text-center">
            <span className="w-12 h-12 rounded-2xl bg-muted flex items-center justify-center text-muted-foreground"><Icon size={22} /></span>
            <p className="font-semibold text-foreground">{query ? 'No clients match your search' : `No ${noun} clients yet`}</p>
            {!query && canAdd && (
              <p className="text-sm text-muted-foreground">Add your first {noun} client to start filing their documents.</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="hidden md:table-cell">Contact number</TableHead>
                <TableHead className="hidden md:table-cell">Email</TableHead>
                <TableHead className="w-10"><span className="sr-only">Open</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => {
                const open = () => router.push(`${prefix}/clients/${c.id}`);
                return (
                  <TableRow
                    key={c.id}
                    tabIndex={0}
                    onClick={open}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
                    }}
                    className="cursor-pointer focus-visible:outline-none focus-visible:bg-primary/[0.09]"
                  >
                    <TableCell>
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0"><Icon size={15} /></span>
                        <div className="flex flex-col min-w-0">
                          <span className="font-semibold text-foreground truncate">{c.displayName}</span>
                          {/* Below `md` the other two columns are hidden, so what they would say sits here. */}
                          {(c.mobile || c.email) && (
                            <span className="md:hidden text-xs text-muted-foreground truncate">
                              {[c.mobile, c.email].filter(Boolean).join(' · ')}
                            </span>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-muted-foreground">
                      {c.mobile || <span aria-label="No contact number">—</span>}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-muted-foreground">
                      {c.email ? <span className="truncate">{c.email}</span> : <span aria-label="No email">—</span>}
                    </TableCell>
                    <TableCell className="text-right"><ChevronRight size={16} className="inline text-muted-foreground" /></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <ClientFormDialog open={formOpen} onOpenChange={setFormOpen} type={type} onSaved={load} />
      </>
      )}
    </PageContainer>
  );
}
