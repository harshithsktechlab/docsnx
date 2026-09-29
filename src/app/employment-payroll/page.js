'use client';

import React, { useEffect, useState } from 'react';
import {
  formatDate } from '@/lib/dateHelper';
import { 
  FileText,
  Plus,
  Search,
  Trash2,
  Sparkles,
  RefreshCw,
  Share2,
  Pencil,
  AlertTriangle,
  CheckCircle2,
  Lightbulb,
  Printer,
  Eye,
  Download,
  Info
} from 'lucide-react';
import { shareRecord, printRecord, downloadRecord } from '@/lib/sharePrintHelper';
import { reportShareResult } from '@/lib/shareToast';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import RowActionsMenu from '@/components/ui/row-actions-menu';
import { toast } from 'sonner';
import { acceptedFileFrom } from '@/app/components/acceptFile';
import { UPLOAD_ACCEPT_ATTRIBUTE } from '@/lib/records/uploadTypes';
import { clientGetMe } from '@/lib/clientAuth';
import DocumentPreviewDialog from '@/components/DocumentPreviewDialog';
import DuplicateResolveDialog from '@/components/records/DuplicateResolveDialog';
import useDuplicateResolve from '@/components/records/useDuplicateResolve';
import { toFormData } from '@/lib/recordRequest';
import HolderSelect, { ALL_MEMBERS, holderValue, holderPayload } from '@/app/components/HolderSelect';
import PageContainer from '@/app/components/PageContainer';
import { apiCall, apiRequest } from '@/lib/net/apiRequest';
import { postUpload } from '@/lib/records/uploadRequest';
import { toastApiError } from '@/lib/net/toastApiError';
import { apiErrorMessage } from '@/lib/net/apiErrorMessage';


