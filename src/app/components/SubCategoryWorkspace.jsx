'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE SUB-CATEGORY WORKSPACE — /modules/<moduleKey>/<documentKey>        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * One page for all 83 sub-categories. Clicking "PAN Card" in the sidebar now
 * lands on PAN Card as a PLACE — what is here, what is missing, what is about to
 * expire, and an add form that asks for a PAN — instead of on /documents with a
 * filter applied and a form belonging to the document manager.
 *
 * ── TWO TABS, IN THE ORDER PEOPLE ASK ──────────────────────────────────────
 * Summary answers "is anything wrong here?" — renewals, coverage gaps, records
 * with no scan. Files answers "show me the list". Summary is first because the
 * list is already one tap away and the warnings are not visible anywhere else.
 *
 * ── EVERYTHING IS DERIVED ──────────────────────────────────────────────────
 * The page knows nothing about PAN cards. Its heading, its form, its dedupe
 * rules and its stats all come from the taxonomy and from
 * `/api/modules/:moduleKey/:documentKey/*`. A category added to the master
 * table gets this page for free.
 *
 * ── THE FILE LIST ACTS ON RECORDS, IT DOES NOT ONLY LIST THEM ──────────────
 * Share / print / download / edit / delete, the same set the Document Manager
 * offers, because these are the same rows: a PAN card reached through the
 * sidebar is the record reached through /documents. A list that could only open
 * and delete sent people back to the Document Manager to do anything else.
 *
 * All of it reuses `sharePrintHelper` — `shareRecords` hands the actual file to
 * the OS share sheet where the browser supports it (Android, iOS, Edge) and
 * degrades to a text sheet and then the clipboard, and `printRecords` composes
 * one print job instead of framing a route the browser refuses to frame.
 *
 * ── PERMISSIONS ────────────────────────────────────────────────────────────
 * The API is the authority: it 403s a sub-category this member may not view.
 * That is rendered as an explicit no-access state, NOT as an empty list — an
 * empty list would read as "you have no PAN cards", which is a different and
 * misleading statement. Add and Delete are hidden by `clientCan`, and refused
 * again server-side.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  AlertCircle, AlertTriangle, ArrowLeft, CalendarClock, ChevronRight, Clock,
  Download, Eye, FileText, FolderOpen, HardDrive, Loader2, Lock,
  Pencil, Plus, Printer, Share2, ShieldAlert, Trash2, Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { DataTable } from '@/components/ui/data-table';
import RowActionsMenu from '@/components/ui/row-actions-menu';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/dateHelper';
import { clientGetMe, clientCan } from '@/lib/clientAuth';
import {
  downloadRecord, getFileUrl, printRecords, shareRecords, warmShare,
} from '@/lib/sharePrintHelper';
import { reportShareResult } from '@/lib/shareToast';
import { apiRequest } from '@/lib/net/apiRequest';
import { toastApiError } from '@/lib/net/toastApiError';
import FilePreviewPane from '@/components/records/FilePreviewPane';
import { CUSTOM_FIELDS_KEY } from '@/lib/records/fieldValidation';
import { LINKED_CARDS_KEY } from '@/lib/records/linkedCards';
import { MODULE_COLORS, DEFAULT_MODULE_COLOR } from '@/lib/documentCategories';
import { scopeForCategory } from '@/lib/records/registry';
import { MODULE_BASE, ALL_NAV_MODULES } from '@/lib/moduleRegistry';
import CategoryRecordForm from '@/app/components/CategoryRecordForm';
import PageContainer from '@/app/components/PageContainer';
import MobileActionFab from '@/app/components/MobileActionFab';


