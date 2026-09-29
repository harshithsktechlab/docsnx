'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { 
  FileText, 
  Upload, 
  Search, 
  Trash2, 
  Download, 
  AlertCircle, 
  Plus, 
  X,
  FileCheck2,
  FolderOpen,
  Eye,
  Share2,
  Printer,
  Pencil,
  Loader2,
  Save,
  FileDown,
  Sparkles,
  UploadCloud
} from 'lucide-react';
import { shareRecord, printRecord, downloadRecord, shareRecords, printRecords, getFileUrl, warmShare } from '@/lib/sharePrintHelper';
import { reportShareResult } from '@/lib/shareToast';
import { clientGetMe, clientCan } from '@/lib/clientAuth';
import { formatDate } from '@/lib/dateHelper';
import { toast } from 'sonner';
import { toastStorageError } from '@/lib/storageToast';
import { Card, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useSearchParams, useRouter } from 'next/navigation';
import { DataTable, parseFilterValues } from '@/components/ui/data-table';
import RowActionsMenu from '@/components/ui/row-actions-menu';
import { MODULE_COLORS, DEFAULT_MODULE_COLOR } from '@/lib/documentCategories';
import HolderSelect, {
  ALL_MEMBERS, holderValue, unmatchedHolderError, HOLDER_REQUIRED_MESSAGE,
} from '@/app/components/HolderSelect';
import { holderRequired, holderForWrite } from '@/lib/records/holderScope';
import { describeFieldErrors } from '@/lib/records/fieldValidation';
import { docField, docCustomFields } from '@/lib/records/docFieldsClient';
import { resolveAutofillOutcome } from '@/lib/records/autofillOutcome';
import { autoReadFor } from '@/lib/records/autoReadOnPick';
import { decidePendingAutofill } from '@/lib/records/pendingAutofillDecision';
import CategorySelect from '@/app/components/CategorySelect';
import CategoryFieldInputs, {
  CustomFieldRows, LinkedCardRows, TITLE_KEY,
} from '@/app/components/CategoryFieldInputs';
import { LINKED_CARDS_KEY } from '@/lib/records/linkedCards';
import useCategoryFields from '@/app/components/useCategoryFields';
import { usePermittedCategories } from '@/lib/usePermittedCategories';
import DuplicateResolveDialog from '@/components/records/DuplicateResolveDialog';
import FilePreviewPane from '@/components/records/FilePreviewPane';
import {
  UPLOAD_ACCEPT_ATTRIBUTE,
  UPLOAD_ACCEPT_LABEL,
  isGenericFileName,
} from '@/lib/records/uploadTypes';
import { prepareUploadFile } from '@/lib/records/fileSnapshot';
import { postUpload, uploadErrorMessage } from '@/lib/records/uploadRequest';
import PageContainer from '@/app/components/PageContainer';
import MobileActionFab from '@/app/components/MobileActionFab';
import { apiDownload } from '@/lib/net/apiRequest';
import { useWorkspaceApi, withCompany } from '@/lib/net/useWorkspaceApi';
import { belongsToWorkspace } from '@/lib/documentCategories';
import { utilityNavPath } from '@/lib/moduleRegistry';
import { toastApiError } from '@/lib/net/toastApiError';


/**
 * Covers the form while a document is in flight.
 *
 * Saving a document is not instant — the file is written, encrypted, placed in
 * the vault and checked against what is already stored — and the only sign of
 * any of it was the Save button growing a spinner, which left the form looking
 * idle for several seconds. Power Scan has said what it is doing all along;
 * this is the same loader, so the two flows read as one product.
 *
 * `position` is a prop because the edit modal scrolls: an `absolute` child of a
 * scrolling box is laid out in its overflow area and scrolls off the top with
 * it, so there the overlay is `fixed` and stays put over the dialog.
 */
function ProcessingOverlay({ title, message, position = 'absolute inset-0 z-20 rounded-xl' }) {
  return (
    <div className={`${position} bg-background/80 backdrop-blur-sm flex flex-col items-center justify-center p-6`}>
      {/* Sticky, because the add form is taller than a phone screen and Save
          sits at its foot: centred in the card, the message would be somewhere
          above the viewport at the exact moment it is needed. */}
      <div className="sticky top-24 flex flex-col items-center text-center gap-2">
        <div className="relative mb-2">
          <Loader2 size={40} className="animate-spin text-primary" />
          <Sparkles size={16} className="text-accent absolute top-0 right-0 animate-pulse" />
        </div>
        <h3 className="text-base font-bold text-foreground">{title}</h3>
        <p className="text-sm text-muted-foreground max-w-xs">{message}</p>
      </div>
    </div>
  );
}

