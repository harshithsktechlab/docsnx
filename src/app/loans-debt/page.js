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


export default function LoansDebtPage() {
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
  const [lenderName, setLenderName] = useState('');
  const [loanType, setLoanType] = useState('HOME_LOAN');
  const [loanAccountNumber, setLoanAccountNumber] = useState('');
  const [principalAmount, setPrincipalAmount] = useState('');
  const [emiAmount, setEmiAmount] = useState('');
  const [interestRate, setInterestRate] = useState('');
  const [startDate, setStartDate] = useState('');
  const [maturityDate, setMaturityDate] = useState('');
  const [status, setStatus] = useState('ACTIVE');
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
      const { json } = await apiCall('/api/loans-debt');
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
      console.error('[loans-debt] handler threw', err);
      setError('Something went wrong loading loan records. Please try again.');
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
            const perm = u.permissions?.find(p => p.module === 'bank_investments' && !p.documentKey);
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
    setLenderName(rec.lenderName || '');
    setLoanType(rec.loanType || 'HOME_LOAN');
    setLoanAccountNumber(rec.loanAccountNumber || '');
    setPrincipalAmount(rec.principalAmount || '');
    setEmiAmount(rec.emiAmount || '');
    setInterestRate(rec.interestRate || '');
    setStartDate(rec.startDate ? new Date(rec.startDate).toISOString().split('T')[0] : '');
    setMaturityDate(rec.maturityDate ? new Date(rec.maturityDate).toISOString().split('T')[0] : '');
    setStatus(rec.status || 'ACTIVE');
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
        if (data.loanType) setLoanType(data.loanType);
        if (data.lenderName) setLenderName(data.lenderName);
        if (data.accountNumber) setLoanAccountNumber(data.accountNumber);
        if (data.principalAmount) setPrincipalAmount(data.principalAmount);
        if (data.emiAmount) setEmiAmount(data.emiAmount);
        if (data.interestRate) setInterestRate(data.interestRate);
        if (data.startDate) setStartDate(new Date(data.startDate).toISOString().split('T')[0]);
        if (data.maturityDate) setMaturityDate(new Date(data.maturityDate).toISOString().split('T')[0]);

        toast.success('Auto-filled fields from document!');
      } else {
        toast.error(json.error || 'Failed to scan document');
      }
    } catch (err) {
      console.error(err);
      console.error('[loans-debt] AI scan handler threw', err);
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
    if (!title || !lenderName || !loanType || !loanAccountNumber) {
      toast.error('Title, Lender Name, Loan Type, and Account Number are required');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        holderId: holderPayload(holderId),
        title, lenderName, loanType, loanAccountNumber,
        principalAmount, emiAmount, interestRate, startDate, maturityDate,
        customFields, forceSave, keepBoth
      };
      
      let url = '/api/loans-debt';
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
        toast.success(`Loan record ${editingRec ? 'updated' : 'added'}`);
        setShowAddModal(false);
        resetForm();
        fetchRecords();
      } else {
        toast.error(json.error || 'Failed to save record');
      }
    } catch (err) {
      console.error('[loans-debt] save handler threw', err);
      toast.error('Something went wrong saving this loan record. Please try again.');
    } finally {
      setSaving(false);
    }
  };
  
  const resetForm = () => {
    setEditingRec(null);
    setTitle('');
    setHolderId(ALL_MEMBERS);
    setLenderName('');
    setLoanType('HOME_LOAN');
    setLoanAccountNumber('');
    setPrincipalAmount('');
    setEmiAmount('');
    setInterestRate('');
    setStartDate('');
    setMaturityDate('');
    setStatus('ACTIVE');
    setCustomFields([]);
    setFile(null);
  }

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this loan record?')) return;
    try {
      const { json } = await apiCall(`/api/loans-debt?id=${id}`, { method: 'DELETE' });
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
      console.error('[loans-debt] handler threw', err);
      toast.error('Something went wrong deleting record. Please try again.');
    }
  };

  const handleShare = async (rec) => {
    const fields = [
      { label: 'Title', value: rec.title },
      { label: 'Lender', value: rec.lenderName },
      { label: 'Loan Type', value: rec.loanType },
      { label: 'Account No', value: rec.loanAccountNumber },
      { label: 'Principal', value: rec.principalAmount ? `INR ${rec.principalAmount}` : 'N/A' },
      { label: 'EMI', value: rec.emiAmount ? `INR ${rec.emiAmount}` : 'N/A' },
      { label: 'Interest Rate', value: rec.interestRate ? `${rec.interestRate}%` : 'N/A' },
      { label: 'Status', value: rec.status }
    ];
    const res = await shareRecord(`Loan & Debt: ${rec.title}`, fields, null, rec.filePath,
      { fileName: rec.fileName, mimeType: rec.mimeType, pageCount: rec.pageCount });
    reportShareResult(res);
  };

  const handlePrint = (rec) => {
    const fields = [
      { label: 'Title', value: rec.title },
      { label: 'Lender', value: rec.lenderName },
      { label: 'Loan Type', value: rec.loanType },
      { label: 'Account No', value: rec.loanAccountNumber },
      { label: 'Principal', value: rec.principalAmount ? `INR ${rec.principalAmount}` : 'N/A' },
      { label: 'EMI', value: rec.emiAmount ? `INR ${rec.emiAmount}` : 'N/A' },
      { label: 'Interest Rate', value: rec.interestRate ? `${rec.interestRate}%` : 'N/A' },
      { label: 'Status', value: rec.status }
    ];
    printRecord(`Loan & Debt: ${rec.title}`, fields, null, rec.filePath);
  };

  const filteredRecords = records.filter(r => {
    const matchesSearch = r.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      r.lenderName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      r.loanAccountNumber.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFilter = typeFilter === 'all' || r.loanType === typeFilter;
    return matchesSearch && matchesFilter;
  });

  return (
    <PageContainer className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Loans & Liabilities Vault</h1>
          <p className="text-sm text-muted-foreground">Manage mortgages, personal loans, vehicle loans, and other debts</p>
        </div>
        <Button onClick={() => { resetForm(); setShowAddModal(true); }} className="flex items-center gap-2">
          <Plus size={16} /> Add Loan Record
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 text-muted-foreground" size={16} />
          <Input
            placeholder="Search by title, lender, or account no..."
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
            <SelectItem value="all">All Loans</SelectItem>
            <SelectItem value="HOME_LOAN">Home Loan</SelectItem>
            <SelectItem value="PERSONAL_LOAN">Personal Loan</SelectItem>
            <SelectItem value="VEHICLE_LOAN">Vehicle Loan</SelectItem>
            <SelectItem value="EDUCATION_LOAN">Education Loan</SelectItem>
            <SelectItem value="CREDIT_CARD_EMI">Credit Card EMI</SelectItem>
            <SelectItem value="BUSINESS_LOAN">Business Loan</SelectItem>
            <SelectItem value="OTHER">Other Debt</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="text-center py-12 text-muted-foreground">Loading loan records...</div>
      ) : filteredRecords.length === 0 ? (
        <Card className="p-12 text-center border-border/30 bg-card backdrop-blur">
          <FileText size={48} className="mx-auto text-faint mb-3" />
          <p className="text-muted-foreground text-sm font-medium">No loans or debt records found</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {filteredRecords.map(r => (
            <Card key={r.id} className="p-5 border-border/50 bg-card backdrop-blur shadow-glass flex flex-col gap-4">
              <div className="flex justify-between items-start">
                <div>
                  <span className="text-xs font-bold px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
                    {r.loanType.replace('_', ' ')}
                  </span>
                  <h3 className="font-bold text-foreground mt-2">{r.title}</h3>
                  <p className="text-xs text-muted-foreground">Lender: {r.lenderName}</p>
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
                            { label: 'Lender', value: r.lenderName },
                            { label: 'Loan Type', value: r.loanType },
                            { label: 'Account No', value: r.loanAccountNumber },
                            { label: 'Principal', value: r.principalAmount ? `INR ${r.principalAmount}` : 'N/A' },
                            { label: 'EMI', value: r.emiAmount ? `INR ${r.emiAmount}` : 'N/A' },
                            { label: 'Interest Rate', value: r.interestRate ? `${r.interestRate}%` : 'N/A' },
                            { label: 'Status', value: r.status }
                          ];
                          downloadRecord(`Loan - ${r.title}`, fields, '', r.filePath);
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
                <div className="col-span-2">
                  <span className="text-muted-foreground block">Account No</span>
                  <span className="font-medium font-mono">{r.loanAccountNumber}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">Principal</span>
                  <span className="font-semibold text-rose-400">INR {r.principalAmount ? Number(r.principalAmount).toLocaleString() : '0'}</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">EMI</span>
                  <span className="font-medium">INR {r.emiAmount ? Number(r.emiAmount).toLocaleString() : '0'}</span>
                </div>
                <div className="col-span-2 flex items-center justify-between mt-2 pt-2 border-t border-border/50">
                  <div>
                    <span className="text-muted-foreground text-xs block">Start: {formatDate(r.startDate)}</span>
                    <span className="text-muted-foreground text-xs block">End: {formatDate(r.maturityDate)}</span>
                  </div>
                  <span className={`px-2 py-1 rounded text-xs font-medium ${r.status === 'ACTIVE' ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                    {r.status}
                  </span>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={showAddModal} onOpenChange={setShowAddModal}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{editingRec ? 'Edit Loan Record' : 'Add Loan Record'}</DialogTitle>
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
                <div className="flex items-center gap-1.5 mt-2 text-xs text-info-text font-medium">
                  <Info size={13} />
                  <span>{aiMessage}</span>
                </div>
              )}
            </div>

            <div>
              <Label>Title / Description</Label>
              <Input required value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. SBI Home Loan" />
            </div>


            <HolderSelect value={holderId} onChange={setHolderId} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label>Lender / Bank Name</Label>
                <Input required value={lenderName} onChange={e => setLenderName(e.target.value)} />
              </div>
              <div>
                <Label>Loan Type</Label>
                <Select value={loanType} onValueChange={setLoanType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="HOME_LOAN">Home Loan</SelectItem>
                    <SelectItem value="PERSONAL_LOAN">Personal Loan</SelectItem>
                    <SelectItem value="VEHICLE_LOAN">Vehicle Loan</SelectItem>
                    <SelectItem value="EDUCATION_LOAN">Education Loan</SelectItem>
                    <SelectItem value="CREDIT_CARD_EMI">Credit Card EMI</SelectItem>
                    <SelectItem value="BUSINESS_LOAN">Business Loan</SelectItem>
                    <SelectItem value="OTHER">Other Debt</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Loan Account Number</Label>
              <Input required value={loanAccountNumber} onChange={e => setLoanAccountNumber(e.target.value)} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <Label>Principal</Label>
                <Input type="number" value={principalAmount} onChange={e => setPrincipalAmount(e.target.value)} />
              </div>
              <div>
                <Label>EMI Amount</Label>
                <Input type="number" value={emiAmount} onChange={e => setEmiAmount(e.target.value)} />
              </div>
              <div>
                <Label>Interest (%)</Label>
                <Input type="number" step="0.01" value={interestRate} onChange={e => setInterestRate(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label>Start Date</Label>
                <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
              </div>
              <div>
                <Label>End Date (Optional)</Label>
                <Input type="date" value={maturityDate} onChange={e => setMaturityDate(e.target.value)} />
              </div>
            </div>
            <div>
              <Label>Status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="CLOSED">Closed/Paid Off</SelectItem>
                  <SelectItem value="DEFAULTED">Defaulted</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={() => setShowAddModal(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? 'Saving...' : (editingRec ? 'Update Loan' : 'Save Loan')}</Button>
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