export default function EmploymentPayrollPage() {
  const [records, setRecords] = useState([]);
  const [canAdd, setCanAdd] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [canDelete, setCanDelete] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  

  const [showAddModal, setShowAddModal] = useState(false);
  const [editingRec, setEditingRec] = useState(null);
  
  const [title, setTitle] = useState('');
  const [holderId, setHolderId] = useState(ALL_MEMBERS);
  const [employerName, setEmployerName] = useState('');
  const [employeeName, setEmployeeName] = useState('');
  const [documentType, setDocumentType] = useState('OFFER_LETTER');
  const [designation, setDesignation] = useState('');
  const [issueDate, setIssueDate] = useState('');
  const [customFields, setCustomFields] = useState([]);
  const [saving, setSaving] = useState(false);

  // AI Auto-fill states
  const [file, setFile] = useState(null);
  const [aiScanning, setAiScanning] = useState(false);
  const [aiMessage, setAiMessage] = useState('');
  const [previewDoc, setPreviewDoc] = useState(null);

  const fetchRecords = async () => {
    try {
      setLoading(true);
      const { json } = await apiCall('/api/employment-payroll');
      if (json.success) {
        setRecords(json.records || []);
      } else {
        setError(json.error || 'Failed to load records');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[employment-payroll] handler threw', err);
      setError('Something went wrong loading employment records. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRecords();
    async function checkPermissions() {
      try {
        const meData = await clientGetMe();
        if (meData.success) {
          const u = meData.user;
          if (u.role === 'SUPER_ADMIN' || u.role === 'TENANT_ADMIN') {
            setCanAdd(true);
            setCanEdit(true);
            setCanDelete(true);
          } else {
            // The page's PRIMARY taxonomy module, and its MODULE DEFAULT row —
            // `!p.documentKey` skips the sub-category overrides 0024 added, which
            // answer for one category rather than for the button.
            const perm = u.permissions?.find(p => p.module === 'employment' && !p.documentKey);
            setCanAdd(!!perm?.canAdd);
            setCanEdit(!!perm?.canEdit);
            setCanDelete(!!perm?.canDelete);
          }
        }
      } catch (err) {
        console.error('Failed to fetch permissions');
      }
    }
    checkPermissions();
  }, []);

  const openEditModal = (rec) => {
    setEditingRec(rec);
    setTitle(rec.title || '');
    setHolderId(holderValue(rec.holderId));
    setEmployerName(rec.employerName || '');
    setEmployeeName(rec.employeeName || '');
    setDocumentType(rec.documentType || 'OFFER_LETTER');
    setDesignation(rec.designation || '');
    setIssueDate(rec.issueDate ? new Date(rec.issueDate).toISOString().split('T')[0] : '');
    setCustomFields(rec.customFields || []);
    setFile(null);
    setShowAddModal(true);
  };

  const handleAiScan = async () => {
    if (!file) {
      toast.error('Please select or upload a document file first to use AI Auto-fill.');
      return;
    }

    setAiScanning(true);
    setAiMessage('Uploading & scanning document page contents with AI...');

    try {
      const formData = new FormData();
      formData.append('files', file);

      /**
       * `postUpload`, not `fetch`: this sends a file, so nginx answers an
       * oversized one with a 413 HTML page — and `res.json()` threw a
       * SyntaxError on it, which landed in the catch below and was reported as
       * "Network error calling AI Scan endpoint". The user went and checked a
       * connection that was working perfectly.
       */
      const outcome = await postUpload('/api/ai/scan', formData);
      if (!outcome.ok) {
        // Names the actual cause. An empty credit balance, a model the provider
        // retired, a file over the size limit and a dropped connection all used
        // to arrive as "AI could not detect structured values. Try filling
        // manually." — which describes a model that read the document and found
        // nothing in it, and is true for none of them.
        toastApiError(outcome, { subject: 'document', action: 'reading this document' });
        setAiMessage('');
        return;
      }
      const json = outcome.json;
      if (json.success && json.proposedRecords?.length > 0) {
        const proposed = json.proposedRecords[0];
        const data = proposed.extractedData || {};

        if (proposed.title) setTitle(proposed.title);
        if (data.employerName) setEmployerName(data.employerName);
        if (data.employeeName) setEmployeeName(data.employeeName);
        if (data.documentType) setDocumentType(data.documentType);
        if (data.designation) setDesignation(data.designation);
        if (data.issueDate) setIssueDate(new Date(data.issueDate).toISOString().split('T')[0]);

        toast.success('Auto-filled fields from document!');
      } else {
        toast.error(json.error || 'Failed to scan document');
      }
    } catch (err) {
      console.error(err);
      console.error('[employment-payroll] AI scan handler threw', err);
      toast.error('Something went wrong reading this document. Fill the form in below.');
    } finally {
      setAiScanning(false);
      setAiMessage('');
    }
  };

  /**
   * The duplicate prompt, when a save is refused because this record already
   * exists. Three answers, the same three everywhere — see
   * `useDuplicateResolve`. `null` for the event: a re-submit is not one.
   */
  const duplicate = useDuplicateResolve((answer) => handleCreateOrUpdate(null, answer));

  /**
   * @param {{force?: boolean, keepBoth?: boolean}} answer
   *   The user's answer to that prompt, when this save IS the answer. `force`
   *   overwrites the record this duplicates; `keepBoth` files a SEPARATE record
   *   beside it, under a numbered title the server resolves. Passed rather than
   *   read from state, because the prompt calls straight back into here.
   */
  const handleCreateOrUpdate = async (e, answer = {}) => {
    if (e) e.preventDefault();
    const forceSave = Boolean(answer.force);
    const keepBoth = Boolean(answer.keepBoth);
    if (!title || !employerName || !employeeName || !documentType) {
      toast.error('Title, Employer, Employee, and Document Type are required');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        holderId: holderPayload(holderId),
        title, employerName, employeeName, documentType,
        designation, issueDate, customFields,
        forceSave, keepBoth
      };
      
      let url = '/api/employment-payroll';
      let method = 'POST';
      
      if (editingRec) {
        method = 'PUT';
        payload.id = editingRec.id;
      }

      // Multipart only when an attachment is present; the route accepts both.
      /**
       * Two transports, because there are two bodies.
       *
       * The multipart branch can be refused by nginx with a 413 HTML page, and
       * `res.json()` threw a SyntaxError on it — landing in the catch below as
       * "Error saving this record", for a file that was simply too large. The
       * JSON branch cannot hit that wall but shares every other one: an expired
       * session, a full Drive, a locked vault.
       */
      const outcome = file
        ? await postUpload(url, toFormData(payload, file), { method })
        : await apiRequest(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

      // No parsed body means no `error`, no `fieldErrors` and no duplicate
      // payload — every branch below reads one of those.
      if (!outcome.ok && (outcome.kind !== 'http' || !outcome.json)) {
        toast.error(apiErrorMessage(outcome, {
          subject: 'record', action: 'saving this record',
        }));
        return;
      }
      const res = { ok: outcome.ok, status: outcome.status };
      const json = outcome.json;

      if (res.status === 409) {
        // Was a browser `window.confirm` — OK or Cancel, so the user could only
        // ever overwrite the record or abandon their entry. The prompt renders
        // both records and offers the third answer the server has always
        // supported: keep both, filed separately.
        if (duplicate.intercept(res, json)) return;
        toast.error(json.error || 'This record already exists');
        return;
      }

      if (json.success) {
        toast.success(`Employment record ${editingRec ? 'updated' : 'added'}`);
        setShowAddModal(false);
        resetForm();
        fetchRecords();
      } else {
        toast.error(json.error || 'Failed to save record');
      }
    } catch (err) {
      console.error('[employment-payroll] save handler threw', err);
      toast.error('Something went wrong saving this employment record. Please try again.');
    } finally {
      setSaving(false);
    }
  };
  
  const resetForm = () => {
    setEditingRec(null);
    setTitle('');
    setHolderId(ALL_MEMBERS);
    setEmployerName('');
    setEmployeeName('');
    setDocumentType('OFFER_LETTER');
    setDesignation('');
    setIssueDate('');
    setCustomFields([]);
    setFile(null);
  }

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this employment record?')) return;
    try {
      const { json } = await apiCall(`/api/employment-payroll?id=${id}`, { method: 'DELETE' });
      if (json.success) {
        toast.success('Record deleted');
        fetchRecords();
      } else {
        toast.error(json.error || 'Failed to delete');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[employment-payroll] handler threw', err);
      toast.error('Something went wrong deleting record. Please try again.');
    }
  };

  const handleShare = async (rec) => {
    const fields = [
      { label: 'Title', value: rec.title },
      { label: 'Employer', value: rec.employerName },
      { label: 'Employee', value: rec.employeeName },
      { label: 'Document Type', value: rec.documentType },
      { label: 'Designation', value: rec.designation },
      { label: 'Issue Date', value: formatDate(rec.issueDate) }
    ];
    const res = await shareRecord(`Employment: ${rec.title}`, fields, null, rec.filePath,
      { fileName: rec.fileName, mimeType: rec.mimeType, pageCount: rec.pageCount });
    reportShareResult(res);
  };

  const handlePrint = (rec) => {
    const fields = [
      { label: 'Title', value: rec.title },
      { label: 'Employer', value: rec.employerName },
      { label: 'Employee', value: rec.employeeName },
      { label: 'Document Type', value: rec.documentType },
      { label: 'Designation', value: rec.designation },
      { label: 'Issue Date', value: formatDate(rec.issueDate) }
    ];
    printRecord(`Employment: ${rec.title}`, fields, null, rec.filePath);
  };

  const filteredRecords = records.filter(r => {
    const matchesSearch = r.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      r.employerName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      r.employeeName.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFilter = typeFilter === 'all' || r.documentType === typeFilter;
    return matchesSearch && matchesFilter;
  });

  return (
    <PageContainer className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Employment & Payroll Vault</h1>
          <p className="text-sm text-muted-foreground">Manage offer letters, payslips, experience letters & employment contracts</p>
        </div>
        <Button onClick={() => { resetForm(); setShowAddModal(true); }} className="flex items-center gap-2">
          <Plus size={16} /> Add Employment Record
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 text-muted-foreground" size={16} />
          <Input
            placeholder="Search by title, employer, or employee..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-full sm:w-48">
            <SelectValue placeholder="Filter Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Documents</SelectItem>
            <SelectItem value="OFFER_LETTER">Offer Letter</SelectItem>
            <SelectItem value="PAYSLIP">Payslip</SelectItem>
            <SelectItem value="EXPERIENCE_LETTER">Experience Letter</SelectItem>
            <SelectItem value="RELIEVING_LETTER">Relieving Letter</SelectItem>
            <SelectItem value="CONTRACT">Employment Contract</SelectItem>
            <SelectItem value="OTHER">Other</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="text-center py-12 text-muted-foreground">Loading employment records...</div>
      ) : filteredRecords.length === 0 ? (
        <Card className="p-12 text-center border-border/30 bg-card backdrop-blur">
          <FileText size={48} className="mx-auto text-faint mb-3" />
          <p className="text-muted-foreground text-sm font-medium">No employment records found</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {filteredRecords.map(r => (
            <Card key={r.id} className="p-5 border-border/50 bg-card backdrop-blur shadow-glass flex flex-col gap-4">
              <div className="flex justify-between items-start">
                <div>
                  <span className="text-xs font-bold px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
                    {r.documentType.replace('_', ' ')}
                  </span>
                  <h3 className="font-bold text-foreground mt-2">{r.title}</h3>
                  <p className="text-xs text-muted-foreground">Employer: {r.employerName}</p>
                </div>
                
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleShare(r)}
                    className="h-8 w-8 text-blue-400 hover:bg-blue-500/10 hover:text-blue-300 rounded-lg"
                    title="Share"
                  >
                    <Share2 size={14} />
                  </Button>
                  {/* The card below already prints every field of the record,
                      so View means one thing: open the attached scan. Absent
                      when there is none — which is why this no longer has to
                      answer a click with 'no document attached'. */}
                  {r.filePath && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setPreviewDoc({
                        name: r.title,
                        filePath: r.filePath,
                        mimeType: r.mimeType,
                        pageCount: r.pageCount
                      })}
                      className="h-8 w-8 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300 rounded-lg"
                      title="View"
                    >
                      <Eye size={14} />
                    </Button>
                  )}
                  
                  <RowActionsMenu
                    variant="ghost"
                    iconSize={14}
                    triggerClassName="h-8 w-8 rounded-lg text-muted-foreground hover:bg-muted/10"
                    items={[
                      {
                        key: 'print',
                        icon: <Printer size={12} />,
                        label: 'Print',
                        onClick: () => handlePrint(r),
                      },
                      {
                        key: 'download',
                        icon: <Download size={12} />,
                        label: 'Download',
                        onClick: () => {
                          const fields = [
                            { label: 'Title', value: r.title },
                            { label: 'Employer', value: r.employerName },
                            { label: 'Employee', value: r.employeeName },
                            { label: 'Document Type', value: r.documentType },
                            { label: 'Designation', value: r.designation },
                            { label: 'Issue Date', value: formatDate(r.issueDate) }
                          ];
                          downloadRecord(`Employment - ${r.title}`, fields, '', r.filePath);
                        },
                      },
                      {
                        key: 'edit',
                        icon: <Pencil size={12} />,
                        label: 'Edit',
                        onClick: () => openEditModal(r),
                      },
                      {
                        key: 'delete',
                        icon: <Trash2 size={12} />,
                        label: 'Delete',
                        destructive: true,
                        onClick: () => handleDelete(r.id),
                      },
                    ]}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs bg-muted/20 border border-border/30 rounded-xl p-3 mt-auto">
                <div>
                  <span className="text-muted-foreground block">Employee</span>
                  <span className="font-medium">{r.employeeName}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">Designation</span>
                  <span className="font-medium">{r.designation || 'N/A'}</span>
                </div>
                <div className="col-span-2">
                  <span className="text-muted-foreground block">Issue Date</span>
                  <span>{formatDate(r.issueDate)}</span>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={showAddModal} onOpenChange={setShowAddModal}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{editingRec ? 'Edit Employment Record' : 'Add Employment Record'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateOrUpdate} className="space-y-4">
            <div className="bg-muted/30 p-3 rounded-lg border border-border/50">
              <Label className="text-sm font-semibold">Attach Document</Label>
              <div className="flex flex-col sm:flex-row gap-3 mt-2">
                <div className="flex-1 relative">
                  <Input
                    type="file"
                    accept={UPLOAD_ACCEPT_ATTRIBUTE}
                    onChange={async (e) => { const chosen = await acceptedFileFrom(e); if (chosen) setFile(chosen); }}
                    className="hidden"
                    id="file-upload"
                  />
                  <Label
                    htmlFor="file-upload"
                    className="flex items-center justify-center w-full h-10 px-4 border-2 border-dashed border-border/50 rounded-lg cursor-pointer bg-muted/10 hover:bg-muted/30 transition-colors"
                  >
                    <span className="text-sm font-medium text-muted-foreground truncate">
                      {file
                        ? file.name
                        : editingRec?.filePath
                          ? 'Replace attached document (optional)'
                          : 'Select a document to attach (optional)'}
                    </span>
                  </Label>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleAiScan}
                  disabled={aiScanning || !file}
                  className="h-10 w-full sm:w-auto px-4 bg-sky-500/10 border-sky-500/30 text-sky-400 hover:bg-sky-500/20 hover:text-sky-300 font-bold flex gap-2 shrink-0 shadow-sm"
                >
                  <Sparkles size={15} className={aiScanning ? 'animate-spin' : ''} />
                  <span>{aiScanning ? 'Scanning...' : 'Auto-fill with AI'}</span>
                </Button>
              </div>
              {aiMessage && (
                <div className="flex items-center gap-1.5 mt-2 text-xs text-sky-400 font-medium">
                  <Info size={13} />
                  <span>{aiMessage}</span>
                </div>
              )}
            </div>

            <div>
              <Label>Title / Description</Label>
              <Input required value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. June 2024 Payslip" />
            </div>


            <HolderSelect value={holderId} onChange={setHolderId} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label>Employer Name</Label>
                <Input required value={employerName} onChange={e => setEmployerName(e.target.value)} />
              </div>
              <div>
                <Label>Employee Name</Label>
                <Input required value={employeeName} onChange={e => setEmployeeName(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label>Document Type</Label>
                <Select value={documentType} onValueChange={setDocumentType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="OFFER_LETTER">Offer Letter</SelectItem>
                    <SelectItem value="PAYSLIP">Payslip</SelectItem>
                    <SelectItem value="EXPERIENCE_LETTER">Experience Letter</SelectItem>
                    <SelectItem value="RELIEVING_LETTER">Relieving Letter</SelectItem>
                    <SelectItem value="CONTRACT">Employment Contract</SelectItem>
                    <SelectItem value="OTHER">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Designation / Role</Label>
                <Input value={designation} onChange={e => setDesignation(e.target.value)} />
              </div>
            </div>
            <div>
              <Label>Issue Date</Label>
              <Input type="date" value={issueDate} onChange={e => setIssueDate(e.target.value)} />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={() => setShowAddModal(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? 'Saving...' : (editingRec ? 'Update Record' : 'Save Record')}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <DocumentPreviewDialog doc={previewDoc} onClose={() => setPreviewDoc(null)} />

      {/* ── This record already exists ─────────────────────────────────────
          Both records rendered side by side, and the answer decides: keep the
          one on file, overwrite it, or keep both. */}
      <DuplicateResolveDialog
        {...duplicate.dialogProps}
        newFile={file}
        newTitle={title}
        busy={saving}
      />
    </PageContainer>
  );
}