export default function DocumentsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [documents, setDocuments] = useState([]);
  // `loading` drives the DataTable's own spinner on every refetch; `initialLoad`
  // gates the full-page skeleton, which must not come back on a filter change or
  // the table (and the focus in its search box) is torn down mid-typing.
  const [loading, setLoading] = useState(true);
  const [initialLoad, setInitialLoad] = useState(true);
  const [error, setError] = useState('');
  const [previewDoc, setPreviewDoc] = useState(null);
  /**
   * The signed-in member, for `clientCan`.
   *
   * This used to be a single `canShare` boolean read as "does ANY permission
   * row carry canShare" — a global OR across all twenty modules, so a member
   * allowed to share one thing was offered Share on everything. Worse, it was
   * the only permission this page consulted at all: Edit, Delete and Download
   * were rendered on every row unconditionally, and a View-only member found
   * out what they could not do by filling in a form and getting a 403.
   *
   * The whole user is kept instead, because the answer is PER ROW — see `may`.
   */
  const [user, setUser] = useState(null);
  /**
   * The categories this member may ADD to — the same list the upload form's
   * picker is built from, asked here so the form's own trigger can be hidden
   * when the answer is "none". Offering "Upload Document" to a member who may
   * write nowhere is a button whose only outcome is a 403.
   *
   * `null` means not loaded yet and is treated as "show it": the hook fails
   * open by design (see usePermittedCategories) and the server refuses anyway.
   */
  const { permitted: addableCategories } = usePermittedCategories('add');
  const canAddAnywhere = addableCategories === null || addableCategories.size > 0;
  /**
   * ── ONE PAGE, TWO WORKSPACES ──────────────────────────────────────────────
   *
   * This is the household's Document Manager at `/documents` and a company's at
   * `/business/<id>/documents` — the same component, the same functionality,
   * differing only in which taxonomy it files into. `api` is `apiCall` with the
   * workspace already appended; `scoped` does the same for the two calls that
   * are not `apiCall` (a multipart upload and a ZIP download), which
   * `useWorkspaceApi` deliberately does not wrap.
   *
   * There are ~14 call sites here. Appending `?companyId=` by hand at each is
   * exactly the change that gets made at thirteen — and the fourteenth then
   * reads or writes the household's documents from inside a company, renders
   * perfectly, and tells no one.
   */
  const { api, companyId } = useWorkspaceApi();
  const scoped = (url) => withCompany(url, companyId);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, totalCount: 0 });

  // The holder FILTER's options, shipped with the list response so it is
  // computed independently of the active filters — selecting a member must not
  // collapse the dropdown to that member. The add/edit PICKERS no longer need
  // this: <HolderSelect> fetches /api/members itself, which every role
  // can call, unlike the TENANT_ADMIN-gated /api/users this page used to hit.
  const [holderOptions, setHolderOptions] = useState([]);

  // Form State
  const [showAddForm, setShowAddForm] = useState(false);
  const [categoryId, setCategoryId] = useState('');
  // ONE file, read by OCR, reviewed, saved. This form used to take N files and
  // then disable half of itself for a batch — no shared title, no duplicate
  // prompt, no auto-fill — which made it a worse copy of Power Scan sitting one
  // button away. Several documents are /documents/bulk-scan's job; this form is
  // the single-document path and keeps everything that only works for one.
  const [file, setFile] = useState(null);
  /** A refused file type, shown against the dropzone. */
  const [fileError, setFileError] = useState('');
  /** A file is being dragged over the dropzone, so it lights up. */
  const [dragActive, setDragActive] = useState(false);
  /** The hidden <input type="file"> the whole dropzone clicks through to. */
  const uploadInputRef = useRef(null);
  // No default. It used to open on ALL_MEMBERS, so a document belonging to one
  // person was filed against the whole household whenever nobody touched the
  // picker — silently, and indistinguishably from a deliberate "All members".
  // Starting empty makes the choice explicit; "All members" is still one tap
  // away in the dropdown. The EDIT form is unchanged: there a stored null
  // genuinely means all members, and demanding a re-choice would reassign
  // records on save.
  const [holderId, setHolderId] = useState('');
  /** Red under the picker: nothing chosen, or a scanned name that matched nobody. */
  const [holderError, setHolderError] = useState('');
  /**
   * The name the scan read and could NOT place. Handed to the picker so its
   * "+" pre-fills the add dialog, and so the picker fills itself in once that
   * member exists.
   */
  const [holderNameFromScan, setHolderNameFromScan] = useState('');

  // Master category list — the 82 seeded rows plus Uncategorized, identical for
  // every tenant. There are no custom categories; adding one means editing
  // DOCUMENT_CATEGORY_MODULES and shipping a migration.
  const [categoryOptions, setCategoryOptions] = useState([]);
  /**
   * Whether the list above has come back — NOT `categoryOptions.length > 0`.
   * "Not loaded yet" and "loaded and empty" have to be told apart, or an
   * autofill answer that lands first is judged against a list nobody has seen.
   */
  const [categoriesLoaded, setCategoriesLoaded] = useState(false);
  /** Why the master list is missing. Shown on the form — it breaks saving. */
  const [categoriesError, setCategoriesError] = useState('');
  // Bulk selection lives HERE, not in <DataTable>: a bulk action triggers a
  // refetch, and state owned by the table would be remounted out from under it.
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  /** A bulk DELETE specifically is in flight — `bulkBusy` also covers share/download. */
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [aiScanning, setAiScanning] = useState(false);
  const [aiMessage, setAiMessage] = useState('');
  /** Why the last scan produced nothing. Advisory — the form stays usable. */
  const [aiError, setAiError] = useState('');
  /** A scan has run for the current file, so the button now says "Rescan". */
  const [hasScanned, setHasScanned] = useState(false);
  /**
   * The read happened, and ended with "you pick the category".
   *
   * Set when /api/documents/autofill could not place the document, or placed it
   * somewhere this member may not file. In both cases the route deliberately
   * sends NO fields, so the form is left with a file in hand and nothing in it —
   * which is exactly the state the user reported as "it cannot do OCR". The
   * effect below turns the user's category choice into the read that was
   * missing, instead of leaving a second button for them to find.
   */
  const [scanNeedsCategory, setScanNeedsCategory] = useState(false);
  /** The OCR picked the holder, so the field says so rather than looking chosen. */
  const [holderFromScan, setHolderFromScan] = useState(false);
  const [uploading, setUploading] = useState(false);
  /**
   * How much of the file has gone out, or -1 before the first progress event.
   *
   * The upload is the long, silent half on a phone — a several-megabyte photo
   * over cellular — and a spinner that says nothing for two minutes is
   * indistinguishable from a stall. This is what tells the two apart.
   */
  const [uploadPercent, setUploadPercent] = useState(-1);
  const [formError, setFormError] = useState('');

  // ── Duplicate detection state ─────────────────────────────────────────
  // `duplicateDoc` is the 409 body itself (`duplicateConflictPayload`, in
  // records/handler.ts) rather than a handful of fields lifted off it: the
  // prompt previews the record it matched, and re-deriving that here is how the
  // two halves drift apart. The ANSWER is not held in state — it is passed
  // straight into the re-submit, because a `setState` would not have landed by
  // the time that call reads it.
  const [duplicateDoc, setDuplicateDoc] = useState(null);
  const [showDuplicateModal, setShowDuplicateModal] = useState(false);

  // Edit state
  const [editingDoc, setEditingDoc] = useState(null);
  const [editCategoryId, setEditCategoryId] = useState('');
  const [editFile, setEditFile] = useState(null);
  const [editSaving, setEditSaving] = useState(false);
  // The modal opens immediately and fills in once the reveal GET lands, so
  // the inputs are disabled until then — an empty input that is really
  // "not loaded yet" would be saved as an empty value.
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState('');
  const [editHolderId, setEditHolderId] = useState(ALL_MEMBERS);

  const fetchDocuments = async () => {
    setLoading(true);
    try {
      const search = window.location.search;
      const { json } = await api(`/api/documents${search}`);
      if (json.success) {
        setError('');
        setDocuments(json.documents);
        // Shipped with every list response and computed independently of the
        // active filters, so selecting a member never collapses the dropdown.
        setHolderOptions(json.filterOptions?.holders || []);
        if (json.pagination) {
          setPagination(json.pagination);
        }
      } else {
        setError(json.error || 'Failed to fetch documents');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[documents] handler threw', err);
      setError('Something went wrong fetching documents. Please try again.');
    } finally {
      setLoading(false);
      setInitialLoad(false);
    }
  };

  // `companyId` alongside `searchParams`: switching workspace is a client-side
  // navigation between two routes that render THIS component, so without it the
  // list would keep showing the workspace it was mounted in while the header
  // chip, the rail and the category filters had all moved on.
  useEffect(() => {
    fetchDocuments();
  }, [searchParams, companyId]);

  // The Holder column names the company on business rows, read live from the
  // join — so a rename from the "Belongs to" picker needs only a re-read to
  // show everywhere on this page.
  useEffect(() => {
    if (!companyId) return undefined;
    const onRenamed = () => fetchDocuments();
    window.addEventListener('docsnx:companies-changed', onRenamed);
    return () => window.removeEventListener('docsnx:companies-changed', onRenamed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  // Loaded once, not per filter change: the member's permissions do not depend
  // on what the list is showing.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const meData = await clientGetMe();
        if (!cancelled && meData.success) setUser(meData.user);
      } catch (err) {
        console.error('Error loading permissions:', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // The master category list drives every dropdown and filter on this page.
  //
  // A failure here is NOT cosmetic and must not be swallowed: `uploadCategory`
  // is resolved out of this list, so an empty one means the upload form cannot
  // load a single category's fields and cannot save anything. It used to fail
  // silently on `json.success === false` — only a thrown fetch raised a toast —
  // which is how a broken session looked like a broken scan.
  useEffect(() => {
    let cancelled = false;
    // Mirrors CategorySelect.jsx's own category-list effect: reset to `false`
    // BEFORE the fetch starts, not just leave it however the LAST fetch left
    // it. Without this, switching workspace (companyId changes, re-running
    // this effect) leaves `categoriesLoaded` sitting `true` from the previous
    // workspace's fetch for the entire time the new one is in flight — so a
    // scan that lands in that window gets judged against the stale,
    // pre-switch `categoryOptions` instead of waiting for the corrected one.
    setCategoriesLoaded(false);
    (async () => {
      try {
        const { json } = await api('/api/document-categories');
        if (cancelled) return;
        if (json.success) {
          // Two filters, for two different reasons.
          //
          // Mirrored categories are dropped because they are a second ADDRESS
          // for another module's category (src/lib/categoryMirrors.ts), so no
          // document carries their id — and every filter here matches on
          // `categoryId`, which would make the chip a guaranteed empty result.
          // The category they mirror is in this list under its own module.
          //
          // The other half of the account is dropped because this endpoint
          // answers with the whole taxonomy: unfiltered, a company's manager
          // would offer Identity and Medical in its module filter and its
          // upload form, and the household's would offer the fourteen `biz_*`
          // modules. Both are dead ends — every one of those filters would match
          // zero rows, and an upload into one is refused on save. This one list
          // feeds the module filter, the sub-category filter and the upload
          // picker (see `categoryGroups` below), so filtering it here is what
          // makes all three follow the workspace.
          setCategoryOptions(json.categories.filter(
            (c) => !c.mirrorOf && belongsToWorkspace(c.moduleKey, companyId),
          ));
          setCategoriesError('');
        } else {
          setCategoriesError(json.error || 'Could not load document categories');
        }
      } catch (err) {
        if (!cancelled) {
          setCategoriesError('Could not load document categories');
          toast.error('Could not load document categories');
        }
      } finally {
        if (!cancelled) setCategoriesLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [companyId]);

  /**
   * The sub-category the upload form is currently filing into.
   *
   * `categoryId` is all the picker reports, and the taxonomy pair is what the
   * field spec is addressed by. Read off the master list the page already has
   * rather than fetched again.
   */
  const uploadCategory = useMemo(
    () => categoryOptions.find((c) => c.id === categoryId) ?? null,
    [categoryOptions, categoryId],
  );
  /**
   * ╔══════════════════════════════════════════════════════════════════════╗
   * ║  THE FIELDS THIS PAGE ASKS FOR ARE NOT WRITTEN HERE                  ║
   * ╚══════════════════════════════════════════════════════════════════════╝
   *
   * Both forms render whatever the chosen sub-category declares, from its
   * stored spec — a PAN card asks for a PAN number and a date of birth, an RC
   * book for a registration number and four renewal dates, and neither list
   * appears in this file. It is the same spec, fetched from the same endpoint
   * and rendered by the same component as the add form on
   * /modules/<module>/<sub>, so the two cannot ask different questions about
   * the same category.
   *
   * What this replaced: a hardcoded ID Number / Holder Name / Date of Birth /
   * Father's Name / Expiry Date block, asked identically of all 83
   * sub-categories. It named a field that does not exist for most of them and
   * had nowhere to put the ones that do. Even the document's NAME is a spec
   * field now (`document_title`), which is why there is no `name` state left.
   *
   * The upload form's spec follows the picker; the edit modal's is fixed by the
   * record's own category, which ships with every list row as `categoryRef`.
   */
  const uploadFields = useCategoryFields(uploadCategory);
  const editFields = useCategoryFields(editingDoc?.categoryRef ?? null);

  // Grouped by module for the two list FILTERS below. The picker does its own
  // grouping — see CategorySelect — so this is no longer shared with a form.
  const categoryGroups = useMemo(() => {
    const groups = new Map();
    for (const c of categoryOptions) {
      if (!groups.has(c.moduleKey)) groups.set(c.moduleKey, { moduleKey: c.moduleKey, moduleName: c.moduleName, items: [] });
      groups.get(c.moduleKey).items.push(c);
    }
    return Array.from(groups.values());
  }, [categoryOptions]);

  /**
   * Pre-select "Belongs to" from what a read of the document produced.
   *
   * Both autofill routes answer with `holderId` (the member the name resolved
   * to, or '') and `holderName` (the name that was READ, matched or not), and
   * all three write surfaces are meant to treat that answer identically — see
   * `unmatchedHolderError` in HolderSelect, which exists so the wording is not
   * invented three times. This is that rule, once.
   *
   * A name that matched nobody is reported HERE rather than at Save: the whole
   * point of naming it is that the user can add that member, or pick the right
   * one, while they are still looking at the document.
   */
  const applyScannedHolder = (json) => {
    if (json.holderId) {
      setHolderId(holderValue(json.holderId));
      setHolderFromScan(true);
      setHolderError('');
      setHolderNameFromScan('');
      return;
    }
    // Never over a choice the user has already made.
    if (holderId) return;
    // In a company an unmatched name is not an error — the record belongs to
    // the company unless a member is picked. The picker says what the document
    // read and offers "Use as company name" / "Add as member" instead.
    if (holderRequired(companyId)) setHolderError(unmatchedHolderError(json.holderName));
    setHolderNameFromScan(json.holderName || '');
  };

  /**
   * ╔══════════════════════════════════════════════════════════════════════╗
   * ║  READ THE DOCUMENT — TWO ROUTES, BECAUSE THE CATEGORY MAY BE KNOWN   ║
   * ╚══════════════════════════════════════════════════════════════════════╝
   *
   * `/api/modules/:m/:d/autofill` — the category is already known, because the
   * user picked it or because the record being edited has one. The only
   * question left is what THIS category's fields say, and it answers under the
   * very keys the inputs are rendered from. That is this function.
   *
   * `/api/documents/autofill` — nobody has said what the file is. It classifies
   * AND reads, in one request, sharing one upload and one rasterisation between
   * the two model calls. See `handleAiScan`.
   *
   * ── WHAT THIS REPLACED ────────────────────────────────────────────────
   * A single `/api/ai/scan` whose six camelCase answers were poured into six
   * hardcoded inputs, identical for all 83 sub-categories. Reading against the
   * spec is what buys a policy number landing in "Policy Number" instead of
   * nowhere — and what makes the super admin's Field Configuration mean
   * something here.
   */
  const runCategoryAutofill = async (selectedFile, categoryRef, fieldsApi) => {
    if (!categoryRef?.moduleKey || !categoryRef?.documentKey) return;
    setAiMessage('Reading this document against the category\u2019s fields...');
    try {
      const body = new FormData();
      body.append('file', selectedFile);
      // `postUpload`: this posts a file, so a 413 from nginx is on the table
      // and the AI wait can outrun any short client timeout.
      //
      // `scoped`, like the classify call below it: `/api/modules/*` is gated by
      // `gateCompany`, so a business category asked for without the workspace
      // is a 400 and this read never happens inside a company at all.
      const upload = await postUpload(
        scoped(`/api/modules/${categoryRef.moduleKey}/${categoryRef.documentKey}/autofill`),
        body,
      );
      if (!upload.ok && (upload.kind !== 'http' || !upload.json)) {
        setAiError(uploadErrorMessage(upload, 'document'));
        setAiMessage('');
        return;
      }
      const res = { ok: upload.ok, status: upload.status };
      const json = upload.json;
      if (!res.ok || !json.success) {
        // Advisory, never blocking — the fields stay editable and the document
        // is still savable by hand. A member with `edit` but not `add` is
        // refused here by design (the route is gated on `add`), and that lands
        // in this same line rather than as a dead control.
        setAiError(json.error || 'Could not read this document. Fill the details in below.');
        setAiMessage('');
        return;
      }

      // Blanks and earlier AI answers only. On the EDIT modal that means the
      // record's own stored values are never overwritten by a re-read — they
      // are reviewed values, which deserve more protection than typing, not
      // less.
      const applied = fieldsApi.applyAutofill(json.fields);

      // The route answers with the member it read off the document, exactly as
      // the classify route does — and this was the one caller that threw it
      // away, so "Belongs to" filled itself in when the AI chose the category
      // and did not when the user chose it. Same three surfaces, same rule.
      // Skipped on the edit modal: that record already has a holder, and a
      // re-read must not reassign it.
      if (!editingDoc) applyScannedHolder(json);

      const truncated = json.pagesTotal > json.pagesRead
        ? ` Read the first ${json.pagesRead} of ${json.pagesTotal} pages.`
        : '';
      if (applied.length === 0) {
        setAiMessage('');
        setAiError(`Nothing on this document matched this category\u2019s fields \u2014 fill them in below.${truncated}`);
      } else {
        setAiMessage(`Filled ${applied.length} field${applied.length === 1 ? '' : 's'} \u2014 check ${applied.length === 1 ? 'it' : 'them'} before saving.${truncated}`);
        setTimeout(() => setAiMessage(''), 5000);
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[documents] handler threw', err);
      setAiError('Something went wrong reading this document. Fill the details in below. Please try again.');
      setAiMessage('');
    }
  };

  /**
   * ANSWERS waiting for their category's spec to arrive.
   *
   * `/api/documents/autofill` returns the category and the fields together, but
   * the inputs those values belong in do not exist yet: setting `categoryId`
   * starts `useCategoryFields` fetching the spec, and `applyAutofill` sorts
   * values by field key — run against an empty spec it would drop every one of
   * them. So the answers are parked here and applied by the effect below, once
   * the fields they belong to exist.
   *
   * It used to park the FILE and fire a second network call here. It does not
   * any more: the values are already in hand, so this is now purely a wait for
   * React state, not a round trip.
   */
  const [pendingAutofill, setPendingAutofill] = useState(null);

  /**
   * Has `useCategoryFields` finished answering for the category we are waiting
   * on? `loadingSpec` alone is not enough: on the very render that sets
   * `categoryId`, the fetch has not been kicked off yet, so `loadingSpec` is
   * still false and a spec-shaped guard would read "done, and empty".
   *
   * The spec carries its own category, so this asks the only question that
   * matters — is what we are holding an answer about THIS pair.
   */
  const specSettled = useMemo(() => {
    if (!uploadCategory) return true;
    if (uploadFields.specError) return true;
    const answered = uploadFields.spec?.category;
    return answered?.moduleKey === uploadCategory.moduleKey
      && answered?.documentKey === uploadCategory.documentKey;
  }, [uploadCategory, uploadFields.spec, uploadFields.specError]);

  /**
   * ╔══════════════════════════════════════════════════════════════════════╗
   * ║  THE CATEGORY THE USER PICKS IS THE SECOND HALF OF THE READ          ║
   * ╚══════════════════════════════════════════════════════════════════════╝
   *
   * When the classify pass cannot place a document — or places it somewhere
   * this member may not file — the route sends no fields, by design. What the
   * page used to do with that was: say "pick a category below", and stop. The
   * user picked one and got an empty form, because the second read only ever
   * happened if they went back up and pressed "Rescan with AI". Power Scan has
   * never worked that way: re-filing a row in the review grid re-reads it.
   *
   * So the pick IS the trigger. `runCategoryAutofill` is the same function the
   * button calls, against the same file already in state — no re-upload from
   * the user, no second dropzone.
   *
   * ── WHEN, EXACTLY ──────────────────────────────────────────────────────
   * Every clause is a way to burn the tenant's credits, read one document
   * twice, or apply an answer to a form that cannot hold it — so the rule
   * lives in `autoReadFor` (records/autoReadOnPick.ts) where it is asserted,
   * beside `resolveAutofillOutcome` and for the same reason. It answers with
   * the key to remember, so this cannot act on a yes without recording what it
   * acted on. `applyAutofill` does the rest: blanks and earlier AI answers
   * only, never over typing.
   */
  const autoReadRef = useRef('');

  useEffect(() => {
    const key = autoReadFor({
      armed: scanNeedsCategory,
      file,
      category: uploadCategory,
      specSettled,
      busy: aiScanning || uploading,
      lastKey: autoReadRef.current,
      editing: Boolean(editingDoc),
    });
    if (!key) return;
    autoReadRef.current = key;

    setScanNeedsCategory(false);
    setAiScanning(true);
    setAiError('');
    runCategoryAutofill(file, uploadCategory, uploadFields)
      .finally(() => setAiScanning(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanNeedsCategory, file, uploadCategory, specSettled, editingDoc, aiScanning, uploading]);

  /**
   * ╔══════════════════════════════════════════════════════════════════════╗
   * ║  EVERY PATH OUT OF HERE ENDS THE JOB                                 ║
   * ╚══════════════════════════════════════════════════════════════════════╝
   *
   * This effect owns `aiScanning` for the classify-and-read flow, so a bare
   * `return` is not a "wait" — it is a hang. It used to have three of them:
   * an unresolvable `uploadCategory`, a spec that never arrived, and a spec
   * with no visible fields all left the button reading "Reading document..."
   * for the rest of the session, with Save and the dropzone disabled behind
   * `busy` and not one word on screen about why.
   *
   * So there is exactly ONE reason to wait — the spec is genuinely in flight —
   * and every other exit clears `pendingAutofill`, clears `aiScanning` and
   * says something. `handleAiScan` no longer parks an answer whose category is
   * unresolvable, so the last case is defence in depth rather than the
   * expected path.
   */
  useEffect(() => {
    // `uploadCategory` reads `null` both while `categoryOptions` is still
    // loading AND when the id genuinely is not in it — `decidePendingAutofill`
    // is what tells those apart, so an answer that arrives before the
    // category list's own fetch does gets WAITED on rather than discarded.
    // See pendingAutofillDecision.ts.
    const decision = decidePendingAutofill({
      hasPendingAutofill: Boolean(pendingAutofill),
      categoriesLoaded,
      uploadCategoryId: uploadCategory?.id ?? null,
      pendingCategoryId: pendingAutofill?.categoryId ?? '',
      specSettled,
    });
    if (decision === 'wait') return;

    const job = pendingAutofill;
    setPendingAutofill(null);
    setAiScanning(false);
    setAiMessage('');

    if (decision === 'fail') {
      // The picker moved on, or the category could not be resolved out of the
      // master list at all. Either way there is nothing to fill in.
      //
      // Named, not generic: `job.documentName`/`moduleName` are the server's
      // own answer for what this was, carried along since `handleAiScan` —
      // this is the ONE piece of ground truth telling "the picker moved on"
      // (ordinary) apart from "the master list doesn't have this category at
      // all" (taxonomy drift, unavailable elsewhere in the app too).
      setAiError(job.documentName
        ? `Could not open “${job.documentName}” (${job.moduleName || 'unknown module'}) — pick a category and sub-category below.`
        : 'Could not open that category’s fields — pick a category and sub-category below.');
      console.warn('[documents] AI-scanned category not found in categoryOptions', {
        categoryId: job.categoryId,
        moduleName: job.moduleName,
        documentName: job.documentName,
      });
      return;
    }
    if (uploadFields.specError) {
      setAiError(`${uploadFields.specError} — fill the details in below.`);
      return;
    }
    if (uploadFields.fields.length === 0) {
      setAiError('This category has no fields to fill in.');
      return;
    }

    const applied = uploadFields.applyAutofill(job.fields);
    const truncated = job.pagesTotal > job.pagesRead
      ? ` Read the first ${job.pagesRead} of ${job.pagesTotal} pages.`
      : '';
    if (applied.length === 0) {
      setAiError(`Nothing on this document matched this category’s fields — fill them in below.${truncated}`);
    } else {
      setAiMessage(`Filled ${applied.length} field${applied.length === 1 ? '' : 's'} — check ${applied.length === 1 ? 'it' : 'them'} before saving.${truncated}`);
      setTimeout(() => setAiMessage(''), 5000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutofill, categoriesLoaded, uploadCategory, specSettled, uploadFields.fields]);

  /**
   * The backstop. The effect above waits on React state reaching a shape; this
   * guarantees the button un-sticks even if it never does.
   *
   * A stuck spinner is the failure this whole change is about, and it is worth
   * one timer to make it unreachable rather than only unlikely. Cleared on the
   * ordinary path, because clearing `pendingAutofill` tears this down with it.
   */
  useEffect(() => {
    if (!pendingAutofill) return undefined;
    const timer = setTimeout(() => {
      setPendingAutofill(null);
      setAiScanning(false);
      setAiMessage('');
      setAiError('Reading this document timed out — fill the details in below.');
    }, 15000);
    return () => clearTimeout(timer);
  }, [pendingAutofill]);

  const handleAiScan = async () => {
    const selectedFile = editingDoc ? editFile : file;
    if (!selectedFile) {
      toast.error('Please select or upload a document file first to use AI Auto-fill.');
      return;
    }

    setAiScanning(true);
    setAiError('');

    /**
     * The second call has been queued and the effect owns the busy flag now.
     * A local, not `pendingAutofill`: the state read in `finally` is this
     * render's, still null however recently it was set, so the button would
     * unstick between the two calls.
     */
    let queued = false;

    // ── The category is already known ──────────────────────────────────────
    // Either the record being edited has one, or the user picked one. Nothing
    // to classify: go straight to reading the fields.
    const known = editingDoc ? editingDoc.categoryRef : uploadCategory;
    if (known?.moduleKey && known?.documentKey) {
      await runCategoryAutofill(
        selectedFile, known, editingDoc ? editFields : uploadFields,
      );
      setAiScanning(false);
      if (!editingDoc) setHasScanned(true);
      return;
    }

    setAiMessage('Reading this document and working out what it is...');

    try {
      const formData = new FormData();
      formData.append('file', selectedFile);

      // ONE request: it classifies AND reads the fields, off one upload and one
      // rasterisation. This used to be `/api/ai/scan` followed by a second
      // upload of the same file to `/api/modules/:m/:d/autofill`.
      // `postUpload`, not `fetch`: this sends the file, so an oversized one
      // comes back as nginx's 413 HTML page and `res.json()` threw on it.
      // Named `upload`, not `outcome`: `resolveAutofillOutcome` below already
      // owns that word in this handler, and it means something different.
      const upload = await postUpload(scoped('/api/documents/autofill'), formData);
      if (!upload.ok && (upload.kind !== 'http' || !upload.json)) {
        setAiError(uploadErrorMessage(upload, 'document'));
        setAiMessage('');
        return;
      }
      const json = upload.json;

      /**
       * ╔══════════════════════════════════════════════════════════════════╗
       * ║  ONE ANSWER, FOUR OUTCOMES — and only ONE of them picks a        ║
       * ║  category                                                        ║
       * ╚══════════════════════════════════════════════════════════════════╝
       *
       * This used to be `if (json.success && json.category?.id)` and then
       * `setCategoryId(json.category.id)`, which was wrong in two of the four
       * cases the route can answer with. It sends the category alongside a
       * `notice` when the member may NOT file there — so the message can name
       * it — and it resolves an unclassifiable document to the catch-all
       * rather than to nothing. Selecting either put an id into
       * <CategorySelect> that the picker has no option for, which Radix
       * renders as an empty trigger rather than as its placeholder, and left
       * `uploadCategory` unresolvable so the effect that owns `aiScanning`
       * never finished. That is the "Reading document..." that never stopped.
       *
       * The rules live in `resolveAutofillOutcome` so they can be asserted.
       */
      const outcome = resolveAutofillOutcome(json, {
        categoryOptions: categoriesLoaded ? categoryOptions : null,
      });

      // The title and the holder are worth having whatever the category came
      // to: a document the user has to file by hand still names itself and
      // still names a person. The title is a spec field like any other, so it
      // goes in through the same door — and only if nothing is typed there.
      if (outcome.title && !String(uploadFields.values[TITLE_KEY] ?? '').trim()) {
        uploadFields.setValue(TITLE_KEY, outcome.title);
      }
      if (outcome.kind !== 'failed') applyScannedHolder(outcome);

      if (outcome.kind === 'apply') {
        setCategoryId(outcome.categoryId);
        // Parked, not applied: the spec for this category has not been fetched
        // yet, and `applyAutofill` sorts values by field key. See
        // `pendingAutofill`. `setAiScanning(false)` is the effect's job in this
        // branch, so the button stays busy until the values reach the inputs —
        // and every path out of that effect ends the job.
        setPendingAutofill({
          categoryId: outcome.categoryId,
          // Carried along only so a later mismatch against `categoryOptions`
          // can NAME what the scan thought this was, instead of reporting a
          // bare "could not open" for a category nobody can identify.
          moduleName: outcome.moduleName,
          documentName: outcome.documentName,
          fields: outcome.fields,
          pagesRead: outcome.pagesRead,
          pagesTotal: outcome.pagesTotal,
        });
        queued = true;
        setHasScanned(true);
        return;
      }

      // Never a dead end: every field stays editable and the document can be
      // saved with details typed by hand. The AI being down — or reading
      // something this member may not file — is not a reason to refuse a
      // document. `queued` stays false, so the `finally` un-sticks the button.
      //
      // And it is not the end of the READ either: whichever category the user
      // now picks, the effect above reads the file against it. Armed for every
      // non-apply outcome, `failed` included — a model call that fell over is
      // worth retrying against a category the user has since named.
      setScanNeedsCategory(true);
      setAiError(outcome.message);
      setAiMessage('');
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[documents] handler threw', err);
      setAiError('Something went wrong calling AI Scan. Fill the details in below. Please try again.');
      setAiMessage('');
    } finally {
      // Not in the queued branch — there the effect finishes the job.
      if (!queued) setAiScanning(false);
      // Labels the ADD form's button "Rescan"; the edit modal has its own.
      if (!editingDoc) setHasScanned(true);
    }
  };

  /**
   * ── ASYNC, BECAUSE THIS IS WHERE THE FILE IS MADE UPLOADABLE ────────────
   * `prepareUploadFile` (src/lib/records/fileSnapshot.ts) checks the type,
   * READS THE BYTES into memory, re-encodes a large camera photo, and checks
   * the size that will actually be sent — in that order, and each step has
   * been the reason an upload from a phone failed where the same file from a
   * laptop did not.
   *
   * The read is the one that finally explained this screen. On Android a file
   * picked from Drive, WhatsApp or "Recent" is a handle whose bytes the owning
   * app hands over only at send time — and when it refuses, Chrome reports a
   * bare network failure. For two weeks that was shown here as a Wi-Fi problem
   * on a phone whose network was fine. Reading at pick time either succeeds
   * while the grant is fresh, or fails HERE with a message that names the file
   * and what to do about it.
   */
  const handleFileChange = async (e) => {
    const picked = Array.from(e.target.files || []);
    // Reset the input so re-picking the SAME file after removing it still fires
    // a change event — otherwise the control looks dead on the second try.
    // Synchronous, before any await: clearing `value` discards `files`.
    e.target.value = '';
    if (picked.length === 0) return;

    const result = await prepareUploadFile(picked[0]);
    if (!result.ok) {
      setFileError(result.error);
      return;
    }
    const chosen = result.file;

    setFileError('');
    setFile(chosen);
    // A new file invalidates whatever the last one's scan filled in — including
    // the complaint that its name matched nobody, and any pending auto-read
    // armed for the file being replaced.
    setHasScanned(false);
    setScanNeedsCategory(false);
    setAiError('');
    setHolderFromScan(false);
    setHolderError('');
    setHolderNameFromScan('');

    // A first guess at the name, from the file's own. The title is a spec
    // field now, so it goes in through the same door as every other value —
    // and only when the user has not already given the document a name.
    //
    // Not from a name the phone made up: every iOS Photos pick is `image.jpeg`,
    // and seeding "image" as the title made the SECOND photo a title clash with
    // the first. Left blank, the user or the scan names it.
    if (!String(uploadFields.values[TITLE_KEY] ?? '').trim() && !isGenericFileName(chosen.name)) {
      uploadFields.setValue(
        TITLE_KEY,
        chosen.name.substring(0, chosen.name.lastIndexOf('.')) || chosen.name,
      );
    }

    // Several files is Power Scan's job, and it is one click away — so keep the
    // first and say where the rest belong, rather than silently discarding them.
    if (picked.length > 1) {
      toast('One document at a time here — kept the first.', {
        description: `${picked.length - 1} more not attached. Power Scan reads them all at once.`,
        action: {
          label: 'Power Scan',
          onClick: () => router.push(utilityNavPath('/documents/bulk-scan', companyId)),
        },
      });
    }
  };

  /**
   * The replacement file on the edit modal. Same allowlist as the add form —
   * the route now refuses anything outside it, so catching it here turns a 400
   * into a message against the control that caused it.
   */
  const handleEditFileChange = async (e) => {
    const chosen = e.target.files?.[0] || null;
    e.target.value = '';
    if (!chosen) return;
    // Same preparation as the add form above, and for the same reasons.
    const result = await prepareUploadFile(chosen);
    if (!result.ok) {
      setEditError(result.error);
      return;
    }
    setEditError('');
    setEditFile(result.file);
  };

  /**
   * @param {Event|{preventDefault:Function}} e
   * @param {'replace'|'keepBoth'|null} answer
   *   The user's answer to the duplicate prompt, when this submit IS that
   *   answer. Passed rather than read from state: the prompt calls straight
   *   back into here, and a `setState` from the click handler would not have
   *   landed yet.
   */
  const handleUploadSubmit = async (e, answer = null) => {
    e.preventDefault();
    if (!file && !answer) {
      setFormError('Please select a file to upload.');
      return;
    }
    // The category comes FIRST now, because it decides what the rest of the
    // form even asks: no category, no field spec, nothing below to validate.
    if (!categoryId) {
      setFormError('Please select a category.');
      return;
    }

    // What gets posted, and the browser's half of the rules the route re-runs.
    const record = uploadFields.payload();
    const name = String(record[TITLE_KEY] ?? '').trim();
    if (!name) {
      setFormError('Please enter a document name.');
      uploadFields.showErrors({
        ...uploadFields.validate(record),
        [TITLE_KEY]: 'Give this document a name',
      });
      return;
    }
    // Red on the control itself, not only in the banner — the banner is above
    // the fold and the picker is not, and the fix is in the picker.
    //
    // Only where there is something to pick. In a company workspace the record
    // belongs to the COMPANY and <HolderSelect> renders a statement with no
    // `onChange`, so `holderId` stays '' however long the user looks at it —
    // and this refused every business upload with a message pointing at a
    // control that had already answered it.
    if (holderRequired(companyId) && !holderId) {
      setHolderError(HOLDER_REQUIRED_MESSAGE);
      setFormError('Please choose who this document belongs to.');
      return;
    }

    // Same module, same rules, same sentences as the route's own check — see
    // `buildTaxonomyRecord`. Answering here only means the user is told before
    // the upload starts rather than after it is refused.
    const fieldErrors = uploadFields.validate(record);
    if (Object.keys(fieldErrors).length > 0) {
      uploadFields.showErrors(fieldErrors);
      // Names the fields rather than counting them. A count is only useful
      // beside something marked, and the marked input can be well below the
      // fold — or, for a key this form renders no input for, absent entirely.
      setFormError(describeFieldErrors(uploadFields.fields, fieldErrors));
      return;
    }

    // One title against one file — which is every upload now, so this no longer
    // has a batch to step around.
    //
    // BOTH arms are scoped to the category, matching `findTwin` on the server.
    // The filename arm used to match across every category, which was not a
    // harmless extra prompt: same-named scans (`scan.pdf`, `IMG_0042.jpg`) are
    // ordinary across unrelated categories, and confirming posted that record's
    // `replaceId`. Reusing a row overwrites its Drive object — which lives under
    // `Documents/<module>/<documentKey>/` with the category bound into its AAD —
    // so agreeing to it re-filed a record across categories and orphaned its
    // ciphertext. The category is part of the match, not an arm of it.
    //
    // And the filename arm is skipped for a name the device invented, again
    // matching the server: every iOS Photos pick is `image.jpeg`, so comparing
    // it made the second phone photo in a category a "duplicate" of the first.
    if (!answer) {
      const sameCategory = (doc) => doc.categoryId === categoryId;
      const namedFile = file && !isGenericFileName(file.name);
      const duplicate = documents.find(
        doc => sameCategory(doc) && (
          doc.title.toLowerCase().trim() === name.toLowerCase().trim()
          || (namedFile && doc.fileName === file.name)
        )
      );
      if (duplicate) {
        const byTitle = duplicate.title.toLowerCase().trim() === name.toLowerCase().trim();
        // Shaped like the server's 409 so the prompt has ONE thing to read,
        // whichever check found the match. The row is already loaded, so the
        // preview costs nothing extra here.
        setDuplicateDoc({
          existingId: duplicate.id,
          existingTitle: duplicate.title,
          // Says which arm fired, the way the server's message does. Claiming a
          // title clash while the user looks at two different titles is worse
          // than saying nothing.
          error: byTitle
            ? `'${duplicate.title}' already has this title, in this category.`
            : `'${duplicate.title}' was uploaded from this file name, in this category.`,
          reason: byTitle ? 'title' : 'fileName',
          existingModuleKey: duplicate.categoryRef?.moduleKey ?? null,
          existingDocumentKey: duplicate.categoryRef?.documentKey ?? null,
          // This check only ever matches on a title or a filename, so keeping
          // both is always answerable. The NAME the copy would take is the
          // server's to resolve — it can see rows this page has not loaded —
          // so it is left unset and reported once the write comes back.
          keepBothAllowed: true,
          keepBothTitle: null,
          existingFile: duplicate.filePath ? {
            filePath: duplicate.filePath,
            mimeType: duplicate.mimeType,
            fileName: duplicate.fileName,
            fileSize: duplicate.fileSize,
            updatedAt: duplicate.updatedAt,
          } : null,
        });
        setShowDuplicateModal(true);
        return;
      }
    }

    setUploading(true);
    setFormError('');

    const formData = new FormData();
    // `files` is the plural field the route reads — it stays the shared write
    // path for every module, so the field name is its contract, not a count.
    // One uploaded file becomes one record, and its pages become that record's.
    if (file) formData.append('files', file);
    formData.append('title', name);
    formData.append('categoryId', categoryId);
    // Appended only where a member can own the record. `holderForWrite` answers
    // undefined in a company workspace, and OMITTING the key is not the same as
    // sending '': `holderFrom` keeps the two apart so `resolveHolder` can fall
    // back to the module default rather than reading an empty string as an
    // explicit "All members" and setting is_global on every business row.
    const uploadHolder = holderForWrite(companyId, holderId);
    if (uploadHolder !== undefined) formData.append('holderId', uploadHolder);

    // Taxonomy-keyed, because the inputs above were rendered from this
    // category's spec. The flag is what tells the route to treat that spec as
    // the allowlist and seal what it marks as PII — without it the body would
    // be read as the legacy camelCase bag and land in the open tier.
    formData.append('metadata', JSON.stringify(record));
    formData.append('taxonomyFields', 'true');

    // The answer to the prompt, if this submit is one. `replaceId` names the
    // record to write onto; `keepBoth` asks for a second record beside it, and
    // the server decides both the name it takes and whether the match may be
    // forked at all.
    if (answer === 'replace' && duplicateDoc) {
      formData.append('replaceId', duplicateDoc.existingId);
    } else if (answer === 'keepBoth') {
      formData.append('keepBoth', 'true');
    }

    // The 409 branch below re-opens the modal, and the `finally` must not
    // immediately close it again.
    let awaitingAnswer = false;

    try {
      /**
       * `postUpload`, not `fetch`, for one specific reason beyond progress:
       * this handler used to call `res.json()` with no catch. nginx refuses an
       * oversized body with a 413 and an HTML page, `JSON.parse` threw on it,
       * and the throw landed in the `catch` below — so "your file is too large"
       * was shown as "Network error uploading document". A 502/504 did the
       * same. The body is parsed defensively in the helper now, and `res.status`
       * survives to the branches that need it.
       */
      const outcome = await postUpload(scoped('/api/documents'), formData, {
        onUploadProgress: (percent) => setUploadPercent(percent),
      });

      // The transport itself failed — no response at all, or one that was not
      // JSON. `uploadErrorMessage` names which of the four it was.
      if (!outcome.ok && (outcome.kind !== 'http' || !outcome.json)) {
        setFormError(uploadErrorMessage(outcome, 'document'));
        return;
      }

      const res = { status: outcome.status };
      const json = outcome.json;

      // The server found a duplicate this page could not. Its own check above
      // reads `documents`, which holds only the page of results currently
      // loaded — a match further down the list is invisible to it. Same modal
      // and same answer either way; only the id comes from elsewhere.
      if (res.status === 409 && json.requiresConfirmation) {
        // The body verbatim. It says WHY it matched — the same title, the same
        // file name, or the same document number — what the matched record
        // looks like, and whether keeping both is even on offer. Rendering our
        // own sentence here told the user their titles clashed while they were
        // looking at two different titles.
        setDuplicateDoc({ ...json, existingTitle: json.existingTitle || name });
        setShowDuplicateModal(true);
        awaitingAnswer = true;
        return;
      }

      if (json.success) {
        // Some of the batch landed and the rest need an answer — a conflict the
        // server could only see once it started writing. Saying "Document
        // uploaded" and stopping would leave those files silently unstored, so
        // the list is refreshed for what DID land and the prompt opens for the
        // first that did not.
        const [pending] = json.duplicates ?? [];
        if (pending) {
          fetchDocuments();
          setDuplicateDoc({
            ...pending,
            existingTitle: pending.existingTitle || pending.fileName || name,
          });
          setShowDuplicateModal(true);
          awaitingAnswer = true;
          return;
        }

        // A kept-both copy is filed under a name the SERVER chose, so the toast
        // reports the name it actually took rather than the one that was typed.
        toast.success(
          answer === 'keepBoth'
            ? `Saved as “${json.document?.title || name}”`
            : answer === 'replace' ? 'Document replaced' : 'Document uploaded',
        );
        closeAddForm();
        fetchDocuments();
      } else if (!toastStorageError(res, json)) {
        // A per-field refusal lands on the input that caused it — the route
        // rendered its messages from the same spec these inputs came from.
        if (json.fieldErrors) uploadFields.showErrors(json.fieldErrors);
        setFormError(json.error || 'Upload failed');
      }
    } catch (err) {
      // Anything left is a bug in this handler rather than a transport failure
      // — `postUpload` does not throw. Logged so it is not silent the way the
      // discarded `err` here used to be.
      console.error('[documents] upload handler threw', err);
      setFormError('Something went wrong saving this document. Please try again.');
    } finally {
      setUploading(false);
      setUploadPercent(-1);
      if (!awaitingAnswer) {
        setDuplicateDoc(null);
        setShowDuplicateModal(false);
      }
    }
  };

  /** The upload form is mid-flight: the dropzone and its controls go inert. */
  const busy = uploading || aiScanning;

  const resetAddForm = () => {
    setCategoryId('');
    setFile(null);
    setFileError('');
    setAiError('');
    setAiMessage('');
    setHasScanned(false);
    setHolderFromScan(false);
    setHolderError('');
    setHolderNameFromScan('');
    // A parked answer belongs to the document that has just been saved. Left
    // behind, its effect would fire against the NEXT document's category. Same
    // for an armed auto-read: the file it was armed for is gone.
    setPendingAutofill(null);
    setScanNeedsCategory(false);
    setAiScanning(false);
    // Values, errors, touched and the AI badges together — the title is one of
    // them now, so there is nothing left to clear by hand.
    uploadFields.reset();
    setHolderId('');
    setDuplicateDoc(null);
  };

  // One definition of "closed", shared by the header toggle, the mobile FAB and
  // the Cancel button, so none of them can leave a half-filled upload — a
  // picked file, a scanned category, a parked autofill — behind in state.
  const closeAddForm = () => {
    resetAddForm();
    setShowAddForm(false);
  };

  /** "Keep the new one" / "Keep both" — the same submit, a different answer. */
  const answerDuplicate = (answer) => {
    setShowDuplicateModal(false);
    handleUploadSubmit({ preventDefault: () => {} }, answer);
  };

  const handleDuplicateCancel = () => {
    setDuplicateDoc(null);
    setShowDuplicateModal(false);
  };

  // Edit handlers.
  // Every field the modal binds must be seeded here — an unseeded one keeps its
  // value from the previous edit, and for holderId that silently reassigns the
  // document to the wrong member on save.
  const openEditModal = async (doc) => {
    setEditingDoc(doc);
    setEditCategoryId(doc.categoryId || '');
    setEditHolderId(holderValue(doc.holderId));
    setEditFile(null);
    setEditError('');
    // The scan notices are shared with the add form; a stale one must not open
    // with the modal and look like it belongs to THIS document.
    setAiError('');
    setAiMessage('');

    // Seed from the single-record GET, never from the list row.
    //
    // A list row carries the open tier plus a MASKED identifier ('••••1234'),
    // and the sealed fields are not in it at all — they live on Drive. Seeding
    // from it and saving would write the mask back as the real value and blank
    // every sealed field. Only /api/documents/<id> reveals them, and its `open`
    // is already keyed the way these inputs are.
    //
    // The `display.numberKey` special case this used to need is gone: the
    // identifier is no longer one generic input to be pointed at the right key,
    // it is simply one of the fields the spec declares.
    setEditLoading(true);
    editFields.reset();
    try {
      const { json } = await api(`/api/documents/${doc.id}`);
      const full = json.success ? json.document : doc;
      // The title is a spec field like any other, so it seeds through the same
      // path — from `document_title` if the record carries one, otherwise from
      // the row's own title, which is what older records have.
      editFields.seed(
        {
          ...(full?.metadata?.open ?? {}),
          [TITLE_KEY]: full?.metadata?.open?.[TITLE_KEY] ?? doc.title ?? '',
        },
        // `docCustomFields` reads both the sealed `custom_fields` JSON and the
        // legacy open `customFields` array, so a record written before the
        // forms were spec-driven keeps its custom rows through this edit.
        docCustomFields(full),
      );
      if (!json.success) {
        setEditError('Could not load this document\u2019s full details \u2014 saving now would overwrite them.');
      }
    } catch (err) {
      // Blank fields that then get saved would destroy the stored values, so
      // the modal says so rather than presenting empty inputs as the truth.
      editFields.reset();
      setEditError('Could not load this document\u2019s full details \u2014 saving now would overwrite them.');
    } finally {
      setEditLoading(false);
    }
  };

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    if (!editingDoc) return;

    // ── The body is taxonomy-keyed, and so must the SAVE be ────────────────
    // `updateVaultRecordBody` REPLACES a record's body rather than merging it.
    // An edit posting the old camelCase six would therefore not just fail to
    // save these fields — it would wipe every one the add form wrote. Hence
    // `taxonomyFields` on both branches below; it is what makes the server run
    // the same normaliser the create path did.
    const record = editFields.payload();
    const title = String(record[TITLE_KEY] ?? '').trim();

    const fieldErrors = editFields.validate(record);
    if (!title) fieldErrors[TITLE_KEY] = fieldErrors[TITLE_KEY] ?? 'Give this document a name';
    if (Object.keys(fieldErrors).length > 0) {
      editFields.showErrors(fieldErrors);
      setEditError(describeFieldErrors(editFields.fields, fieldErrors));
      return;
    }
    // The PUT refuses a blank categoryId as an unexplained "Invalid request
    // body"; say what is actually missing instead.
    if (!editCategoryId) {
      setEditError('Pick a sub-category before saving.');
      return;
    }

    setEditSaving(true);
    setEditError('');

    /** A route's per-field refusal lands on its input, not in the banner. */
    const showServerErrors = (json) => {
      if (json.fieldErrors) editFields.showErrors(json.fieldErrors);
      setEditError(json.error || 'Update failed');
    };

    try {
      if (editFile) {
        const uploadFormData = new FormData();
        // 'title', not 'name' — POST /api/documents rejects a missing title.
        uploadFormData.append('title', title);
        uploadFormData.append('categoryId', editCategoryId);
        uploadFormData.append('file', editFile);
        uploadFormData.append('replaceId', editingDoc.id);
        // Omitted in a company workspace, as on the add form above — see
        // `holderForWrite`. An edit that omits it leaves the stored holder and
        // is_global exactly as they were, which is the right answer for a
        // record whose owner was never in question.
        const editHolder = holderForWrite(companyId, editHolderId);
        if (editHolder !== undefined) uploadFormData.append('holderId', editHolder);
        uploadFormData.append('metadata', JSON.stringify(record));
        uploadFormData.append('taxonomyFields', 'true');
        // `postUpload`, not `apiCall`: this is a multipart write. It carries the
        // 330s ceiling an upload needs — a phone photo on mobile data outruns the
        // 45s a JSON request gets — and the uploading/waiting boundary that
        // separates "nothing was sent, retry" from "this may already have saved".
        const upload = await postUpload(scoped('/api/documents'), uploadFormData);
        if (!upload.ok && (upload.kind !== 'http' || !upload.json)) {
          setEditError(uploadErrorMessage(upload, 'document'));
          return;
        }
        const res = { ok: upload.ok, status: upload.status };
        const uploadJson = upload.json;
        if (uploadJson.success) {
          toast.success('Document updated');
          setEditingDoc(null);
          fetchDocuments();
          return;
        }
        showServerErrors({ ...uploadJson, error: uploadJson.error || 'File upload failed' });
        setEditSaving(false);
        return;
      }

      // Update metadata only
      const metadataHolder = holderForWrite(companyId, editHolderId);
      const { json } = await api(`/api/documents/${editingDoc.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
        // 'title', not 'name' — the PUT zod schema strips unknown keys, so a
        // rename sent as `name` is silently discarded.
        title,
        categoryId: editCategoryId,
        // `undefined` in a company workspace, and `JSON.stringify` drops the key
        // — the omission `holderFrom` reads as "not sent". The personal branch
        // keeps its `|| null`: '' means "All members", which the route spells
        // as a null holder.
        holderId: metadataHolder === undefined ? undefined : (metadataHolder || null),
        metadata: record,
        taxonomyFields: true,
        }),
      });
      if (json.success) {
        toast.success('Document updated');
        setEditingDoc(null);
        fetchDocuments();
      } else {
        showServerErrors(json);
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[documents] handler threw', err);
      setEditError('Something went wrong updating document. Please try again.');
    } finally {
      setEditSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this document?')) return;
    try {
      const { json } = await api(`/api/documents/${id}`, { method: 'DELETE' });
      if (json.success) {
        toast.success('Document deleted');
        setDocuments(prev => prev.filter(d => d.id !== id));
      } else {
        toast.error(json.error || 'Failed to delete document');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[documents] handler threw', err);
      toast.error('Something went wrong deleting document. Please try again.');
    }
  };

  /**
   * ╔════════════════════════════════════════════════════════════════════════╗
   * ║  What Share, Print and the exported PDF say about a record             ║
   * ╚════════════════════════════════════════════════════════════════════════╝
   *
   * One list, used by all three, plus their bulk counterparts.
   *
   * ── IT COMES FROM THE ROW'S OWN CATEGORY NOW ─────────────────────────────
   * This used to be a fixed list: number, holder, date of birth, father/spouse,
   * expiry date. Those are the fields of an IDENTITY document, and the Document
   * Manager lists all 84+ sub-categories. So a GST return shared with no ARN, no
   * period and no amount; a lease with no counterparty; a business PAN card with
   * nothing at all beyond its title, because the business taxonomy declares none
   * of the five. Three of the five were blank on most rows and the fields the
   * record actually held were never looked at.
   *
   * `doc.fields` is that answer, built server-side from the category's spec
   * where the spec is already loaded — see `documentFieldList` in
   * records/docMetadata.ts. The sub-category workspace has done this since it
   * was written (`recordFields` in SubCategoryWorkspace.jsx); this is the
   * Document Manager catching up, and the two now say the same things about the
   * same record.
   *
   * ── THE FALLBACK IS FOR PRE-TAXONOMY ROWS ONLY ───────────────────────────
   * A row written before the taxonomy has no `categoryRef`, so the server has no
   * spec to shape a list from and returns none. Those rows genuinely do hold the
   * legacy five, so the old list is what describes them — kept for them, and
   * reached by nothing else.
   *
   * Custom fields stay client-side: `docCustomFields` already reads both the
   * sealed `custom_fields` JSON and the legacy open `customFields` array, and
   * duplicating that parsing on the server would be a second place to keep it.
   */
  const docFields = (doc) => {
    const heading = [
      { label: 'Document Name', value: doc.title },
      { label: 'Category', value: docCategoryName(doc).toUpperCase() },
    ];
    const custom = docCustomFields(doc).map((f) => ({ label: f.label, value: f.value }));

    if (Array.isArray(doc.fields)) {
      return [
        ...heading,
        // Not in `doc.fields`: `documentFieldList` deliberately omits
        // `holder_name`, because a business record belongs to the COMPANY
        // however that free-text field was filled in, and `display.holderName`
        // is the answer that knows it.
        { label: 'Holder Name', value: doc.display?.holderName || '' },
        // Dates arrive as the stored ISO string and are rendered HERE, in the
        // reader's locale — the server has no business deciding that an Indian
        // household reads '08 Sep 2026'. `dataType` travels with each field for
        // exactly this.
        ...doc.fields.map((f) => (f.dataType === 'date' && f.value
          ? { label: f.label, value: formatDate(f.value) }
          : { label: f.label, value: f.value })),
        ...custom,
      ].filter((f) => f.value !== '' && f.value !== undefined && f.value !== null);
    }

    return [
      ...heading,
      { label: doc.display?.numberLabel || 'Document Number', value: doc.display?.number || '' },
      { label: 'Holder Name', value: doc.display?.holderName || '' },
      { label: 'Date of Birth', value: docField(doc, 'dob') ? formatDate(docField(doc, 'dob')) : '' },
      { label: 'Father/Spouse', value: docField(doc, 'fatherName') },
      { label: 'Expiry Date', value: docField(doc, 'expiryDate') ? formatDate(docField(doc, 'expiryDate')) : '' },
      ...custom,
    ];
  };

  // All three helpers take filePath as their FOURTH argument. Passing it earlier
  // lands it in `detailsText` and leaves `fields` holding something that isn't
  // an array — which is why Share threw and Download emitted a metadata sheet
  // instead of the file.
  //
  // The FIFTH argument is what the attachment is. Without it a shared vault file
  // arrives named after the record with no extension — a vault filePath carries
  // none — and WhatsApp will not open it. `pageCount` is what makes a scanned
  // multi-page document share as all of its pages.
  const handleShare = async (doc) => {
    // Every outcome — including "you may not share this file" and "this browser
    // has no share sheet" — is reported by `reportShareResult`, in the same
    // words on all twenty pages that share a record.
    reportShareResult(await shareRecord(
      doc.title,
      docFields(doc),
      undefined,
      doc.filePath,
      { fileName: doc.fileName, mimeType: doc.mimeType, pageCount: doc.pageCount },
    ));
  };

  const handleDownload = async (doc) => {
    if (!doc.filePath) {
      await downloadRecord(`Document - ${doc.title}`, docFields(doc));
      return;
    }
    // `?download=1` makes the route send Content-Disposition with the stored
    // filename. Letting downloadRecord derive a name from a vault filePath
    // (/api/records/documents/<id>/file) would save it as "file", extensionless.
    // getFileUrl still has to run: legacy rows hold /uploads/<name>.
    const href = new URL(getFileUrl(doc.filePath), window.location.origin);
    href.searchParams.set('download', '1');
    const a = document.createElement('a');
    a.href = href.toString();
    a.download = doc.fileName || 'document';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handlePrint = async (doc) => {
    // Everything this used to do by hand — fetch the bytes, frame the blob
    // rather than the URL the browser refuses, pick image-vs-PDF without
    // trusting an extensionless vault path — `printRecord` now does, and does
    // for every page. It additionally prints an office document as its rendered
    // PDF, which this could not: the old allowlist sent those to the metadata
    // sheet and the pages themselves were never printed at all.
    const result = await printRecord(doc.title, docFields(doc), undefined, doc.filePath);
    if (result && !result.success) {
      toast.error(result.error || 'Could not open this document to print.');
    }
  };

  // ── Bulk actions on the current selection ─────────────────────────────────
  // Every one of these acts on `selectedIds`, which the user built from the
  // FILTERED list. The ids are resolved back to rows for the client-side
  // actions; delete and download send the ids and let the server re-check them
  // against the tenant, because a client-held row proves nothing.

  const selectedDocs = () => documents.filter((d) => selectedIds.includes(d.id));

  /** The share/print/download item shape, for one row. */
  const asShareItem = (doc) => ({
    id: doc.id,
    title: doc.title,
    fields: docFields(doc),
    filePath: doc.filePath,
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    // A scanned record is stored as pages; without this only the first sheet
    // reaches the share sheet.
    pageCount: doc.pageCount,
  });

  /**
   * Pull every id the CURRENT filters match, not just this page.
   *
   * The list is paginated, so "select all matching" cannot be answered from
   * what is on screen. Re-runs the same query with a large page size and takes
   * the ids only.
   */
  const handleSelectAllMatching = async () => {
    setBulkBusy(true);
    try {
      const params = new URLSearchParams(searchParams.toString());
      params.set('page', '1');
      params.set('limit', '500');
      const { json } = await api(`/api/documents?${params.toString()}`);
      if (!json.success) {
        toast.error(json.error || 'Could not select all matching documents');
        return;
      }
      setSelectedIds(json.documents.map((d) => d.id));
      if (json.pagination?.totalCount > json.documents.length) {
        toast.info(`Selected the first ${json.documents.length} of ${json.pagination.totalCount}.`);
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[documents] handler threw', err);
      toast.error('Something went wrong selecting all matching documents. Please try again.');
    } finally {
      setBulkBusy(false);
    }
  };

  /**
   * The selected rows this member may `action`, and how many were dropped.
   *
   * A selection spans categories — that is the point of the document manager —
   * so "may they do this" has no single answer for a selection. Each bulk
   * action runs on its own permitted subset.
   *
   * The shortfall is RETURNED rather than swallowed: quietly acting on four of
   * six rows is worse than acting on four and saying so, because the member has
   * no other way to discover which two did not happen.
   */
  const permittedSelection = (action) => {
    const all = selectedDocs();
    const allowed = all.filter((d) => may(d, action));
    return { allowed, denied: all.length - allowed.length, total: all.length };
  };

  /** "Shared 4 of 6 — …" when some rows were not permitted. */
  const reportShortfall = (verb, allowed, denied) => {
    if (denied > 0) {
      toast.info(
        `${verb} ${allowed} of ${allowed + denied} — you do not have permission for ${denied} of the selected documents.`,
      );
    }
  };

  const handleBulkShare = async () => {
    const { allowed, denied } = permittedSelection('share');
    const items = allowed.map(asShareItem);
    if (items.length === 0) {
      if (denied > 0) toast.error('You cannot share any of the selected documents.');
      return;
    }
    setBulkBusy(true);
    try {
      const result = await shareRecords(items);
      reportShareResult(result);
      if (result.success) reportShortfall('Shared', items.length, denied);
    } catch (err) {
      toast.error('Could not share the selected documents');
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkPrint = async () => {
    const items = selectedDocs().map(asShareItem);
    if (items.length === 0) return;
    setBulkBusy(true);
    try {
      await printRecords(items);
    } catch (err) {
      toast.error('Could not print the selected documents');
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkDownload = async () => {
    if (selectedIds.length === 0) return;
    // Same rule as the single Download: taking a copy out is `share`. The
    // route filters the ids to the same set server-side (permittedCategories
    // with 'share'), so this only decides what to ask for and what to say.
    const { allowed, denied } = permittedSelection('share');
    if (allowed.length === 0) {
      toast.error('You cannot download any of the selected documents.');
      return;
    }
    setBulkBusy(true);
    try {
      // `apiDownload`, because the success body is a ZIP and must not be read
      // as text — but the FAILURE body is JSON or a proxy's HTML page, and
      // "Could not build the archive" was the answer to all of it: a 507 with
      // the tenant's figures in it, a 504 on an archive too big for the proxy,
      // and an expired session.
      const outcome = await apiDownload(scoped('/api/documents/bulk-download'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: allowed.map((d) => d.id) }),
      }, { subject: 'archive', action: 'building this archive' });
      if (!outcome.ok) {
        if (!toastStorageError({ status: outcome.status }, outcome.json)) {
          toastApiError(outcome, { subject: 'archive', action: 'building this archive' });
        }
        return;
      }
      // The route streams a ZIP; save it under the filename it named itself.
      const blob = await outcome.response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `documents-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Downloading ${allowed.length} document(s)`);
      reportShortfall('Downloaded', allowed.length, denied);
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[documents] handler threw', err);
      toast.error('Something went wrong downloading the selected documents. Please try again.');
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    const { allowed, denied } = permittedSelection('delete');
    if (allowed.length === 0) {
      toast.error('You cannot delete any of the selected documents.');
      return;
    }
    // The count in the prompt is what will ACTUALLY be deleted, not what is
    // ticked — confirming "delete 6" and losing 4 is the wrong kind of surprise.
    if (!confirm(`Delete ${allowed.length} document(s)? They can be restored by an administrator.`)) return;
    setBulkBusy(true);
    setBulkDeleting(true);
    try {
      const { json } = await api('/api/documents/bulk-delete', {
        method: 'POST',
        timeoutMs: 180_000,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: allowed.map((d) => d.id) }),
      });
      if (!json.success) {
        toast.error(json.error || 'Could not delete the selected documents');
        return;
      }
      const failed = (json.results || []).filter((r) => !r.success).length;
      if (failed > 0) {
        toast.warning(`Deleted ${json.deletedCount}; ${failed} could not be found.`);
      } else {
        toast.success(`Deleted ${json.deletedCount} document(s)`);
      }
      reportShortfall('Deleted', allowed.length, denied);
      setSelectedIds([]);
      // Drop the rows NOW, from the answer itself — not only via the refetch
      // below, which a user who has already given up and pressed refresh
      // cancels mid-flight. The refetch still runs, for the counts and paging.
      const deletedIds = new Set((json.results || []).filter((r) => r.success).map((r) => r.id));
      setDocuments((prev) => prev.filter((d) => !deletedIds.has(d.id)));
      fetchDocuments();
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[documents] handler threw', err);
      toast.error('Something went wrong deleting the selected documents. Please try again.');
    } finally {
      setBulkBusy(false);
      setBulkDeleting(false);
    }
  };

  // Search, category filtering and sorting are owned by <DataTable> (it keeps its
  // own state and drives the list through URL params) — see src/components/ui/data-table.jsx.

  /**
   * Display name / module for a document. `categoryRef` is hydrated by
   * /api/documents; the fallbacks cover a row written by an older client.
   */
  const docCategoryName = (doc) => doc.categoryRef?.documentName || doc.category || 'Uncategorized';
  const docColors = (doc) => MODULE_COLORS[doc.categoryRef?.moduleKey] || DEFAULT_MODULE_COLOR;

  /**
   * The row's FULL taxonomy pair — 'Category - Sub-category', in the words the
   * rest of the app uses for the two tiers (see CategorySelect's label pair).
   *
   * The list used to show one tier or the other and never both: the table named
   * the module under the title, the mobile card named the sub-category under a
   * heading that said "Category". Neither told you where a document actually
   * sits, and the two views disagreed about what "Category" meant.
   *
   * A pre-vault row carries only the sub-category half (legacyShape builds a
   * `categoryRef` with `documentName` alone), and an uncategorised row reads
   * 'Uncategorized' on both halves — neither should render a hyphen with the
   * same word on either side of it.
   */
  const docTaxonomyLabel = (doc) => {
    const moduleName = doc.categoryRef?.moduleName || null;
    const subName = doc.categoryRef?.documentName || doc.category || null;
    if (moduleName && subName && moduleName !== subName) return `${moduleName} - ${subName}`;
    return moduleName || subName || 'Uncategorized';
  };

  /**
   * ╔════════════════════════════════════════════════════════════════════════╗
   * ║  may() — may this member do `action` to THIS row?                      ║
   * ╚════════════════════════════════════════════════════════════════════════╝
   *
   * The document manager lists the whole taxonomy, so a permission question
   * here has no single answer: the same table holds a passport the member may
   * only read and a medical report they own outright. The row's OWN category
   * decides, exactly as the server decides it — `canReachRecord` in
   * records/handler.ts asks `hasPermission(row.categoryModuleKey, action,
   * row.categoryDocumentKey)` and this is the same question client-side.
   *
   * `categoryRef` ships with every list row (the `with:` block in
   * /api/documents GET) precisely so this is answerable without a second fetch.
   *
   * A row with no category pair is a pre-vault row; it falls back to the
   * `documents` module default, which is the fallback `canReachRecord` makes
   * too (via `canAnyInScope`). Not identical — the server asks "any category of
   * the scope", this asks the module row — but it errs toward showing a control
   * the server then re-checks, never toward hiding one that is allowed.
   *
   * ── STILL NOT THE CONTROL ────────────────────────────────────────────────
   * Every route re-checks. Hiding a button is honesty about what will happen,
   * not the thing that makes it happen.
   */
  const may = (doc, action) =>
    clientCan(
      user,
      doc?.categoryRef?.moduleKey ?? 'documents',
      doc?.categoryRef?.documentKey ?? null,
      action,
    );

  /**
   * A bulk selection owns the actions.
   *
   * With two or more rows checked, the toolbar above is showing what is about
   * to happen to N documents while every row still offers its own Share, View
   * and ⋮ — so a click is ambiguous about which set it acts on. The row
   * controls grey out until the selection is back down to one row (or none),
   * which is the point at which "this row" is unambiguous again.
   */
  const bulkSelectionActive = selectedIds.length > 1;
  const rowActionTitle = (label) =>
    (bulkSelectionActive ? 'Use the bulk actions above' : label);

  /**
   * View — opening the stored scan — is the row's most-reached-for action, so it
   * is a button on the row rather than an entry in the ⋮. Written once for the
   * same reason the menu below is: the table and the mobile card are two
   * renderings of one row, and every payload field here was added because the
   * modal was missing it.
   */
  const openPreview = (doc) => setPreviewDoc({
    title: doc.title,
    fileName: doc.fileName,
    filePath: doc.filePath,
    mimeType: doc.mimeType,
    // A scanned agreement is stored a page per Drive object; without this
    // the modal shows sheet one and offers no way to the rest.
    pageCount: doc.pageCount,
    // Carried so the modal's own Download button can ask `may` the same
    // question this row did.
    categoryRef: doc.categoryRef,
  });

  /**
   * The ⋮ menu, written once for the table row and the mobile card — they offer
   * the same four actions and drifted apart the last time they were two copies.
   *
   * Falsy entries are dropped by <RowActionsMenu>, which renders nothing at all
   * when they ALL drop out: an empty ⋮ is a promise the menu cannot keep.
   */
  const rowMenuItems = (doc) => [
    // Print asks nothing extra: the row is listed, so `view` is already true,
    // and printing is reading.
    {
      key: 'print',
      icon: <Printer size={12} />,
      label: 'Print',
      onClick: () => handlePrint(doc),
    },
    // Taking a copy out is `share`, not `view` — see the file route's download gate.
    may(doc, 'share') && {
      key: 'download',
      icon: <Download size={12} />,
      label: 'Download',
      onClick: () => handleDownload(doc),
    },
    may(doc, 'edit') && {
      key: 'edit',
      icon: <Pencil size={12} />,
      label: 'Edit',
      onClick: () => openEditModal(doc),
    },
    may(doc, 'delete') && {
      key: 'delete',
      icon: <Trash2 size={12} />,
      label: 'Delete',
      destructive: true,
      onClick: () => handleDelete(doc.id),
    },
  ];

  // Filter options come from the master list. The taxonomy has exactly two
  // levels — Category, then Sub-category — so the filters do too. Both take
  // SEVERAL values: a household question is rarely about one category, and
  // "insurance and vehicle papers" used to mean running the list twice.
  //
  // The visible word is "Category" because that is what the rest of the app
  // calls this tier (see CategorySelect); the URL param stays `moduleKey`,
  // which is the key the API and hasPermission actually speak.
  const selectedModuleKeys = parseFilterValues(searchParams.get('moduleKey'));
  const moduleFilterOptions = categoryGroups.map((g) => ({
    value: g.moduleKey,
    label: g.moduleName,
  }));

  // Sub-category filter. It is NOT chained to the category one: with nothing
  // chosen above it offers the whole taxonomy under module headings, and with
  // categories chosen it narrows to those.
  //
  // Its value is a category ID, not a `documentKey`. A documentKey is unique
  // only INSIDE a module — `registration_certificate` is both a vehicle RC and
  // a business registration — so it only ever meant something alongside a
  // moduleKey, which is exactly what forced the old cascade. An id is
  // unambiguous on its own, and the route already understands `categoryId`.
  const subCategoryFilterOptions = (selectedModuleKeys.length > 0
    ? categoryGroups.filter((g) => selectedModuleKeys.includes(g.moduleKey))
    : categoryGroups
  ).flatMap((g) => g.items.map((c) => ({
    value: c.id,
    label: c.documentName,
    // Read by <DataTable>'s groupOptions: 83 flat sub-categories are a wall,
    // the same 83 under their module headings are a list.
    group: g.moduleName,
  })));

  /**
   * The sub-categories still reachable after a change to the CATEGORY filter.
   *
   * The two filters AND together, so a leftover sub-category from a module the
   * member has just deselected would silently match nothing. Rather than clear
   * the whole sub-category selection (what `resets` would do), keep the picks
   * that are still in scope and drop only the rest.
   */
  const pruneSubCategories = (nextModuleValue, currentParams) => {
    const moduleKeys = parseFilterValues(nextModuleValue);
    const chosen = parseFilterValues(currentParams.get('categoryId'));
    if (chosen.length === 0 || moduleKeys.length === 0) return {};
    const inScope = new Set(
      categoryOptions
        .filter((c) => moduleKeys.includes(c.moduleKey))
        .map((c) => c.id),
    );
    const kept = chosen.filter((id) => inScope.has(id));
    return { categoryId: kept.length > 0 ? kept.join(',') : null };
  };

  // Members, plus the unassigned bucket. `holderId` is nullable, so
  // "Global (All Members)" needs its own sentinel — the API maps it to IS NULL.
  const holderFilterOptions = [
    { value: 'none', label: 'Global (All Members)' },
    ...holderOptions.map((h) => ({ value: h.id, label: h.name })),
  ];

  if (initialLoad) {
    return (
      <PageContainer>
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-10 w-32 rounded-lg" />
        </div>
        <Skeleton className="h-11 w-full rounded-xl" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-56 w-full rounded-2xl" />
          ))}
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      
      {/* Header Row */}
      <div className="flex flex-wrap items-start justify-between gap-3 animate-fade-in">
        <div className="flex flex-col gap-1 min-w-0">
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-foreground">Documents Manager</h1>
          <p className="text-muted-foreground text-sm">One secure place for every document your workspace owns</p>
        </div>
        {/* Both routes into this page are ways of ADDING a document, so both
            disappear together for a member who may add nowhere.

            Hidden below `sm` and replaced by the FAB column at the bottom of
            this file: the two labels carry `whitespace-nowrap` (see Button), so
            side by side they are ~288px of rigid width that a 375px phone
            cannot spare — the heading was crushed and the second button clipped
            off the right edge by `body { overflow-x: hidden }`. */}
        {canAddAnywhere && (
        <div className="hidden sm:flex items-center gap-2">
          {/*
            Power scan is part of the document manager, not a dashboard feature.
            It was reachable only from the sidebar, the command palette, /more
            and /dashboard — never from the module that owns uploading.
          */}
          <Button
            variant="secondary"
            onClick={() => router.push(utilityNavPath('/documents/bulk-scan', companyId))}
            className="flex items-center gap-2 h-10 px-4"
          >
            <Sparkles size={16} />
            <span>Power Scan</span>
          </Button>
          <Button
            onClick={() => (showAddForm ? closeAddForm() : setShowAddForm(true))}
            className="flex items-center gap-2 h-10 px-4"
          >
            {showAddForm ? <X size={16} /> : <Plus size={16} />}
            <span>{showAddForm ? 'Close Form' : 'Upload Document'}</span>
          </Button>
        </div>
        )}
      </div>

      {/* Add Document Section */}
      {showAddForm && (
        <Card className="relative border-border/50 bg-card backdrop-blur shadow-glass p-6 md:p-8 animate-scale-in">
          {uploading && (
            <ProcessingOverlay
              title="Processing your document"
              message={
                uploadPercent >= 0 && uploadPercent < 100
                  ? `Uploading — ${uploadPercent}%`
                  : 'Uploading and saving it securely — this can take a few moments.'
              }
            />
          )}
          <CardHeader className="p-0 pb-4 border-b border-border/50 mb-6">
            <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
              <Upload className="text-primary" size={20} />
              <span>Upload New Document</span>
            </h2>
          </CardHeader>

          

          {formError && (
            <Alert variant="destructive" className="mb-4">
              <AlertCircle size={16} />
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}

          {/* Not cosmetic: the whole form is built from this list — the picker,
              the field spec behind it, and the scan's ability to select what it
              classified. Without it nothing here can be saved, so it says so
              rather than presenting a form that will not work. */}
          {categoriesError && (
            <Alert variant="destructive" className="mb-4">
              <AlertCircle size={16} />
              <AlertDescription>
                {categoriesError} — reload the page before uploading.
              </AlertDescription>
            </Alert>
          )}

          <form onSubmit={handleUploadSubmit} className="flex flex-col gap-5">
            {/* ── Step 1: the file, and reading it ──────────────────────────
                The file comes FIRST because everything below it is meant to be
                filled in by reading it rather than typed — and it is the same
                dropzone Power Scan opens with, because these are the same act
                done to one document instead of many. A drag lands on the same
                handler as a click, so the type check and the "kept the first"
                rule cannot apply to only one of them. */}
            <div className="flex flex-col gap-1.5">
              <div
                onDragOver={(e) => { e.preventDefault(); if (!busy) setDragActive(true); }}
                onDragLeave={() => setDragActive(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragActive(false);
                  if (busy) return;
                  // Same handler as the picker, so a dragged file gets the same
                  // type check and the same "kept the first" rule. `value` is
                  // there because the handler resets it — a real input needs
                  // that to fire again for the same file twice.
                  handleFileChange({ target: { files: e.dataTransfer.files, value: '' } });
                }}
                onClick={(e) => {
                  // The input lives INSIDE this div, so the click it dispatches
                  // bubbles straight back here — without this guard the handler
                  // re-opens the picker from its own click.
                  if (e.target === uploadInputRef.current) return;
                  if (busy) return;
                  uploadInputRef.current?.click();
                }}
                className={cn(
                  'glass-card group flex min-h-[220px] flex-col items-center justify-center rounded-2xl border-2 border-dashed p-8 text-center transition-all',
                  busy ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                  fileError ? 'border-destructive'
                    : dragActive ? 'border-primary bg-card/80'
                    : 'border-border/60 hover:border-primary/50 hover:bg-card/80',
                )}
              >
                <input
                  type="file"
                  ref={uploadInputRef}
                  accept={UPLOAD_ACCEPT_ATTRIBUTE}
                  onChange={handleFileChange}
                  className="hidden"
                  disabled={uploading || aiScanning}
                />
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary transition-transform duration-300 group-hover:scale-110">
                  <UploadCloud size={28} />
                </div>
                <h3 className="mb-1 text-lg font-bold text-foreground">Drag &amp; drop your document here</h3>
                <p className="mb-4 max-w-sm text-xs text-muted-foreground">
                  Supports PDFs, Images, Word Docs, Text, Excel, and more
                </p>
                {/* Singular, both of them: this form takes exactly ONE file —
                    `handleFileChange` keeps the first of a multi-file drop and
                    points at Power Scan for the rest. Power Scan's own dropzone
                    stays plural, because it really does take many. */}
                <Button type="button" variant="secondary" size="sm" tabIndex={-1}>
                  Select File
                </Button>
              </div>

              {/* One row, not a list: several files is Power Scan's job, and
                  `handleFileChange` keeps the first with a link to it. */}
              {file && (
                <div className="mt-3 flex items-center justify-between rounded-xl border border-border bg-card p-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <FileText size={18} />
                    </div>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-semibold text-foreground">{file.name}</span>
                      <span className="mt-0.5 text-xs text-muted-foreground">
                        {(file.size / 1024 / 1024).toFixed(2)} MB
                      </span>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={uploading || aiScanning}
                    onClick={(e) => { e.stopPropagation(); setFile(null); setFileError(''); }}
                    className="h-8 w-8 text-danger-action hover:bg-destructive/10"
                    aria-label="Remove file"
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
              )}

              {fileError && (
                <p className="text-xs font-medium text-danger-text">{fileError}</p>
              )}
              <p className="text-xs text-faint">
                One document at a time. Accepted: {UPLOAD_ACCEPT_LABEL}.
              </p>

              <div className="flex flex-col gap-2 mt-2">
                <Button
                  type="button"
                  onClick={handleAiScan}
                  disabled={aiScanning || uploading || !file}
                  className="w-full text-xs font-semibold py-2 flex items-center justify-center gap-2"
                >
                  <Sparkles size={15} className={aiScanning ? 'animate-spin' : ''} />
                  <span>
                    {aiScanning ? 'Reading document...'
                      : hasScanned ? 'Rescan with AI'
                      : 'Auto-fill with AI'}
                  </span>
                </Button>
                {aiMessage && <p className="text-xs text-center text-info-text mt-1">{aiMessage}</p>}
                {/* Advisory, never blocking: a document the OCR could not read
                    is still a document, and the fields below stay editable. */}
                {aiError && (
                  <p className="text-xs text-center text-amber-500">
                    {aiError}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => router.push(utilityNavPath('/documents/bulk-scan', companyId))}
                  className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 self-center"
                >
                  Several documents at once? Use Power Scan
                </button>
              </div>
            </div>

            {/* ── Step 2: where it is filed, and who it belongs to ─────────
                These three are the ONLY controls this page hardcodes. The
                category decides everything below it, so it comes first. */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-border/50 pt-5 mt-2">
              {/* `add`, not the default `view`: this form offered every
                  category the member could SEE and then 403'd on the ones it
                  had no business offering.

                  The span is `md`, not `sm`: this grid only becomes two columns
                  at `md`, and CategorySelect splits into two of its own — a
                  `sm` span left it crushed into half a column from `md` up. */}
              <CategorySelect
                id="category"
                label="Category / Folder *"
                subLabel="Sub-category *"
                value={categoryId}
                onChange={setCategoryId}
                disabled={uploading}
                className="md:col-span-2"
                action="add"
              />

              <div className="flex flex-col gap-1">
                <HolderSelect
                  value={holderId}
                  onChange={(val) => {
                    setHolderId(val);
                    setHolderFromScan(false);
                    setHolderError('');
                  }}
                  disabled={uploading}
                  required
                  error={holderError}
                  suggestedName={holderNameFromScan}
                />
                {holderFromScan && (
                  <p className="text-xs font-medium text-info-text">Matched from the scan — change it if that is wrong.</p>
                )}
              </div>
            </div>

            {/* ── Step 3: whatever THIS category collects ───────────────────
                Not one line of it written here. A hardcoded ID Number / Holder
                Name / Date of Birth / Father's Name / Expiry Date block used to
                sit in this spot and was asked identically of all 83
                sub-categories — naming a field most of them do not have, and
                with nowhere to put the ones they do. */}
            <div className="flex flex-col gap-4 border-t border-border/50 pt-5 mt-2">
              {!categoryId ? (
                <p className="text-xs text-muted-foreground">
                  Pick a category above and its own fields appear here.
                </p>
              ) : uploadFields.loadingSpec ? (
                <div className="flex items-center gap-2 py-4 text-muted-foreground">
                  <Loader2 size={16} className="animate-spin" />
                  <span className="text-xs">Loading this category&rsquo;s fields&hellip;</span>
                </div>
              ) : uploadFields.specError ? (
                <Alert variant="destructive">
                  <AlertCircle size={16} />
                  <AlertDescription>{uploadFields.specError}</AlertDescription>
                </Alert>
              ) : (
                <>
                  <span className="text-xs font-bold text-primary uppercase tracking-wider">
                    {uploadFields.spec?.category?.documentName || 'Document'} details
                  </span>

                  <CategoryFieldInputs
                    fields={uploadFields.fields}
                    values={uploadFields.values}
                    errors={uploadFields.errors}
                    touched={uploadFields.touched}
                    aiFilled={uploadFields.aiFilled}
                    disabled={uploading}
                    onChange={uploadFields.setValue}
                    onBlur={uploadFields.onBlur}
                    registerRef={uploadFields.registerRef}
                  />

                  {uploadFields.hasCards && (
                    <LinkedCardRows
                      value={uploadFields.cardsValue}
                      onChange={uploadFields.setCardsValue}
                      disabled={uploading}
                      error={uploadFields.touched[LINKED_CARDS_KEY]
                        ? uploadFields.errors[LINKED_CARDS_KEY]
                        : undefined}
                    />
                  )}

                  <CustomFieldRows
                    rows={uploadFields.customRows}
                    onChange={uploadFields.setCustomRows}
                    disabled={uploading}
                  />
                </>
              )}
            </div>

            {/* Cancel sits WITH Save, at the foot of the form, because that is
                where someone who has changed their mind actually is — the toggle up
                in the page header has long since scrolled away. It discards whatever
                was typed; see closeAddForm. */}
            <div className="mt-2 flex flex-col-reverse gap-3 md:flex-row md:justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={closeAddForm}
                disabled={uploading || aiScanning}
                className="h-11 px-6"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={uploading || aiScanning}
                className="w-full md:w-auto h-11 px-6"
              >
                {uploading ? (
                  <>
                    <Loader2 size={16} className="animate-spin mr-1.5" />
                    Uploading...
                  </>
                ) : 'Save Document'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* Documents List */}
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle size={16} />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!error && (
        <DataTable
          data={documents}
          loading={loading}
          pagination={pagination}
          selectable
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          totalMatching={pagination?.totalCount || 0}
          onSelectAllMatching={handleSelectAllMatching}
          bulkActions={[
            // Disabled when NOTHING in the selection permits the action; a
            // partly-permitted selection stays enabled, acts on the subset and
            // reports the shortfall. Print asks nothing extra — every selected
            // row is a row this member may already view.
            {
              key: 'share',
              label: 'Share',
              icon: <Share2 size={13} />,
              disabled: bulkBusy || permittedSelection('share').allowed.length === 0,
              onClick: handleBulkShare,
            },
            {
              key: 'print',
              label: 'Print',
              icon: <Printer size={13} />,
              disabled: bulkBusy,
              onClick: handleBulkPrint,
            },
            {
              key: 'download',
              label: 'Download',
              icon: <Download size={13} />,
              disabled: bulkBusy || permittedSelection('share').allowed.length === 0,
              onClick: handleBulkDownload,
            },
            {
              key: 'delete',
              label: bulkDeleting ? 'Deleting…' : 'Delete',
              icon: bulkDeleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />,
              variant: 'destructive',
              disabled: bulkBusy || permittedSelection('delete').allowed.length === 0,
              onClick: handleBulkDelete,
            },
          ]}
          filterDefinitions={[
            {
              key: 'moduleKey',
              label: 'Category',
              allLabel: 'All categories',
              multiple: true,
              options: moduleFilterOptions,
              // `documentKey` is the retired single-value sub-category param.
              // The route still honours it, so a bookmarked `?documentKey=…`
              // would keep narrowing the list with no control showing it —
              // naming it here puts it under both this reset and the Clear
              // button. The live sub-category filter is `categoryId` below and
              // is deliberately NOT reset: see pruneSubCategories.
              resets: ['documentKey'],
              derive: pruneSubCategories,
            },
            {
              key: 'categoryId',
              label: 'Sub-category',
              allLabel: 'All sub-categories',
              multiple: true,
              options: subCategoryFilterOptions,
            },
            {
              key: 'holderId',
              label: 'Members',
              allLabel: 'All members',
              multiple: true,
              options: holderFilterOptions
            }
          ]}
          columns={[
            {
              header: 'Document Name',
              key: 'name',
              sortable: true,
              render: (doc) => {
                const { fg: docColor, bg: docBg } = docColors(doc);
                const taxonomy = docTaxonomyLabel(doc);
                return (
                  <div className="flex items-center gap-3">
                    <span
                      className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                      style={{ color: docColor, backgroundColor: docBg }}
                    >
                      <FileText size={20} />
                    </span>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-bold text-foreground truncate max-w-[200px]">{doc.title}</span>
                      {/* Both tiers, so the row says where the document sits and
                          not merely which module owns it. The pair is roughly
                          twice as long as either half, so it WRAPS — a single
                          clipped line cut the sub-category, the half that says
                          which of the module's kinds this actually is. Two lines
                          keeps the row height predictable; the tooltip still
                          carries the whole of it. */}
                      <span
                        className="text-xs text-muted-foreground break-words line-clamp-2 max-w-[280px]"
                        title={taxonomy}
                      >
                        {taxonomy}
                      </span>
                    </div>
                  </div>
                );
              }
            },
            {
              // `display` is derived server-side from the row's OWN category —
              // its identifier field, and the member it is filed
              // against. Reading `documentNumber`/`idHolderName` here meant
              // only the six keys fieldMap names ever rendered, and a holder
              // only when someone had typed one as free text. See docMetadata.
              header: 'Number',
              key: 'number',
              render: (doc) => <span className="font-medium text-xs">{doc.display?.number || '-'}</span>
            },
            {
              header: 'Holder',
              key: 'holder',
              render: (doc) => <span className="text-xs">{doc.display?.holderName || '-'}</span>
            },
            {
              header: 'Uploaded By',
              key: 'user',
              render: (doc) => <span className="text-xs text-muted-foreground">{doc.user?.name || '-'}</span>
            },
            {
              header: 'Actions',
              key: 'actions',
              render: (doc) => (
                <div className="flex items-center gap-1.5 justify-end">
                  {/* All three grey out while a bulk selection is up — see
                      bulkSelectionActive. */}
                  {may(doc, 'share') && (
                    <Button
                      onClick={() => handleShare(doc)}
                      // Starts fetching the file on press rather than on click, so the
                      // bytes are usually in hand before the handler runs and
                      // `navigator.share()` still holds the user activation it
                      // requires. See warmShare.
                      onPointerDown={() => warmShare([asShareItem(doc)])}
                      variant="outline"
                      size="icon"
                      disabled={bulkSelectionActive}
                      className="h-8 w-8 text-primary hover:text-primary hover:bg-primary/10 border-primary/20 bg-primary/5"
                      title={rowActionTitle('Share')}
                    >
                      <Share2 size={13} />
                    </Button>
                  )}
                  {/* View asks nothing extra: the row is listed, so `view` is
                      already true. Gated on the file instead — a record with no
                      scan has nothing for the preview to open. */}
                  {doc.filePath && (
                    <Button
                      onClick={() => openPreview(doc)}
                      variant="outline"
                      size="icon"
                      disabled={bulkSelectionActive}
                      className="h-8 w-8 text-emerald-500 hover:text-emerald-600 hover:bg-emerald-500/10 border-emerald-500/20 bg-emerald-500/5"
                      title={rowActionTitle('View')}
                    >
                      <Eye size={13} />
                    </Button>
                  )}

                  <RowActionsMenu
                    items={rowMenuItems(doc)}
                    disabled={bulkSelectionActive}
                    title={rowActionTitle('More actions')}
                    triggerClassName="h-8 w-8 text-muted-foreground hover:bg-muted/10 border-border/50 bg-background/5"
                  />
                </div>
              )
            }
          ]}
          renderCard={(doc, { checkbox }) => {
            const { fg: docColor, bg: docBg } = docColors(doc);
            // No bottom margin on the Card: the table's mobile list already
            // spaces these with `space-y-4`, and an `mb-4` on top of it left
            // documents 32px apart while every other card list sits at 16px.
            /* Content only: <DataTable> wraps every mobile row in <RecordCard>,
               which owns the border, fill, padding and shadow — and paints the
               selected state to match a selected desktop row. */
            return (
              <div className="flex flex-col gap-4">
                  <div className="flex items-start justify-between gap-4">
                    {/* The selection control lives in the card's own header row,
                        beside the file-type icon. Outside the card it indented
                        the whole list away from the search box above it. */}
                    <span className="flex items-center gap-3 min-w-0">
                      {checkbox}
                      <span
                        className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                        style={{ color: docColor, backgroundColor: docBg }}
                      >
                        <FileText size={20} />
                      </span>
                    </span>

                    
                    {/* The same gates as the table's Actions column above —
                        permissions AND the bulk-selection greying. Both have to
                        carry them or the mobile view keeps offering what the
                        desktop one has stopped offering. */}
                    <div className="relative flex items-center gap-1.5 min-w-0">
                      {may(doc, 'share') && (
                        <Button
                          onClick={() => handleShare(doc)}
                          // Starts fetching the file on press rather than on click, so the
                          // bytes are usually in hand before the handler runs and
                          // `navigator.share()` still holds the user activation it
                          // requires. See warmShare.
                          onPointerDown={() => warmShare([asShareItem(doc)])}
                          variant="outline"
                          size="icon"
                          disabled={bulkSelectionActive}
                          className="h-8 w-8 text-primary hover:text-primary hover:bg-primary/10 border-primary/20 bg-primary/5"
                          title={rowActionTitle('Share')}
                        >
                          <Share2 size={13} />
                        </Button>
                      )}
                      {doc.filePath && (
                        <Button
                          onClick={() => openPreview(doc)}
                          variant="outline"
                          size="icon"
                          disabled={bulkSelectionActive}
                          className="h-8 w-8 text-emerald-500 hover:text-emerald-600 hover:bg-emerald-500/10 border-emerald-500/20 bg-emerald-500/5"
                          title={rowActionTitle('View')}
                        >
                          <Eye size={13} />
                        </Button>
                      )}

                      <RowActionsMenu
                        items={rowMenuItems(doc)}
                        disabled={bulkSelectionActive}
                        title={rowActionTitle('More actions')}
                        triggerClassName="h-8 w-8 text-muted-foreground hover:bg-muted/10 border-border/50 bg-background/5"
                      />
                    </div>
                  </div>
                  
                  <div className="flex flex-col gap-1 min-w-0">
                    <span className="text-sm font-extrabold text-foreground truncate pr-2">{doc.title}</span>
                    <div className="flex flex-col gap-1 mt-2">
                      <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
                        {/* Both tiers, exactly as the table's first column shows
                            them. It spans the grid because the pair does not fit
                            a half-width cell — this heading said "Category" and
                            then named the SUB-category, which is the confusion
                            the pair removes. */}
                        <div className="flex flex-col gap-0.5 min-w-0 col-span-2">
                          <span className="text-xs uppercase font-bold text-faint">Category</span>
                          {/* Wraps rather than truncates: `title` is a hover
                              tooltip, and there is no hover on a phone — the
                              clipped half was simply unreadable. The block
                              already spans both columns, so it has the width. */}
                          <span
                            className="text-xs font-semibold text-foreground whitespace-normal break-words leading-snug"
                            title={docTaxonomyLabel(doc)}
                          >
                            {docTaxonomyLabel(doc).toUpperCase()}
                          </span>
                        </div>
                        {doc.display?.number && (
                          <div className="flex flex-col gap-0.5 min-w-0">
                            {/* The category's own label — 'Voter ID Number',
                                'Consumer Number' — rather than one word for
                                eighty-three different kinds of number. */}
                            <span className="text-xs uppercase font-bold text-faint">{doc.display.numberLabel || 'Doc No'}</span>
                            <span className="text-xs font-mono font-medium text-foreground truncate">{doc.display.number}</span>
                          </div>
                        )}
                        {doc.display?.holderName && (
                          <div className="flex flex-col gap-0.5 min-w-0">
                            <span className="text-xs uppercase font-bold text-faint">Holder</span>
                            <span className="text-xs text-foreground truncate">{doc.display.holderName}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
              </div>
            );
          }}
        />
      )}

      {/* Preview Modal */}
      <Dialog open={!!previewDoc} onOpenChange={(open) => { if (!open) setPreviewDoc(null); }}>
        {previewDoc && (
          <DialogContent aria-describedby={undefined} className="max-w-[800px] border-border/50 bg-popover/95 backdrop-blur shadow-glass flex flex-col gap-4">
            <DialogHeader className="border-b border-border pb-3">
              <DialogTitle className="text-base font-bold truncate">
                Preview: {previewDoc.title}
              </DialogTitle>
            </DialogHeader>
            <FilePreviewPane
              className="min-h-[350px] max-h-[70vh] flex-1"
              source={{
                kind: 'record',
                filePath: previewDoc.filePath,
                mimeType: previewDoc.mimeType,
                name: previewDoc.title,
                pageCount: previewDoc.pageCount,
              }}
              emptyMessage={`No preview available for ${previewDoc.title}`}
              /* `previewDoc` carries the row's categoryRef for exactly this, so
                 the modal asks the same question the row did. */
              fallbackAction={may(previewDoc, 'share') ? (
                <Button className="mt-4 gap-1.5" onClick={() => handleDownload(previewDoc)}>
                  <Download size={16} />
                  <span>Download File</span>
                </Button>
              ) : null}
            />
          </DialogContent>
        )}
      </Dialog>

      {/* ── Duplicate Detection ─────────────────────────────────────────
          Both halves rendered, three answers. See DuplicateResolveDialog. */}
      <DuplicateResolveDialog
        open={showDuplicateModal}
        match={duplicateDoc}
        newFile={file}
        newTitle={String(uploadFields.values[TITLE_KEY] ?? '').trim()}
        busy={uploading}
        onKeepExisting={handleDuplicateCancel}
        onKeepNew={() => answerDuplicate('replace')}
        onKeepBoth={() => answerDuplicate('keepBoth')}
      />

      {/* Edit Document Modal */}
      <Dialog open={!!editingDoc} onOpenChange={(open) => { if (!open) setEditingDoc(null); }}>
        {editingDoc && (
          <DialogContent aria-describedby={undefined} className="max-w-[640px] max-h-[90vh] overflow-y-auto border-border/50 bg-popover/95 backdrop-blur shadow-glass flex flex-col gap-4">
            <DialogHeader className="border-b border-border pb-3">
              <DialogTitle className="text-lg font-bold flex items-center gap-2 text-foreground">
                <Pencil className="text-primary" size={18} /> 
                <span>Edit Document Settings</span>
              </DialogTitle>
            </DialogHeader>

            {/* Only when a replacement FILE is being sent: that goes through the
                same upload as the add form. A metadata-only edit is a quick PUT
                and the button's own spinner says enough. */}
            {editSaving && editFile && (
              <ProcessingOverlay
                position="fixed inset-0 z-50 rounded-xl"
                title="Processing your document"
                message="Uploading the replacement file and saving it securely — this can take a few moments."
              />
            )}



            {editError && (
              <Alert variant="destructive">
                <AlertCircle size={16} />
                <AlertDescription>{editError}</AlertDescription>
              </Alert>
            )}

            <form onSubmit={handleEditSubmit} className="flex flex-col gap-5 py-2">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* `edit`: re-filing a record is an edit of the destination as
                    much as of the record. The record's CURRENT category stays
                    visible even when it is outside that list — CategorySelect
                    keeps an out-of-list `value` selectable for display. */}
                <CategorySelect
                  id="editCategory"
                  label="Category *"
                  subLabel="Sub-category *"
                  value={editCategoryId}
                  onChange={setEditCategoryId}
                  disabled={editSaving || editLoading}
                  className="md:col-span-2"
                  action="edit"
                />
              </div>

              <HolderSelect id="editHolderId" value={editHolderId} onChange={setEditHolderId} disabled={editSaving || editLoading} />

              {/* The record's OWN category decides what is asked here, from
                  the same spec the upload form renders. It must: the save
                  REPLACES the record body rather than merging it, so a modal
                  still offering the legacy six would blank every field the add
                  form wrote. */}
              <div className="flex flex-col gap-4 border-t border-border/50 pt-5">
                {editFields.loadingSpec || editLoading ? (
                  <div className="flex items-center gap-2 py-4 text-muted-foreground">
                    <Loader2 size={16} className="animate-spin" />
                    <span className="text-xs">
                      {editLoading ? 'Decrypting this document\u2019s details\u2026' : 'Loading this category\u2019s fields\u2026'}
                    </span>
                  </div>
                ) : editFields.specError ? (
                  <Alert variant="destructive">
                    <AlertCircle size={16} />
                    <AlertDescription>{editFields.specError}</AlertDescription>
                  </Alert>
                ) : (
                  <>
                    <span className="text-xs font-bold text-primary uppercase tracking-wider">
                      {editFields.spec?.category?.documentName || 'Document'} details
                    </span>

                    <CategoryFieldInputs
                      fields={editFields.fields}
                      values={editFields.values}
                      errors={editFields.errors}
                      touched={editFields.touched}
                      aiFilled={editFields.aiFilled}
                      disabled={editSaving || editLoading}
                      onChange={editFields.setValue}
                      onBlur={editFields.onBlur}
                      registerRef={editFields.registerRef}
                    />

                    {editFields.hasCards && (
                      <LinkedCardRows
                        value={editFields.cardsValue}
                        onChange={editFields.setCardsValue}
                        disabled={editSaving || editLoading}
                        error={editFields.touched[LINKED_CARDS_KEY]
                          ? editFields.errors[LINKED_CARDS_KEY]
                          : undefined}
                      />
                    )}

                    <CustomFieldRows
                      rows={editFields.customRows}
                      onChange={editFields.setCustomRows}
                      disabled={editSaving || editLoading}
                    />
                  </>
                )}
              </div>

              {/* Upload revised document */}
              <div className="flex flex-col gap-1.5 border-t border-border/50 pt-5 mt-2">
                <span className="text-xs font-bold text-amber-500 uppercase tracking-wider">Upload Revised Document (Optional)</span>
                <div className="border-2 border-dashed border-border/50 hover:border-border rounded-xl p-6 text-center bg-background/10 relative cursor-pointer transition-colors mt-2">
                  <input
                    type="file"
                    accept={UPLOAD_ACCEPT_ATTRIBUTE}
                    onChange={handleEditFileChange}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    disabled={editSaving || editLoading}
                  />
                  <Upload size={20} className="text-muted-foreground mx-auto mb-2 opacity-60" />
                  <p className="text-sm font-bold text-foreground">
                    {editFile ? editFile.name : 'Choose file to replace current document'}
                  </p>
                  <p className="text-xs text-faint mt-1">Current: {editingDoc.fileName}</p>
                </div>
                <div className="flex flex-col gap-2 mt-2">
                  <Button
                    type="button"
                    onClick={handleAiScan}
                    disabled={aiScanning || !editFile}
                    variant="secondary"
                    className="w-full text-xs font-semibold py-2 flex items-center justify-center gap-2"
                  >
                    <Sparkles size={15} className={aiScanning ? 'animate-spin' : ''} />
                    <span>{aiScanning ? 'Reading...' : 'Fill blanks from this document'}</span>
                  </Button>
                  {/* Blanks ONLY, unlike the add form. The values on screen are
                      the record's own, already reviewed once — a re-read
                      overwriting them is a more destructive act than filling
                      in what was never filled, and not one a button this small
                      should be able to do. */}
                  <p className="text-xs text-center text-faint">
                    Fills empty fields only — nothing already recorded is changed.
                  </p>
                  {aiMessage && <p className="text-xs text-center text-info-text mt-1">{aiMessage}</p>}
                  {aiError && <p className="text-xs text-center text-amber-500">{aiError}</p>}
                </div>
              </div>

              {/* `-mx-6` cancels the horizontal padding DialogContent gives the
                  <form> around this footer — without it the bar is inset twice
                  and its background and top border stop short of the edges. */}
              <DialogFooter className="mt-4 gap-2 -mx-6 sm:-mx-7">
                <Button 
                  type="button" 
                  variant="secondary" 
                  onClick={() => setEditingDoc(null)} 
                  disabled={editSaving || editLoading}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={editSaving || editLoading} className="gap-1.5">
                  {editSaving ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      <span>Saving...</span>
                    </>
                  ) : (
                    <>
                      <Save size={16} />
                      <span>Save Changes</span>
                    </>
                  )}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>

      {/* Mobile: the two header actions, reachable and clear of the bottom nav.
          The geometry lives in <MobileActionFab>, which the sub-category
          workspace uses too — the two screens cannot disagree about where the
          primary action lives, and neither can scroll its last row underneath
          it. */}
      {canAddAnywhere && (
        <MobileActionFab
          actions={[
            {
              key: 'power-scan',
              icon: <Sparkles size={18} />,
              label: 'Power Scan',
              variant: 'secondary',
              onClick: () => router.push(utilityNavPath('/documents/bulk-scan', companyId)),
            },
            {
              key: 'add',
              icon: showAddForm ? <X size={22} /> : <Plus size={22} />,
              label: showAddForm ? 'Close upload form' : 'Upload document',
              primary: true,
              onClick: () => (showAddForm ? closeAddForm() : setShowAddForm(true)),
            },
          ]}
        />
      )}

    </PageContainer>
  );
}
