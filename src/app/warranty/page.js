'use client';

import {
  formatDate } from '@/lib/dateHelper';
import React,
  { useEffect,
  useState } from 'react';
import { 
  ShieldCheck,
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
  Phone,
  HelpCircle,
  Building,
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
import { PhoneInput } from '@/components/ui/PhoneInput';
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


export default function WarrantyAmcPage() {
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
  const [typeFilter, setTypeFilter] = useState('all'); // 'all', 'WARRANTY', 'AMC'

  // Add Form State
  const [showAddForm, setShowAddForm] = useState(false);
  const [applianceName, setApplianceName] = useState('');
  const [company, setCompany] = useState('');
  const [type, setType] = useState('WARRANTY'); // 'WARRANTY' or 'AMC'
  const [purchaseDate, setPurchaseDate] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [supportContact, setSupportContact] = useState('');
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
  const [editApplianceName, setEditApplianceName] = useState('');
  const [editCompany, setEditCompany] = useState('');
  const [editType, setEditType] = useState('WARRANTY');
  const [editPurchaseDate, setEditPurchaseDate] = useState('');
  const [editExpiryDate, setEditExpiryDate] = useState('');
  const [editSupportContact, setEditSupportContact] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editHolderId, setEditHolderId] = useState(ALL_MEMBERS);
  const [editFile, setEditFile] = useState(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const fetchRecords = async () => {
    try {
      const { json } = await apiCall('/api/warranty');
      if (json.success) {
        setRecords(json.warrantyAmcs || []);
      } else {
        setError(json.error || 'Failed to fetch warranty/AMC records');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[warranty] handler threw', err);
      setError('Something went wrong fetching warranty/AMC records. Please try again.');
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
            // The page's PRIMARY taxonomy module, and its MODULE DEFAULT row —
            // `!p.documentKey` skips the sub-category overrides 0024 added, which
            // answer for one category rather than for the button.
            const perm = u.permissions?.find(p => p.module === 'warranty_amc' && !p.documentKey);
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
        const appliance = title || data.name || data.applianceName || '';
        const comp = data.company || data.provider || data.companyName || '';
        const expDate = formatDateToInput(data.expiryDate);
        const purDate = formatDateToInput(data.purchaseDate || data.startDate);
        const contact = data.supportContact || data.phoneNumber || '';
        const detailsNotes = data.notes || data.details || '';

        if (editingRec) {
          if (appliance) setEditApplianceName(appliance);
          if (comp) setEditCompany(comp);
          if (expDate) setEditExpiryDate(expDate);
          if (purDate) setEditPurchaseDate(purDate);
          if (contact) setEditSupportContact(contact);
          if (detailsNotes) setEditNotes(detailsNotes);
        } else {
          if (appliance) setApplianceName(appliance);
          if (comp) setCompany(comp);
          if (expDate) setExpiryDate(expDate);
          if (purDate) setPurchaseDate(purDate);
          if (contact) setSupportContact(contact);
          if (detailsNotes) setNotes(detailsNotes);
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
      console.error('[warranty] handler threw', err);
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
    setApplianceName('');
    setCompany('');
    setType('WARRANTY');
    setPurchaseDate('');
    setExpiryDate('');
    setSupportContact('');
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
    if (!applianceName.trim() || !company.trim() || !type || !expiryDate) {
      setFormError('Appliance Name, Company, Type, and Expiry Date are required');
      return;
    }
    setFormError('');
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append('applianceName', applianceName.trim());
      formData.append('company', company.trim());
      formData.append('type', type);
      formData.append('purchaseDate', purchaseDate || '');
      formData.append('expiryDate', expiryDate);
      formData.append('supportContact', supportContact.trim());
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
      const outcome = await postUpload('/api/warranty', formData);
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
        newTitle: applianceName,
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
      console.error('[warranty] upload handler threw', err);
      setFormError('Something went wrong saving this record. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  const openEditModal = (rec) => {
    setEditingRec(rec);
    setEditApplianceName(rec.applianceName || '');
    setEditCompany(rec.company || '');
    setEditType(rec.type || 'WARRANTY');
    setEditPurchaseDate(rec.purchaseDate ? rec.purchaseDate.substring(0, 10) : '');
    setEditExpiryDate(rec.expiryDate ? rec.expiryDate.substring(0, 10) : '');
    setEditSupportContact(rec.supportContact || '');
    setEditNotes(rec.notes || '');
    setEditHolderId(holderValue(rec.holderId));
    setEditFile(null);
    setEditError('');
  };

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    if (!editingRec) return;
    if (!editApplianceName.trim() || !editCompany.trim() || !editType || !editExpiryDate) {
      setEditError('Appliance Name, Company, Type, and Expiry Date are required');
      return;
    }
    setEditSaving(true);
    setEditError('');

    try {
      const formData = new FormData();
      formData.append('applianceName', editApplianceName.trim());
      formData.append('company', editCompany.trim());
      formData.append('type', editType);
      formData.append('purchaseDate', editPurchaseDate || '');
      formData.append('expiryDate', editExpiryDate);
      formData.append('supportContact', editSupportContact.trim());
      formData.append('notes', editNotes.trim());
      formData.append('holderId', holderPayload(editHolderId));
      if (editFile) {
        formData.append('file', editFile);
      }

      // `postUpload`, not `apiCall`: this is a multipart write. It carries the
      // 330s ceiling an upload needs — a phone photo on mobile data outruns the
      // 45s a JSON request gets — and the uploading/waiting boundary that
      // separates "nothing was sent, retry" from "this may already have saved".
      const upload = await postUpload(`/api/warranty/${editingRec.id}`, formData, { method: 'PUT' });
      if (!upload.ok && (upload.kind !== 'http' || !upload.json)) {
        setEditError(uploadErrorMessage(upload, 'warranty record'));
        return;
      }
      const res = { ok: upload.ok, status: upload.status };
      const json = upload.json;
      // An EDIT names the record it is writing onto, so the server withdraws
      // both overwrite and keep-both: the prompt shows what this change would
      // collide with and links to it. No `resubmit` — there is nothing to send.
      if (duplicate.intercept(res, json, {
        newFile: editFile,
        newTitle: editApplianceName,
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
      console.error('[warranty] handler threw', err);
      setEditError('Something went wrong updating record. Please try again.');
    } finally {
      setEditSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this warranty/AMC record?')) return;
    try {
      const { json } = await apiCall(`/api/warranty/${id}`, { method: 'DELETE' });
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
      console.error('[warranty] handler threw', err);
      toast.error('Something went wrong deleting record. Please try again.');
    }
  };

  const handleShare = async (rec) => {
    const fields = [
      { label: 'Item Name', value: rec.applianceName },
      { label: 'Provider / Company', value: rec.company },
      { label: 'Type', value: rec.type },
      { label: 'Expiry Date', value: formatDate(rec.expiryDate) },
      { label: 'Purchase Date', value: rec.purchaseDate ? formatDate(rec.purchaseDate) : 'N/A' },
      { label: 'Support Contact', value: rec.supportContact || 'N/A' },
      { label: 'Assigned Holder', value: rec.holder?.name || 'All Members' }
    ];
    const res = await shareRecord(`Warranty/AMC: ${rec.applianceName}`, fields, rec.notes, rec.filePath,
      { fileName: rec.fileName, mimeType: rec.mimeType, pageCount: rec.pageCount });
    reportShareResult(res);
  };

  const handlePrint = (rec) => {
    const fields = [
      { label: 'Item Name', value: rec.applianceName },
      { label: 'Provider / Company', value: rec.company },
      { label: 'Type', value: rec.type },
      { label: 'Expiry Date', value: formatDate(rec.expiryDate) },
      { label: 'Purchase Date', value: rec.purchaseDate ? formatDate(rec.purchaseDate) : 'N/A' },
      { label: 'Support Contact', value: rec.supportContact || 'N/A' },
      { label: 'Assigned Holder', value: rec.holder?.name || 'All Members' }
    ];
    printRecord(`Warranty/AMC details`, fields, rec.notes, rec.filePath);
  };

  const filteredRecords = records.filter(rec => {
    const matchesSearch = 
      rec.applianceName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      rec.company.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (rec.notes && rec.notes.toLowerCase().includes(searchTerm.toLowerCase()));
    
    const matchesType = typeFilter === 'all' || rec.type === typeFilter;
    return matchesSearch && matchesType;
  });

  const isExpired = (expiryDateStr) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const exp = new Date(expiryDateStr);
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
            <Skeleton key={i} className="h-52 w-full rounded-2xl" />
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
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground">Warranty & AMC</h1>
          <p className="text-muted-foreground text-sm">Keep track of home appliances warranties and annual maintenance contracts</p>
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
      

      {/* Add Record Form */}
      {showAddForm && (
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass p-6 md:p-8 animate-scale-in">
          <CardHeader className="p-0 pb-4 border-b border-border/50 mb-6">
            <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
              <ShieldCheck className="text-sky-400" size={20} />
              <span>Add Warranty/AMC Contract</span>
            </h2>
          </CardHeader>

          

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="applianceName">Appliance / Item Name *</Label>
                <Input
                  id="applianceName"
                  placeholder="e.g. LG Split AC, Dell Laptop"
                  value={applianceName}
                  onChange={(e) => setApplianceName(e.target.value)}
                  disabled={uploading}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="company">Company / Service Provider *</Label>
                <Input
                  id="company"
                  placeholder="e.g. LG Electronics, Dell India"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  disabled={uploading}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="type">Contract Type *</Label>
                <Select value={type} onValueChange={(val) => setType(val)} disabled={uploading}>
                  <SelectTrigger id="type">
                    <SelectValue placeholder="Select Type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="WARRANTY">Warranty</SelectItem>
                    <SelectItem value="AMC">Annual Maintenance Contract (AMC)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="purchaseDate">Purchase Date</Label>
                <Input
                  id="purchaseDate"
                  type="date"
                  value={purchaseDate}
                  onChange={(e) => setPurchaseDate(e.target.value)}
                  disabled={uploading}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="expiryDate">Expiry Date *</Label>
                <Input
                  id="expiryDate"
                  type="date"
                  value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)}
                  disabled={uploading}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <PhoneInput
                  id="supportContact"
                  label="Support Helpline Number"
                  value={supportContact}
                  onChange={setSupportContact}
                  disabled={uploading}
                />
              </div>

              <HolderSelect value={holderId} onChange={setHolderId} disabled={uploading} />
            </div>


            <div className="flex flex-col gap-1.5">
              <Label htmlFor="notes">Notes / Coverage Details</Label>
              <Textarea
                id="notes"
                placeholder="e.g. Includes compressor warranty of 5 years. Standard parts included."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                disabled={uploading}
                className="resize-none"
              />
            </div>

            {/* Document Upload with AI Auto-fill visual button */}
            <div className="flex flex-col gap-2.5 border-t border-border/30 pt-4 mt-2">
              <Label>Attach Bill / Warranty Card PDF or Image</Label>
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
                {uploading ? 'Uploading & saving...' : 'Save Warranty Details'}
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
            placeholder="Search appliances, brands, notes..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 h-11 bg-card border-border/50"
          />
        </div>

        <div className="flex gap-2">
          {[
            { value: 'all', label: 'All Items' },
            { value: 'WARRANTY', label: 'Warranties' },
            { value: 'AMC', label: 'AMCs' }
          ].map((cat) => (
            <Button
              key={cat.value}
              variant={typeFilter === cat.value ? "default" : "outline"}
              onClick={() => setTypeFilter(cat.value)}
              className="h-11 px-5 text-xs font-semibold rounded-lg shrink-0"
            >
              {cat.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Records list */}
      {filteredRecords.length === 0 ? (
        <Card className="border-border/30 bg-card backdrop-blur p-12 text-center animate-fade-in">
          <ShieldCheck size={48} className="mx-auto text-faint mb-3" />
          <p className="text-muted-foreground text-sm font-medium">No warranty or AMC records found</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredRecords.map((rec) => {
            const expired = isExpired(rec.expiryDate);
            const isAmc = rec.type === 'AMC';
            return (
              <Card 
                key={rec.id}
                className="border-border/50 bg-card backdrop-blur shadow-glass hover:bg-card transition-colors p-5 flex flex-col justify-between gap-4 animate-fade-in"
              >
                <div className="flex flex-col gap-3">
                  <div className="flex justify-between items-start gap-2">
                    <div className="flex flex-col min-w-0">
                      <span className="font-bold text-foreground text-sm truncate">{rec.applianceName}</span>
                      {/* `min-w-0` + `truncate`: without them this nested row
                          keeps its min-content width and a long company name
                          runs out under the action buttons opposite. */}
                      <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground mt-0.5 flex min-w-0 items-center gap-1">
                        <Building size={10} className="shrink-0" />
                        <span className="truncate">{rec.company}</span>
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
                            name: rec.applianceName + ' - ' + rec.type,
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
                              downloadRecord(`${rec.type} - ${rec.applianceName}`, [
                                { label: 'Item Name', value: rec.applianceName },
                                { label: 'Company', value: rec.company },
                                { label: 'Type', value: rec.type },
                                { label: 'Expiry Date', value: formatDate(rec.expiryDate) },
                                { label: 'Purchase Date', value: rec.purchaseDate ? formatDate(rec.purchaseDate) : '' },
                                { label: 'Support Contact', value: rec.supportContact }
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
                    <Badge variant={isAmc ? "outline" : "secondary"} className={`text-2xs font-bold ${isAmc ? 'text-violet-400 border-violet-500/20 bg-violet-500/5' : 'text-sky-400 bg-sky-500/10'}`}>
                      {rec.type}
                    </Badge>

                    {expired ? (
                      <Badge variant="destructive" className="text-2xs font-bold">Expired</Badge>
                    ) : (
                      <Badge variant="outline" className="text-2xs font-bold text-emerald-400 border-emerald-500/20 bg-emerald-500/5">Active</Badge>
                    )}
                  </div>

                  <div className="flex flex-col gap-1.5 text-xs text-muted-foreground border-t border-border/30 pt-3 mt-1.5">
                    <div className="flex justify-between items-center">
                      <span>Expires:</span>
                      <span className={`font-bold ${expired ? 'text-red-400' : 'text-foreground'}`}>
                        {formatDate(rec.expiryDate)}
                      </span>
                    </div>

                    {rec.purchaseDate && (
                      <div className="flex justify-between items-center text-xs">
                        <span>Purchased:</span>
                        <span className="font-semibold text-foreground">
                          {formatDate(rec.purchaseDate)}
                        </span>
                      </div>
                    )}

                    {rec.supportContact && (
                      <a href={`tel:${rec.supportContact}`} className="flex items-center gap-1.5 text-foreground hover:text-primary transition-colors py-0.5 mt-1 group">
                        <Phone size={13} className="text-emerald-400 shrink-0 group-hover:animate-bounce" />
                        <span className="font-semibold">{rec.supportContact}</span>
                      </a>
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
              <DialogTitle className="text-lg font-bold">Edit Warranty/AMC details</DialogTitle>
            </DialogHeader>

            

            <form onSubmit={handleEditSubmit} className="flex flex-col gap-5 mt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editApplianceName">Appliance / Item Name *</Label>
                  <Input
                    id="editApplianceName"
                    value={editApplianceName}
                    onChange={(e) => setEditApplianceName(e.target.value)}
                    disabled={editSaving}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editCompany">Company / Service Provider *</Label>
                  <Input
                    id="editCompany"
                    value={editCompany}
                    onChange={(e) => setEditCompany(e.target.value)}
                    disabled={editSaving}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editType">Contract Type *</Label>
                  <Select value={editType} onValueChange={(val) => setEditType(val)} disabled={editSaving}>
                    <SelectTrigger id="editType">
                      <SelectValue placeholder="Select Type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="WARRANTY">Warranty</SelectItem>
                      <SelectItem value="AMC">Annual Maintenance Contract (AMC)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editPurchaseDate">Purchase Date</Label>
                  <Input
                    id="editPurchaseDate"
                    type="date"
                    value={editPurchaseDate}
                    onChange={(e) => setEditPurchaseDate(e.target.value)}
                    disabled={editSaving}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editExpiryDate">Expiry Date *</Label>
                  <Input
                    id="editExpiryDate"
                    type="date"
                    value={editExpiryDate}
                    onChange={(e) => setEditExpiryDate(e.target.value)}
                    disabled={editSaving}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <PhoneInput
                    id="editSupportContact"
                    label="Support Helpline Number"
                    value={editSupportContact}
                    onChange={setEditSupportContact}
                    disabled={editSaving}
                  />
                </div>

                <HolderSelect id="editHolderId" value={editHolderId} onChange={setEditHolderId} disabled={editSaving} />
              </div>


              <div className="flex flex-col gap-1.5">
                <Label htmlFor="editNotes">Notes / Coverage Details</Label>
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
