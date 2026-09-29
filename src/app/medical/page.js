'use client';

import {
  formatDate } from '@/lib/dateHelper';
import React,
  { useEffect,
  useState } from 'react';
import { 
  HeartPulse,
  Plus,
  X,
  Upload,
  Search,
  Download,
  Trash2,
  Calendar,
  AlertCircle,
  User,
  Stethoscope,
  Share2,
  Printer,
  Eye,
  Pencil,
  FileDown,
  Sparkles
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


export default function MedicalRecordsPage() {
  const [records, setRecords] = useState([]);
  const [canAdd, setCanAdd] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [canDelete, setCanDelete] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [canShare, setCanShare] = useState(false);
  const [previewDoc, setPreviewDoc] = useState(null);
  const [aiScanning, setAiScanning] = useState(false);
  const [aiMessage, setAiMessage] = useState('');
  
  // Search & Filter
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedType, setSelectedType] = useState('all');

  // Form State
  const [showAddForm, setShowAddForm] = useState(false);
  const [patientName, setPatientName] = useState('');
  const [holderId, setHolderId] = useState(ALL_MEMBERS);
  const [recordType, setRecordType] = useState('prescription');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [doctorName, setDoctorName] = useState('');
  const [hospitalName, setHospitalName] = useState('');
  const [details, setDetails] = useState('');
  const [file, setFile] = useState(null);
  const [customFields, setCustomFields] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState('');

  // Edit Form State
  const [editingRec, setEditingRec] = useState(null);
  const [editPatientName, setEditPatientName] = useState('');
  const [editHolderId, setEditHolderId] = useState(ALL_MEMBERS);
  const [editRecordType, setEditRecordType] = useState('prescription');
  const [editDate, setEditDate] = useState('');
  const [editDoctorName, setEditDoctorName] = useState('');
  const [editHospitalName, setEditHospitalName] = useState('');
  const [editDetails, setEditDetails] = useState('');
  const [editFile, setEditFile] = useState(null);
  const [editCustomFields, setEditCustomFields] = useState([]);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const openEditModal = (rec) => {
    setEditingRec(rec);
    setEditPatientName(rec.patientName || '');
    setEditHolderId(holderValue(rec.holderId));
    setEditRecordType(rec.recordType || 'prescription');
    setEditDate(rec.date ? rec.date.substring(0, 10) : '');
    setEditDoctorName(rec.doctorName || '');
    setEditHospitalName(rec.hospitalName || '');
    setEditDetails(rec.details || '');
    setEditFile(null);
    setEditCustomFields(rec.customFields || []);
    setEditError('');
  };

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
        const data = proposed.extractedData || {};
        const title = proposed.title || '';

        const extPatientName = data.patientName || '';
        const extRecordType = data.recordType || 'prescription';
        const extDate = data.date ? data.date.substring(0, 10) : '';
        const extDoctorName = data.doctorName || '';
        const extHospitalName = data.hospitalName || '';
        const extDetails = data.details || '';

        if (editingRec) {
          if (extPatientName) setEditPatientName(extPatientName);
          if (extRecordType) setEditRecordType(extRecordType);
          if (extDate) setEditDate(extDate);
          if (extDoctorName) setEditDoctorName(extDoctorName);
          if (extHospitalName) setEditHospitalName(extHospitalName);
          if (extDetails) setEditDetails(extDetails);
        } else {
          if (extPatientName) setPatientName(extPatientName);
          if (extRecordType) setRecordType(extRecordType);
          if (extDate) setDate(extDate);
          if (extDoctorName) setDoctorName(extDoctorName);
          if (extHospitalName) setHospitalName(extHospitalName);
          if (extDetails) setDetails(extDetails);
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
      console.error('[medical] handler threw', err);
      toast.error('Something went wrong calling AI Scan endpoint. Please try again.');
      setAiMessage('');
    } finally {
      setAiScanning(false);
    }
  };

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    if (!editingRec) return;
    if (!editPatientName || !editDate) {
      setEditError('Patient Name and Date are required');
      return;
    }
    setEditSaving(true);
    setEditError('');

    try {
      const formData = new FormData();
      formData.append('patientName', editPatientName);
      formData.append('holderId', holderPayload(editHolderId));
      formData.append('recordType', editRecordType);
      formData.append('date', editDate);
      formData.append('doctorName', editDoctorName);
      formData.append('hospitalName', editHospitalName);
      formData.append('details', editDetails);
      formData.append('customFields', JSON.stringify(editCustomFields));
      if (editFile) {
        formData.append('file', editFile);
      }

      // `postUpload`, not `apiCall`: this is a multipart write. It carries the
      // 330s ceiling an upload needs — a phone photo on mobile data outruns the
      // 45s a JSON request gets — and the uploading/waiting boundary that
      // separates "nothing was sent, retry" from "this may already have saved".
      const upload = await postUpload(`/api/medical/${editingRec.id}`, formData, { method: 'PUT' });
      if (!upload.ok && (upload.kind !== 'http' || !upload.json)) {
        setEditError(uploadErrorMessage(upload, 'medical record'));
        return;
      }
      const res = { ok: upload.ok, status: upload.status };
      const json = upload.json;
      // An EDIT names the record it is writing onto, so the server withdraws
      // both overwrite and keep-both: the prompt shows what this change would
      // collide with and links to it. No `resubmit` — there is nothing to send.
      if (duplicate.intercept(res, json, {
        newFile: editFile,
        newTitle: `${editRecordType} — ${editDate}`,
      })) return;
      if (json.success) {
        setEditingRec(null);
        fetchRecords();
      } else {
        setEditError(json.error || 'Update failed');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[medical] handler threw', err);
      setEditError('Something went wrong updating medical record. Please try again.');
    } finally {
      setEditSaving(false);
    }
  };

  const fetchRecords = async () => {
    try {
      const { json } = await apiCall('/api/medical');
      if (json.success) {
        // `records`, not `medicalRecords`: the medical scope never overrode
        // `legacyEnvelope`, so the adapter answers under the default key. The
        // old name read `undefined`, and the `records.filter` below then threw
        // the whole page into the error boundary.
        setRecords(json.records || []);
      } else {
        setError(json.error || 'Failed to fetch medical records');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[medical] handler threw', err);
      setError('Something went wrong fetching medical records. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRecords();
    async function checkSharePermission() {
      try {
        const meData = await clientGetMe();
        if (meData.success) {
          const u = meData.user;
          if (u.role === 'SUPER_ADMIN' || u.role === 'TENANT_ADMIN') {
            setCanShare(true);
          } else {
            // The page's PRIMARY taxonomy module, and its MODULE DEFAULT row —
            // `!p.documentKey` skips the sub-category overrides 0024 added, which
            // answer for one category rather than for the button.
            const perm = u.permissions?.find(p => p.module === 'health_medical' && !p.documentKey);
            setCanShare(!!perm?.canShare);
          }
        }
      } catch (err) {
        console.error('Error loading permissions:', err);
      }
    }
    checkSharePermission();
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const q = params.get('search');
      if (q) setSearchTerm(q);
    }
  }, []);

  const handleFileChange = async (e) => {
    const chosen = await acceptedFileFrom(e);
    if (chosen) setFile(chosen);
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
    setPatientName('');
    setRecordType('prescription');
    setDate(new Date().toISOString().split('T')[0]);
    setDoctorName('');
    setHospitalName('');
    setDetails('');
    setFile(null);
    setCustomFields([]);
    setFormError('');
  };

  const closeAddForm = () => {
    resetAddForm();
    setShowAddForm(false);
  };

  const handleSubmit = async (e, answer = {}) => {
    if (e) e.preventDefault();
    if (!patientName || !date) {
      setFormError('Please fill in required fields (Patient Name and Date)');
      return;
    }
    setFormError('');
    setUploading(true);

    const formData = new FormData();
    formData.append('patientName', patientName);
    formData.append('holderId', holderPayload(holderId));
    formData.append('recordType', recordType);
    formData.append('date', date);
    formData.append('doctorName', doctorName);
    formData.append('hospitalName', hospitalName);
    formData.append('details', details);
    formData.append('customFields', JSON.stringify(customFields));
    if (file) {
      formData.append('file', file);
    }

    try {
      // The answer to the duplicate prompt, when this submit is one.
      if (answer.force) formData.append('forceSave', 'true');
      if (answer.keepBoth) formData.append('keepBoth', 'true');

      /**
       * `postUpload`, not `fetch`: `res.json()` here had no catch, so nginx's
       * 413 HTML page for an oversized upload threw a SyntaxError that landed
       * in the `catch` below and was reported as a network error. The helper
       * parses defensively and says which of the four things actually happened.
       */
      const outcome = await postUpload('/api/medical', formData);
      if (!outcome.ok && (outcome.kind !== 'http' || !outcome.json)) {
        setFormError(uploadErrorMessage(outcome, 'medical record'));
        return;
      }
      const res = { status: outcome.status };
      const json = outcome.json;
      // Already on file. Not a failure — a question, and the prompt is where it
      // gets asked: keep the record on file, overwrite it, or keep both.
      if (duplicate.intercept(res, json, {
        newFile: file,
        newTitle: `${recordType} — ${date}`,
        resubmit: (next) => handleSubmit(null, next),
      })) return;
      if (json.success) {
        closeAddForm();
        // Refresh list
        fetchRecords();
      } else {
        setFormError(json.error || 'Upload failed');
      }
    } catch (err) {
      // `postUpload` does not throw, so anything here is a bug in this
      // handler rather than a transport failure — and it used to be silent.
      console.error('[medical] upload handler threw', err);
      setFormError('Something went wrong saving this record. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this medical record?')) return;
    try {
      const { json } = await apiCall(`/api/medical/${id}`, { method: 'DELETE' });
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
      console.error('[medical] handler threw', err);
      toast.error('Something went wrong deleting record. Please try again.');
    }
  };

  const handleShare = async (rec) => {
    const fields = [
      { label: 'Patient Name', value: rec.patientName },
      { label: 'Record Type', value: rec.recordType.toUpperCase() },
      { label: 'Date', value: formatDate(rec.date) },
      { label: 'Doctor', value: rec.doctorName },
      { label: 'Hospital', value: rec.hospitalName }
    ];
    if (Array.isArray(rec.customFields)) {
      rec.customFields.forEach(f => {
        fields.push({ label: f.label, value: f.value });
      });
    }
    const res = await shareRecord(`Medical Record - ${rec.patientName}`, fields, rec.details, rec.filePath,
      { fileName: rec.fileName, mimeType: rec.mimeType, pageCount: rec.pageCount });
    reportShareResult(res);
  };

  const handlePrint = (rec) => {
    const fields = [
      { label: 'Patient Name', value: rec.patientName },
      { label: 'Record Type', value: rec.recordType.toUpperCase() },
      { label: 'Date', value: formatDate(rec.date) },
      { label: 'Doctor', value: rec.doctorName },
      { label: 'Hospital', value: rec.hospitalName }
    ];
    if (Array.isArray(rec.customFields)) {
      rec.customFields.forEach(f => {
        fields.push({ label: f.label, value: f.value });
      });
    }
    printRecord(`Medical Record - ${rec.patientName}`, fields, rec.details, rec.filePath);
  };

  const filteredRecords = records.filter(rec => {
    const matchesSearch = 
      rec.patientName.toLowerCase().includes(searchTerm.toLowerCase()) || 
      (rec.doctorName && rec.doctorName.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (rec.details && rec.details.toLowerCase().includes(searchTerm.toLowerCase()));
    
    const matchesType = selectedType === 'all' || rec.recordType === selectedType;
    return matchesSearch && matchesType;
  });

  const recordTypes = [
    { value: 'all', label: 'All Records' },
    { value: 'prescription', label: 'Prescriptions' },
    { value: 'lab_report', label: 'Lab Reports' },
    { value: 'bill', label: 'Bills' },
    { value: 'other', label: 'Other' },
  ];

  const getRecordColorClasses = (type) => {
    switch (type) {
      case 'prescription': return 'text-sky-400 bg-sky-500/10 border-sky-500/20';
      case 'lab_report': return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
      case 'bill': return 'text-amber-400 bg-amber-500/10 border-amber-500/20';
      default: return 'text-violet-400 bg-violet-500/10 border-violet-500/20';
    }
  };

  const getBadgeVariant = (type) => {
    switch (type) {
      case 'prescription': return 'secondary';
      case 'lab_report': return 'outline'; // Custom class mapping if needed
      case 'bill': return 'warning'; // Custom warning style
      default: return 'default';
    }
  };

  if (loading) {
    return (
      <PageContainer>
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-10 w-10 rounded-full" />
        </div>
        <Skeleton className="h-12 w-full rounded-xl" />
        <div className="flex gap-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-9 w-24 rounded-lg" />
          ))}
        </div>
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
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground">Medical Records</h1>
          <p className="text-muted-foreground text-sm">Store prescriptions, lab reports, & health histories</p>
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
              <HeartPulse className="text-sky-400" size={20} />
              <span>Add Health Record</span>
            </h2>
          </CardHeader>

          

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="patientName">Patient Name *</Label>
              <Input
                id="patientName"
                placeholder="e.g. Sunil (Self), Mother, etc."
                value={patientName}
                onChange={(e) => setPatientName(e.target.value)}
                disabled={uploading}
              />
            </div>

            <HolderSelect value={holderId} onChange={setHolderId} disabled={uploading} />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="recordType">Record Type *</Label>
                <Select value={recordType} onValueChange={(val) => setRecordType(val)} disabled={uploading}>
                  <SelectTrigger id="recordType">
                    <SelectValue placeholder="Select Record Type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="prescription">Prescription</SelectItem>
                    <SelectItem value="lab_report">Lab Report</SelectItem>
                    <SelectItem value="bill">Medical Bill</SelectItem>
                    <SelectItem value="other">Other Log</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="date">Date *</Label>
                <Input
                  id="date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  disabled={uploading}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="doctorName">Doctor Name</Label>
                <Input
                  id="doctorName"
                  placeholder="Dr. Joshi"
                  value={doctorName}
                  onChange={(e) => setDoctorName(e.target.value)}
                  disabled={uploading}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="hospitalName">Hospital / Clinic</Label>
                <Input
                  id="hospitalName"
                  placeholder="Apollo Hospital"
                  value={hospitalName}
                  onChange={(e) => setHospitalName(e.target.value)}
                  disabled={uploading}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="details">Symptoms / Treatment Details</Label>
              <Textarea
                id="details"
                placeholder="e.g. Viral fever. Prescribed Paracetamol and Rest."
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                rows={3}
                disabled={uploading}
                className="resize-none"
              />
            </div>

            {/* Custom Fields */}
            <div className="flex flex-col gap-3 border-t border-border/50 pt-5 mt-2">
              <div className="flex justify-between items-center">
                <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Custom Attributes</span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setCustomFields(prev => [...prev, { label: '', value: '' }])}
                  disabled={uploading}
                  className="h-8 text-xs px-3"
                >
                  + Add Custom Field
                </Button>
              </div>

              {customFields.length > 0 && (
                <div className="flex flex-col gap-2">
                  {customFields.map((field, fIdx) => (
                    <div key={fIdx} className="flex gap-2 items-center">
                      <Input
                        placeholder="Label (e.g. Blood Sugar)"
                        value={field.label}
                        onChange={(e) => {
                          const updated = [...customFields];
                          updated[fIdx] = { ...updated[fIdx], label: e.target.value };
                          setCustomFields(updated);
                        }}
                        className="flex-1 h-9 text-sm"
                        disabled={uploading}
                      />
                      <Input
                        placeholder="Value"
                        value={field.value}
                        onChange={(e) => {
                          const updated = [...customFields];
                          updated[fIdx] = { ...updated[fIdx], value: e.target.value };
                          setCustomFields(updated);
                        }}
                        className="flex-[2] h-9 text-sm"
                        disabled={uploading}
                      />
                      <Button
                        type="button"
                        variant="destructive"
                        size="icon"
                        onClick={() => setCustomFields(prev => prev.filter((_, idx) => idx !== fIdx))}
                        className="h-9 w-9 shrink-0"
                        disabled={uploading}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Attach Bill / Prescription PDF / Image (Optional)</Label>
              <div className="border-2 border-dashed border-border/50 rounded-xl p-6 text-center bg-card hover:bg-card transition-colors relative cursor-pointer">
                <input
                  type="file"
                  accept={UPLOAD_ACCEPT_ATTRIBUTE}
                  onChange={handleFileChange}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  disabled={uploading}
                />
                <Upload size={20} className="mx-auto text-muted-foreground mb-2" />
                <p className="text-xs font-semibold text-foreground">
                  {file ? file.name : 'Select document file (Drag & Drop or Click)'}
                </p>
              </div>
              <div className="flex flex-col gap-2 mt-2">
                <Button
                  type="button"
                  onClick={handleAiScan}
                  disabled={aiScanning || !file}
                  variant="secondary"
                  className="w-full text-xs font-semibold py-2 flex items-center justify-center gap-2"
                >
                  <Sparkles size={15} className={aiScanning ? 'animate-spin' : ''} />
                  <span>{aiScanning ? 'Scanning...' : 'Auto-fill with AI'}</span>
                </Button>
                {aiMessage && <p className="text-xs text-center text-info-text mt-1">{aiMessage}</p>}
              </div>
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
                disabled={uploading}
                className="h-11 px-6"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={uploading}
                className="h-11 flex-1"
              >
                {uploading ? 'Saving record...' : 'Add Medical Entry'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* Search & Filter */}
      <div className="flex flex-col gap-4 animate-fade-in">
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" size={18} />
          <Input
            placeholder="Search by patient, doctor, description..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 h-11 bg-card border-border/50"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          {recordTypes.map((cat) => (
            <Button
              key={cat.value}
              variant={selectedType === cat.value ? "default" : "outline"}
              onClick={() => setSelectedType(cat.value)}
              className="h-9 px-4 text-xs font-medium rounded-lg"
            >
              {cat.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Records List */}
      {filteredRecords.length === 0 ? (
        <Card className="border-border/30 bg-card backdrop-blur p-12 text-center animate-fade-in">
          <HeartPulse size={48} className="mx-auto text-faint mb-3" />
          <p className="text-muted-foreground text-sm font-medium">No medical records found</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredRecords.map((rec, index) => {
            const colorClass = getRecordColorClasses(rec.recordType);
            return (
              <Card 
                key={rec.id}
                className="border-border/50 bg-card backdrop-blur shadow-glass hover:bg-card transition-colors p-5 flex flex-col gap-4 animate-fade-in"
              >
                {/* Card Header */}
                <div className="flex justify-between items-start gap-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`p-2 rounded-xl border shrink-0 ${colorClass}`}>
                      <HeartPulse size={18} />
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="font-bold text-foreground text-sm truncate">{rec.patientName}</span>
                      <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground mt-0.5">
                        {rec.recordType.replace('_', ' ')}
                      </span>
                    </div>
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
                        onClick={() => {
                          setPreviewDoc({
                            name: rec.patientName + ' - ' + rec.recordType,
                            filePath: rec.filePath,
                            mimeType: rec.mimeType,
                            pageCount: rec.pageCount
                          });
                        }}
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
                            downloadRecord(`Medical Record - ${rec.patientName}`, [
                              { label: 'Patient Name', value: rec.patientName },
                              { label: 'Record Type', value: rec.recordType.toUpperCase() },
                              { label: 'Date', value: formatDate(rec.date) },
                              { label: 'Doctor', value: rec.doctorName },
                              { label: 'Hospital', value: rec.hospitalName },
                              ...(Array.isArray(rec.customFields) ? rec.customFields.map(f => ({ label: f.label, value: f.value })) : [])
                            ], rec.details, rec.filePath);
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

                {/* Date */}
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Calendar size={12} className="text-muted-foreground" />
                  <span>{formatDate(rec.date)}</span>
                </div>

                {/* Doctor & Hospital */}
                {(rec.doctorName || rec.hospitalName) && (
                  <div className="flex flex-wrap gap-2 text-xs bg-muted/30 border border-border/30 rounded-xl p-2.5">
                    {rec.doctorName && (
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <Stethoscope size={13} className="text-sky-400" />
                        <span className="font-medium truncate max-w-[150px]">{rec.doctorName}</span>
                      </div>
                    )}
                    {rec.hospitalName && (
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <User size={13} className="text-violet-400" />
                        <span className="font-medium truncate max-w-[150px]">{rec.hospitalName}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Details */}
                {rec.details && (
                  <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
                    {rec.details}
                  </p>
                )}

                {/* Render custom fields */}
                {Array.isArray(rec.customFields) && rec.customFields.length > 0 && (
                  <div className="flex flex-col gap-1.5 border-t border-border/30 pt-3 mt-1">
                    {rec.customFields.map((f, idx) => (
                      <div key={idx} className="flex justify-between items-center text-xs">
                        <span className="text-muted-foreground">{f.label}:</span>
                        <span className="font-semibold text-foreground">{f.value}</span>
                      </div>
                    ))}
                  </div>
                )}
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
              <DialogTitle className="text-lg font-bold">Edit Health Record</DialogTitle>
            </DialogHeader>

            

            <form onSubmit={handleEditSubmit} className="flex flex-col gap-5 mt-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="editPatientName">Patient Name *</Label>
                <Input
                  id="editPatientName"
                  value={editPatientName}
                  onChange={(e) => setEditPatientName(e.target.value)}
                  disabled={editSaving}
                />
              </div>

              <HolderSelect id="editHolderId" value={editHolderId} onChange={setEditHolderId} disabled={editSaving} />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editRecordType">Record Type *</Label>
                  <Select value={editRecordType} onValueChange={(val) => setEditRecordType(val)} disabled={editSaving}>
                    <SelectTrigger id="editRecordType">
                      <SelectValue placeholder="Select Record Type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="prescription">Prescription</SelectItem>
                      <SelectItem value="lab_report">Lab Report</SelectItem>
                      <SelectItem value="bill">Medical Bill</SelectItem>
                      <SelectItem value="other">Other Log</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editDate">Date *</Label>
                  <Input
                    id="editDate"
                    type="date"
                    value={editDate}
                    onChange={(e) => setEditDate(e.target.value)}
                    disabled={editSaving}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editDoctorName">Doctor Name</Label>
                  <Input
                    id="editDoctorName"
                    value={editDoctorName}
                    onChange={(e) => setEditDoctorName(e.target.value)}
                    disabled={editSaving}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editHospitalName">Hospital / Clinic</Label>
                  <Input
                    id="editHospitalName"
                    value={editHospitalName}
                    onChange={(e) => setEditHospitalName(e.target.value)}
                    disabled={editSaving}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="editDetails">Symptoms / Treatment Details</Label>
                <Textarea
                  id="editDetails"
                  value={editDetails}
                  onChange={(e) => setEditDetails(e.target.value)}
                  rows={3}
                  disabled={editSaving}
                  className="resize-none"
                />
              </div>

              {/* Custom Fields */}
              <div className="flex flex-col gap-3 border-t border-border/30 pt-5 mt-2">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Custom Attributes</span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setEditCustomFields(prev => [...prev, { label: '', value: '' }])}
                    disabled={editSaving}
                    className="h-8 text-xs px-3"
                  >
                    + Add Custom Field
                  </Button>
                </div>

                {editCustomFields.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {editCustomFields.map((field, fIdx) => (
                      <div key={fIdx} className="flex gap-2 items-center">
                        <Input
                          placeholder="Label"
                          value={field.label}
                          onChange={(e) => {
                            const updated = [...editCustomFields];
                            updated[fIdx] = { ...updated[fIdx], label: e.target.value };
                            setEditCustomFields(updated);
                          }}
                          className="flex-1 h-9 text-sm"
                          disabled={editSaving}
                        />
                        <Input
                          placeholder="Value"
                          value={field.value}
                          onChange={(e) => {
                            const updated = [...editCustomFields];
                            updated[fIdx] = { ...updated[fIdx], value: e.target.value };
                            setEditCustomFields(updated);
                          }}
                          className="flex-[2] h-9 text-sm"
                          disabled={editSaving}
                        />
                        <Button
                          type="button"
                          variant="destructive"
                          size="icon"
                          onClick={() => setEditCustomFields(prev => prev.filter((_, idx) => idx !== fIdx))}
                          className="h-9 w-9 shrink-0"
                          disabled={editSaving}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="editFile">Replace Attachment File (Optional)</Label>
                <Input
                  id="editFile"
                  type="file"
                  accept={UPLOAD_ACCEPT_ATTRIBUTE}
                  onChange={async (e) => { const chosen = await acceptedFileFrom(e); if (chosen) setEditFile(chosen); }}
                  disabled={editSaving}
                  className="h-10 text-sm"
                />
                {editingRec.filePath && (
                  <span className="text-xs text-muted-foreground mt-1">
                    Current File: {editingRec.filePath.split('/').pop()}
                  </span>
                )}
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
                  <span>{aiScanning ? 'Scanning...' : 'Auto-fill with AI'}</span>
                </Button>
                {aiMessage && <p className="text-xs text-center text-info-text mt-1">{aiMessage}</p>}
              </div>

              <div className="flex justify-end gap-3 border-t border-border/30 pt-5 mt-4">
                <Button type="button" variant="secondary" onClick={() => setEditingRec(null)} disabled={editSaving}>
                  Cancel
                </Button>
                <Button type="submit" disabled={editSaving}>
                  {editSaving ? 'Saving...' : 'Save Changes'}
                </Button>
              </div>
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
