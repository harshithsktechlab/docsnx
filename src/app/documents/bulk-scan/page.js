'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { 
  UploadCloud, 
  FileText, 
  Trash2, 
  ArrowLeft, 
  AlertCircle, 
  Loader2, 
  Sparkles, 
  PlusCircle, 
  Check, 
  HelpCircle,
  FolderDot,
  Eye,
  Copy,
  RefreshCw
} from 'lucide-react';

import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { toastStorageError } from '@/lib/storageToast';
import {
  MAX_SCAN_BYTES,
  MAX_SCAN_FILES,
  UPLOAD_ACCEPT_ATTRIBUTE,
  UPLOAD_ACCEPT_LABEL,
  isAcceptedUpload,
  scanBatchError,
  scanBytesError,
  trimScanBatch,
  trimScanBytes,
} from '@/lib/records/uploadTypes';
import { prepareUploadBatch } from '@/lib/records/fileSnapshot';
import { postUpload } from '@/lib/records/uploadRequest';
import { AI_ERROR_CODES, aiErrorMessageFor } from '@/lib/aiErrors';
import HolderSelect, { unmatchedHolderError } from '@/app/components/HolderSelect';
import { holderForWrite } from '@/lib/records/holderScope';
import { listSentence } from '@/lib/records/fieldValidation';
import CategorySelect from '@/app/components/CategorySelect';
import { clientGetMe, clientCan } from '@/lib/clientAuth';
import { DEFAULT_MODULE_COLOR, MODULE_COLORS } from '@/lib/documentCategories';
import { usePermittedCategories } from '@/lib/usePermittedCategories';
import {
  SCAN_CATEGORY_MODULE,
  SCAN_MODULES_WITHOUT_CATEGORIES,
  scanCategoryForKey,
  scanCategoryKeys,
  scanModuleLabel,
} from '@/lib/records/scanCategoryModule';
import ScanRecordFields, {
  scanRecordErrors, useSpecCache,
} from '@/app/components/ScanRecordFields';
import DuplicateResolveDialog from '@/components/records/DuplicateResolveDialog';
import PageContainer from '@/app/components/PageContainer';
import { useWorkspaceApi, withCompany } from '@/lib/net/useWorkspaceApi';
import { belongsToWorkspace } from '@/lib/documentCategories';
import { utilityNavPath } from '@/lib/moduleRegistry';
import { chunkBySavePages } from '@/lib/records/saveChunks';


/**
 * How many rows the "needs attention" toast names before it counts the rest.
 *
 * A batch can be thirty documents; naming all of them is a toast taller than
 * the grid it is talking about. Three plus "and N more" is enough to start
 * looking, and the marked rows finish the job.
 */
const NAMED_ROW_LIMIT = 3;

/** The "Preparing your documents…" toast, so a second drop replaces it rather than stacking. */
const PREPARE_TOAST = 'scan-prepare';

/**
 * Structured error codes from the AI key rotation, in the user's words.
 *
 * The map itself used to live here, because `aiKeyManager.ts` pulls `db` and
 * both provider SDKs and cannot be imported into a client bundle. That copy
 * covered eight of the eleven codes and had already drifted from the server's
 * wording, so a retired model or an empty credit balance fell through to
 * `json.error`. `@/lib/aiErrors` is the same vocabulary as a leaf module, which
 * is what makes one copy possible.
 *
 * The page still adds one clause the shared sentence cannot know: on the three
 * codes worth waiting out, the batch survives the failure, so retrying is one
 * click rather than a re-upload. Saying so is the difference between someone
 * pressing Scan again and someone starting over.
 */
const FILES_SURVIVE = new Set([
  AI_ERROR_CODES.SERVICE_UNAVAILABLE,
  AI_ERROR_CODES.MODEL_OVERLOADED,
  AI_ERROR_CODES.RATE_LIMITED,
]);

function aiErrorMessage(json) {
  const shared = aiErrorMessageFor(json);
  if (!shared) return json?.error || 'Failed to complete scan.';
  return FILES_SURVIVE.has(json?.errorCode)
    ? `${shared} Your files are still selected.`
    : shared;
}

const seconds = (ms) => `${Math.max(1, Math.round(ms / 1000))}s`;

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  WHAT TO TELL SOMEONE WHOSE SCAN DID NOT COME BACK                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every one of these used to be the same sentence — "Could not reach DocsNX.
 * Please check your connection and try again." — which was the wrong advice for
 * most of them and gave support nothing to work from. A user on a laptop never
 * saw it; a user on a phone saw it for four unrelated reasons.
 *
 * So each cause gets its own sentence, and each says what to DO. The
 * uploading/waiting split is the one that carries real information: it is the
 * difference between "nothing happened, press Retry" and "this may have already
 * run, look before you scan it again".
 */
function scanErrorMessage(outcome) {
  if (outcome.kind === 'offline') {
    return 'You are offline. Reconnect and press Retry — your files are still selected.';
  }

  if (outcome.kind === 'network') {
    if (outcome.stage === 'uploading') {
      const far = outcome.totalBytes
        ? ` at ${Math.round((outcome.sentBytes / outcome.totalBytes) * 100)}%`
        : '';
      return `The upload stopped${far} after ${seconds(outcome.elapsedMs)}. On a phone that is `
        + 'usually a switch between Wi-Fi and mobile data. Your files are still selected.';
    }
    // Past the upload, so the scan may well have run. Worded so nobody assumes
    // nothing happened — the records may be there already.
    return outcome.wasHidden
      ? 'The scan was cut off when DocsNX went into the background — a phone that locks '
        + 'its screen suspends the page. Keep this screen open, and check Documents '
        + 'before scanning the same batch again.'
      : 'The connection dropped while DocsNX was reading your documents. Check Documents '
        + 'before scanning the same batch again, in case it finished.';
  }

  if (outcome.kind === 'timeout') {
    return `The scan ran past ${Math.max(1, Math.round(outcome.elapsedMs / 60000))} minutes with no answer. `
      + 'Try again with fewer documents in the batch.';
  }

  // kind === 'http' — something answered, and it was not a 2xx.
  if (outcome.json) return aiErrorMessage(outcome.json);
  if (outcome.status === 413) {
    return 'This batch is too large to upload. Remove the biggest files and scan them separately.';
  }
  // An HTML page from the reverse proxy, not the app.
  if (outcome.status === 502 || outcome.status === 504) {
    return 'The scan took too long and the connection was cut. Try again with fewer documents.';
  }
  return `The scan failed (HTTP ${outcome.status}).`;
}

/**
 * A row without what the last save said about it. Any edit clears it, since
 * the next save re-checks the row either way.
 */
function withoutIssue(record) {
  if (!record?._issue) return record;
  const { _issue, ...rest } = record;
  return rest;
}