/** Bytes as something a person reads without counting zeroes. */
function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function StatTile({ icon: Icon, label, value, tone = 'default', hint }) {
  return (
    <div className={cn(
      'flex flex-col gap-1 rounded-xl border p-3 sm:p-4',
      tone === 'warn'
        ? 'border-amber-500/30 bg-amber-500/5'
        : tone === 'danger'
          ? 'border-destructive/30 bg-destructive/5'
          : 'border-border/50 bg-card',
    )}
    >
      <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">
        <Icon size={12} />
        {label}
      </span>
      <span className={cn(
        'text-xl sm:text-2xl font-black tabular-nums',
        tone === 'warn' ? 'text-amber-500' : tone === 'danger' ? 'text-danger-text' : 'text-foreground',
      )}
      >
        {value}
      </span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

/**
 * Serves BOTH `/modules/<m>/<d>` and `/business/<companyId>/modules/<m>/<d>`.
 *
 * One component, two routes. The list, the form, the summary, the upload and
 * every permission check are identical between the personal and the business
 * workspace — only the taxonomy half the category comes from differs, and
 * whether a company qualifies the request. `companyId` arrives through
 * `useParams`, so it is simply absent on the personal route.
 */
export default function SubCategoryWorkspace() {
  const { moduleKey, documentKey, companyId } = useParams();
  /**
   * Appended to every request this page makes.
   *
   * The server refuses a mismatch outright — a business module with no company
   * and a personal module with one are both 400s — so this is not a filter that
   * can be forgotten into a wrong-but-plausible result.
   */
  const companyParam = companyId ? `companyId=${encodeURIComponent(companyId)}` : '';
  /** Prefix for every link out of this page. */
  const prefix = companyId ? `/business/${companyId}` : '';
  const router = useRouter();
  const searchParams = useSearchParams();

  const [user, setUser] = useState(null);
  const [summary, setSummary] = useState(null);
  const [records, setRecords] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, totalCount: 0 });
  const [loadingList, setLoadingList] = useState(true);
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [denied, setDenied] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [formHolder, setFormHolder] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  /** The row whose "more actions" menu is open, if any. */
  /** The category's field spec — used for the LABELS a share sheet carries. */
  const [fieldSpecs, setFieldSpecs] = useState([]);
  /** The record open in the preview modal. The bytes are FilePreviewPane's. */
  const [previewRecord, setPreviewRecord] = useState(null);

  const tab = searchParams.get('tab') === 'files' ? 'files' : 'summary';
  const colors = MODULE_COLORS[moduleKey] || DEFAULT_MODULE_COLOR;

  // The scope owns the single-record endpoints (`/api/records/:scope/:id/...`).
  // Derived on the client from the same registry the server uses, so there is no
  // extra round trip just to address a record. NOT used to build file URLs: the
  // list already returns a `filePath` resolved against the scope that OWNS the
  // category, which need not be this page's (see records/fileUrl.ts).
  const scope = useMemo(
    () => scopeForCategory({ moduleKey, documentKey }),
    [moduleKey, documentKey],
  );

  const canAdd = clientCan(user, moduleKey, documentKey, 'add');
  const canEdit = clientCan(user, moduleKey, documentKey, 'edit');
  const canDelete = clientCan(user, moduleKey, documentKey, 'delete');
  // Taking a copy out is what `share` governs — see the file route. A view-only
  // member previews the document and is offered no download.
  const canShare = clientCan(user, moduleKey, documentKey, 'share');

  useEffect(() => {
    (async () => {
      const me = await clientGetMe();
      if (me.success) setUser(me.user);
    })();
  }, []);

  // Viewing happens HERE, not in a new tab: the row already knows the record,
  // and a tab hand-off loses that context and lands people on a bare file.
  //
  // The fetch, the blob, the decryption spinner and the renderer choice all
  // live in FilePreviewPane now — this page had a second copy of every one of
  // them, and the Document Manager a third. These are the same records shown
  // the same way; they should not be two implementations that drift.

  /** A 403 is a permission, a 404 is a bad URL — they read very differently. */
  const noteFailure = (status) => {
    if (status === 403) setDenied(true);
    if (status === 404) setNotFound(true);
  };

  const loadList = useCallback(async () => {
    setLoadingList(true);
    try {
      const qs = new URLSearchParams(window.location.search);
      qs.delete('tab');
      if (companyParam) qs.set('companyId', companyId);
      const outcome = await apiRequest(`/api/modules/${moduleKey}/${documentKey}?${qs.toString()}`);
      if (!outcome.ok) {
        // 403 and 404 are answered by the page itself — a permission wall and a
        // category that does not exist both render a whole screen, and a toast
        // on top of that screen says the same thing twice.
        if (outcome.kind === 'http' && (outcome.status === 403 || outcome.status === 404)) {
          noteFailure(outcome.status);
          return;
        }
        toastApiError(outcome, { subject: 'records', action: 'loading these records' });
        return;
      }
      const json = outcome.json;
      setRecords(json.records || []);
      if (json.pagination) setPagination(json.pagination);
    } catch (err) {
      // `apiRequest` does not throw; reaching here means the block above did.
      console.error('[module list] load threw', err);
      toast.error('Something went wrong loading these records.');
    } finally {
      setLoadingList(false);
    }
  }, [moduleKey, documentKey, searchParams]);

  const loadSummary = useCallback(async () => {
    setLoadingSummary(true);
    try {
      const outcome = await apiRequest(
        `/api/modules/${moduleKey}/${documentKey}/summary${companyParam ? `?${companyParam}` : ''}`);
      // Deliberately silent on failure, as before: the list still renders, and
      // a missing summary card is not worth a second toast beside the one
      // `loadList` has almost certainly already raised for the same cause.
      if (!outcome.ok) {
        if (outcome.kind === 'http' && (outcome.status === 403 || outcome.status === 404)) {
          noteFailure(outcome.status);
        }
        return;
      }
      setSummary(outcome.json);
    } catch (err) {
      console.error('[module list] summary threw', err);
    } finally {
      setLoadingSummary(false);
    }
  }, [moduleKey, documentKey]);

  useEffect(() => { loadList(); }, [loadList]);
  // A company renamed from a "Belongs to" picker: the rows name it through a
  // live join, so re-reading them is the whole fix.
  useEffect(() => {
    if (!companyId) return undefined;
    window.addEventListener('docsnx:companies-changed', loadList);
    return () => window.removeEventListener('docsnx:companies-changed', loadList);
  }, [companyId, loadList]);
  useEffect(() => { loadSummary(); }, [loadSummary]);

  /**
   * The category's declared fields, for their LABELS.
   *
   * A record carries its values under taxonomy keys (`pan_number`), and a share
   * sheet reading "pan_number: ABCDE1234F" is a leak of our schema, not a
   * description of the document. The same endpoint the add form uses answers
   * with the labels a person wrote.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const outcome = await apiRequest(
          `/api/modules/${moduleKey}/${documentKey}/fields${companyParam ? `?${companyParam}` : ''}`);
        // Genuinely silent: labels fall back to the field key and nothing else
        // on the page needs them, so a failure here is invisible by design
        // rather than by omission.
        if (!cancelled && outcome.ok && outcome.json?.success) {
          setFieldSpecs(outcome.json.fields || []);
        }
      } catch (err) {
        console.error('[module list] field labels threw', err);
      }
    })();
    return () => { cancelled = true; };
  }, [moduleKey, documentKey]);

  /**
   * What to head the Number column with.
   *
   * The first field this category calls an identifier, under the label an
   * operator wrote — so a PAN card's column says "PAN" and a GST return's says
   * "ARN". `isIdentifier` is stamped onto the spec by `loadCategoryFieldSpec`
   * before `/fields` returns it, and an operator's override is already applied,
   * so turning an identifier off on /admin/document-fields moves this heading
   * with it.
   *
   * "Number" for a category that declares none, and while the spec is still
   * loading — a heading that appears late is better than one that changes.
   */
  const numberLabel = useMemo(() => {
    const identifier = fieldSpecs.find((f) => f.isIdentifier);
    return identifier?.fieldLabel || 'Number';
  }, [fieldSpecs]);

  const setTab = (next) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'summary') params.delete('tab'); else params.set('tab', next);
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  const openForm = (holderId = '') => {
    setEditingId(null);
    setFormHolder(holderId);
    setFormOpen(true);
  };

  /**
   * Edit a record in the same generated form that added it.
   *
   * The form seeds itself from `/api/modules/:m/:d/:id`, NOT from the row handed
   * to it: a row carries masks where the sealed values are, and saving those
   * back would overwrite the real ones. See CategoryRecordForm.
   */
  const openEdit = (record) => {
    setFormHolder('');
    setEditingId(record.id);
    setFormOpen(true);
  };

  /**
   * Follow a summary row to the record it is about.
   *
   * The Summary's job is to point at something; a row that names a document
   * about to expire and then does nothing when clicked makes the reader hunt
   * for it in the Files list by hand. Switching tabs and filtering to that one
   * record is the shortest honest answer — the record's own id goes into the
   * table's search box, which the DataTable already reads from the URL.
   */
  const openRecord = (recordId) => {
    const record = records.find((r) => r.id === recordId);
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', 'files');
    if (record?.title) params.set('search', record.title);
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  const remove = async (record) => {
    if (!window.confirm(`Delete "${record.title}"? It moves to deleted records.`)) return;
    setBusyId(record.id);
    try {
      const outcome = await apiRequest(
        `/api/records/${scope}/${record.id}${companyParam ? `?${companyParam}` : ''}`,
        { method: 'DELETE' });
      if (!outcome.ok) {
        // "Could not delete this record" covered a locked vault, an expired
        // session and a phone with no signal — three different next steps, and
        // on a destructive action the user needs to know which one applies
        // before deciding whether the record is actually still there.
        toastApiError(outcome, { subject: 'record', action: 'deleting this record' });
        return;
      }
      toast.success('Record deleted');
      loadList();
      loadSummary();
    } finally {
      setBusyId(null);
    }
  };

  const categoryName = summary?.category?.documentName || String(documentKey).replace(/_/g, ' ');
  /**
   * The module in the URL — where the breadcrumb goes back to.
   *
   * Deliberately NOT `summary.category.moduleName`: that is the module the
   * records are STORED in, which for a mirrored category is a different one
   * (src/lib/categoryMirrors.ts). Reached through /modules/vehicle, the
   * breadcrumb has to say Vehicle and return there; whose records these really
   * are is said on its own line below.
   */
  const moduleName = ALL_NAV_MODULES.find((m) => m.key === moduleKey)?.name
    || String(moduleKey).replace(/_/g, ' ');

  /**
   * The other module this category is listed in, worded from where the reader
   * is standing: on the mirror address it names the module that OWNS the
   * records, and on the canonical it names the module they also appear in.
   * Null for the ordinary category, which is all but one of them.
   */
  const sharedWith = useMemo(() => {
    const category = summary?.category;
    if (!category?.sharedWith?.length) return null;
    const here = category.sharedWith.find((m) => m.moduleKey === moduleKey);
    const nameFor = (key) => ALL_NAV_MODULES.find((m) => m.key === key)?.name
      || String(key).replace(/_/g, ' ');
    // Standing ON a mirror address: the records belong to the canonical module.
    if (here) return { moduleName: nameFor(category.moduleKey), owns: true };
    // Standing on the canonical: they are also listed in each mirror's module.
    return { moduleName: nameFor(category.sharedWith[0].moduleKey), owns: false };
  }, [summary, moduleKey]);

  /**
   * What a share sheet, a print-out or an exported PDF says about a record.
   *
   * The OPEN tier and the MASKS, and nothing else. A record's sealed values —
   * the Aadhaar number, the date of birth — are not in the list response at all
   * and are not fetched here on purpose: `/reveal` is an audited, deliberate
   * act, and "share this document" is not a request to decrypt its identifiers
   * into a WhatsApp message. The attached FILE still goes with the share, which
   * is what people actually mean.
   */
  const recordFields = useCallback((record) => {
    const open = record.fields || {};
    const masked = record.masked || {};
    const out = [];
    /**
     * The two JSON blobs, neither of which is a fact to print.
     *
     * `cards` matters more than it looks: it is the debit and credit cards on
     * a bank account, numbers included. It reaches a list row only if a stale
     * open-tier copy exists — it is sealed — and printing it as raw JSON on
     * the strength of that would be the worst possible way to find out.
     */
    const seen = new Set([CUSTOM_FIELDS_KEY, LINKED_CARDS_KEY]);

    // Spec order first, so two records of the same category read the same way.
    //
    // MASKED BEFORE OPEN, matching `primaryIdentifier` and the Document
    // Manager's `documentFieldList`. This read them the other way round, so a
    // record holding both a mask and a STALE open-tier copy of a key that has
    // since been sealed shared the plaintext — from the one surface whose whole
    // job is to hand the record to someone else.
    for (const spec of fieldSpecs) {
      const key = spec.fieldKey;
      if (seen.has(key)) continue;
      seen.add(key);
      const value = masked[key] ?? open[key];
      if (value === undefined || value === null || value === '') continue;
      out.push({ label: spec.fieldLabel || key, value: String(value) });
    }
    // Anything the spec no longer declares but the record still holds. Masked
    // spread LAST, so it wins here for the same reason.
    for (const [key, value] of Object.entries({ ...open, ...masked })) {
      if (seen.has(key) || value === undefined || value === null || value === '') continue;
      seen.add(key);
      out.push({ label: key.replace(/_/g, ' '), value: String(value) });
    }

    // The server's answer, which knows a business record belongs to the COMPANY
    // — its `holder_id` is null by design and the old expression here read that
    // as 'All members'. See holderDisplayName.
    out.push({ label: 'Belongs to', value: record.display?.holderName || '' });
    return out.filter((f) => f.value !== '');
  }, [fieldSpecs]);

  /** The shape `shareRecords`/`printRecords` read a record as. */
  const shareItem = useCallback((record) => ({
    title: record.title,
    fields: recordFields(record),
    filePath: record.filePath,
    fileName: record.fileName,
    mimeType: record.mimeType,
    // A scanned record is stored as pages; without this only the first sheet
    // reaches the share sheet.
    pageCount: record.pageCount,
  }), [recordFields]);

  const share = async (record) => {
    // Hands the FILE to the OS share sheet where the browser allows it, and
    // falls back to a text sheet and then the clipboard where it does not.
    reportShareResult(await shareRecords([shareItem(record)]));
  };

  // Not `print` — that shadows window.print, which is what the iframe below
  // eventually calls.
  const printRow = async (record) => {
    await printRecords([shareItem(record)]);
  };

  // The pane resets itself when the record changes — there is no local blob or
  // error to clear here any more.
  const openPreview = (record) => setPreviewRecord(record);

  const download = async (record) => {
    if (!record.filePath) {
      // No attachment: the record's own details, as a PDF.
      await downloadRecord(`${categoryName} - ${record.title}`, recordFields(record));
      return;
    }
    // `?download=1` makes the file route send Content-Disposition with the
    // stored filename — a vault path carries no extension, so a link without it
    // saves as "file". getFileUrl still has to run: legacy rows hold /uploads/.
    const href = new URL(getFileUrl(record.filePath), window.location.origin);
    href.searchParams.set('download', '1');
    const a = document.createElement('a');
    a.href = href.toString();
    a.download = record.fileName || record.title || 'document';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };


  // ── No access / bad URL ───────────────────────────────────────────────────
  if (denied || notFound) {
    return (
      <PageContainer className="max-w-lg py-16 items-center text-center gap-4">
        <span className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center text-muted-foreground">
          {denied ? <ShieldAlert size={24} /> : <FolderOpen size={24} />}
        </span>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-lg font-bold text-foreground">
            {denied ? 'You do not have access to this sub-category' : 'No such sub-category'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {denied
              ? 'Ask a workspace admin to grant you access to it under Members → Permissions.'
              : 'The link may be out of date. Pick a sub-category from the sidebar to continue.'}
          </p>
        </div>
        <Button variant="outline" onClick={() => router.push(`${prefix}/dashboard`)} className="gap-2">
          <ArrowLeft size={14} /> Back to dashboard
        </Button>
      </PageContainer>
    );
  }

  return (
    <PageContainer className="gap-5">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span
            className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0"
            style={{ color: colors.fg, backgroundColor: colors.bg }}
          >
            <FileText size={18} />
          </span>
          <div className="flex flex-col min-w-0">
            <button
              onClick={() => router.push(`${prefix}${MODULE_BASE}/${moduleKey}`)}
              className="flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-primary transition-colors w-fit"
            >
              {moduleName}
              <ChevronRight size={11} />
            </button>
            <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-foreground capitalize truncate">
              {categoryName}
            </h1>
            {/* One record, two modules. Said here so an edit made from this side
                is not a surprise on the other. */}
            {sharedWith && (
              <p className="text-xs text-muted-foreground">
                {sharedWith.owns
                  ? `These are ${sharedWith.moduleName}'s records, shown here too — an edit changes the same record in both.`
                  : `Also listed under ${sharedWith.moduleName} — the same records, not a copy.`}
              </p>
            )}
          </div>
        </div>

        {canAdd && (
          <Button onClick={() => openForm()} className="gap-2 hidden sm:flex">
            <Plus size={15} /> Add {categoryName.toLowerCase()}
          </Button>
        )}
      </div>

      {/* ── Tabs ── */}
      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList className="w-full sm:w-auto grid grid-cols-2 sm:flex">
          <TabsTrigger value="summary">Summary</TabsTrigger>
          <TabsTrigger value="files">
            Files
            {pagination.totalCount > 0 && (
              <span className="ml-1.5 text-xs font-bold opacity-70">{pagination.totalCount}</span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ── SUMMARY ── */}
        <TabsContent value="summary" className="mt-4 flex flex-col gap-4">
          {loadingSummary ? (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
            </div>
          ) : !summary ? (
            <Card className="border-border/50">
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                Summary unavailable right now. The file list below still works.
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <StatTile icon={FileText} label="Records" value={summary.counts.total} />
                <StatTile
                  icon={FolderOpen}
                  label="With a scan"
                  value={summary.counts.withFile}
                  hint={`${summary.counts.pages} page${summary.counts.pages === 1 ? '' : 's'} stored`}
                />
                <StatTile
                  icon={AlertTriangle}
                  label="No scan yet"
                  value={summary.counts.dataOnly}
                  tone={summary.counts.dataOnly > 0 ? 'warn' : 'default'}
                  hint={summary.counts.dataOnly > 0 ? 'Details entered, document not uploaded' : 'Every record has its document'}
                />
                <StatTile
                  icon={HardDrive}
                  label="Storage"
                  value={formatBytes(summary.counts.storageBytes)}
                  hint={`${summary.counts.addedLast30Days} added in 30 days`}
                />
              </div>

              {/*
                * Equal-height cards in a two-column grid.
                *
                * `auto-rows-fr` matters: the coverage card is absent for a
                * household category (warranties, rentals), which left the grid
                * with three items — one stretched across a full row and one
                * half-width beside a gap. Uniform rows make any count read as a
                * deliberate layout rather than a broken one.
                */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 auto-rows-fr">
                {/* Renewals & expiry */}
                <Card className="border-border/50 bg-card flex flex-col">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-bold flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <CalendarClock size={15} className="text-primary" />
                        Renewals &amp; expiry
                      </span>
                      {summary.renewals.next.length > 0 && (
                        <button
                          onClick={() => setTab('files')}
                          className="text-xs font-semibold text-primary hover:underline"
                        >
                          View all
                        </button>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3 flex-1">
                    {!summary.renewals.available ? (
                      <p className="text-xs text-muted-foreground">
                        Could not read renewal dates just now — this does not mean nothing is due.
                      </p>
                    ) : (
                      <>
                        <div className="grid grid-cols-4 gap-2 text-center">
                          <div className="flex flex-col">
                            <span className={cn(
                              'text-lg font-black tabular-nums',
                              summary.renewals.overdue > 0 ? 'text-danger-text' : 'text-muted-foreground',
                            )}
                            >
                              {summary.renewals.overdue}
                            </span>
                            <span className="text-xs font-semibold uppercase text-muted-foreground">Overdue</span>
                          </div>
                          {[30, 60, 90].map((days) => (
                            <div key={days} className="flex flex-col">
                              <span className="text-lg font-black tabular-nums text-foreground">
                                {summary.renewals.dueWithin?.[days] ?? 0}
                              </span>
                              <span className="text-xs font-semibold uppercase text-muted-foreground">
                                {days}d
                              </span>
                            </div>
                          ))}
                        </div>

                        {summary.renewals.next.length === 0 ? (
                          <p className="text-xs text-muted-foreground">Nothing here carries a renewal date.</p>
                        ) : (
                          <div className="flex flex-col gap-1.5">
                            {/*
                              * The DOCUMENT leads. Previously this rendered the
                              * server's prose — "Rent Agreement: contract ends is
                              * overdue by 104 days" — which buried the record's
                              * name mid-sentence and went nowhere when clicked.
                              */}
                            {summary.renewals.next.map((item) => (
                              <button
                                key={item.id}
                                onClick={() => openRecord(item.recordId)}
                                className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/30 px-3 py-2 text-left hover:border-primary/40 hover:bg-muted/30 transition-colors"
                              >
                                <span className="flex min-w-0 flex-col gap-0.5">
                                  <span className="truncate text-xs font-bold text-foreground">
                                    {item.recordTitle}
                                  </span>
                                  {/*
                                    * `min-w-0` is the whole reason the badge no
                                    * longer sits ON the holder name. This row is
                                    * a nested flex container, so its automatic
                                    * `min-width: auto` was its MIN-CONTENT width:
                                    * the column above it shrank, this row did not,
                                    * and its tail ran out past the column's right
                                    * edge and under the `shrink-0` badge. Wrapping
                                    * rather than truncating keeps the field label
                                    * — "Policy renewal date" — readable on a phone.
                                    */}
                                  <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                                    <span className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-semibold">
                                      {item.fieldLabel}
                                    </span>
                                    <span>{formatDate(item.dueDate)}</span>
                                    {item.holderName && (
                                      <span className="min-w-0 max-w-full truncate">· {item.holderName}</span>
                                    )}
                                  </span>
                                </span>
                                <Badge
                                  variant={item.daysLeft < 0 ? 'destructive' : 'secondary'}
                                  className="shrink-0 text-2xs"
                                >
                                  {item.daysLeft < 0
                                    ? `${Math.abs(item.daysLeft)}d overdue`
                                    : item.daysLeft === 0
                                      ? 'today'
                                      : `in ${item.daysLeft}d`}
                                </Badge>
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </CardContent>
                </Card>

                {/* Member coverage — only where a record belongs to a person. */}
                {summary.coverage && (
                  <Card className="border-border/50 bg-card flex flex-col">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-bold flex items-center gap-2">
                        <Users size={15} className="text-primary" />
                        Member coverage
                        <span className="ml-auto text-xs font-bold text-muted-foreground tabular-nums">
                          {summary.coverage.coveredMembers} / {summary.coverage.totalMembers}
                        </span>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-2 flex-1">
                      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-primary transition-all"
                          style={{
                            width: `${summary.coverage.totalMembers > 0
                              ? (summary.coverage.coveredMembers / summary.coverage.totalMembers) * 100
                              : 0}%`,
                          }}
                        />
                      </div>
                      {summary.coverage.missing.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Everyone in the workspace has one on file.
                        </p>
                      ) : (
                        <>
                          <p className="text-xs text-muted-foreground">
                            No {categoryName.toLowerCase()} on file for:
                          </p>
                          <div className="flex flex-col gap-1.5">
                            {summary.coverage.missing.map((member) => (
                              <div
                                key={member.id}
                                className="flex items-center justify-between gap-2 rounded-lg border border-border/40 bg-background/30 px-3 py-2"
                              >
                                <span className="truncate text-xs font-semibold text-foreground/90">
                                  {member.name}
                                </span>
                                {canAdd && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 shrink-0 gap-1 text-xs"
                                    onClick={() => openForm(member.id)}
                                  >
                                    <Plus size={11} /> Add
                                  </Button>
                                )}
                              </div>
                            ))}
                          </div>
                          {summary.coverage.coversAllMembers && (
                            <p className="text-xs text-faint">
                              Some records here are filed for all members rather than one member.
                            </p>
                          )}
                        </>
                      )}
                    </CardContent>
                  </Card>
                )}

                {/* Needs attention */}
                <Card className="border-border/50 bg-card flex flex-col">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-bold flex items-center gap-2">
                      <AlertTriangle size={15} className="text-amber-500" />
                      Needs attention
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3 flex-1">
                    {summary.attention.noFile.length === 0 && summary.attention.stale.length === 0 ? (
                      <p className="text-xs text-muted-foreground">Nothing needs attention here.</p>
                    ) : (
                      <>
                        {summary.attention.noFile.length > 0 && (
                          <div className="flex flex-col gap-1">
                            <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                              No document attached
                            </span>
                            {summary.attention.noFile.map((r) => (
                              <button
                                key={r.id}
                                onClick={() => openRecord(r.id)}
                                className="truncate text-left text-xs text-foreground/85 hover:text-primary"
                              >
                                • {r.title}
                              </button>
                            ))}
                          </div>
                        )}
                        {summary.attention.stale.length > 0 && (
                          <div className="flex flex-col gap-1">
                            <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                              Not updated in over a year
                            </span>
                            {summary.attention.stale.map((r) => (
                              <button
                                key={r.id}
                                onClick={() => openRecord(r.id)}
                                className="truncate text-left text-xs text-foreground/85 hover:text-primary"
                              >
                                • {r.title} ({r.daysSinceUpdate} days)
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </CardContent>
                </Card>

                {/* Recent activity */}
                <Card className="border-border/50 bg-card flex flex-col">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-bold flex items-center gap-2">
                      <Clock size={15} className="text-primary" />
                      Recently added
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex-1">
                    {summary.recent.length === 0 ? (
                      <p className="text-xs text-muted-foreground">Nothing here yet.</p>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {summary.recent.map((r) => (
                          <button
                            key={r.id}
                            onClick={() => openRecord(r.id)}
                            className="flex items-center justify-between gap-2 text-left hover:text-primary"
                          >
                            <span className="truncate text-xs font-medium text-foreground/90">{r.title}</span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {formatDate(r.createdAt)}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            </>
          )}
        </TabsContent>

        {/* ── FILES ── */}
        <TabsContent value="files" className="mt-4">
          <DataTable
            data={records}
            loading={loadingList}
            pagination={pagination}
            emptyMessage={`No ${categoryName.toLowerCase()} records yet.`}
            filterDefinitions={[
              {
                key: 'holderId',
                label: 'Belongs to',
                options: (summary?.coverage
                  ? [{ value: 'none', label: 'All members' }]
                  : []),
              },
            ].filter((f) => f.options.length > 0)}
            columns={[
              {
                header: 'Record',
                key: 'title',
                render: (r) => (
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-xs font-bold text-foreground truncate">{r.title}</span>
                    <span className="text-xs text-muted-foreground truncate">
                      {r.fileName || 'No document attached'}
                    </span>
                  </div>
                ),
              },
              {
                /**
                 * The category's OWN word for its number — "PAN", "ARN", "GSTIN".
                 *
                 * The Document Manager heads this column "Number" because it
                 * spans 84 sub-categories and cannot name one. This page shows
                 * exactly one, so every row's number is the same kind of thing
                 * and the column can say which. Read from the SPEC rather than
                 * from the rows, so the heading does not change when the list is
                 * empty or filtered down to a record that left the field blank.
                 */
                header: numberLabel,
                key: 'number',
                render: (r) => (
                  <span className="text-xs font-medium">{r.display?.number || '—'}</span>
                ),
              },
              {
                header: 'Belongs to',
                key: 'holder',
                render: (r) => (
                  <span className="text-xs text-muted-foreground">
                    {/* Derived server-side by `holderDisplayName`, which knows a
                        business record belongs to the company. This used to read
                        the columns directly and answered 'All members' for one. */}
                    {r.display?.holderName || '—'}
                  </span>
                ),
              },
              {
                header: 'Pages',
                key: 'pageCount',
                render: (r) => <span className="text-xs tabular-nums">{r.pageCount || '—'}</span>,
              },
              {
                header: 'Added',
                key: 'createdAt',
                render: (r) => (
                  <span className="text-xs text-muted-foreground">{formatDate(r.createdAt)}</span>
                ),
              },
              {
                header: '',
                key: 'actions',
                render: (r) => (
                  <div className="flex items-center justify-end gap-1.5">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 border-primary/20 bg-primary/5 text-primary hover:bg-primary/10 hover:text-primary"
                      title="Share"
                      onClick={() => share(r)}
                      // Fetches the file on press rather than on click, so
                      // `navigator.share()` still holds its user activation when
                      // the handler reaches it. See warmShare.
                      onPointerDown={() => warmShare([shareItem(r)])}
                    >
                      <Share2 size={13} />
                    </Button>
                    {/* Gated on the file the same way the mobile card's Open is:
                        a record with no scan has nothing to preview. */}
                    {r.filePath && (
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 border-emerald-500/20 bg-emerald-500/5 text-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-600"
                        title="View"
                        onClick={() => openPreview(r)}
                      >
                        <Eye size={13} />
                      </Button>
                    )}

                    <RowActionsMenu
                      triggerClassName="h-8 w-8 border-border/50 bg-background/5 text-muted-foreground hover:bg-muted/10"
                      items={[
                        {
                          key: 'print',
                          icon: <Printer size={12} />,
                          label: 'Print',
                          onClick: () => printRow(r),
                        },
                        {
                          key: 'download',
                          icon: <Download size={12} />,
                          label: 'Download',
                          onClick: () => download(r),
                        },
                        canEdit && {
                          key: 'edit',
                          icon: <Pencil size={12} />,
                          label: 'Edit',
                          onClick: () => openEdit(r),
                        },
                        canDelete && {
                          key: 'delete',
                          icon: busyId === r.id
                            ? <Loader2 size={12} className="animate-spin" />
                            : <Trash2 size={12} />,
                          label: 'Delete',
                          destructive: true,
                          disabled: busyId === r.id,
                          onClick: () => remove(r),
                        },
                      ]}
                    />
                  </div>
                ),
              },
            ]}
            renderCard={(r) => (
              <div className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex flex-col min-w-0">
                    <span className="text-sm font-bold text-foreground truncate">{r.title}</span>
                    {/* The number gets its own line rather than joining the
                        dotted list below: it is the thing someone scanning a
                        phone screen is looking FOR, and it is the one line that
                        names what it is showing. Absent entirely when the
                        record carries no number, rather than a dash — a card is
                        not a table and has no column to keep alignment with. */}
                    {r.display?.number && (
                      <span className="text-xs font-medium text-foreground/90 truncate">
                        {r.display.numberLabel || numberLabel}: {r.display.number}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground truncate">
                      {r.display?.holderName || '—'} · {formatDate(r.createdAt)}
                    </span>
                  </div>
                  {r.filePath
                    ? <Badge variant="secondary" className="text-2xs shrink-0">{r.pageCount || 1}p</Badge>
                    : <Badge variant="outline" className="text-2xs shrink-0">No scan</Badge>}
                </div>
                {/* Touch targets, not a kebab menu: on a phone the actions ARE
                    the card, and a 36px row of them beats a popover. */}
                <div className="flex flex-wrap items-center gap-2">
                  {r.filePath && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 flex-1 gap-1.5 text-xs"
                      onClick={() => openPreview(r)}
                    >
                      <Eye size={13} /> Open
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 gap-1.5 text-xs"
                    onClick={() => share(r)}
                    // Fetches the file on press rather than on click, so
                    // `navigator.share()` still holds its user activation when
                    // the handler reaches it. See warmShare.
                    onPointerDown={() => warmShare([shareItem(r)])}
                  >
                    <Share2 size={13} /> Share
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    aria-label="Download"
                    onClick={() => download(r)}
                  >
                    <Download size={13} />
                  </Button>
                  {canEdit && (
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-9 w-9"
                      aria-label="Edit"
                      onClick={() => openEdit(r)}
                    >
                      <Pencil size={13} />
                    </Button>
                  )}
                  {canDelete && (
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-9 w-9 text-danger-action"
                      aria-label="Delete"
                      disabled={busyId === r.id}
                      onClick={() => remove(r)}
                    >
                      {busyId === r.id
                        ? <Loader2 size={13} className="animate-spin" />
                        : <Trash2 size={13} />}
                    </Button>
                  )}
                </div>
              </div>
            )}
          />
        </TabsContent>
      </Tabs>

      {/* Sealed-field reassurance, once per page rather than per record. */}
      <p className="flex items-center gap-1.5 text-xs text-faint">
        <Lock size={10} />
        Identifiers and personal details in this module are encrypted before they are stored.
      </p>

      {/* Mobile: a reachable Add, clear of the bottom nav AND of the last row
          of the list — <MobileActionFab> reserves the scroll room it needs. */}
      {canAdd && (
        <MobileActionFab
          actions={[{
            key: 'add',
            icon: <Plus size={22} />,
            label: `Add ${categoryName}`,
            onClick: () => openForm(),
            primary: true,
          }]}
        />
      )}

      {/* In-page preview. Same modal the Document Manager shows, because a
          record reached through the sidebar is the record reached through
          /documents — opening a raw file tab for one and a preview for the
          other made them look like two different things. */}
      <Dialog open={!!previewRecord} onOpenChange={(open) => { if (!open) setPreviewRecord(null); }}>
        {previewRecord && (
          <DialogContent aria-describedby={undefined} className="max-w-[800px] border-border/50 bg-popover/95 backdrop-blur shadow-glass flex flex-col gap-4">
            <DialogHeader className="border-b border-border pb-3">
              <DialogTitle className="text-base font-bold truncate">
                Preview: {previewRecord.title}
              </DialogTitle>
            </DialogHeader>
            <FilePreviewPane
              className="min-h-[350px] max-h-[70vh] flex-1"
              source={{
                kind: 'record',
                filePath: previewRecord.filePath,
                mimeType: previewRecord.mimeType,
                name: previewRecord.title,
                pageCount: previewRecord.pageCount,
              }}
              emptyMessage={`No preview available for ${previewRecord.title}`}
              fallbackAction={canShare ? (
                <Button className="mt-4 gap-1.5" onClick={() => download(previewRecord)}>
                  <Download size={16} />
                  <span>Download File</span>
                </Button>
              ) : null}
            />
          </DialogContent>
        )}
      </Dialog>

      <CategoryRecordForm
        open={formOpen}
        onClose={() => { setFormOpen(false); setEditingId(null); }}
        moduleKey={moduleKey}
        documentKey={documentKey}
        initialHolderId={formHolder}
        recordId={editingId}
        onCreated={() => { loadList(); loadSummary(); }}
      />
    </PageContainer>
  );
}
