'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A CLIENT'S DOCUMENTS — the Document Manager's table, for one client    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The same table the Document Manager shows (src/app/documents/page.js), over ONE
 * client's documents: Document Name with "Module - Sub-category" under it, Number,
 * Holder (the client), Uploaded By, and the Share / View / ⋮ actions; selectable
 * rows with bulk Share / Print / Download / Delete; a row opens the detail panel;
 * View opens the scan.
 *
 * ── SAME PIECES, NOT A COPY OF THE PAGE ────────────────────────────────────
 * It is built from the shared primitives the Document Manager uses — `DataTable`,
 * `RowActionsMenu`, `DocumentDetailPanel`, `FilePreviewPane`, the share/print
 * helpers and `documentRowFormat` — and reads `GET /api/documents`, the same route,
 * with the client named (`?clientId=`, added by `withCompany` from the URL path and
 * proven server-side; see src/lib/clients/clientDocumentScope.ts). The Document
 * Manager page itself is left alone: its table's handlers are inline in a
 * 3,400-line component that also owns upload, scan and duplicate handling, and
 * merging the two is a refactor of its own.
 *
 * ── WHAT DIFFERS, ON PURPOSE ───────────────────────────────────────────────
 *   Holder       the CLIENT. A client's document has no member holder.
 *   Sub-category no filter dropdowns: the client page has a "Sub-categories" button
 *                that opens a page of every type this client can have.
 *   Edit         no "edit all" form and no re-file picker: a document's type and
 *                client are not changed from here; a type's own page edits it.
 *
 * Search, filters, sort and page live in the URL, like the Document Manager's, so
 * this must sit under a Suspense boundary (`useSearchParams`).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { AlertCircle, Download, Eye, FileText, Loader2, Printer, Share2, Trash2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DataTable, isInteractiveTarget } from '@/components/ui/data-table';
import RowActionsMenu from '@/components/ui/row-actions-menu';
import DocumentDetailPanel from '@/components/records/DocumentDetailPanel';
import FilePreviewPane, { formatBytes } from '@/components/records/FilePreviewPane';
import {
  downloadRecord, getFileUrl, printRecord, printRecords, shareRecord, shareRecords, warmShare,
} from '@/lib/sharePrintHelper';
import { reportShareResult } from '@/lib/shareToast';
import { clientCan } from '@/lib/clientAuth';
import { formatDate } from '@/lib/dateHelper';
import { docCustomFields, docField } from '@/lib/records/docFieldsClient';
import { docCategoryName, docColors, docTaxonomyLabel } from '@/lib/records/documentRowFormat';
import { apiDownload } from '@/lib/net/apiRequest';
import { toastStorageError } from '@/lib/storageToast';
import { toastApiError } from '@/lib/net/toastApiError';
import { useWorkspaceApi, withCompany } from '@/lib/net/useWorkspaceApi';
import { CLIENT_MODULE_BY_TYPE } from '@/lib/clientCategories';

/**
 * @param {{
 *   client: { id: string, clientType: 'individual' | 'company', displayName: string },
 *   user: any,
 *   onChanged?: () => void,
 * }} props
 */
