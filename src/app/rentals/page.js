'use client';

import {
  formatDate } from '@/lib/dateHelper';
import React,
  { useEffect,
  useState } from 'react';
import { 
  FileSignature,
  Plus,
  X,
  Upload,
  Search,
  Download,
  Trash2,
  Calendar,
  AlertCircle,
  User,
  Share2,
  Printer,
  Eye,
  Pencil,
  Sparkles,
  Building,
  CreditCard,
  Info,
  FileDown
} from 'lucide-react';
import { shareRecord, printRecord, downloadRecord } from '@/lib/sharePrintHelper';
import { reportShareResult } from '@/lib/shareToast';
import DocumentPreviewDialog from '@/components/DocumentPreviewDialog';
import { clientGetMe } from '@/lib/clientAuth';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import RowActionsMenu from '@/components/ui/row-actions-menu';
import { toast } from 'sonner';
import { acceptedFileFrom } from '@/app/components/acceptFile';
import { postUpload, uploadErrorMessage } from '@/lib/records/uploadRequest';
import { UPLOAD_ACCEPT_ATTRIBUTE } from '@/lib/records/uploadTypes';
import HolderSelect, { ALL_MEMBERS, holderValue, holderPayload } from '@/app/components/HolderSelect';
import PageContainer from '@/app/components/PageContainer';
import DuplicateResolveDialog from '@/components/records/DuplicateResolveDialog';
import useDuplicateResolve from '@/components/records/useDuplicateResolve';
import { apiCall } from '@/lib/net/apiRequest';
import { toastApiError } from '@/lib/net/toastApiError';