export default function BulkScanPage() {
  const router = useRouter();

  // State
  const [files, setFiles] = useState([]);
  /**
   * What is committed to `files`, readable across an await.
   *
   * `addFiles` now re-encodes photos before adding them, so it has a real
   * suspension point in the middle of it — and `files` captured from that
   * render goes stale across it. Every budget check reads this instead.
   */
  const filesRef = useRef(files);
  useEffect(() => { filesRef.current = files; }, [files]);
  const [status, setStatus] = useState('upload'); // upload | scanning | verification | saving | completed
  
  // AI results
  const [uploadedFiles, setUploadedFiles] = useState([]);
  /**
   * The pending duplicate the user asked to LOOK at, if any.
   *
   * A scan is the likeliest way to produce duplicates — a stack of paperwork
   * re-scanned is the same stack — and "update it" is not an answer anybody can
   * give about a record they cannot see.
   */
  const [comparing, setComparing] = useState(null);
  const [proposedRecords, setProposedRecords] = useState([]);
  /**
   * The field specs the scan response carried, keyed "moduleKey/documentKey".
   *
   * Seeds `useSpecCache` below so the grid renders every row's real fields with
   * no request of its own. A forty-record batch would otherwise open forty.
   */
  const [scanFieldSpecs, setScanFieldSpecs] = useState(null);
  /**
   * What Save refused, per record index: `{ 2: { policy_number: '...' } }`.
   *
   * Held here rather than inside each row because Save is what computes it —
   * it validates every record at once and must not submit if ANY row fails.
   * Cleared for a row as soon as the reviewer edits it, so a corrected field
   * stops shouting before they press Save again.
   */
  const [recordErrors, setRecordErrors] = useState({});

  // Loader Text
  const [loaderText, setLoaderText] = useState('Uploading documents...');
  /**
   * What the save actually did, per record.
   *
   * `/api/ai/scan/save` reports failure PER RECORD and always answers 200 — a
   * forty-page scan must not lose thirty-nine because one page was unreadable.
   * The completed screen read a `success` variable that was never declared,
   * which threw at render and hid the whole outcome behind an error boundary;
   * nothing has ever shown which records did not make it.
   */
  const [saveResults, setSaveResults] = useState([]);

  /**
   * ╔══════════════════════════════════════════════════════════════════════════╗
   * ║  WHERE THIS MEMBER MAY ACTUALLY FILE A SCAN                              ║
   * ╚══════════════════════════════════════════════════════════════════════════╝
   *
   * /api/ai/scan/save has always checked this per record and refused what the
   * member may not add — no scan has ever slipped past a permission. What it
   * could not do is check it BEFORE the OCR ran. A member denied `medical`
   * would upload forty pages, wait for the AI, review them, hit Save, and only
   * then be told that half the batch was never going to be written. The scan
   * had already been paid for.
   *
   * So the same question is asked here, first, against the same shared map the
   * route uses (SCAN_CATEGORY_MODULE). This decides nothing — the route still
   * refuses — it just stops the member spending a scan on a refusal.
   */
  const [user, setUser] = useState(null);
  const { permitted: addable, categories: addableRows } = usePermittedCategories('add');
  /**
   * Power Scan runs in whichever workspace it was opened from — `/documents/bulk-scan`
   * for the household, `/business/<id>/documents/bulk-scan` for a company — and
   * the company on the URL is what decides three things: which taxonomy the
   * model is shown, which categories the review grid offers, and which vault the
   * saved records are sealed into. `scoped` is for the multipart scan post,
   * which `useWorkspaceApi` does not wrap.
   */
  const { api, companyId } = useWorkspaceApi();
  const scoped = (url) => withCompany(url, companyId);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await clientGetMe();
        if (!cancelled && me.success) setUser(me.user);
      } catch {
        // Leaves `user` null, which reads as "not known yet" below and shows
        // no warnings — the server remains the authority either way.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /**
   * The scan categories this member may file into.
   *
   * Two kinds of destination, exactly as the route splits them:
   *  · record SCOPES — permitted if ANY of the taxonomy categories the scope
   *    spans is in the `add` list, which is what `canAnyInScope` asks
   *    server-side;
   *  · `todos` and `emergency_contacts` — no taxonomy rows at all, so they are
   *    asked of the module permission row directly.
   *
   * ── ASK ABOUT THE CATEGORIES, NEVER THE SCOPE ────────────────────────────
   * `addable` is keyed by taxonomy moduleKey (`identity`, `bank_investments`),
   * while SCAN_CATEGORY_MODULE holds scope names (`documents`, `bank_info`).
   * This memo used to do `addable.get(mod)` across that gap, which found
   * nothing for 13 of the 17 categories and denied EVERY member — a
   * TENANT_ADMIN, for whom clientCan is unconditionally true, was told they
   * could not file a PAN card into "Documents". A missing key is not a denial;
   * it is the wrong question. `scanCategoryKeys` resolves the scope to the
   * pairs a permission can actually be granted on.
   *
   * `null` until both loads land: unknown is not the same as denied, and
   * warning about a denial we have not established would be worse than the
   * silence this replaces.
   */
  const allowedCategories = useMemo(() => {
    if (!user || !addable) return null;
    const out = new Set();
    for (const [category, mod] of Object.entries(SCAN_CATEGORY_MODULE)) {
      // The other half of the account is not "denied" — it is unreachable from
      // here at all, and offering it would be a category the save route refuses
      // after the member has reviewed forty pages. `todos` and
      // `emergency_contacts` are exempt: they own no taxonomy and exist in both
      // accounts, so a scanned task belongs to whichever workspace is filing it.
      const inThisWorkspace = SCAN_MODULES_WITHOUT_CATEGORIES.includes(mod)
        || belongsToWorkspace(mod, companyId);
      if (!inThisWorkspace) continue;
      const permitted = SCAN_MODULES_WITHOUT_CATEGORIES.includes(mod)
        ? clientCan(user, mod, null, 'add')
        : scanCategoryKeys(category).some(
            (key) => addable.get(key.moduleKey)?.has(key.documentKey) ?? false,
          );
      if (permitted) out.add(category);
    }
    return out;
  }, [user, addable, companyId]);

  /** The ids of the sub-categories this member may add to, for `document` rows. */
  const addableIds = useMemo(
    () => (addableRows ? new Set(addableRows.map((c) => c.id)) : null),
    [addableRows],
  );

  /**
   * May this record be saved? Unknown counts as yes; the route re-asks anyway.
   *
   * `document` needs a second question. Its module gate only asks whether ANY
   * sub-category is writable — the same thing `canAnyInScope` asks server-side —
   * but the record names one specific sub-category, which `createRecord` then
   * checks exactly. The AI proposes that category, so it can land on one the
   * member is denied even though the module as a whole is open to them. Without
   * this the review screen would clear a record the save then refuses.
   */
  const recordAllowed = (record) => {
    if (!allowedCategories) return true;
    if (!allowedCategories.has(record?.category)) return false;
    // `todo` and `emergency_contact` own no sub-category to check.
    if (SCAN_MODULES_WITHOUT_CATEGORIES.includes(SCAN_CATEGORY_MODULE[record?.category])) {
      return true;
    }
    const chosen = record?.extractedData?.categoryId;
    // No category chosen yet is not a denial — it is an incomplete record, and
    // the save reports "Could not resolve a document category" for it.
    if (!chosen || !addableIds) return true;
    return addableIds.has(chosen);
  };

  /**
   * Every sub-category spec the grid needs, seeded from the scan response.
   *
   * One hook for the WHOLE grid, not one per row: a hook inside the `.map()`
   * would be called a different number of times whenever the batch changes
   * size, which is exactly what the rules of hooks forbid.
   */
  const { specFor, request: requestSpec } = useSpecCache(scanFieldSpecs);

  /**
   * Fetch any spec the grid needs and the scan response did not carry.
   *
   * In an effect, never during render: `request` sets state, and setting state
   * while another component renders is the "Cannot update a component while
   * rendering a different component" warning — and, with a row re-filed twice
   * quickly, a render loop. `request` deduplicates on the pair, so running this
   * on every records change costs nothing once a spec is in hand.
   *
   * The common case fetches NOTHING: every category the batch landed in is
   * already seeded from `fieldSpecs`. This is for the reviewer who re-files a
   * record into a category the scan did not propose.
   */
  useEffect(() => {
    for (const record of proposedRecords) {
      const { moduleKey, documentKey } = record?.extractedData || {};
      if (moduleKey && documentKey) requestSpec(moduleKey, documentKey);
    }
  }, [proposedRecords, requestSpec]);

  /**
   * The spec props for one document row: `{ spec, loading }`.
   *
   * A pure lookup — the effect above is what puts anything in the cache. A pair
   * that is neither cached nor in flight reads as loading, because the effect
   * is about to ask for it on this same commit.
   */
  const documentSpec = (extracted) => {
    const moduleKey = extracted?.moduleKey;
    const documentKey = extracted?.documentKey;
    const { fields, loading } = specFor(moduleKey, documentKey);
    return { spec: fields, loading: loading || (!fields && !!moduleKey && !!documentKey) };
  };

  /** Records the AI filed somewhere this member cannot write. */
  const blockedRecords = useMemo(
    () => proposedRecords.filter((r) => !recordAllowed(r)),
    [proposedRecords, allowedCategories, addableIds],
  );

  /**
   * The holder this row will actually be saved with. `''` means nobody has
   * answered for it yet.
   */
  const rowHolder = (record) => record?.holderId ?? '';

  /**
   * The `holderId` a row puts on the wire.
   *
   * Three states, and collapsing any two of them writes the wrong record:
   *   · `undefined` — a company workspace. `JSON.stringify` drops the key, and
   *     `holderFrom` reads a missing key as "not sent", so `resolveHolder`
   *     takes the module default. A business record belongs to the company.
   *   · `null` — the reviewer chose "All members" (or, historically, left it):
   *     an explicit household-wide record, `is_global` true.
   *   · a uuid — that member.
   */
  const rowHolderForWrite = (record) => {
    const holder = holderForWrite(companyId, rowHolder(record));
    return holder === undefined ? undefined : (holder || null);
  };

  /**
   * Records nobody has said who they belong to.
   *
   * A row is unanswered while its own holder is empty — every record is
   * answered for on its own row. These block the save the same way
   * `blockedRecords` do — a scanned document filed against nobody is one nobody
   * goes looking for afterwards, and the review screen is the last moment
   * anyone is looking at it.
   */
  const unassignedRecords = useMemo(
    // Nothing to answer in a company workspace: the record belongs to the
    // COMPANY, so every row's picker is a statement naming it and `holderId`
    // stays '' however long the reviewer looks at the grid. Counting those made
    // Save permanently disabled — "N records need attention" over a grid with
    // no row marked, and no way past it.
    () => (companyId ? [] : proposedRecords.filter((r) => !rowHolder(r))),
    [proposedRecords, companyId],
  );

  /**
   * Every row the save is waiting on, counted once however many things are
   * wrong with it — a record that is both blocked and unassigned is still one
   * record to fix, and a button offering to save "3 of 2" is a bug report.
   */
  const needAttention = useMemo(
    () => [...new Set([...blockedRecords, ...unassignedRecords])],
    [blockedRecords, unassignedRecords],
  );

  /** Why the save is off, naming both reasons when both apply. */
  const attentionReason = useMemo(() => {
    const reasons = [];
    if (blockedRecords.length > 0) {
      reasons.push('Some records are filed under a module you cannot add to.');
    }
    if (unassignedRecords.length > 0) {
      reasons.push('Some records have no "Belongs to" — pick who each one belongs to.');
    }
    return reasons.join(' ') || undefined;
  }, [blockedRecords, unassignedRecords]);

  // Ref
  const fileInputRef = useRef(null);

  // File drag handlers
  const handleDragOver = (e) => {
    e.preventDefault();
  };

  const handleDrop = (e) => {
    e.preventDefault();
    if (e.dataTransfer.files) {
      addFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleFileChange = (e) => {
    if (e.target.files) {
      addFiles(Array.from(e.target.files));
    }
  };

  /**
   * Both the picker and the drop zone land here, which is the only place a
   * refusal can be enforced for both: a drag-and-drop ignores `accept`
   * entirely, so the attribute on the input filters the dialog and this filters
   * everything else.
   *
   * Refused files are NAMED — for the wrong type, for the batch limit, and now
   * for the byte budget. A batch can hold fifteen files, and silently adding
   * fourteen of them leaves the user to work out which one went missing and why
   * nothing said so.
   *
   * ── ASYNC NOW, BECAUSE PHOTOS ARE SHRUNK AT SELECTION TIME ───────────────
   * `downscaleBatch` re-encodes large camera images HERE rather than at Scan
   * time, so the size shown in the list below is the size that will actually be
   * sent and the byte budget is measured against the real payload. That
   * re-encode is the fix for Power Scan failing on phones and not on laptops —
   * see src/lib/records/imageDownscale.ts for why.
   *
   * Which means `files` from this render is no longer safe to read after the
   * await: a second drop landing during a re-encode would be measured against a
   * stale selection. `filesRef` always holds what is committed, so the byte
   * budget below reads that instead.
   */
  const addFiles = async (newFiles) => {
    const accepted = newFiles.filter(isAcceptedUpload);
    const refused = newFiles.filter((f) => !isAcceptedUpload(f));
    if (refused.length > 0) {
      toast.error(
        `${refused.map((f) => f.name).join(', ')} — cannot be scanned. `
        + `Accepted: ${UPLOAD_ACCEPT_LABEL}.`,
      );
    }
    if (accepted.length === 0) return;

    /**
     * Trimmed against what is ALREADY selected, not against this drop alone:
     * three drops of six are the same eighteen files as one drop of eighteen,
     * and only counting the batch as a whole refuses both.
     *
     * The overflow is NAMED, for the same reason a wrong type is. Silently
     * keeping the first fifteen of a twenty-file drop would leave five
     * documents unscanned with nothing on screen saying which — the user would
     * find out when they went looking for a record that was never created.
     *
     * Computed out here, against `filesRef`, rather than inside a setState
     * updater: an updater has to be pure, and React calls it twice under
     * StrictMode — which would raise the toast twice for one drop.
     */
    const { accepted: fitted, refused: dropped } = trimScanBatch(
      filesRef.current.length, accepted,
    );
    if (dropped.length > 0) {
      toast.error(
        `${scanBatchError(filesRef.current.length + accepted.length, 'files')} `
        + `Not added: ${dropped.map((f) => f.name).join(', ')}.`,
      );
    }
    if (fitted.length === 0) return;

    /**
     * Only announced for a drop heavy enough to take a visible moment. A
     * re-encode of one 300 KB scan is instant and a toast that flashes for it
     * is noise; fifteen phone photos is a few seconds of a picker that would
     * otherwise look frozen.
     */
    const heavy = fitted.reduce((n, f) => n + (f.size || 0), 0) > 4 * 1024 * 1024;
    if (heavy) toast.loading('Preparing your documents…', { id: PREPARE_TOAST });
    /**
     * `prepareUploadBatch` reads each file's bytes into memory, re-encodes the
     * photos and applies the per-file ceiling — the same preparation every
     * other upload path runs (src/lib/records/fileSnapshot.ts). The read is
     * what matters on a phone: a file picked from Drive or WhatsApp is a handle
     * whose bytes the owning app may refuse at send time, and that refusal
     * used to reach the user here as a Wi-Fi problem. Now it is refused at the
     * picker, by name, with the fix.
     */
    let batch;
    try {
      batch = await prepareUploadBatch(fitted);
    } finally {
      if (heavy) toast.dismiss(PREPARE_TOAST);
    }

    /**
     * Every refusal is NAMED — the per-file size ceiling, an unreadable file,
     * a type the earlier filter somehow missed. One toast per distinct reason
     * rather than one per file, so a drop of twelve Drive files says the
     * Downloads sentence once, not twelve times.
     */
    if (batch.refused.length > 0) {
      const byReason = new Map();
      for (const { file, error } of batch.refused) {
        if (!byReason.has(error)) byReason.set(error, []);
        byReason.get(error).push(file.name);
      }
      for (const [error, names] of byReason) {
        toast.error(names.length > 1 ? `${error} Not added: ${names.join(', ')}.` : error);
      }
    }
    const withinFileLimit = batch.accepted;
    if (withinFileLimit.length === 0) return;

    const selectedBytes = filesRef.current.reduce((n, f) => n + (f.size || 0), 0);
    const budget = trimScanBytes(selectedBytes, withinFileLimit);
    if (budget.refused.length > 0) {
      const attempted = selectedBytes
        + withinFileLimit.reduce((n, f) => n + (f.size || 0), 0);
      toast.error(
        `${scanBytesError(attempted)} `
        + `Not added: ${budget.refused.map((f) => f.name).join(', ')}.`,
      );
    }
    if (budget.accepted.length === 0) return;
    setFiles((prev) => [...prev, ...budget.accepted]);
  };

  const removeFile = (index) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  /**
   * ╔══════════════════════════════════════════════════════════════════════════╗
   * ║  ONE UPLOAD, AND FOUR DIFFERENT WAYS IT CAN FAIL                        ║
   * ╚══════════════════════════════════════════════════════════════════════════╝
   *
   * This used to be a bare `fetch` in a `try`, and its `catch` told every
   * failure the same thing: "Could not reach DocsNX. Please check your
   * connection and try again." That message was wrong advice for three of the
   * four causes — the connection was usually fine, and the real problem was a
   * screen that locked, a batch too large to upload, or a reverse proxy that
   * hung up at sixty seconds. It also destroyed the evidence: a rejected
   * `fetch` carries a `TypeError` and nothing else, so a user's report could
   * never be narrowed down, and nothing reached the server logs at all.
   *
   * `postUpload` returns a description of the failure instead of throwing one
   * away. See src/lib/records/uploadRequest.ts for why the uploading/waiting
   * boundary is the thing worth knowing, and `scanErrorMessage` above for what
   * each case is told.
   */
  const startScan = async ({ isRetry = false } = {}) => {
    if (files.length === 0) {
      toast.error('Please upload at least one file.');
      return;
    }

    // `addFiles` already trims to this, so reaching it means a screen that has
    // been open across a change or a path that did not go through the picker.
    // The route refuses it either way; this just keeps the upload off the wire.
    if (files.length > MAX_SCAN_FILES) {
      toast.error(scanBatchError(files.length, 'files'));
      return;
    }

    /**
     * The byte budget, asked once more at the last moment.
     *
     * `addFiles` enforces it too, but nginx (`client_max_body_size 100m`) and
     * Cloudflare both refuse an oversized body without the route ever seeing
     * it — and that refusal reaches the browser as an ordinary network failure,
     * which is precisely the confusion this screen is being fixed for. Cheaper
     * to say it here, before spending minutes uploading.
     */
    const batchBytes = files.reduce((n, f) => n + (f.size || 0), 0);
    if (batchBytes > MAX_SCAN_BYTES) {
      toast.error(scanBytesError(batchBytes));
      return;
    }

    // The same question /api/ai/scan asks itself before running the OCR — asked
    // here so a member who may write nowhere never spends a scan discovering it.
    if (allowedCategories && allowedCategories.size === 0) {
      toast.error(
        'You do not have permission to add records to any module, so there is nowhere to file a scan. Ask an administrator for access.',
      );
      return;
    }

    setStatus('scanning');
    setLoaderText(
      isRetry
        ? 'The connection dropped — starting the upload again…'
        : 'Uploading your documents...',
    );

    const formData = new FormData();
    files.forEach(f => {
      formData.append('files', f);
    });

    /**
     * Hold the screen awake for the duration.
     *
     * A scan is a minute or more of waiting with nothing on screen to touch, so
     * putting the phone down is the natural thing to do — and a locked screen
     * suspends the page, which kills the request outright. This removes the
     * single most avoidable cause of the failure rather than only explaining it
     * afterwards. Feature-detected: iOS gained wake locks in 16.4, and the
     * request is refused outright in a backgrounded tab, so neither is treated
     * as an error worth a word to the user.
     */
    let wakeLock = null;
    try {
      wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      /* Not available, or refused. The scan proceeds either way. */
    }

    try {
      const outcome = await postUpload(scoped('/api/ai/scan'), formData, {
        onUploadProgress: (percent) => {
          // The upload is the long, silent half on a phone, and a spinner that
          // says nothing for two minutes is indistinguishable from a stall.
          setLoaderText(
            percent < 0
              ? 'Uploading your documents...'
              : `Uploading your documents — ${percent}%`,
          );
        },
        onUploadComplete: () => {
          setLoaderText('Reading your documents and pulling out the details — this may take a few moments...');
        },
      });

      if (outcome.ok) {
        const json = outcome.json;
        if (json.success) {
          setUploadedFiles(json.files);
          // Normalize fileIndices, and keep any holder the scan matched.
          //
          // `holderId` is set server-side when the OCR'd name resolves to exactly
          // one member (attachHolderIds, /api/ai/scan). A record the scan could
          // NOT place is left with no holder at all, so it reads as unanswered on
          // its own row until somebody picks one there.
          const records = (json.proposedRecords || []).map(r => ({
            ...r,
            fileIndices: r.fileIndices || [],
          }));
          setProposedRecords(records);
          // Every sub-category this batch landed in, already resolved server-side
          // with the operator's Field Configuration applied. See useSpecCache.
          setScanFieldSpecs(json.fieldSpecs || null);
          setRecordErrors({});
          setStatus('verification');
          return;
        }

        // A 200 that says `success: false` — the AI key rotation reporting a
        // quota, a rate limit or an unavailable provider.
        toast.error(aiErrorMessage(json), {
          duration: 10000,
          action: { label: 'Retry', onClick: () => startScan() },
        });
        setStatus('upload');
        return;
      }

      /**
       * A connection lost while the body was STILL GOING OUT means the server
       * never started: no page was rasterised, no model was called, no credit
       * was spent, and the batch is exactly as it was. That is the one failure
       * safe to retry without asking — and on a phone it is also the most
       * common one, a Wi-Fi to cellular handover part-way through the upload.
       *
       * Once only, and never after `upload.onload`: past that point the scan may
       * have run to completion and been charged for, and a silent retry would
       * bill the tenant twice for one batch and file every record again.
       */
      if (outcome.kind === 'network' && outcome.stage === 'uploading' && !isRetry) {
        return await startScan({ isRetry: true });
      }

      // `files` deliberately survives this, so Retry costs no re-selection —
      // which on a phone means not walking back through the gallery picker.
      toast.error(scanErrorMessage(outcome), {
        duration: 10000,
        action: { label: 'Retry', onClick: () => startScan() },
      });
      setStatus('upload');
    } finally {
      // Never allowed to fail the scan: the lock may already be gone if the
      // page was backgrounded, and releasing a released lock rejects.
      wakeLock?.release?.().catch(() => {});
    }
  };

  // Record Manipulation Helpers
  const addEmptyRecord = () => {
    const newRecord = {
      title: 'New Manual Record',
      category: 'document',
      fileIndices: [],
      // `fields` holds the record's own values, keyed by the sub-category's
      // own field keys; everything beside it is routing. A stray
      // `category: 'other'` used to sit here and, being neither, was written
      // into the record as a field of its own.
      //
      // Empty rather than seeded: no category is chosen yet, so there are no
      // field keys to seed. Picking one below renders that category's fields.
      extractedData: {
        name: 'New Manual Document',
        fields: {}
      }
    };
    setProposedRecords(prev => [...prev, newRecord]);
  };

  /**
   * @param {number} index
   * @param {{rescueFiles?: boolean}} options  `false` when the row is dropped
   *   as a DUPLICATE: its pages are a copy of something already on file, and
   *   handing them to the first record would file them there instead.
   */
  const deleteRecord = (index, { rescueFiles = true } = {}) => {
    const recordToDelete = proposedRecords[index];
    // Re-assign files of this deleted record back to the first record, if exists
    const filesToRescue = rescueFiles ? (recordToDelete.fileIndices || []) : [];
    
    setProposedRecords(prev => {
      const filtered = prev.filter((_, i) => i !== index);
      if (filtered.length > 0 && filesToRescue.length > 0) {
        filtered[0] = {
          ...filtered[0],
          fileIndices: [...new Set([...filtered[0].fileIndices, ...filesToRescue])],
        };
      }
      return filtered;
    });
    // Keyed by position, so every row after the removed one moves up by one.
    // Left alone, a field error would land on the neighbour below.
    setRecordErrors(prev => {
      const next = {};
      for (const [key, value] of Object.entries(prev)) {
        const i = Number(key);
        if (i < index) next[i] = value;
        else if (i > index) next[i - 1] = value;
      }
      return next;
    });
  };

  /**
   * The member's answer to a row the check flagged as a duplicate. It travels
   * with the record to /api/ai/scan/save, which re-checks it.
   *   · `{ replaceId }`: write onto the record already on file ("Update it").
   *   · `{ keepBoth: true }`: file it beside that record as a separate copy.
   */
  const answerRow = (index, answer) => {
    setProposedRecords(prev => {
      const updated = [...prev];
      const { _issue, replaceId, keepBoth, ...rest } = updated[index];
      updated[index] = { ...rest, ...answer };
      return updated;
    });
  };

  const updateRecordField = (recordIndex, field, value) => {
    setProposedRecords(prev => {
      const updated = [...prev];
      updated[recordIndex] = withoutIssue(updated[recordIndex]);
      updated[recordIndex].extractedData = {
        ...updated[recordIndex].extractedData,
        [field]: value
      };
      return updated;
    });
  };

  /**
   * One taxonomy field of one record.
   *
   * `key` is a field key from that record's sub-category spec — `pan_number`,
   * `policy_number` — not one of the five camelCase names this grid used to
   * ask every category for. See <ScanRecordFields>.
   */
  const updateRecordFields = (recordIndex, key, value) => {
    setProposedRecords(prev => {
      const updated = [...prev];
      updated[recordIndex] = withoutIssue(updated[recordIndex]);
      const current = updated[recordIndex].extractedData.fields || {};
      updated[recordIndex].extractedData = {
        ...updated[recordIndex].extractedData,
        fields: { ...current, [key]: value },
      };
      return updated;
    });
    // Editing a field clears what Save said about it. An error still showing
    // under a value the reviewer has just corrected reads as unfixable.
    setRecordErrors(prev => {
      if (!prev[recordIndex]?.[key]) return prev;
      const forRecord = { ...prev[recordIndex] };
      delete forRecord[key];
      return { ...prev, [recordIndex]: forRecord };
    });
  };

  /**
   * ╔══════════════════════════════════════════════════════════════════════════╗
   * ║   POST THE BATCH IN CHUNKS, NOT AS ONE REQUEST                           ║
   * ╚══════════════════════════════════════════════════════════════════════════╝
   *
   * A commit is not CPU work, it is Google Drive round trips: per record the
   * server seals and uploads each page, walks the folder tree for it, takes a
   * Postgres advisory lock on the category and re-uploads that category's whole
   * encrypted store. Call it five to eight seconds each, serialised — 25
   * records is minutes.
   *
   * Nothing in front of the app will wait that long. nginx defaults to
   * `proxy_read_timeout 60s` and Cloudflare cuts the origin off at 100s, so the
   * browser got a 504 — an HTML error page, which `res.json()` then reported as
   * `SyntaxError: Unexpected token '<'` — while the server carried on writing
   * records the user had been told nothing about. Pressing Save again then put
   * a second commit loop alongside the first, and the two fought over the same
   * per-category lock: `VAULT_LOCKED — Another change to this category is in
   * progress`, on records that were about to be written anyway.
   *
   * So the batch goes up a few records at a time. Each chunk is comfortably
   * inside every timeout, the progress line moves while it runs, and the route
   * needs no change to support it: it already reports success PER RECORD and
   * answers 200 regardless, so chunking is just that failure model used at the
   * granularity it was designed for.
   *
   * How much fits in a chunk is `chunkBySavePages`, and it counts PAGES rather
   * than records — the first cut of this sliced four records per request, which
   * is fine for four certificates and hopeless for one 16-page Articles of
   * Association. Read the note there; it is the whole reason this comment's
   * "504" was really a 524, and why the records it described as "about to be
   * written anyway" had in fact already been written.
   *
   * `index` is echoed by the server and counts WITHIN the chunk, so it is
   * rewritten to the row's position in `entries` — the same translation
   * `confirmDuplicates` does for its subset, and for the same reason: keyed on
   * the echoed index, the answers for chunk two would land on rows 0..3.
   *
   * @param {Array} entries  records to post, already payload-shaped
   * @param {(done: number, total: number) => void} onProgress
   * @returns {Promise<{ok: true, results: Array} | {ok: false, error: string, results: Array}>}
   */
  const postRecordsInChunks = async (entries, onProgress, { atomic = false } = {}) => {
    const results = [];
    // Packed by page count rather than sliced by record count — see
    // `chunkBySavePages`. `start` is still the chunk's offset into `entries`,
    // which is what the index rewriting below needs, so it is tracked here
    // instead of being the loop variable.
    let start = 0;

    for (const chunk of chunkBySavePages(entries)) {
      onProgress?.(start, entries.length);

      /**
       * `json` is the body `apiCall` has ALREADY read and parsed — there is no
       * `res.json()` to call here, because `res` is `{ ok, status }` and not a
       * `Response`. This line used to call it anyway, left behind when the loop
       * moved off raw `fetch`: `res.json` is undefined, so it threw a TypeError
       * SYNCHRONOUSLY (past its own `.catch`), out of this function and into
       * `handleSave`'s outer catch — which told the user the save had gone
       * wrong on records that were already in Drive and in the table.
       */
      const { res, json } = await api('/api/ai/scan/save', {
        timeoutMs: 180_000,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: chunk, files: uploadedFiles, ...(atomic ? { atomic: true } : {}) }),
      });

      /**
       * `res.ok` decides first, whatever the body turned out to be. A 502/504
       * from the reverse proxy is an HTML page, so there is no `success` flag
       * to read and no route sentence to quote. Whatever this chunk did on the
       * server is unknown from here, so the records already confirmed are kept
       * and the rest is reported.
       */
      if (!res.ok) {
        // Out of space gets the toast that names the figures, not a bare
        // "HTTP 507" — and `error: null` so the caller does not toast twice.
        if (res.status === 507) {
          if (toastStorageError(res, json)) return { ok: false, results, error: null };
        }
        return {
          ok: false,
          results,
          // 524 is Cloudflare's "the origin did not answer in time", and it was
          // missing — yet it is the status this flow actually hits, because a
          // long commit reaches Cloudflare's 100s ceiling before it reaches
          // anything else. It fell through to the flat "Save failed" sentence,
          // which is the opposite of what a 524 means: the origin is still
          // working, and these records usually land.
          error: res.status === 504 || res.status === 502 || res.status === 524
            ? `The server is still saving records ${start + 1}–${start + chunk.length} — it did not answer in time, but they are probably being written. Check Documents before saving them again.`
            : `Save failed on records ${start + 1}–${start + chunk.length} (HTTP ${res.status}).`,
        };
      }

      // `{}` when a 200 came back with an empty body, which is not a success
      // this loop can record anything from — same refusal as an explicit one.
      if (!json?.success) {
        return { ok: false, results, error: json?.error || 'Failed to save records' };
      }

      (json.results || []).forEach((row, i) => {
        results.push({ ...row, index: start + i });
      });
      // Atomic: the route stopped at its first failure, and so does this loop.
      // Nothing after that point may be written, since it is all about to be undone.
      if (atomic && (json.results || []).some((row) => !row.success)) {
        return { ok: true, results };
      }
      start += chunk.length;
      onProgress?.(Math.min(start, entries.length), entries.length);
    }

    return { ok: true, results };
  };

  const handleSave = async () => {
    // The button is disabled in this state; this catches the path where a
    // permission changed under a screen that has been open a while.
    if (blockedRecords.length > 0) {
      toast.error('Some records are filed under a module you cannot add to. Fix or remove them first.');
      return;
    }
    if (unassignedRecords.length > 0) {
      toast.error('Some records have no "Belongs to" — pick who each one belongs to.');
      return;
    }

    /**
     * ── EVERY DOCUMENT ROW AGAINST ITS OWN CATEGORY'S RULES ───────────────
     *
     * The mandatory fields and the validation the super admin configured, run
     * here for the first time. This grid never validated anything: it asked
     * five camelCase questions of every category and saved whatever came back,
     * so a required field could not be enforced because the grid did not know
     * the category HAD one.
     *
     * The server runs `buildTaxonomyRecord` over the same body regardless —
     * this is the browser's half of the same rules, so a problem lands under
     * the input that has it instead of coming back as a per-record failure at
     * the end of a forty-record save.
     *
     * Refuses the whole batch rather than the offending rows: the save is one
     * request, and a partial submit would leave the reviewer looking at a grid
     * whose good rows had silently already been written.
     */
    const errorsByRecord = {};
    let awaitingSpec = false;
    proposedRecords.forEach((record, index) => {
      // The two that own no sub-category own no field spec to validate against.
      if (SCAN_MODULES_WITHOUT_CATEGORIES.includes(SCAN_CATEGORY_MODULE[record?.category])) return;
      const { spec } = documentSpec(record.extractedData);
      // No spec yet means the row was just re-filed and its fields are still
      // arriving. `scanRecordErrors` would answer "nothing wrong" — which is
      // not the same as "checked and fine", and saving on it would skip the
      // check entirely for that row.
      if (!spec) { awaitingSpec = true; return; }
      const fieldErrors = scanRecordErrors(spec, record.extractedData?.fields);
      if (Object.keys(fieldErrors).length > 0) errorsByRecord[index] = fieldErrors;
    });
    if (awaitingSpec) {
      toast.error('Still loading the fields for a category you just changed — try again in a moment.');
      return;
    }
    if (Object.keys(errorsByRecord).length > 0) {
      setRecordErrors(errorsByRecord);
      const indices = Object.keys(errorsByRecord);
      const count = indices.length;
      // Names the rows, not just how many. The grid can be long enough that
      // "check the fields marked below" is a scroll hunt, and a row whose title
      // the scan never read is named by its position instead.
      const titled = indices
        .slice(0, NAMED_ROW_LIMIT)
        .map((i) => proposedRecords[i]?.title?.trim() || `record ${Number(i) + 1}`);
      const named = listSentence(
        count > NAMED_ROW_LIMIT ? [...titled, `${count - NAMED_ROW_LIMIT} more`] : titled,
      );
      toast.error(
        `${count} record${count === 1 ? '' : 's'} ${count === 1 ? 'needs' : 'need'} attention — check ${named}.`,
      );
      return;
    }
    setRecordErrors({});

    // Snapshot of what is being saved. The grid is hidden while this runs, so
    // the rows cannot change underneath it, and every index below is into it.
    const payload = proposedRecords.map(({ _issue, ...r }) => ({
      ...r,
      // `undefined` in a company workspace, which `JSON.stringify` drops —
      // the omission `holderFrom` reads as "not sent", so `resolveHolder`
      // takes the module default rather than reading a null as an explicit
      // "All members". See src/lib/records/holderScope.
      holderId: rowHolderForWrite(r),
    }));
    const post = (body) => api('/api/ai/scan/save', {
      timeoutMs: 180_000,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    /**
     * ── ALL OR NOTHING ─────────────────────────────────────────────────────
     * A scan is saved as one batch or not at all. A half-saved batch is how
     * members ended up fixing one row, pressing Save again, and being told the
     * rows that HAD saved "already exist". So:
     *   1. The server checks every row and writes nothing. Anything it flags
     *      stays on this screen, to be fixed, answered or removed.
     *   2. Only a clean batch is written.
     *   3. If the write still fails partway, the records it created are undone.
     * See src/lib/records/scanBatch.ts.
     */
    setStatus('saving');
    setLoaderText('Checking every record before saving...');
    try {
      const { res, json } = await post({ mode: 'check', records: payload, files: uploadedFiles });
      if (!res.ok || !json?.success) {
        toast.error(json?.error || `Could not check these records (HTTP ${res.status}). Nothing was saved.`);
        setStatus('verification');
        return;
      }
      if (!json.ready) {
        const flagged = markIssues(payload, json.results);
        setStatus('verification');
        toast.error(
          `${flagged} record${flagged === 1 ? ' needs' : 's need'} attention before this batch can be saved. Nothing was saved yet.`,
          { duration: 8000 },
        );
        return;
      }
    } catch (err) {
      console.error('[bulk-scan] check threw', err);
      toast.error('Could not check these records. Nothing was saved.');
      setStatus('verification');
      return;
    }

    setLoaderText('Saving records to Google Drive...');
    let outcome;
    try {
      outcome = await postRecordsInChunks(
        payload,
        (done, total) => setLoaderText(`Saving records to Google Drive... ${done} of ${total}`),
        { atomic: true },
      );
    } catch (err) {
      // `postRecordsInChunks` returns its failures rather than throwing them,
      // so this is a bug in the loop. What it wrote is unknown from here.
      console.error('[bulk-scan] save loop threw', err);
      toast.error('Something went wrong saving these records. Check Documents before saving again.');
      setStatus('verification');
      return;
    }

    const { results } = outcome;
    const failure = results.find((r) => !r.success);

    if (outcome.ok && !failure) {
      // Committed. The pages were kept on disk so a rollback could re-save
      // them, and they are released now. Best effort: the hourly sweep takes
      // anything this misses.
      post({ mode: 'finalize', files: uploadedFiles }).catch(() => {});
      setSaveResults(results);
      setStatus('completed');
      toast.success(`Saved all ${results.length} record${results.length === 1 ? '' : 's'}`);
      return;
    }

    // ── Undo the part that landed ─────────────────────────────────────────
    setLoaderText('A record could not be saved. Undoing the rest of the batch...');
    const tokens = results.filter((r) => r.success && r.rollbackToken).map((r) => r.rollbackToken);
    let undoFailed = 0;
    if (tokens.length > 0) {
      try {
        const { res, json } = await post({ mode: 'rollback', tokens });
        undoFailed = res.ok ? (json?.failed ?? 0) : tokens.length;
      } catch {
        undoFailed = tokens.length;
      }
    }

    if (failure) markIssues(payload, [{ ...failure, ok: false }]);
    setStatus('verification');

    if (failure) {
      toast.error(
        `Nothing was saved. '${failure.title || 'A record'}' could not be saved${failure.error ? `: ${failure.error}` : ''}. Fix or remove it, then save again.`,
        { duration: 10000 },
      );
    } else if (outcome.error) {
      // A transport failure: a timeout, or the proxy's HTML error page. The
      // chunk in flight may still be finishing on the server, and it returned
      // no tokens, so its records cannot be undone from here.
      toast.error(
        `${outcome.error} The rest of the batch was undone. Check Documents before saving again: records from that last step may have been written anyway.`,
        { duration: 12000 },
      );
    }
    if (undoFailed > 0) {
      toast.warning(
        `${undoFailed} record${undoFailed === 1 ? '' : 's'} could not be undone and may appear in Documents. Check there before saving again.`,
        { duration: 12000 },
      );
    }
  };

  /**
   * Puts what the server said about each row onto the row itself.
   *
   * On the record rather than in a map keyed by position, so an issue moves
   * with its row when a row above it is removed. Field errors go through
   * `recordErrors`, which renders them under the inputs they belong to.
   *
   * @returns {number} how many rows were flagged
   */
  const markIssues = (payload, results) => {
    const byIndex = new Map(results.map((r) => [r.index, r]));
    const fieldErrors = {};
    let flagged = 0;
    setProposedRecords(payload.map((row, i) => {
      // `payload` carries the holder as it goes on the wire. The grid's own
      // value is kept, so the picker does not change under the member.
      const clean = { ...withoutIssue(row), holderId: proposedRecords[i]?.holderId };
      const r = byIndex.get(i);
      if (!r || r.ok) return clean;
      flagged += 1;
      if (r.fieldErrors) {
        fieldErrors[i] = r.fieldErrors;
        return { ...clean, _issue: { kind: 'error', error: 'Some fields need attention.' } };
      }
      if (r.requiresConfirmation) return { ...clean, _issue: { kind: 'duplicate', ...r, index: i } };
      if (r.batchDuplicate) return { ...clean, _issue: { kind: 'batch', ...r, index: i } };
      return { ...clean, _issue: { kind: 'error', error: r.error, code: r.code } };
    }));
    setRecordErrors(fieldErrors);
    return flagged;
  };

  /**
   * The answer to the duplicates the save reported.
   *
   * Re-submits ONLY the records the user picked, each carrying its answer:
   *
   *   · `replaceId` — the id of the record it duplicates. The server excludes
   *     that record from its own duplicate check, so the write lands on it as a
   *     plain replace and no second copy appears. ("Update it".)
   *   · `keepBoth`  — file this scan as a SEPARATE record beside the one it
   *     matched, under a numbered title the server resolves. Refused there for
   *     a match on a declared identifier, so the prompt only offers it when the
   *     result said it was available.
   *
   * Everything already saved is left alone either way.
   *
   * @param {Array} chosen        the pending results being answered
   * @param {{keepBoth?: boolean}} answer
   */
  const confirmDuplicates = async (chosen, { keepBoth = false } = {}) => {
    // Every row has to resolve back to the record it came from. `index` is
    // echoed by the server for exactly this; without a usable one, spreading
    // `proposedRecords[undefined]` would post `{}` — an empty record the server
    // would either reject or, worse, file as a blank. Dropped loudly instead.
    const resolved = chosen.filter(
      (r) => Number.isInteger(r?.index) && proposedRecords[r.index] && r.existingId,
    );
    if (resolved.length < chosen.length) {
      toast.error(
        `${chosen.length - resolved.length} of these could not be matched back to a scan — reload and try again.`,
      );
    }
    if (resolved.length === 0) return;

    setStatus('saving');
    setLoaderText(keepBoth
      ? `Saving ${resolved.length} record${resolved.length === 1 ? '' : 's'} as separate copies...`
      : `Updating ${resolved.length} existing record${resolved.length === 1 ? '' : 's'}...`);

    try {
      const outcome = await postRecordsInChunks(
        resolved.map((r) => ({
          ...proposedRecords[r.index],
          holderId: rowHolderForWrite(proposedRecords[r.index]),
          // One or the other, never both: `replaceId` names the record to
          // write onto, and `createRecord` refuses a keep-both answer that
          // arrives with one.
          ...(keepBoth ? { keepBoth: true } : { replaceId: r.existingId }),
        })),
        (done, total) => setLoaderText(
          keepBoth
            ? `Saving ${total} record${total === 1 ? '' : 's'} as separate copies... ${done} of ${total}`
            : `Updating ${total} existing record${total === 1 ? '' : 's'}... ${done} of ${total}`,
        ),
      );

      if (!outcome.ok && outcome.error) toast.error(outcome.error);

      // Merge back onto the ORIGINAL rows.
      //
      // This submit carried a subset, so the index the server echoes counts
      // within the subset — 0, 1, 2 — and means nothing against the first run's
      // array. `postRecordsInChunks` has already rewritten each answer's index
      // to its position in what was POSTED; `resolved` is that same list, in the
      // same order, and each of its rows still carries the index it had in the
      // full batch, so it is the translation between the two. Keying on the
      // submission index instead would write the answer onto whatever happened
      // to be rows 0, 1 and 2 — and it has to be `resolved` rather than
      // `chosen`, since anything dropped above never went and would shift every
      // position after it.
      const answered = new Map(
        outcome.results.map((r) => [resolved[r.index]?.index, r]),
      );
      setSaveResults((prev) => prev.map((row, i) => {
        const key = row.index ?? i;
        const update = answered.get(key);
        return update ? { ...update, index: key } : row;
      }));
      setStatus('completed');

      const succeeded = outcome.results.filter((r) => r.success);
      const done = succeeded.length;
      // These needed no write at all: the scan they answer for had already been
      // sealed to Drive by an attempt whose reply never arrived. "Updated" would
      // describe work this request did not do, on records that were never at
      // risk — and the member's real question is whether their documents are
      // safe, not which request filed them.
      const untouched = succeeded.filter((r) => r.alreadyStored).length;
      if (done > 0) {
        toast.success(
          untouched === done
            ? `${done === 1 ? 'That record was' : `All ${done} were`} already saved — an earlier attempt had finished after the page gave up`
            : keepBoth
              ? `Saved ${done} record${done === 1 ? '' : 's'} alongside the ${done === 1 ? 'one' : 'ones'} already on file`
              : `Updated ${done} existing record${done === 1 ? '' : 's'}`,
        );
      }
    } catch (err) {
      console.error('[bulk-scan] duplicate resolve threw', err);
      toast.error('Something went wrong updating those records. Check Documents before trying again.');
      setStatus('completed');
    }
  };

  /**
   * The FILE this scanned record came from, for the comparison prompt.
   *
   * From `files` — the originals still sitting in this page's state — not from
   * the server. `/api/ai/scan` splits uploads into page images inside a private
   * scratch dir under the OS temp directory; nothing there is HTTP-reachable,
   * by design. Returns null when the pairing cannot be made, and the prompt
   * says so rather than showing an empty frame.
   */
  const scanSourceFile = (result) => {
    const proposed = proposedRecords[result?.index];
    const fileIndex = proposed?.fileIndices?.[0];
    const meta = Number.isInteger(fileIndex) ? uploadedFiles[fileIndex] : null;
    const name = meta?.originalName || meta?.fileName;
    return name ? files.find((f) => f.name === name) || null : null;
  };

  /**
   * The row's badge, coloured by the taxonomy MODULE it is filed under.
   *
   * This was a six-arm switch on the scan category with a grey question mark
   * for everything else — which, once every record started being filed against
   * the taxonomy, meant eleven of the seventeen destinations drew "unknown" for
   * records that were classified perfectly well.
   *
   * `MODULE_COLORS` is the app's own per-module palette, keyed by moduleKey, so
   * the badge here matches the badge on the same record in the Documents
   * Manager and cannot drift as modules are added. `todo` and
   * `emergency_contact` have no module and keep the neutral default.
   */
  const getCategoryIcon = (record) => {
    const moduleKey = record?.extractedData?.moduleKey;
    const { fg, bg } = MODULE_COLORS[moduleKey] || DEFAULT_MODULE_COLOR;
    const Icon = moduleKey ? FileText : HelpCircle;
    return <Icon size={18} style={{ color: fg, backgroundColor: bg }} className="rounded" />;
  };

  // Rendered above and below the review list, so a member who has read to the
  // end of a long batch can save without scrolling back up.
  //
  // Blocked while any record is filed somewhere this member cannot write, or
  // belongs to nobody. Saving anyway would half-succeed and report the rest as
  // failures — the member can see the problem and fix it here. Both reasons
  // share one count, because the button is answering one question: how many
  // rows still need a hand.
  const saveAllButton = (
    <Button
      onClick={handleSave}
      disabled={needAttention.length > 0}
      title={attentionReason}
      className="flex items-center gap-2 font-extrabold shadow-md bg-gradient-to-r from-primary to-accent hover:opacity-90"
    >
      <Check size={18} />
      {needAttention.length > 0
        ? `${needAttention.length} record${needAttention.length === 1 ? '' : 's'} need attention`
        : `Confirm & Save All (${proposedRecords.length})`}
    </Button>
  );

  return (
    <PageContainer width="wide" className="gap-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/40 pb-6">
        <div className="flex items-center gap-4">
          {/* LEAVING the page is not this button's job — Shell draws a global
              Back in both headers (useBackNavigation), and from here its parent
              fallback is already /documents. A second pill saying the same
              thing one row below it is what this used to be.

              Mid-review it is not a duplicate: the destination is a STEP of
              this page, not a route. Shell's Back would walk out to /documents
              and take the scanned batch with it, so the review grid keeps its
              own way back to file selection. */}
          {status === 'verification' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setStatus('upload')}
              className="flex items-center gap-2"
            >
              <ArrowLeft size={16} /> Back to Files
            </Button>
          )}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Documents
            </p>
            <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl gradient-text">
              Intelligent Power Scanner
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Scan multiple documents and let AI group, categorize, and compile details automatically
            </p>
          </div>
        </div>
      </div>

      {/* STEP 1: Upload Workspace */}
      {status === 'upload' && (
        <div className="flex flex-col gap-6">
          {/* Dropzone */}
          <div 
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current.click()}
            className="glass-card flex flex-col items-center justify-center min-h-[260px] p-8 text-center cursor-pointer border-2 border-dashed border-border/60 hover:border-primary/50 hover:bg-card/80 transition-all rounded-2xl group"
          >
            <input 
              type="file" 
              accept={UPLOAD_ACCEPT_ATTRIBUTE}
              ref={fileInputRef} 
              multiple 
              onChange={handleFileChange}
              className="hidden"
            />
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center text-primary mb-4 group-hover:scale-110 transition-transform duration-300">
              <UploadCloud size={28} />
            </div>
            <h3 className="text-lg font-bold text-foreground mb-1">Drag & Drop your files here</h3>
            <p className="text-xs text-muted-foreground mb-4 max-w-sm">
              Supports PDFs, Images, Word Docs, Text, Excel, and more.
              {' '}Up to {MAX_SCAN_FILES} documents per scan — smaller batches are read more accurately.
            </p>
            <Button variant="secondary" size="sm">
              Select Files
            </Button>
          </div>

          {/* Uploaded File List */}
          {files.length > 0 && (
            <Card className="glass-card static animate-fade-in">
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-3 border-b border-border/20">
                <CardTitle className="text-base font-bold text-primary flex items-center gap-2">
                  Selected Files
                  {/* Shown against the ceiling, not on its own: a bare count
                      gives no warning that the next drop will be refused. */}
                  <Badge variant={files.length >= MAX_SCAN_FILES ? 'destructive' : 'secondary'}>
                    {files.length} / {MAX_SCAN_FILES}
                  </Badge>
                </CardTitle>
                <Button 
                  variant="destructive" 
                  size="sm"
                  onClick={() => setFiles([])}
                  className="h-8"
                >
                  Clear All
                </Button>
              </CardHeader>
              <CardContent className="pt-4 flex flex-col gap-3">
                <div className="flex flex-col gap-2 max-h-[320px] overflow-y-auto pr-1">
                  {files.map((file, i) => (
                    <div 
                      key={i} 
                      className="flex items-center justify-between p-3 rounded-xl border border-border bg-card hover:bg-muted/30 transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0 max-w-[85%]">
                        <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center text-muted-foreground flex-shrink-0">
                          <FileText size={18} />
                        </div>
                        <div className="flex flex-col min-w-0">
                          <span className="text-sm font-semibold truncate text-foreground">
                            {file.name}
                          </span>
                          <span className="text-xs text-muted-foreground mt-0.5">
                            {(file.size / 1024 / 1024).toFixed(2)} MB — {file.type}
                          </span>
                        </div>
                      </div>
                      
                      <Button 
                        variant="ghost" 
                        size="icon"
                        onClick={() => removeFile(i)}
                        className="h-8 w-8 text-danger-action hover:bg-destructive/10"
                      >
                        <Trash2 size={15} />
                      </Button>
                    </div>
                  ))}
                </div>

                <Button 
                  onClick={() => startScan()}
                  className="w-full mt-2 flex items-center justify-center gap-2 h-11 text-sm font-bold shadow-lg"
                >
                  <Sparkles size={16} /> Start AI Group & Scan
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* STEP 2: Scanning / Processing Loader */}
      {(status === 'scanning' || status === 'saving') && (
        <Card className="glass-card static py-12 flex flex-col items-center justify-center text-center min-h-[320px]">
          <CardContent className="flex flex-col items-center justify-center">
            <div className="relative mb-6">
              <Loader2 size={50} className="animate-spin text-primary" />
              <Sparkles size={20} className="text-accent absolute top-0.5 right-0.5 animate-pulse" />
            </div>
            <h3 className="text-lg font-bold text-foreground mb-2">
              {status === 'scanning' ? 'Scanning Documents' : 'Saving Records'}
            </h3>
            <p className="text-sm text-muted-foreground max-w-md">
              {loaderText}
            </p>
            {status === 'scanning' && (
              <div className="w-64 mt-6">
                <Progress value={45} className="h-1.5 animate-pulse" />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* STEP 3: Verification View */}
      {status === 'verification' && (
        <div className="flex flex-col gap-6 animate-fade-in">
          <Alert>
            <Sparkles className="h-4 w-4 text-primary" />
            <AlertDescription className="text-sm text-foreground/90 ml-2">
              <strong>AI Scan Finished!</strong> Review the grouped records below. You can rename them, edit their fields, choose who each one belongs to, and delete anything you do not want saved.
            </AlertDescription>
          </Alert>

          {/* Actions panel */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <Button
              variant="outline"
              onClick={addEmptyRecord}
              className="flex items-center gap-2 self-start"
            >
              <PlusCircle size={16} /> Create Empty Record
            </Button>

            {saveAllButton}
          </div>

          {blockedRecords.length > 0 && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="text-sm ml-2">
                {blockedRecords.length === 1 ? 'One record is' : `${blockedRecords.length} records are`}{' '}
                filed under a module you do not have permission to add to. Change
                the category on {blockedRecords.length === 1 ? 'it' : 'them'}, or
                remove {blockedRecords.length === 1 ? 'it' : 'them'}, to save the rest.
              </AlertDescription>
            </Alert>
          )}

          {/* The comparison for a row the check flagged. "Keep the existing
              one" only closes it: the dialog also fires that on Esc or an
              outside click, and a stray dismissal must not drop a record from
              the batch. Leaving it out stays the row's own explicit button. */}
          <DuplicateResolveDialog
            open={Boolean(comparing)}
            match={comparing}
            newFile={scanSourceFile(comparing)}
            newTitle={comparing ? proposedRecords[comparing.index]?.title : undefined}
            onKeepExisting={() => setComparing(null)}
            onKeepNew={() => {
              const answered = comparing;
              setComparing(null);
              answerRow(answered.index, { replaceId: answered.existingId });
            }}
            onKeepBoth={() => {
              const answered = comparing;
              setComparing(null);
              answerRow(answered.index, { keepBoth: true });
            }}
          />

          {/* Records Grid */}
          <div className="flex flex-col gap-6">
            {proposedRecords.map((record, rIdx) => {
              const { category, title, fileIndices, extractedData } = record;
              const blocked = !recordAllowed(record);

              return (
                <Card
                  key={rIdx}
                  className={cn(
                    'glass-card static border-l-4 overflow-hidden',
                    blocked ? 'border-l-destructive' : 'border-l-primary/80',
                  )}
                >
                  <CardContent className="p-6 flex flex-col gap-6">
                    {/* Two different denials, two different fixes: a module the
                        member holds none of is not recoverable here, while a
                        single denied sub-category is one dropdown away from
                        being one they hold. Named against the MODULE because
                        that is the word the access screen uses. */}
                    {blocked && (
                      <Alert variant="destructive">
                        <AlertCircle className="h-4 w-4" />
                        <AlertDescription className="text-sm ml-2">
                          {allowedCategories?.has(category) ? (
                            <>
                              You do not have permission to add to the sub-category
                              the scan chose. Pick another below, or remove this record.
                            </>
                          ) : (
                            <>
                              You cannot file records into <strong>{scanModuleLabel(category)}</strong>.
                              Remove this record, or ask an administrator for access.
                            </>
                          )}
                        </AlertDescription>
                      </Alert>
                    )}

                    {/* ── What the check said about this row ──────────────
                        Nothing in the batch is saved until every row is clean,
                        so each flagged row says what is wrong and offers its
                        own answers right here. */}
                    {record._issue && (
                      <Alert variant={record._issue.kind === 'error' ? 'destructive' : undefined}
                        className={record._issue.kind === 'error' ? undefined : 'border-amber-500/40 bg-amber-500/5'}>
                        <AlertCircle className={cn('h-4 w-4', record._issue.kind !== 'error' && 'text-amber-500')} />
                        <AlertDescription className="ml-2 flex flex-col gap-2 text-sm">
                          <span>
                            {record._issue.kind === 'duplicate' && (
                              <strong className="text-foreground">Already in your documents. </strong>
                            )}
                            {record._issue.error}
                          </span>
                          {record._issue.kind !== 'error' && (
                            <span className="flex flex-wrap items-center gap-2">
                              {record._issue.kind === 'duplicate' && (
                                <Button size="sm" variant="outline" className="h-7 gap-1.5 px-2 text-xs"
                                  onClick={() => setComparing({ ...record._issue, index: rIdx })}>
                                  <Eye size={13} /> Compare
                                </Button>
                              )}
                              {record._issue.kind === 'duplicate' && record._issue.keepNewAllowed && (
                                <Button size="sm" variant="outline" className="h-7 px-2 text-xs"
                                  onClick={() => answerRow(rIdx, { replaceId: record._issue.existingId })}>
                                  Update the one on file
                                </Button>
                              )}
                              {(record._issue.keepBothAllowed || record._issue.batchDuplicate?.keepBothAllowed) && (
                                <Button size="sm" variant="outline" className="h-7 gap-1.5 px-2 text-xs"
                                  onClick={() => answerRow(rIdx, { keepBoth: true })}>
                                  <Copy size={13} /> Keep both
                                </Button>
                              )}
                              <Button size="sm" variant="outline" className="h-7 gap-1.5 px-2 text-xs"
                                onClick={() => deleteRecord(rIdx, { rescueFiles: false })}>
                                <Trash2 size={13} /> Don&apos;t save this one
                              </Button>
                            </span>
                          )}
                        </AlertDescription>
                      </Alert>
                    )}
                    {!record._issue && (record.replaceId || record.keepBoth) && (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-muted-foreground">
                        <span>
                          <Check size={13} className="mr-1.5 inline text-emerald-500" />
                          {record.replaceId
                            ? 'Will update the record already on file.'
                            : 'Will be saved as a separate copy beside the one it matched.'}
                        </span>
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs"
                          onClick={() => answerRow(rIdx, {})}>
                          Change
                        </Button>
                      </div>
                    )}

                    {/* Record Header */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/40 pb-4">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <div className="w-10 h-10 rounded-xl bg-card border border-border flex items-center justify-center flex-shrink-0">
                          {getCategoryIcon(record)}
                        </div>
                        
                        <div className="flex-1 min-w-0">
                          <Input
                            type="text"
                            className="font-bold text-base bg-transparent border-none focus-visible:ring-0 p-0 h-auto text-foreground placeholder:text-faint"
                            value={record.title}
                            onChange={(e) => {
                              const val = e.target.value;
                              setProposedRecords(prev => {
                                const updated = [...prev];
                                updated[rIdx] = { ...withoutIssue(updated[rIdx]), title: val };
                                return updated;
                              });
                            }}
                            placeholder="Record Title"
                          />
                        </div>
                      </div>

                      <div className="flex items-center gap-3 self-end sm:self-auto">
                        <div className="w-44">
                          <HolderSelect
                            id={`holder-${rIdx}`}
                            label=""
                            value={rowHolder(record)}
                            required
                            compact
                            // Red on the rows the scan could not place, naming
                            // the name it read so the reason is on screen
                            // rather than guessed at. Never in a company: the
                            // company is a complete answer, so an unmatched
                            // name is a hint (rename the company, or add the
                            // member), not an error — the picker shows it.
                            error={rowHolder(record) || companyId
                              ? ''
                              : unmatchedHolderError(record.holderNameFromScan, { compact: true })}
                            // Only while the row is still unplaced: it
                            // pre-fills this row's "+" dialog, and lets the row
                            // adopt the member as soon as they are added, which
                            // is the point of adding them mid-batch.
                            suggestedName={rowHolder(record) ? '' : (record.holderNameFromScan || '')}
                            onChange={(val) => setProposedRecords(prev => {
                              const updated = [...prev];
                              // Choosing by hand outranks the scan's match, and
                              // clearing the flag stops "apply to all" from
                              // skipping this row afterwards.
                              updated[rIdx] = {
                                ...withoutIssue(updated[rIdx]),
                                holderId: val,
                                holderMatchedFromScan: false,
                              };
                              return updated;
                            })}
                          />
                          {record.holderMatchedFromScan && (
                            <p className="mt-1 text-xs font-medium text-info-text">
                              Matched from scan
                            </p>
                          )}
                        </div>
                        {/* The 17-option vault-category select that used to sit
                            here is gone. Since the master document table became
                            the module list, <CategorySelect> below IS the module
                            picker, and two controls filing the same record into
                            two different taxonomies could only disagree. The
                            record's page follows from the sub-category picked
                            below — `scanCategoryForKey` reads it back off the
                            pair, which the save route re-derives for itself. */}

                        <Button
                          variant="ghost" 
                          size="icon"
                          onClick={() => deleteRecord(rIdx)}
                          className="h-9 w-9 text-danger-action hover:bg-destructive/10"
                        >
                          <Trash2 size={16} />
                        </Button>
                      </div>
                    </div>

                    {/* Record Form Fields based on Category */}
                    <div className="flex flex-col gap-4">
                      {/* ── ONE PICKER AND ONE FIELD SET, FOR EVERY RECORD ───
                          Not one line of it written here: it is the same
                          <CategoryFieldInputs> the module form and the
                          Documents Manager render, driven by the
                          sub-category's own spec, so a field a super admin
                          relabelled, retired or made mandatory on
                          /admin/document-fields says the same thing in all
                          three places.

                          This block used to be `category === 'document'`, and
                          below it sat five hand-written field sets for five of
                          the other sixteen scan categories — the remaining
                          eleven rendered nothing at all. A batch of
                          prescriptions, policies, salary slips and utility
                          bills therefore came back with no Category, no
                          Sub-category and, for most of them, no fields: there
                          was no control on screen that could file them, because
                          only `document` was ever asked which sub-category it
                          belonged to.

                          Pass 1 files every record against the master taxonomy
                          now, so every record has a pair, a resolved
                          `categoryId` and a spec — and the same two controls
                          the single-upload form uses serve all of them. The
                          five legacy field sets are gone with the legacy
                          schemas that fed them; each was a strict subset of
                          what its category already declares, and none of them
                          honoured a single super-admin field configuration.

                          `todo` and `emergency_contact` own no taxonomy
                          category, so they keep their own small forms. */}
                      {!SCAN_MODULES_WITHOUT_CATEGORIES.includes(SCAN_CATEGORY_MODULE[category]) && (
                        <>
                          {/* The same picker the single-upload form uses, so the
                              two flows present the taxonomy identically.
                              Pre-selected from the AI's proposed category when
                              /api/ai/scan resolved its pair.

                              `add`: the review grid is a write form, so it must
                              not offer a sub-category the save will refuse. A
                              denied category the AI proposed stays VISIBLE as
                              the current value (CategorySelect keeps an
                              out-of-list value for display) and the warning
                              above says to change it. */}
                          <CategorySelect
                            id={`category-${rIdx}`}
                            label="Category"
                            subLabel="Sub-category"
                            compact
                            action="add"
                            value={extractedData.categoryId || ''}
                            onChange={(val, picked) => {
                              updateRecordField(rIdx, 'categoryId', val);
                              // The CHOSEN category's pair, never the AI's: an
                              // explicit choice must not be able to fall back to
                              // the proposal in the save route, and clearing the
                              // pair outright would leave the fields below with
                              // no spec to render from.
                              updateRecordField(rIdx, 'moduleKey', picked?.moduleKey || '');
                              updateRecordField(rIdx, 'documentKey', picked?.documentKey || '');
                              // The values below are keyed by the OLD category's
                              // field keys. Kept, they would be posted as fields
                              // the new category does not declare — dropped by
                              // `buildTaxonomyRecord` at best, and misleading on
                              // screen either way, since the inputs that showed
                              // them are about to be replaced.
                              updateRecordField(rIdx, 'fields', {});
                              // The record moves to whichever page owns the new
                              // category. Kept in step here purely so the
                              // permission warning and the module icon on this
                              // row agree with what the save will do — the route
                              // re-derives it from the category and does not
                              // trust this value.
                              //
                              // A duplicate answer was given about the OLD
                              // category's match, so it is dropped with it.
                              setProposedRecords((prev) => {
                                const updated = [...prev];
                                const { replaceId, keepBoth, ...rest } = withoutIssue(updated[rIdx]);
                                updated[rIdx] = {
                                  ...rest,
                                  category: scanCategoryForKey(picked) || updated[rIdx].category,
                                };
                                return updated;
                              });
                            }}
                          />
                          <ScanRecordFields
                            {...documentSpec(extractedData)}
                            values={extractedData.fields}
                            errors={recordErrors[rIdx]}
                            disabled={status === 'saving'}
                            onChange={(key, value) => updateRecordFields(rIdx, key, value)}
                          />
                        </>
                      )}
                    </div>

                    {/* Grouped Files List — read-only.
                        The per-file "Group to" select is gone: with one record
                        it reassigned a page to the record it was already in,
                        and the grouping it re-did is the scan's own job. A
                        mis-grouped batch is corrected by deleting the record
                        here, which returns its pages to the first record. */}
                    <div className="mt-2 bg-muted/20 border border-border/40 p-4 rounded-xl flex flex-col gap-2.5">
                      <span className="text-xs font-bold text-muted-foreground flex items-center gap-1.5">
                        Associated Pages / Files <Badge variant="secondary" className="px-1.5 py-0 h-4 text-xs">{fileIndices.length}</Badge>
                      </span>

                      {fileIndices.length === 0 ? (
                        <p className="text-xs text-faint italic py-1">
                          No files linked to this record. It will be saved as details only, with no document attached.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-2 mt-1">
                          {fileIndices.map((fileIdx) => {
                            const fileMeta = uploadedFiles[fileIdx];
                            if (!fileMeta) return null;
                            return (
                              <div
                                key={fileIdx}
                                className="flex items-center gap-2 p-2 bg-card border border-border/20 rounded-lg text-xs"
                              >
                                <span className="flex items-center gap-2 font-semibold text-foreground truncate">
                                  <FolderDot size={14} className="text-primary/70 flex-shrink-0" />
                                  <span className="truncate">{fileMeta.fileName}</span>
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Same button as the actions panel above. Full width on phones like
              that one, and on the same right edge from sm up. */}
          {proposedRecords.length > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-4 pt-2">
              {saveAllButton}
            </div>
          )}
        </div>
      )}

      {/* STEP 4: Completed Page */}
      {status === 'completed' && (() => {
        // Derived from the response, not from what was submitted. Every record
        // is saved independently, so "completed" is not the same as "all saved"
        // — and the screen has to be able to say so.
        const saved = saveResults.filter(r => r.success);
        // Three outcomes, not two. A duplicate is a QUESTION — the record is
        // fine and the tenant already holds one like it — so it must not be
        // listed under "not saved" beside a genuine error.
        const pending = saveResults.filter(r => !r.success && r.requiresConfirmation);
        const failed = saveResults.filter(r => !r.success && !r.requiresConfirmation);
        const allSaved = failed.length === 0 && pending.length === 0;
        // Saved, but not by THIS request: an earlier attempt had already sealed
        // these pages to Drive and its answer never came back. The records are
        // safe — the screen just must not take the credit, or the member is
        // left believing a save that failed in front of them did nothing.
        const alreadyStored = saved.filter(r => r.alreadyStored);
        // A scan that expired on the server. The files are still in this
        // page's `files` state, so it is one click to start over rather than a
        // dead end — see the button below. Keyed on the route's structured
        // `code`, never on its sentence: a reworded message must not quietly
        // remove the only recovery this screen offers.
        const expired = failed.filter(r => r.code === 'SCAN_PAGES_EXPIRED');

        return (
        <Card className="glass-card static py-12 flex flex-col items-center justify-center text-center min-h-[320px]">
          <CardContent className="flex w-full max-w-xl flex-col items-center justify-center">
            <div className={cn(
              'w-16 h-16 rounded-full flex items-center justify-center mb-6',
              allSaved ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500',
            )}>
              {allSaved ? <Check size={32} /> : <AlertCircle size={32} />}
            </div>

            <h3 className="text-xl font-bold text-foreground mb-2">
              {allSaved
                ? 'Scan Completed Successfully!'
                : pending.length > 0
                  ? 'Some of these already exist'
                  : 'Scan Completed With Errors'}
            </h3>

            <p className="text-sm text-muted-foreground max-w-md mb-6">
              {allSaved
                ? `${saved.length} record${saved.length === 1 ? '' : 's'} saved to your documents and encrypted to Google Drive.`
                : pending.length > 0
                  ? `${saved.length} saved. ${pending.length} match ${pending.length === 1 ? 'a record' : 'records'} you already have — nothing was overwritten without asking.`
                  : `${saved.length} of ${saveResults.length} records saved. The rest are listed below and were not stored.`}
            </p>

            {/* ── "That one was already in your vault" ───────────────────
                A save that outruns Cloudflare's 100s ceiling finishes on the
                server after the browser has given up, so the member is shown a
                failure for documents that are safely filed. Saying only "saved"
                here would be true of the record and false of this request —
                and it is the difference between someone checking Documents and
                someone scanning the same stack a third time. */}
            {alreadyStored.length > 0 && (
              <p className="-mt-3 mb-6 max-w-md text-xs text-muted-foreground">
                {alreadyStored.length === saved.length && saved.length === 1
                  ? 'It was already in your vault — an earlier attempt had finished saving it even though the page reported an error. Nothing was uploaded twice.'
                  : `${alreadyStored.length} of ${saved.length === 1 ? 'these' : `these ${saved.length}`} ${alreadyStored.length === 1 ? 'was' : 'were'} already in your vault — an earlier attempt had finished saving ${alreadyStored.length === 1 ? 'it' : 'them'} even though the page reported an error. Nothing was uploaded twice.`}
              </p>
            )}

            {/* ── Already here: the user decides ─────────────────────────
                Power Scan is the likeliest way to produce duplicates — a stack
                of paperwork re-scanned is the same stack. It used to overwrite
                these silently and report them as "created". Each one now names
                the record it matched and waits. */}
            {pending.length > 0 && (
              <div className="mb-8 w-full rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-left">
                <p className="mb-1 text-xs font-bold uppercase tracking-wider text-amber-500">
                  Already in your documents
                </p>
                <p className="mb-3 text-xs text-muted-foreground">
                  Compare the scan with what is on file, then choose whether to
                  update that record, keep both, or leave it alone.
                </p>
                <ul className="space-y-2">
                  {pending.map((r, i) => (
                    <li key={i} className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">
                        <span className="font-semibold text-foreground">
                          {r.title || 'Untitled record'}
                        </span>
                        {r.error ? ` — ${r.error}` : ''}
                      </span>
                      <span className="flex items-center gap-2">
                        {/* Both documents, side by side, and all three answers
                            — the same prompt the Document Manager raises. */}
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1.5 px-2 text-xs"
                          onClick={() => setComparing(r)}
                        >
                          <Eye size={13} />
                          Compare
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          onClick={() => confirmDuplicates([r])}
                        >
                          Update it
                        </Button>
                        {/* The third answer, inline. It was reachable only
                            through Compare, so a row the user had already
                            recognised could be answered "update" in one click
                            and "keep both" in three. Offered on the same terms
                            the prompt offers it: never for an identifier
                            clash, which the server refuses whatever a client
                            sends. */}
                        {r.keepBothAllowed && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1.5 px-2 text-xs"
                            onClick={() => confirmDuplicates([r], { keepBoth: true })}
                          >
                            <Copy size={13} />
                            Keep both
                          </Button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
                {pending.length > 1 && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      className="h-7 px-3 text-xs"
                      onClick={() => confirmDuplicates(pending)}
                    >
                      Update all {pending.length}
                    </Button>
                    {/* Only the rows that MAY be forked — an identifier clash
                        would come straight back refused, and sweeping it in
                        would report a failure the user did not ask for. */}
                    {pending.some((r) => r.keepBothAllowed) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1.5 px-3 text-xs"
                        onClick={() => confirmDuplicates(
                          pending.filter((r) => r.keepBothAllowed),
                          { keepBoth: true },
                        )}
                      >
                        <Copy size={13} />
                        Keep both for {pending.filter((r) => r.keepBothAllowed).length}
                      </Button>
                    )}
                  </div>
                )}

                <DuplicateResolveDialog
                  open={Boolean(comparing)}
                  match={comparing}
                  newFile={scanSourceFile(comparing)}
                  newTitle={comparing?.title}
                  onKeepExisting={() => setComparing(null)}
                  onKeepNew={() => {
                    const answered = comparing;
                    setComparing(null);
                    confirmDuplicates([answered]);
                  }}
                  onKeepBoth={() => {
                    const answered = comparing;
                    setComparing(null);
                    confirmDuplicates([answered], { keepBoth: true });
                  }}
                />
              </div>
            )}

            {/* Named individually: "3 failed" is not actionable, and the user
                still has the source files open in the previous step. */}
            {failed.length > 0 && (
              <div className="mb-8 w-full rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-left">
                <p className="mb-2 text-xs font-bold uppercase tracking-wider text-amber-500">
                  Not saved
                </p>
                <ul className="space-y-1.5">
                  {failed.map((r, i) => (
                    <li key={i} className="text-xs text-muted-foreground">
                      <span className="font-semibold text-foreground">{r.title || 'Untitled record'}</span>
                      {r.error ? ` — ${r.error}` : ''}
                    </li>
                  ))}
                </ul>

                {/* ── The scan expired, so start it over from here ────────
                    A scratch directory lives an hour; a review session can
                    outlast one. The pages are unrecoverable, but the FILES are
                    not: `files` still holds the browser File objects the member
                    picked, all the way through review, so this is one click
                    rather than finding the documents on disk a second time.

                    A re-scan re-proposes records that DID save on the earlier
                    pass. Those come back through the duplicate prompt, which is
                    exactly where a second copy of something already on file
                    belongs — so the overlap resolves itself. */}
                {expired.length > 0 && files.length > 0 && (
                  <div className="mt-3 border-t border-amber-500/20 pt-3">
                    <p className="mb-2 text-xs text-muted-foreground">
                      {expired.length === 1 ? 'That scan' : 'Those scans'} sat on this
                      screen long enough for the server to clear the pages. Your files are
                      still here, so scanning again does not mean picking them out afresh.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1.5 px-3 text-xs"
                      onClick={() => startScan({ isRetry: true })}
                    >
                      <RefreshCw size={13} />
                      Scan {files.length === 1 ? 'the file' : `all ${files.length} files`} again
                    </Button>
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-center gap-2">
              {/* Documents, not the dashboard: it is where the records just
                  created actually are. */}
              <Button onClick={() => router.push(utilityNavPath('/documents', companyId))} className="px-6">
                Go to Documents
              </Button>
              {(failed.length > 0 || pending.length > 0) && (
                <Button variant="outline" onClick={() => setStatus('verification')} className="px-6">
                  Back to review
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
        );
      })()}

    </PageContainer>
  );
}