export default function ClientDocuments({ client, user, onChanged }) {
  const { api, companyId } = useWorkspaceApi();
  const searchParams = useSearchParams();

  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pagination, setPagination] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [detailDoc, setDetailDoc] = useState(null);
  const [previewDoc, setPreviewDoc] = useState(null);

  const moduleKey = CLIENT_MODULE_BY_TYPE[client.clientType];
  /** May this member do `action` to THIS row? The row's own category decides, as the server does. */
  const may = (doc, action) => clientCan(
    user,
    doc?.categoryRef?.moduleKey ?? moduleKey,
    doc?.categoryRef?.documentKey ?? null,
    action,
  );

  const fetchDocuments = useCallback(async () => {
    setLoading(true);
    try {
      // The URL is the state (search, sort, page, the sub-category filter), exactly
      // as in the Document Manager. `api` adds the company and — from the path —
      // this client.
      const { json } = await api(`/api/documents${window.location.search}`);
      if (json.success) {
        setError('');
        setDocuments(json.documents);
        if (json.pagination) setPagination(json.pagination);
      } else {
        setError(json.error || 'Failed to fetch documents');
      }
    } catch (err) {
      console.error('[client documents] handler threw', err);
      setError('Something went wrong fetching documents. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  // Keyed on the query STRING, so only a real change of search / filter / page refetches.
  const queryKey = searchParams.toString();
  useEffect(() => { fetchDocuments(); }, [fetchDocuments, queryKey, companyId, client.id]);

  /** The list changed (a delete in the panel): refetch it. */
  const changed = () => { fetchDocuments(); onChanged?.(); };

  // After a refetch the panel shows the fresh row, not the one it opened with.
  useEffect(() => {
    setDetailDoc((prev) => (prev ? documents.find((d) => d.id === prev.id) ?? prev : prev));
  }, [documents]);

  // ── Row actions — the Document Manager's, on this table ─────────────────
  /** The row's fields, labelled — what Share, Print and the exported PDF describe it with. */
  const docFields = (doc) => {
    const heading = [
      { label: 'Document Name', value: doc.title },
      { label: 'Category', value: docCategoryName(doc).toUpperCase() },
      { label: 'Client', value: client.displayName },
    ];
    const custom = docCustomFields(doc).map((f) => ({ label: f.label, value: f.value }));
    if (Array.isArray(doc.fields)) {
      return [
        ...heading,
        ...doc.fields.map((f) => (f.dataType === 'date' && f.value
          ? { label: f.label, value: formatDate(f.value) }
          : { label: f.label, value: f.value })),
        ...custom,
      ].filter((f) => f.value !== '' && f.value !== undefined && f.value !== null);
    }
    return [
      ...heading,
      { label: doc.display?.numberLabel || 'Document Number', value: doc.display?.number || '' },
      { label: 'Date of Birth', value: docField(doc, 'dob') ? formatDate(docField(doc, 'dob')) : '' },
      { label: 'Expiry Date', value: docField(doc, 'expiryDate') ? formatDate(docField(doc, 'expiryDate')) : '' },
      ...custom,
    ].filter((f) => f.value !== '' && f.value !== undefined && f.value !== null);
  };

  const asShareItem = (doc) => ({
    id: doc.id,
    title: doc.title,
    fields: docFields(doc),
    filePath: doc.filePath,
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    pageCount: doc.pageCount,
  });

  const handleShare = async (doc) => {
    reportShareResult(await shareRecord(
      doc.title, docFields(doc), undefined, doc.filePath,
      { fileName: doc.fileName, mimeType: doc.mimeType, pageCount: doc.pageCount },
    ));
  };

  const handleDownload = async (doc) => {
    if (!doc.filePath) {
      await downloadRecord(`Document - ${doc.title}`, docFields(doc));
      return;
    }
    // `?download=1` makes the route send the stored filename; a vault filePath has none.
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
    const result = await printRecord(doc.title, docFields(doc), undefined, doc.filePath);
    if (result && !result.success) toast.error(result.error || 'Could not open this document to print.');
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this document?')) return false;
    try {
      const { json } = await api(`/api/documents/${id}`, { method: 'DELETE' });
      if (json.success) {
        toast.success('Document deleted');
        setDocuments((prev) => prev.filter((d) => d.id !== id));
        onChanged?.();
        return true;
      }
      toast.error(json.error || 'Failed to delete document');
      return false;
    } catch (err) {
      console.error('[client documents] handler threw', err);
      toast.error('Something went wrong deleting document. Please try again.');
      return false;
    }
  };

  const openPreview = (doc) => setPreviewDoc({
    id: doc.id,
    rotation: doc.rotation || 0,
    title: doc.title,
    fileName: doc.fileName,
    fileSize: doc.fileSize,
    filePath: doc.filePath,
    mimeType: doc.mimeType,
    pageCount: doc.pageCount,
    categoryRef: doc.categoryRef,
  });

  const saveRotation = async (docId, degrees) => {
    const { json } = await api(`/api/documents/${docId}/rotation`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rotation: degrees }),
    });
    if (!json?.success) throw new Error(json?.error || 'Could not save the rotation');
    setDocuments((prev) => prev.map((d) => (d.id === docId ? { ...d, rotation: degrees } : d)));
    setPreviewDoc((prev) => (prev && prev.id === docId ? { ...prev, rotation: degrees } : prev));
  };

  // ── Bulk actions on the current selection ───────────────────────────────
  const selectedDocs = () => documents.filter((d) => selectedIds.includes(d.id));

  /** Every id the CURRENT filters match, not just this page. */
  const handleSelectAllMatching = async () => {
    setBulkBusy(true);
    try {
      const params = new URLSearchParams(searchParams.toString());
      params.set('page', '1');
      params.set('limit', '500');
      const { json } = await api(`/api/documents?${params.toString()}`);
      if (!json.success) { toast.error(json.error || 'Could not select all matching documents'); return; }
      setSelectedIds(json.documents.map((d) => d.id));
      if (json.pagination?.totalCount > json.documents.length) {
        toast.info(`Selected the first ${json.documents.length} of ${json.pagination.totalCount}.`);
      }
    } catch (err) {
      console.error('[client documents] handler threw', err);
      toast.error('Something went wrong selecting all matching documents. Please try again.');
    } finally {
      setBulkBusy(false);
    }
  };

  /** The selected rows this member may `action`, and how many were dropped. */
  const permittedSelection = (action) => {
    const all = selectedDocs();
    const allowed = all.filter((d) => may(d, action));
    return { allowed, denied: all.length - allowed.length, total: all.length };
  };
  const reportShortfall = (verb, allowed, denied) => {
    if (denied > 0) {
      toast.info(`${verb} ${allowed} of ${allowed + denied} — you do not have permission for ${denied} of the selected documents.`);
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
    } catch {
      toast.error('Could not share the selected documents');
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkPrint = async () => {
    const items = selectedDocs().map(asShareItem);
    if (items.length === 0) return;
    setBulkBusy(true);
    try { await printRecords(items); } catch { toast.error('Could not print the selected documents'); } finally { setBulkBusy(false); }
  };

  const handleBulkDownload = async () => {
    if (selectedIds.length === 0) return;
    const { allowed, denied } = permittedSelection('share');
    if (allowed.length === 0) { toast.error('You cannot download any of the selected documents.'); return; }
    setBulkBusy(true);
    try {
      // `withCompany` names the company AND (from the path) this client, which the
      // route proves again before it opens a single document.
      const outcome = await apiDownload(withCompany('/api/documents/bulk-download', companyId), {
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
      const blob = await outcome.response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${client.displayName.replace(/[^\w.-]+/g, '_')}-documents-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Downloading ${allowed.length} document(s)`);
      reportShortfall('Downloaded', allowed.length, denied);
    } catch (err) {
      console.error('[client documents] handler threw', err);
      toast.error('Something went wrong downloading the selected documents. Please try again.');
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    const { allowed, denied } = permittedSelection('delete');
    if (allowed.length === 0) { toast.error('You cannot delete any of the selected documents.'); return; }
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
      if (!json.success) { toast.error(json.error || 'Could not delete the selected documents'); return; }
      const failed = (json.results || []).filter((r) => !r.success).length;
      if (failed > 0) toast.warning(`Deleted ${json.deletedCount}; ${failed} could not be found.`);
      else toast.success(`Deleted ${json.deletedCount} document(s)`);
      reportShortfall('Deleted', allowed.length, denied);
      setSelectedIds([]);
      const deletedIds = new Set((json.results || []).filter((r) => r.success).map((r) => r.id));
      setDocuments((prev) => prev.filter((d) => !deletedIds.has(d.id)));
      changed();
    } catch (err) {
      console.error('[client documents] handler threw', err);
      toast.error('Something went wrong deleting the selected documents. Please try again.');
    } finally {
      setBulkBusy(false);
      setBulkDeleting(false);
    }
  };

  /** With two or more rows checked, the bulk bar owns the actions and the row controls grey out. */
  const bulkSelectionActive = selectedIds.length > 1;
  const rowActionTitle = (label) => (bulkSelectionActive ? 'Use the bulk actions above' : label);

  const handleRowClick = (doc, event) => {
    if (isInteractiveTarget(event)) return;
    if (typeof window !== 'undefined' && String(window.getSelection?.() ?? '').length > 0) return;
    setDetailDoc(doc);
  };

  /** The ⋮ menu, written once for the table row and the mobile card. */
  const rowMenuItems = (doc) => [
    { key: 'print', icon: <Printer size={12} />, label: 'Print', onClick: () => handlePrint(doc) },
    may(doc, 'share') && { key: 'download', icon: <Download size={12} />, label: 'Download', onClick: () => handleDownload(doc) },
    may(doc, 'delete') && { key: 'delete', icon: <Trash2 size={12} />, label: 'Delete', destructive: true, onClick: () => handleDelete(doc.id) },
  ];

  /** Share + View + ⋮, identically on the table row and the mobile card. */
  const rowActions = (doc) => (
    <>
      {may(doc, 'share') && (
        <Button
          onClick={() => handleShare(doc)}
          // Starts fetching on press so the bytes are in hand before the click handler
          // runs and `navigator.share()` still holds the user activation it needs.
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
    </>
  );

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle size={16} />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <>
      <DataTable
        data={documents}
        loading={loading}
        pagination={pagination}
        selectable
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        totalMatching={pagination?.totalCount || 0}
        onSelectAllMatching={handleSelectAllMatching}
        onRowClick={handleRowClick}
        onCardClick={handleRowClick}
        compactCards
        collapsibleFilters
        emptyMessage="No documents for this client yet. Use “Add document” to file the first one."
        bulkActions={[
          { key: 'share', label: 'Share', icon: <Share2 size={13} />, disabled: bulkBusy || permittedSelection('share').allowed.length === 0, onClick: handleBulkShare },
          { key: 'print', label: 'Print', icon: <Printer size={13} />, disabled: bulkBusy, onClick: handleBulkPrint },
          { key: 'download', label: 'Download', icon: <Download size={13} />, disabled: bulkBusy || permittedSelection('share').allowed.length === 0, onClick: handleBulkDownload },
          {
            key: 'delete',
            label: bulkDeleting ? 'Deleting…' : 'Delete',
            icon: bulkDeleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />,
            variant: 'destructive',
            disabled: bulkBusy || permittedSelection('delete').allowed.length === 0,
            onClick: handleBulkDelete,
          },
        ]}
        columns={[
          {
            header: 'Document Name',
            key: 'name',
            sortable: true,
            render: (doc) => {
              const { fg, bg } = docColors(doc);
              const taxonomy = docTaxonomyLabel(doc);
              return (
                <div className="flex items-center gap-3">
                  <span className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ color: fg, backgroundColor: bg }}>
                    <FileText size={20} />
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <button
                      type="button"
                      onClick={() => setDetailDoc(doc)}
                      className="text-left font-bold text-foreground truncate max-w-[200px] hover:text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                      title={`Open ${doc.title}`}
                    >
                      {doc.title}
                    </button>
                    <span className="text-xs text-muted-foreground break-words line-clamp-2 max-w-[280px]" title={taxonomy}>
                      {taxonomy}
                    </span>
                  </div>
                </div>
              );
            },
          },
          { header: 'Number', key: 'number', render: (doc) => <span className="font-medium text-xs">{doc.display?.number || '-'}</span> },
          { header: 'Holder', key: 'holder', render: (doc) => <span className="text-xs">{doc.display?.holderName || '-'}</span> },
          { header: 'Uploaded By', key: 'user', render: (doc) => <span className="text-xs text-muted-foreground">{doc.user?.name || '-'}</span> },
          {
            header: 'Actions',
            key: 'actions',
            render: (doc) => <div className="flex items-center gap-1.5 justify-end">{rowActions(doc)}</div>,
          },
        ]}
        renderCard={(doc, { checkbox }) => {
          const { fg, bg } = docColors(doc);
          return (
            <div className="flex items-center gap-2.5">
              <span className="flex items-center gap-2 shrink-0">
                {checkbox}
                <span className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ color: fg, backgroundColor: bg }}>
                  <FileText size={16} />
                </span>
              </span>
              <span className="flex-1 min-w-0 font-semibold text-sm text-foreground break-words line-clamp-2">{doc.title}</span>
              <div className="flex items-center gap-1.5 shrink-0">{rowActions(doc)}</div>
            </div>
          );
        }}
      />

      {/* Document detail — opened by clicking a row. A client's document is filed under
          the client, so the panel shows the client and the type read-only. */}
      {detailDoc && (
        <DocumentDetailPanel
          key={detailDoc.id}
          doc={detailDoc}
          api={api}
          companyId={companyId}
          may={(action) => may(detailDoc, action)}
          taxonomyLabel={docTaxonomyLabel(detailDoc)}
          clientName={client.displayName}
          categoryOptions={[]}
          onChanged={changed}
          onClose={() => setDetailDoc(null)}
          onShare={() => handleShare(detailDoc)}
          onDownload={() => handleDownload(detailDoc)}
          onPrint={() => handlePrint(detailDoc)}
          onDelete={async () => { if (await handleDelete(detailDoc.id)) setDetailDoc(null); }}
          onExpandPreview={() => { const d = detailDoc; setDetailDoc(null); openPreview(d); }}
          onRotate={(deg) => saveRotation(detailDoc.id, deg)}
        />
      )}

      {/* Preview */}
      <Dialog open={!!previewDoc} onOpenChange={(open) => { if (!open) setPreviewDoc(null); }}>
        {previewDoc && (
          <DialogContent aria-describedby={undefined} className="max-w-[800px] border-border/50 bg-popover/95 backdrop-blur shadow-glass flex flex-col gap-4">
            <DialogHeader className="border-b border-border pb-3">
              <DialogTitle className="text-base font-bold truncate">Preview: {previewDoc.title}</DialogTitle>
              {previewDoc.fileName && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0" title={previewDoc.fileName}>
                  <FileText size={12} className="shrink-0" />
                  <span className="truncate">
                    Original file: <span className="font-medium text-foreground">{previewDoc.fileName}</span>
                    {previewDoc.fileSize ? ` · ${formatBytes(previewDoc.fileSize)}` : ''}
                  </span>
                </p>
              )}
            </DialogHeader>
            <FilePreviewPane
              className="min-h-[350px] max-h-[70vh] flex-1"
              source={{ kind: 'record', filePath: previewDoc.filePath, mimeType: previewDoc.mimeType, name: previewDoc.title, pageCount: previewDoc.pageCount }}
              rotation={previewDoc.rotation}
              onRotate={may(previewDoc, 'edit') ? (deg) => saveRotation(previewDoc.id, deg) : null}
              emptyMessage={`No preview available for ${previewDoc.title}`}
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
    </>
  );
}