export default function RentalsPage() {
  const [records, setRecords] = useState([]);
  const [canAdd, setCanAdd] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [canDelete, setCanDelete] = useState(false);
  const [users, setUsers] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [canShare, setCanShare] = useState(false);
  const [previewDoc, setPreviewDoc] = useState(null);

  // Search & Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState('all'); // 'all', 'RENTAL', 'MAINTENANCE', 'UTILITY', 'SUBSCRIPTION'

  // Add Form State
  const [showAddForm, setShowAddForm] = useState(false);
  const [type, setType] = useState('RENTAL');
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [amount, setAmount] = useState('');
  const [billingCycle, setBillingCycle] = useState('monthly');
  const [notes, setNotes] = useState('');
  const [holderId, setHolderId] = useState(ALL_MEMBERS);
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState('');

  // AI scanning states
  const [aiScanning, setAiScanning] = useState(false);
  const [aiMessage, setAiMessage] = useState('');

  // Edit Form State
  const [editingRec, setEditingRec] = useState(null);
  const [editType, setEditType] = useState('RENTAL');
  const [editName, setEditName] = useState('');
  const [editProvider, setEditProvider] = useState('');
  const [editAccountNumber, setEditAccountNumber] = useState('');
  const [editStartDate, setEditStartDate] = useState('');
  const [editEndDate, setEditEndDate] = useState('');
  const [editAmount, setEditAmount] = useState('');
  const [editBillingCycle, setEditBillingCycle] = useState('monthly');
  const [editNotes, setEditNotes] = useState('');
  const [editHolderId, setEditHolderId] = useState(ALL_MEMBERS);
  const [editFile, setEditFile] = useState(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const fetchRecords = async () => {
    try {
      const { json } = await apiCall('/api/rentals');
      if (json.success) {
        setRecords(json.contractAgreements || []);
      } else {
        setError(json.error || 'Failed to fetch rentals & subscriptions');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[rentals] handler threw', err);
      setError('Something went wrong fetching rentals & subscriptions. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const fetchUsers = async () => {
    try {
      const { res, json } = await apiCall('/api/users');
      if (res.ok) {
        if (json.success) {
          setUsers(json.users || []);
        }
      }
    } catch (err) {
      console.warn('Failed to load users list:', err);
    }
  };

  useEffect(() => {
    async function initPage() {
      setLoading(true);
      await fetchRecords();

      try {
        const meData = await clientGetMe();
        if (meData.success) {
          const u = meData.user;
          setCurrentUser(u);
          if (u.role === 'SUPER_ADMIN' || u.role === 'TENANT_ADMIN') {
            setCanShare(true);
            await fetchUsers();
          } else {
            // 'contracts' is not a permission key — the module is 'rentals' — so
            // this always found nothing and canShare was permanently false.
            // The page's PRIMARY taxonomy module, and its MODULE DEFAULT row —
            // `!p.documentKey` skips the sub-category overrides 0024 added, which
            // answer for one category rather than for the button.
            const perm = u.permissions?.find(p => p.module === 'rentals_subscriptions' && !p.documentKey);
            setCanShare(!!perm?.canShare);
            setUsers([u]);
          }
        }
      } catch (err) {
        console.error('Error loading permissions:', err);
      }
    }
    initPage();
  }, []);

  const handleFileChange = async (e) => {
    const chosen = await acceptedFileFrom(e);
    if (chosen) setFile(chosen);
  };

  const handleEditFileChange = async (e) => {
    const chosen = await acceptedFileFrom(e);
    if (chosen) setEditFile(chosen);
  };

  const formatDateToInput = (dateStr) => {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return '';
      return d.toISOString().substring(0, 10);
    } catch (e) {
      return '';
    }
  };

  // Perform AI scan and auto-fill form fields
  const handleAiScan = async () => {
    const selectedFile = editingRec ? editFile : file;
    if (!selectedFile) {
      toast.error('Please select or upload a document file first to use AI Auto-fill.');
      return;
    }

    setAiScanning(true);
    setAiMessage('Uploading & scanning document page contents with AI...');

    try {
      const formData = new FormData();
      formData.append('files', selectedFile);

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
        const data = proposed.extractedData;
        const title = proposed.title || '';

        // Safely extract proposed values
        const docName = title || data.name || '';
        const prov = data.provider || data.company || data.companyName || '';
        const stDate = formatDateToInput(data.startDate || data.purchaseDate);
        const edDate = formatDateToInput(data.endDate || data.expiryDate);
        const note = data.notes || data.details || '';
        const accNum = data.accountNumber || '';
        const amt = data.amount || '';
        const cycle = data.billingCycle || 'monthly';

        if (editingRec) {
          if (docName) setEditName(docName);
          if (prov) setEditProvider(prov);
          if (stDate) setEditStartDate(stDate);
          if (edDate) setEditEndDate(edDate);
          if (note) setEditNotes(note);
          if (accNum) setEditAccountNumber(accNum);
          if (amt) setEditAmount(amt);
          if (cycle) setEditBillingCycle(cycle);
        } else {
          if (docName) setName(docName);
          if (prov) setProvider(prov);
          if (stDate) setStartDate(stDate);
          if (edDate) setEndDate(edDate);
          if (note) setNotes(note);
          if (accNum) setAccountNumber(accNum);
          if (amt) setAmount(amt);
          if (cycle) setBillingCycle(cycle);
        }

        setAiMessage('AI Auto-fill successful! Form fields updated.');
        setTimeout(() => setAiMessage(''), 3000);
      } else {
        // Reached only when the scan genuinely came back with nothing to fill
        // in — every other cause returned above with its own sentence.
        toast.error(json.error
          || 'The scan did not find these fields on this document — fill them in below.');
        setAiMessage('');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[rentals] handler threw', err);
      toast.error('Something went wrong calling AI Scan endpoint. Please try again.');
      setAiMessage('');
    } finally {
      setAiScanning(false);
    }
  };

  /**
   * The duplicate prompt, when a save is refused because this record already
   * exists. This module used to drop that refusal into an error banner, which
   * left the user no answer at all — see `useDuplicateResolve`.
   */
  const duplicate = useDuplicateResolve();

  /**
   * @param {{force?: boolean, keepBoth?: boolean}} answer
   *   The user's answer to that prompt, when this save IS the answer. `force`
   *   overwrites the record this duplicates; `keepBoth` files a SEPARATE record
   *   beside it, under a numbered title the server resolves. Passed rather than
   *   read from state, because the prompt calls straight back into here.
   */
  // ─── Closing the Add form ─────────────────────────────────────────────────
  // Every way out goes through these two, so "closed" has ONE definition and it
  // always clears. Before, the fields were reset only inside the success branch
  // of handleSubmit, so dismissing a half-typed entry left it sitting in state
  // to reappear whole the next time the form was opened.
  const resetAddForm = () => {
    setName('');
    setProvider('');
    setAccountNumber('');
    setStartDate('');
    setEndDate('');
    setAmount('');
    setBillingCycle('monthly');
    setNotes('');
    setHolderId(ALL_MEMBERS);
    setFile(null);
    setFormError('');
  };

  const closeAddForm = () => {
    resetAddForm();
    setShowAddForm(false);
  };

  const handleSubmit = async (e, answer = {}) => {
    if (e) e.preventDefault();
    if (!type || !name.trim() || !provider.trim() || !endDate) {
      setFormError('Type, Contract Name, Provider, and End/Renewal Date are required');
      return;
    }
    setFormError('');
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append('type', type);
      // `title` is the wire name the route reads (`get('title')`); the state is
      // still called `name` because that is what `toLegacyShape` reads BACK as.
      formData.append('title', name.trim());
      formData.append('provider', provider.trim());
      formData.append('accountNumber', accountNumber.trim());
      formData.append('startDate', startDate || '');
      formData.append('endDate', endDate);
      formData.append('amount', amount);
      formData.append('billingCycle', billingCycle);
      formData.append('notes', notes.trim());
      formData.append('holderId', holderPayload(holderId));
      if (file) {
        formData.append('file', file);
      }

      // The answer to the duplicate prompt, when this submit is one.
      if (answer.force) formData.append('forceSave', 'true');
      if (answer.keepBoth) formData.append('keepBoth', 'true');

      /**
       * `postUpload`, not `fetch`: `res.json()` here had no catch, so nginx's
       * 413 HTML page for an oversized upload threw a SyntaxError that landed
       * in the `catch` below and was reported as a network error. The helper
       * parses defensively and says which of the four things actually happened.
       */
      const outcome = await postUpload('/api/rentals', formData);
      if (!outcome.ok && (outcome.kind !== 'http' || !outcome.json)) {
        setFormError(uploadErrorMessage(outcome, 'record'));
        return;
      }
      const res = { status: outcome.status };
      const json = outcome.json;
      // Already on file. Not a failure — a question, and the prompt is where it
      // gets asked: keep the record on file, overwrite it, or keep both.
      if (duplicate.intercept(res, json, {
        newFile: file,
        newTitle: name,
        resubmit: (next) => handleSubmit(null, next),
      })) return;
      if (json.success) {
        closeAddForm();
        fetchRecords();
      } else {
        setFormError(json.error || 'Failed to create record');
      }
    } catch (err) {
      // `postUpload` does not throw, so anything here is a bug in this
      // handler rather than a transport failure — and it used to be silent.
      console.error('[rentals] upload handler threw', err);
      setFormError('Something went wrong saving this record. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  const openEditModal = (rec) => {
    setEditingRec(rec);
    setEditType(rec.type || 'RENTAL');
    setEditName(rec.name || '');
    setEditProvider(rec.provider || '');
    setEditAccountNumber(rec.accountNumber || '');
    setEditStartDate(rec.startDate ? rec.startDate.substring(0, 10) : '');
    setEditEndDate(rec.endDate ? rec.endDate.substring(0, 10) : '');
    setEditAmount(rec.amount ? rec.amount.toString() : '');
    setEditBillingCycle(rec.billingCycle || 'monthly');
    setEditNotes(rec.notes || '');
    setEditHolderId(holderValue(rec.holderId));
    setEditFile(null);
    setEditError('');
  };

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    if (!editingRec) return;
    if (!editType || !editName.trim() || !editProvider.trim() || !editEndDate) {
      setEditError('Type, Contract Name, Provider, and End/Renewal Date are required');
      return;
    }
    setEditSaving(true);
    setEditError('');

    try {
      const formData = new FormData();
      formData.append('type', editType);
      formData.append('title', editName.trim());
      formData.append('provider', editProvider.trim());
      formData.append('accountNumber', editAccountNumber.trim());
      formData.append('startDate', editStartDate || '');
      formData.append('endDate', editEndDate);
      formData.append('amount', editAmount);
      formData.append('billingCycle', editBillingCycle);
      formData.append('notes', editNotes.trim());
      formData.append('holderId', holderPayload(editHolderId));
      if (editFile) {
        formData.append('file', editFile);
      }

      // `postUpload`, not `apiCall`: this is a multipart write. It carries the
      // 330s ceiling an upload needs — a phone photo on mobile data outruns the
      // 45s a JSON request gets — and the uploading/waiting boundary that
      // separates "nothing was sent, retry" from "this may already have saved".
      const upload = await postUpload(`/api/rentals/${editingRec.id}`, formData, { method: 'PUT' });
      if (!upload.ok && (upload.kind !== 'http' || !upload.json)) {
        setEditError(uploadErrorMessage(upload, 'rental record'));
        return;
      }
      const res = { ok: upload.ok, status: upload.status };
      const json = upload.json;
      // An EDIT names the record it is writing onto, so the server withdraws
      // both overwrite and keep-both: the prompt shows what this change would
      // collide with and links to it. No `resubmit` — there is nothing to send.
      if (duplicate.intercept(res, json, {
        newFile: editFile,
        newTitle: editName,
      })) return;
      if (json.success) {
        setEditingRec(null);
        fetchRecords();
      } else {
        setEditError(json.error || 'Failed to update record');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[rentals] handler threw', err);
      setEditError('Something went wrong updating record. Please try again.');
    } finally {
      setEditSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this contract/rental record?')) return;
    try {
      const { json } = await apiCall(`/api/rentals/${id}`, { method: 'DELETE' });
      if (json.success) {
        fetchRecords();
      } else {
        toast.error(json.error || 'Failed to delete');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[rentals] handler threw', err);
      toast.error('Something went wrong deleting record. Please try again.');
    }
  };

  const handleShare = async (rec) => {
    const fields = [
      { label: 'Name', value: rec.name },
      { label: 'Type', value: rec.type },
      { label: 'Provider', value: rec.provider },
      { label: 'Account/Ref #', value: rec.accountNumber || 'N/A' },
      { label: 'Renewal/Expiry', value: formatDate(rec.endDate) },
      { label: 'Start Date', value: rec.startDate ? formatDate(rec.startDate) : 'N/A' },
      { label: 'Amount', value: rec.amount ? `${rec.amount} / ${rec.billingCycle}` : 'N/A' },
      { label: 'Holder', value: rec.holder?.name || 'All Members' }
    ];
    const res = await shareRecord(`Contract/Rental: ${rec.name}`, fields, rec.notes, rec.filePath,
      { fileName: rec.fileName, mimeType: rec.mimeType, pageCount: rec.pageCount });
    reportShareResult(res);
  };

  const handlePrint = (rec) => {
    const fields = [
      { label: 'Name', value: rec.name },
      { label: 'Type', value: rec.type },
      { label: 'Provider', value: rec.provider },
      { label: 'Account/Ref #', value: rec.accountNumber || 'N/A' },
      { label: 'Renewal/Expiry', value: formatDate(rec.endDate) },
      { label: 'Start Date', value: rec.startDate ? formatDate(rec.startDate) : 'N/A' },
      { label: 'Amount', value: rec.amount ? `${rec.amount} / ${rec.billingCycle}` : 'N/A' },
      { label: 'Holder', value: rec.holder?.name || 'All Members' }
    ];
    printRecord(`Contract/Rental details`, fields, rec.notes, rec.filePath);
  };

  const filteredRecords = records.filter(rec => {
    const matchesSearch = 
      rec.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      rec.provider.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (rec.notes && rec.notes.toLowerCase().includes(searchTerm.toLowerCase()));
    
    const matchesType = typeFilter === 'all' || rec.type === typeFilter;
    return matchesSearch && matchesType;
  });

  const isExpired = (endDateStr) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const exp = new Date(endDateStr);
    exp.setHours(0, 0, 0, 0);
    return exp < today;
  };

  if (loading) {
    return (
      <PageContainer>
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-10 w-10 rounded-full" />
        </div>
        <Skeleton className="h-12 w-full rounded-xl" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-56 w-full rounded-2xl" />
          ))}
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between gap-4 animate-fade-in">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground">Rentals & Subscriptions</h1>
          <p className="text-muted-foreground text-sm">Manage lease agreements, active utilities, subscriptions, and recurring contracts</p>
        </div>
        <Button 
          onClick={() => (showAddForm ? closeAddForm() : setShowAddForm(true))}
          variant={showAddForm ? "destructive" : "default"}
          size="icon"
          className="h-10 w-10 rounded-full shadow-lg"
        >
          {showAddForm ? <X size={20} /> : <Plus size={20} />}
        </Button>
      </div>

      {/* Error Alert */}
      

      {/* Add Form */}
      {showAddForm && (
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass p-6 md:p-8 animate-scale-in">
          <CardHeader className="p-0 pb-4 border-b border-border/50 mb-6">
            <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
              <FileSignature className="text-sky-400" size={20} />
              <span>Add Agreement / Subscription</span>
            </h2>
          </CardHeader>

          

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="name">Contract / Rental Name *</Label>
                <Input
                  id="name"
                  placeholder="e.g. Apartment Lease, Netflix, Electricity Bill"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={uploading}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="provider">Provider / Landlord *</Label>
                <Input
                  id="provider"
                  placeholder="e.g. Ramesh Kumar, Netflix Inc., MSEDCL"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  disabled={uploading}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="type">Category Type *</Label>
                <Select value={type} onValueChange={(val) => setType(val)} disabled={uploading}>
                  <SelectTrigger id="type">
                    <SelectValue placeholder="Select Category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="RENTAL">Rental Lease</SelectItem>
                    <SelectItem value="MAINTENANCE">Maintenance</SelectItem>
                    <SelectItem value="UTILITY">Utility Service</SelectItem>
                    <SelectItem value="SUBSCRIPTION">Digital Subscription</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startDate">Start Date</Label>
                <Input
                  id="startDate"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  disabled={uploading}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="endDate">End / Renewal Date *</Label>
                <Input
                  id="endDate"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  disabled={uploading}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="amount">Recurring Amount</Label>
                <Input
                  id="amount"
                  type="number"
                  step="0.01"
                  placeholder="e.g. 15000"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={uploading}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="billingCycle">Billing Cycle</Label>
                <Select value={billingCycle} onValueChange={(val) => setBillingCycle(val)} disabled={uploading}>
                  <SelectTrigger id="billingCycle">
                    <SelectValue placeholder="Select Cycle" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
                    <SelectItem value="half-yearly">Half Yearly</SelectItem>
                    <SelectItem value="yearly">Yearly</SelectItem>
                    <SelectItem value="one-time">One Time</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="accountNumber">Account / Consumer No.</Label>
                <Input
                  id="accountNumber"
                  placeholder="e.g. Consumer ID 12345"
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  disabled={uploading}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <HolderSelect value={holderId} onChange={setHolderId} disabled={uploading} />

            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="notes">Notes / Terms</Label>
              <Textarea
                id="notes"
                placeholder="e.g. Deposit amount is 50,000. Rent due on 5th of every month."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                disabled={uploading}
                className="resize-none"
              />
            </div>

            {/* Document Upload with AI Auto-fill visual button */}
            <div className="flex flex-col gap-2.5 border-t border-border/30 pt-4 mt-2">
              <Label>Attach Agreement PDF / Rent Receipt Image</Label>
              <div className="flex flex-col sm:flex-row gap-3 items-center">
                <div className="border-2 border-dashed border-border/50 rounded-xl p-4 text-center bg-card hover:bg-card transition-colors relative cursor-pointer flex-1 w-full">
                  <input
                    type="file"
                    accept={UPLOAD_ACCEPT_ATTRIBUTE}
                    onChange={handleFileChange}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    disabled={uploading || aiScanning}
                  />
                  <Upload size={18} className="mx-auto text-muted-foreground mb-1" />
                  <p className="text-xs font-semibold text-foreground truncate max-w-[280px] mx-auto">
                    {file ? file.name : 'Select contract file'}
                  </p>
                </div>

                <Button 
                  type="button" 
                  variant="outline"
                  onClick={handleAiScan}
                  disabled={aiScanning || uploading}
                  className="h-12 w-full sm:w-auto px-4 bg-sky-500/10 border-sky-500/30 text-sky-400 hover:bg-sky-500/20 hover:text-sky-300 font-bold flex gap-2 shrink-0 shadow-sm"
                >
                  <Sparkles size={15} className={aiScanning ? 'animate-spin' : ''} />
                  <span>{aiScanning ? 'Scanning...' : 'Auto-fill with AI'}</span>
                </Button>
              </div>
              {aiMessage && (
                <div className="flex items-center gap-1.5 text-xs text-sky-400 font-medium">
                  <Info size={13} />
                  <span>{aiMessage}</span>
                </div>
              )}
            </div>

            {/* Cancel sits WITH Save, at the foot of the form, because that is
                where someone who has changed their mind actually is — the toggle up
                in the page header has long since scrolled away. It discards whatever
                was typed; see closeAddForm. */}
            <div className="mt-2 flex gap-3">
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
                className="h-11 flex-1"
              >
                {uploading ? 'Uploading & saving...' : 'Save Contract Details'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* Search & Filters */}
      <div className="flex flex-col md:flex-row gap-4 animate-fade-in">
        <div className="relative flex-grow">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" size={18} />
          <Input
            placeholder="Search contracts, providers, notes..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 h-11 bg-card border-border/50"
          />
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1 md:pb-0">
          {[
            { value: 'all', label: 'All Contracts' },
            { value: 'RENTAL', label: 'Lease/Rent' },
            { value: 'MAINTENANCE', label: 'Maintenance' },
            { value: 'UTILITY', label: 'Utilities' },
            { value: 'SUBSCRIPTION', label: 'Subscriptions' }
          ].map((cat) => (
            <Button
              key={cat.value}
              variant={typeFilter === cat.value ? "default" : "outline"}
              onClick={() => setTypeFilter(cat.value)}
              className="h-11 px-4 text-xs font-semibold rounded-lg shrink-0"
            >
              {cat.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Records list */}
      {filteredRecords.length === 0 ? (
        <Card className="border-border/30 bg-card backdrop-blur p-12 text-center animate-fade-in">
          <FileSignature size={48} className="mx-auto text-faint mb-3" />
          <p className="text-muted-foreground text-sm font-medium">No rentals or subscription contracts found</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredRecords.map((rec) => {
            const expired = isExpired(rec.endDate);
            return (
              <Card 
                key={rec.id}
                className="border-border/50 bg-card backdrop-blur shadow-glass hover:bg-card transition-colors p-5 flex flex-col justify-between gap-4 animate-fade-in"
              >
                <div className="flex flex-col gap-3">
                  <div className="flex justify-between items-start gap-2">
                    <div className="flex flex-col min-w-0">
                      <span className="font-bold text-foreground text-sm truncate">{rec.name}</span>
                      {/* `min-w-0` + `truncate`: without them this nested row
                          keeps its min-content width and a long provider name
                          runs out under the action buttons opposite. */}
                      <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground mt-0.5 flex min-w-0 items-center gap-1">
                        <Building size={10} className="shrink-0" />
                        <span className="truncate">{rec.provider}</span>
                      </span>
                    </div>

                    <div className="relative flex items-center gap-1.5 shrink-0">
                      <Button 
                        onClick={() => handleShare(rec)}
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-sky-400 hover:bg-sky-500/10 hover:text-sky-300 rounded-lg"
                        title="Share"
                      >
                        <Share2 size={14} />
                      </Button>
                      {/* The card below already prints every field of the record,
                          so View means one thing: open the attached scan. Absent
                          when there is none. */}
                      {rec.filePath && (
                        <Button
                          onClick={() => setPreviewDoc({
                            name: rec.name + ' - ' + rec.type,
                            filePath: rec.filePath,
                            mimeType: rec.mimeType,
                            pageCount: rec.pageCount
                          })}
                          variant="ghost"
                          size="icon"
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
                            onClick: () => handlePrint(rec),
                          },
                          {
                            key: 'download',
                            icon: <Download size={12} />,
                            label: 'Download',
                            onClick: () => {
                              downloadRecord(`${rec.type} - ${rec.name}`, [
                                { label: 'Contract Name', value: rec.name },
                                { label: 'Type', value: rec.type },
                                { label: 'Provider', value: rec.provider },
                                { label: 'Account #', value: rec.accountNumber },
                                { label: 'Amount', value: rec.amount ? `${rec.amount} / ${rec.billingCycle}` : '' },
                                { label: 'Start Date', value: rec.startDate ? formatDate(rec.startDate) : '' },
                                { label: 'End/Renewal Date', value: formatDate(rec.endDate) }
                              ], rec.notes, rec.filePath);
                            },
                          },
                          {
                            key: 'edit',
                            icon: <Pencil size={12} />,
                            label: 'Edit',
                            onClick: () => openEditModal(rec),
                          },
                          {
                            key: 'delete',
                            icon: <Trash2 size={12} />,
                            label: 'Delete',
                            destructive: true,
                            onClick: () => handleDelete(rec.id),
                          },
                        ]}
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2.5 mt-1">
                    <Badge variant="secondary" className="text-2xs font-bold text-sky-400 bg-sky-500/10">
                      {rec.type.replace('_', ' ')}
                    </Badge>

                    {expired ? (
                      <Badge variant="destructive" className="text-2xs font-bold">Expired / Overdue</Badge>
                    ) : (
                      <Badge variant="outline" className="text-2xs font-bold text-emerald-400 border-emerald-500/20 bg-emerald-500/5">Active</Badge>
                    )}
                  </div>

                  {rec.amount && (
                    <div className="flex items-center gap-1.5 font-extrabold text-foreground text-sm py-1 bg-muted/20 border border-border/20 px-3 w-fit rounded-lg">
                      <CreditCard size={13} className="text-emerald-400" />
                      <span>{Number(rec.amount).toLocaleString('en-IN', { style: 'currency', currency: 'INR' })}</span>
                      <span className="text-xs text-muted-foreground font-normal">/ {rec.billingCycle || 'monthly'}</span>
                    </div>
                  )}

                  <div className="flex flex-col gap-1.5 text-xs text-muted-foreground border-t border-border/30 pt-3 mt-1.5">
                    <div className="flex justify-between items-center font-semibold">
                      <span>End / Renewal:</span>
                      <span className={expired ? 'text-red-400 font-bold' : 'text-foreground'}>
                        {formatDate(rec.endDate)}
                      </span>
                    </div>

                    {rec.startDate && (
                      <div className="flex justify-between items-center text-xs">
                        <span>Start Date:</span>
                        <span className="font-medium text-foreground">
                          {formatDate(rec.startDate)}
                        </span>
                      </div>
                    )}

                    {rec.accountNumber && (
                      <div className="flex justify-between items-center text-xs">
                        <span>Account/Ref #:</span>
                        <span className="font-medium text-foreground truncate max-w-[150px]">
                          {rec.accountNumber}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  {rec.holder?.name && (
                    <div className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
                      <User size={10} className="text-sky-400" />
                      <span>Holder: {rec.holder.name}</span>
                    </div>
                  )}

                  {rec.notes && (
                    <p className="text-xs text-muted-foreground leading-relaxed bg-muted/20 border border-border/20 rounded-lg p-2 italic whitespace-pre-wrap">
                      {rec.notes}
                    </p>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Preview Modal — one pane for every stored format. See
          DocumentPreviewDialog for why this is no longer written per page. */}
      <DocumentPreviewDialog doc={previewDoc} onClose={() => setPreviewDoc(null)} />

      {/* Edit Record Modal */}
      <Dialog open={!!editingRec} onOpenChange={(open) => !open && setEditingRec(null)}>
        {editingRec && (
          <DialogContent aria-describedby={undefined} className="max-w-2xl max-h-[90vh] flex flex-col py-6 overflow-y-auto border-border/50 bg-card/95 backdrop-blur-md">
            <DialogHeader className="p-0 pb-4 border-b border-border/30">
              <DialogTitle className="text-lg font-bold">Edit Contract/Rental Details</DialogTitle>
            </DialogHeader>

            

            <form onSubmit={handleEditSubmit} className="flex flex-col gap-5 mt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editName">Contract / Rental Name *</Label>
                  <Input
                    id="editName"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    disabled={editSaving}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editProvider">Provider / Landlord *</Label>
                  <Input
                    id="editProvider"
                    value={editProvider}
                    onChange={(e) => setEditProvider(e.target.value)}
                    disabled={editSaving}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editType">Category Type *</Label>
                  <Select value={editType} onValueChange={(val) => setEditType(val)} disabled={editSaving}>
                    <SelectTrigger id="editType">
                      <SelectValue placeholder="Select Category" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="RENTAL">Rental Lease</SelectItem>
                      <SelectItem value="MAINTENANCE">Maintenance</SelectItem>
                      <SelectItem value="UTILITY">Utility Service</SelectItem>
                      <SelectItem value="SUBSCRIPTION">Digital Subscription</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editStartDate">Start Date</Label>
                  <Input
                    id="editStartDate"
                    type="date"
                    value={editStartDate}
                    onChange={(e) => setEditStartDate(e.target.value)}
                    disabled={editSaving}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editEndDate">End / Renewal Date *</Label>
                  <Input
                    id="editEndDate"
                    type="date"
                    value={editEndDate}
                    onChange={(e) => setEditEndDate(e.target.value)}
                    disabled={editSaving}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editAmount">Recurring Amount</Label>
                  <Input
                    id="editAmount"
                    type="number"
                    step="0.01"
                    value={editAmount}
                    onChange={(e) => setEditAmount(e.target.value)}
                    disabled={editSaving}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editBillingCycle">Billing Cycle</Label>
                  <Select value={editBillingCycle} onValueChange={(val) => setEditBillingCycle(val)} disabled={editSaving}>
                    <SelectTrigger id="editBillingCycle">
                      <SelectValue placeholder="Select Cycle" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="monthly">Monthly</SelectItem>
                      <SelectItem value="quarterly">Quarterly</SelectItem>
                      <SelectItem value="half-yearly">Half Yearly</SelectItem>
                      <SelectItem value="yearly">Yearly</SelectItem>
                      <SelectItem value="one-time">One Time</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editAccountNumber">Account / Consumer No.</Label>
                  <Input
                    id="editAccountNumber"
                    value={editAccountNumber}
                    onChange={(e) => setEditAccountNumber(e.target.value)}
                    disabled={editSaving}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <HolderSelect id="editHolderId" value={editHolderId} onChange={setEditHolderId} disabled={editSaving} />

              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="editNotes">Notes / Terms</Label>
                <Textarea
                  id="editNotes"
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  rows={3}
                  disabled={editSaving}
                  className="resize-none"
                />
              </div>

              <div className="flex flex-col gap-2.5 border-t border-border/30 pt-4 mt-2">
                <Label>Replace Attached Document (PDF or Image)</Label>
                <div className="flex flex-col sm:flex-row gap-3 items-center">
                  <div className="border-2 border-dashed border-border/50 rounded-xl p-4 text-center bg-card hover:bg-card transition-colors relative cursor-pointer flex-1 w-full">
                    <input
                      type="file"
                      accept={UPLOAD_ACCEPT_ATTRIBUTE}
                      onChange={handleEditFileChange}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      disabled={editSaving || aiScanning}
                    />
                    <Upload size={18} className="mx-auto text-muted-foreground mb-1" />
                    <p className="text-xs font-semibold text-foreground truncate max-w-[280px] mx-auto">
                      {editFile ? editFile.name : 'Select contract file'}
                    </p>
                  </div>

                  <Button 
                    type="button" 
                    variant="outline"
                    onClick={handleAiScan}
                    disabled={aiScanning || editSaving}
                    className="h-12 w-full sm:w-auto px-4 bg-sky-500/10 border-sky-500/30 text-sky-400 hover:bg-sky-500/20 hover:text-sky-300 font-bold flex gap-2 shrink-0 shadow-sm"
                  >
                    <Sparkles size={15} className={aiScanning ? 'animate-spin' : ''} />
                    <span>{aiScanning ? 'Scanning...' : 'Auto-fill with AI'}</span>
                  </Button>
                </div>
                {aiMessage && (
                  <div className="flex items-center gap-1.5 text-xs text-sky-400 font-medium">
                    <Info size={13} />
                    <span>{aiMessage}</span>
                  </div>
                )}
              </div>

              <Button 
                type="submit" 
                disabled={editSaving || aiScanning}
                className="mt-2 w-full h-11"
              >
                {editSaving ? 'Saving changes...' : 'Save Changes'}
              </Button>
            </form>
          </DialogContent>
        )}
      </Dialog>

      {/* ── This record already exists ─────────────────────────────────────
          Both records rendered side by side, and the answer decides. */}
      <DuplicateResolveDialog {...duplicate.dialogProps} />
    </PageContainer>
  );
}
