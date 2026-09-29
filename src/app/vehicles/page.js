'use client';

import {
  formatDate } from '@/lib/dateHelper';
import React,
  { useEffect,
  useState } from 'react';
import { 
  Car,
  Plus,
  X,
  Upload,
  Search,
  Download,
  Trash2,
  Calendar,
  AlertCircle,
  ShieldCheck,
  Activity,
  User,
  Share2,
  Printer,
  Eye,
  Pencil,
  FileDown,
  Sparkles,
  ListTodo
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
import { Skeleton } from '@/components/ui/skeleton';
import RowActionsMenu from '@/components/ui/row-actions-menu';
import { toast } from 'sonner';
import { acceptedFileFrom } from '@/app/components/acceptFile';
import { UPLOAD_ACCEPT_ATTRIBUTE } from '@/lib/records/uploadTypes';
import HolderSelect, { ALL_MEMBERS, holderValue, holderPayload } from '@/app/components/HolderSelect';
import PageContainer from '@/app/components/PageContainer';
import DuplicateResolveDialog from '@/components/records/DuplicateResolveDialog';
import useDuplicateResolve from '@/components/records/useDuplicateResolve';
import { apiCall } from '@/lib/net/apiRequest';
import { postUpload, uploadErrorMessage } from '@/lib/records/uploadRequest';
import { toastApiError } from '@/lib/net/toastApiError';


export default function VehiclesPage() {
  const [vehicles, setVehicles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [canShare, setCanShare] = useState(false);
  const [previewDoc, setPreviewDoc] = useState(null);
  const [aiScanning, setAiScanning] = useState(false);
  const [aiMessage, setAiMessage] = useState('');
  const [isGeneratingFollowup, setIsGeneratingFollowup] = useState(null);

  // Search & Filter
  const [searchTerm, setSearchTerm] = useState('');

  // Form State
  const [showAddForm, setShowAddForm] = useState(false);
  const [vehicleName, setVehicleName] = useState('');
  const [holderId, setHolderId] = useState(ALL_MEMBERS);
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [registrationDate, setRegistrationDate] = useState('');
  const [insuranceExpiry, setInsuranceExpiry] = useState('');
  const [pucExpiry, setPucExpiry] = useState('');
  const [fitnessExpiry, setFitnessExpiry] = useState('');
  const [lastServiceDate, setLastServiceDate] = useState('');
  const [nextServiceDate, setNextServiceDate] = useState('');
  const [serviceNotes, setServiceNotes] = useState('');
  const [file, setFile] = useState(null); // RC copy / Insurance
  const [customFields, setCustomFields] = useState([]);
  
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // Edit Form State
  const [editingVehicle, setEditingVehicle] = useState(null);
  const [editVehicleName, setEditVehicleName] = useState('');
  const [editHolderId, setEditHolderId] = useState(ALL_MEMBERS);
  const [editVehicleNumber, setEditVehicleNumber] = useState('');
  const [editOwnerName, setEditOwnerName] = useState('');
  const [editRegistrationDate, setEditRegistrationDate] = useState('');
  const [editInsuranceExpiry, setEditInsuranceExpiry] = useState('');
  const [editPucExpiry, setEditPucExpiry] = useState('');
  const [editFitnessExpiry, setEditFitnessExpiry] = useState('');
  const [editLastServiceDate, setEditLastServiceDate] = useState('');
  const [editNextServiceDate, setEditNextServiceDate] = useState('');
  const [editServiceNotes, setEditServiceNotes] = useState('');
  const [editFile, setEditFile] = useState(null);
  const [editCustomFields, setEditCustomFields] = useState([]);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const openEditModal = (v) => {
    setEditingVehicle(v);
    setEditVehicleName(v.vehicleName || '');
    setEditHolderId(holderValue(v.holderId));
    setEditVehicleNumber(v.vehicleNumber || '');
    setEditOwnerName(v.ownerName || '');
    setEditRegistrationDate(v.registrationDate ? new Date(v.registrationDate).toISOString().split('T')[0] : '');
    setEditInsuranceExpiry(v.insuranceExpiry ? new Date(v.insuranceExpiry).toISOString().split('T')[0] : '');
    setEditPucExpiry(v.pucExpiry ? new Date(v.pucExpiry).toISOString().split('T')[0] : '');
    setEditFitnessExpiry(v.fitnessExpiry ? new Date(v.fitnessExpiry).toISOString().split('T')[0] : '');
    setEditLastServiceDate(v.lastServiceDate ? new Date(v.lastServiceDate).toISOString().split('T')[0] : '');
    setEditNextServiceDate(v.nextServiceDate ? new Date(v.nextServiceDate).toISOString().split('T')[0] : '');
    setEditServiceNotes(v.serviceNotes || '');
    setEditFile(null);
    setEditCustomFields(v.customFields || []);
    setEditError('');
  };

  const handleAiScan = async () => {
    const selectedFile = editingVehicle ? editFile : file;
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

        const extVehicleName = data.vehicleName || title || '';
        const extVehicleNumber = data.vehicleNumber || '';
        const extOwnerName = data.ownerName || '';
        const extRegDate = data.registrationDate ? data.registrationDate.substring(0, 10) : '';
        const extInsExpiry = data.insuranceExpiry ? data.insuranceExpiry.substring(0, 10) : '';
        const extPucExpiry = data.pucExpiry ? data.pucExpiry.substring(0, 10) : '';
        const extFitExpiry = data.fitnessExpiry ? data.fitnessExpiry.substring(0, 10) : '';

        if (editingVehicle) {
          if (extVehicleName) setEditVehicleName(extVehicleName);
          if (extVehicleNumber) setEditVehicleNumber(extVehicleNumber);
          if (extOwnerName) setEditOwnerName(extOwnerName);
          if (extRegDate) setEditRegistrationDate(extRegDate);
          if (extInsExpiry) setEditInsuranceExpiry(extInsExpiry);
          if (extPucExpiry) setEditPucExpiry(extPucExpiry);
          if (extFitExpiry) setEditFitnessExpiry(extFitExpiry);
        } else {
          if (extVehicleName) setVehicleName(extVehicleName);
          if (extVehicleNumber) setVehicleNumber(extVehicleNumber);
          if (extOwnerName) setOwnerName(extOwnerName);
          if (extRegDate) setRegistrationDate(extRegDate);
          if (extInsExpiry) setInsuranceExpiry(extInsExpiry);
          if (extPucExpiry) setPucExpiry(extPucExpiry);
          if (extFitExpiry) setFitnessExpiry(extFitExpiry);
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
      console.error('[vehicles] handler threw', err);
      toast.error('Something went wrong calling AI Scan endpoint. Please try again.');
      setAiMessage('');
    } finally {
      setAiScanning(false);
    }
  };

  const handleEditFileChange = async (e) => {
    const chosen = await acceptedFileFrom(e);
    if (chosen) setEditFile(chosen);
  };

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    if (!editingVehicle) return;
    if (!editVehicleName || !editVehicleNumber || !editOwnerName || !editRegistrationDate || !editInsuranceExpiry || !editPucExpiry || !editFitnessExpiry) {
      setEditError('Please fill in all fields');
      return;
    }
    setEditSaving(true);
    setEditError('');

    const formData = new FormData();
    formData.append('vehicleName', editVehicleName);
    formData.append('holderId', holderPayload(editHolderId));
    formData.append('vehicleNumber', editVehicleNumber);
    formData.append('ownerName', editOwnerName);
    formData.append('registrationDate', editRegistrationDate);
    formData.append('insuranceExpiry', editInsuranceExpiry);
    formData.append('pucExpiry', editPucExpiry);
    formData.append('fitnessExpiry', editFitnessExpiry);
    formData.append('lastServiceDate', editLastServiceDate);
    formData.append('nextServiceDate', editNextServiceDate);
    formData.append('serviceNotes', editServiceNotes);
    formData.append('customFields', JSON.stringify(editCustomFields));
    if (editFile) {
      formData.append('file', editFile);
    }

    try {
      // `postUpload`, not `apiCall`: this is a multipart write. It carries the
      // 330s ceiling an upload needs — a phone photo on mobile data outruns the
      // 45s a JSON request gets — and the uploading/waiting boundary that
      // separates "nothing was sent, retry" from "this may already have saved".
      const upload = await postUpload(`/api/vehicles/${editingVehicle.id}`, formData, { method: 'PUT' });
      if (!upload.ok && (upload.kind !== 'http' || !upload.json)) {
        setEditError(uploadErrorMessage(upload, 'vehicle'));
        return;
      }
      const res = { ok: upload.ok, status: upload.status };
      const json = upload.json;
      // An EDIT names the record it is writing onto, so the server withdraws
      // both overwrite and keep-both: the prompt shows what this change would
      // collide with and links to it. No `resubmit` — there is nothing to send.
      if (duplicate.intercept(res, json, {
        newFile: editFile,
        newTitle: editVehicleName,
      })) return;
      if (json.success) {
        setEditingVehicle(null);
        fetchVehicles();
      } else {
        setEditError(json.error || 'Update failed');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[vehicles] handler threw', err);
      setEditError('Something went wrong updating vehicle details. Please try again.');
    } finally {
      setEditSaving(false);
    }
  };

  const fetchVehicles = async () => {
    try {
      const { json } = await apiCall('/api/vehicles');
      if (json.success) {
        setVehicles(json.vehicles);
      } else {
        setError(json.error || 'Failed to fetch vehicles');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[vehicles] handler threw', err);
      setError('Something went wrong fetching vehicles. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchVehicles();
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
            const perm = u.permissions?.find(p => p.module === 'vehicle' && !p.documentKey);
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
    setVehicleName('');
    setVehicleNumber('');
    setOwnerName('');
    setRegistrationDate('');
    setInsuranceExpiry('');
    setPucExpiry('');
    setFitnessExpiry('');
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
    if (!vehicleName || !vehicleNumber || !ownerName || !registrationDate || !insuranceExpiry || !pucExpiry || !fitnessExpiry) {
      setFormError('Please fill in all fields');
      return;
    }
    setFormError('');
    setSaving(true);

    const formData = new FormData();
    formData.append('vehicleName', vehicleName);
    formData.append('holderId', holderPayload(holderId));
    formData.append('vehicleNumber', vehicleNumber);
    formData.append('ownerName', ownerName);
    formData.append('registrationDate', registrationDate);
    formData.append('insuranceExpiry', insuranceExpiry);
    formData.append('pucExpiry', pucExpiry);
    formData.append('fitnessExpiry', fitnessExpiry);
    formData.append('lastServiceDate', lastServiceDate);
    formData.append('nextServiceDate', nextServiceDate);
    formData.append('serviceNotes', serviceNotes);
    formData.append('customFields', JSON.stringify(customFields));
    if (file) {
      formData.append('file', file);
    }

    try {
      // The answer to the duplicate prompt, when this submit is one.
      if (answer.force) formData.append('forceSave', 'true');
      if (answer.keepBoth) formData.append('keepBoth', 'true');

      // `postUpload`, not `apiCall`: this is a multipart write. It carries the
      // 330s ceiling an upload needs — a phone photo on mobile data outruns the
      // 45s a JSON request gets — and the uploading/waiting boundary that
      // separates "nothing was sent, retry" from "this may already have saved".
      const upload = await postUpload('/api/vehicles', formData);
      if (!upload.ok && (upload.kind !== 'http' || !upload.json)) {
        setFormError(uploadErrorMessage(upload, 'vehicle'));
        return;
      }
      const res = { ok: upload.ok, status: upload.status };
      const json = upload.json;
      // Already on file. Not a failure — a question, and the prompt is where it
      // gets asked: keep the record on file, overwrite it, or keep both.
      if (duplicate.intercept(res, json, {
        newFile: file,
        newTitle: vehicleName,
        resubmit: (next) => handleSubmit(null, next),
      })) return;
      if (json.success) {
        closeAddForm();
        // Refresh list
        fetchVehicles();
      } else {
        setFormError(json.error || 'Save failed');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[vehicles] handler threw', err);
      setFormError('Something went wrong saving vehicle. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this vehicle record?')) return;
    try {
      const { json } = await apiCall(`/api/vehicles/${id}`, { method: 'DELETE' });
      if (json.success) {
        fetchVehicles();
      } else {
        toast.error(json.error || 'Failed to delete');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[vehicles] handler threw', err);
      toast.error('Something went wrong deleting record. Please try again.');
    }
  };

  const handleGenerateFollowups = async (v) => {
    try {
      setIsGeneratingFollowup(v.id);
      const { res, json: data } = await apiCall(`/api/vehicles/${v.id}/generate-followups`, {
        method: 'POST',
      });
      
      if (res.ok) {
        toast.success(data.message || 'Follow-ups generated successfully');
      } else {
        toast.error(data.error || 'Failed to generate follow-ups');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[vehicles] handler threw', err);
      toast.error('Something went wrong . Please try again. Please try again.');
      console.error(err);
    } finally {
      setIsGeneratingFollowup(null);
    }
  };

  const handleShare = async (v) => {
    const fields = [
      { label: 'Vehicle Name', value: v.vehicleName },
      { label: 'Vehicle Number', value: v.vehicleNumber },
      { label: 'Owner Name', value: v.ownerName },
      { label: 'Registration Date', value: formatDate(v.registrationDate) },
      { label: 'Insurance Expiry', value: formatDate(v.insuranceExpiry) },
      { label: 'PUC Expiry', value: formatDate(v.pucExpiry) },
      { label: 'Fitness Expiry', value: formatDate(v.fitnessExpiry) }
    ];
    if (v.lastServiceDate) fields.push({ label: 'Last Service Date', value: formatDate(v.lastServiceDate) });
    if (v.nextServiceDate) fields.push({ label: 'Next Service Date', value: formatDate(v.nextServiceDate) });
    if (v.serviceNotes) fields.push({ label: 'Service Notes', value: v.serviceNotes });
    if (Array.isArray(v.customFields)) {
      v.customFields.forEach(f => {
        fields.push({ label: f.label, value: f.value });
      });
    }
    const res = await shareRecord(`Vehicle Details - ${v.vehicleName}`, fields, undefined, v.filePath,
      { fileName: v.fileName, mimeType: v.mimeType, pageCount: v.pageCount });
    reportShareResult(res);
  };

  const handlePrint = (v) => {
    const fields = [
      { label: 'Vehicle Name', value: v.vehicleName },
      { label: 'Vehicle Number', value: v.vehicleNumber },
      { label: 'Owner Name', value: v.ownerName },
      { label: 'Registration Date', value: formatDate(v.registrationDate) },
      { label: 'Insurance Expiry', value: formatDate(v.insuranceExpiry) },
      { label: 'PUC Expiry', value: formatDate(v.pucExpiry) },
      { label: 'Fitness Expiry', value: formatDate(v.fitnessExpiry) }
    ];
    if (v.lastServiceDate) fields.push({ label: 'Last Service Date', value: formatDate(v.lastServiceDate) });
    if (v.nextServiceDate) fields.push({ label: 'Next Service Date', value: formatDate(v.nextServiceDate) });
    if (v.serviceNotes) fields.push({ label: 'Service Notes', value: v.serviceNotes });
    if (Array.isArray(v.customFields)) {
      v.customFields.forEach(f => {
        fields.push({ label: f.label, value: f.value });
      });
    }
    printRecord(`Vehicle Details - ${v.vehicleName}`, fields, undefined, v.filePath);
  };

  // Expiry styling utility
  const getExpiryItem = (label, dateStr) => {
    const date = new Date(dateStr);
    const now = new Date();
    const daysLeft = Math.ceil((date - now) / (1000 * 60 * 60 * 24));
    
    let colorClass = 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
    if (daysLeft < 0) {
      colorClass = 'text-rose-400 bg-rose-500/10 border-rose-500/20';
    } else if (daysLeft <= 10) {
      colorClass = 'text-rose-400 bg-rose-500/10 border-rose-500/20';
    } else if (daysLeft <= 30) {
      colorClass = 'text-amber-400 bg-amber-500/10 border-amber-500/20';
    }

    return (
      <div className="flex justify-between items-center p-2.5 bg-muted/20 border border-border/30 rounded-xl text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={`px-2 py-0.5 rounded border text-xs font-bold flex items-center gap-1 ${colorClass}`}>
          {formatDate(date)} 
          <span className="opacity-80 font-normal">
            ({daysLeft < 0 ? `Overdue ${Math.abs(daysLeft)}d` : `${daysLeft}d left`})
          </span>
        </span>
      </div>
    );
  };

  const filteredVehicles = vehicles.filter(v => {
    return (
      v.vehicleName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      v.vehicleNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      v.ownerName.toLowerCase().includes(searchTerm.toLowerCase())
    );
  });

  if (loading) {
    return (
      <PageContainer>
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-10 w-10 rounded-full" />
        </div>
        <Skeleton className="h-12 w-full rounded-xl" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[...Array(4)].map((_, i) => (
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
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground">Vehicles</h1>
          <p className="text-muted-foreground text-sm">Track registrations, PUC certificates, & insurance expiry schedules</p>
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

      {/* Add Vehicle Form */}
      {showAddForm && (
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass p-6 md:p-8 animate-scale-in">
          <CardHeader className="p-0 pb-4 border-b border-border/50 mb-6">
            <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
              <Car className="text-amber-400" size={20} />
              <span>Save Vehicle Records</span>
            </h2>
          </CardHeader>

          

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="vehicleName">Vehicle Name *</Label>
                <Input
                  id="vehicleName"
                  placeholder="e.g. Honda City"
                  value={vehicleName}
                  onChange={(e) => setVehicleName(e.target.value)}
                  disabled={saving}
                />
              </div>

              <HolderSelect value={holderId} onChange={setHolderId} disabled={saving} />

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="vehicleNumber">Vehicle Number *</Label>
                <Input
                  id="vehicleNumber"
                  placeholder="MH-12-XX-1234"
                  value={vehicleNumber}
                  onChange={(e) => setVehicleNumber(e.target.value.toUpperCase())}
                  disabled={saving}
                  className="uppercase font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ownerName">Registered Owner *</Label>
                <Input
                  id="ownerName"
                  placeholder="e.g. Sunil Gadhiya"
                  value={ownerName}
                  onChange={(e) => setOwnerName(e.target.value)}
                  disabled={saving}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="registrationDate">Registration Date *</Label>
                <Input
                  id="registrationDate"
                  type="date"
                  value={registrationDate}
                  onChange={(e) => setRegistrationDate(e.target.value)}
                  disabled={saving}
                />
              </div>
            </div>

            <div className="border border-dashed border-border rounded-xl p-4 bg-muted/10 flex flex-col gap-4">
              <span className="text-xs font-bold text-primary uppercase tracking-wider">Expiry Timelines</span>
              
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="insuranceExpiry" className="text-xs">Insurance Expiry *</Label>
                  <Input
                    id="insuranceExpiry"
                    type="date"
                    value={insuranceExpiry}
                    onChange={(e) => setInsuranceExpiry(e.target.value)}
                    disabled={saving}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="pucExpiry" className="text-xs">PUC Expiry *</Label>
                  <Input
                    id="pucExpiry"
                    type="date"
                    value={pucExpiry}
                    onChange={(e) => setPucExpiry(e.target.value)}
                    disabled={saving}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="fitnessExpiry" className="text-xs">Fitness Expiry *</Label>
                  <Input
                    id="fitnessExpiry"
                    type="date"
                    value={fitnessExpiry}
                    onChange={(e) => setFitnessExpiry(e.target.value)}
                    disabled={saving}
                  />
                </div>
              </div>
            </div>

            <div className="border border-dashed border-border rounded-xl p-4 bg-muted/10 flex flex-col gap-4">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Service Tracking</span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="lastServiceDate" className="text-xs">Last Service Date</Label>
                  <Input
                    id="lastServiceDate"
                    type="date"
                    value={lastServiceDate}
                    onChange={(e) => setLastServiceDate(e.target.value)}
                    disabled={saving}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="nextServiceDate" className="text-xs">Next Service Due Date</Label>
                  <Input
                    id="nextServiceDate"
                    type="date"
                    value={nextServiceDate}
                    onChange={(e) => setNextServiceDate(e.target.value)}
                    disabled={saving}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="serviceNotes" className="text-xs">Service Notes</Label>
                <Input
                  id="serviceNotes"
                  placeholder="E.g. Changed oil, next time check brake pads"
                  value={serviceNotes}
                  onChange={(e) => setServiceNotes(e.target.value)}
                  disabled={saving}
                />
              </div>
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
                  disabled={saving}
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
                        placeholder="Label (e.g. Engine Number)"
                        value={field.label}
                        onChange={(e) => {
                          const updated = [...customFields];
                          updated[fIdx] = { ...updated[fIdx], label: e.target.value };
                          setCustomFields(updated);
                        }}
                        className="flex-1 h-9 text-sm"
                        disabled={saving}
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
                        disabled={saving}
                      />
                      <Button
                        type="button"
                        variant="destructive"
                        size="icon"
                        onClick={() => setCustomFields(prev => prev.filter((_, idx) => idx !== fIdx))}
                        className="h-9 w-9 shrink-0"
                        disabled={saving}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Upload RC copy / Insurance PDF (Optional)</Label>
              <div className="border-2 border-dashed border-border/50 rounded-xl p-6 text-center bg-card hover:bg-card transition-colors relative cursor-pointer">
                <input
                  type="file"
                  accept={UPLOAD_ACCEPT_ATTRIBUTE}
                  onChange={handleFileChange}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  disabled={saving}
                />
                <Upload size={20} className="mx-auto text-muted-foreground mb-2" />
                <p className="text-xs font-semibold text-foreground">
                  {file ? file.name : 'Select file (Drag & Drop or Click)'}
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
                disabled={saving}
                className="h-11 px-6"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={saving}
                className="h-11 flex-1"
              >
                {saving ? 'Saving vehicle records...' : 'Add Vehicle'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* Search Toolbar */}
      <div className="relative animate-fade-in">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" size={18} />
        <Input
          placeholder="Search by name, number, owner..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-10 h-11 bg-card border-border/50"
        />
      </div>

      {/* Error / List State */}
      {error ? (
        <div className="text-red-500 bg-red-500/10 p-4 rounded-lg">{error}</div>
      ) : filteredVehicles.length === 0 ? (
        <Card className="border-border/30 bg-card backdrop-blur p-12 text-center animate-fade-in">
          <Car size={48} className="mx-auto text-faint mb-3" />
          <p className="text-muted-foreground text-sm font-medium">No vehicles registered yet</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {filteredVehicles.map((v, index) => (
            <Card 
              key={v.id}
              className="border-border/50 bg-card backdrop-blur shadow-glass hover:bg-card transition-colors p-5 flex flex-col gap-4 animate-fade-in"
            >
              {/* Header */}
              <div className="flex justify-between items-start gap-2">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="p-2 rounded-xl border shrink-0 text-amber-400 bg-amber-500/10 border-amber-500/20">
                    <Car size={18} />
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="font-bold text-foreground text-sm truncate">{v.vehicleName}</span>
                    <span className="text-xs text-muted-foreground font-mono mt-0.5">
                      {v.vehicleNumber}
                    </span>
                  </div>
                </div>
                
                <div className="relative flex items-center gap-1.5 shrink-0">
                  <Button 
                    onClick={() => handleShare(v)}
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
                  {v.filePath && (
                    <Button
                      onClick={() => setPreviewDoc({
                        name: v.vehicleName,
                        filePath: v.filePath,
                        mimeType: v.mimeType,
                        pageCount: v.pageCount
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
                        onClick: () => handlePrint(v),
                      },
                      {
                        key: 'download',
                        icon: <Download size={12} />,
                        label: 'Download',
                        onClick: () => {
                          downloadRecord(`Vehicle - ${v.vehicleName}`, [
                            { label: 'Vehicle Name', value: v.vehicleName },
                            { label: 'Vehicle Number', value: v.vehicleNumber },
                            { label: 'Owner Name', value: v.ownerName },
                            { label: 'Registration Date', value: formatDate(v.registrationDate) },
                            { label: 'Insurance Expiry', value: formatDate(v.insuranceExpiry) },
                            { label: 'PUC Expiry', value: formatDate(v.pucExpiry) },
                            { label: 'Fitness Expiry', value: formatDate(v.fitnessExpiry) },
                            ...(Array.isArray(v.customFields) ? v.customFields.map(f => ({ label: f.label, value: f.value })) : [])
                          ], '', v.filePath);
                        },
                      },
                      {
                        key: 'edit',
                        icon: <Pencil size={12} />,
                        label: 'Edit',
                        onClick: () => openEditModal(v),
                      },
                      {
                        key: 'followups',
                        icon: <ListTodo size={12} className={isGeneratingFollowup === v.id ? 'animate-spin' : ''} />,
                        label: isGeneratingFollowup === v.id ? 'Generating...' : 'Generate Follow-ups',
                        disabled: isGeneratingFollowup === v.id,
                        onClick: () => handleGenerateFollowups(v),
                      },
                      {
                        key: 'delete',
                        icon: <Trash2 size={12} />,
                        label: 'Delete',
                        destructive: true,
                        onClick: () => handleDelete(v.id),
                      },
                    ]}
                  />
                </div>
              </div>

              {/* Ownership details */}
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground border-b border-border/30 pb-3">
                <span className="flex items-center gap-1.5">
                  <User size={13} className="text-amber-400 shrink-0" /> Owner: <span className="font-medium text-foreground">{v.ownerName}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <Calendar size={13} className="shrink-0" /> Registered: <span className="font-medium text-foreground">{formatDate(v.registrationDate)}</span>
                </span>
              </div>

              {/* Renewals timelines details */}
              <div className="flex flex-col gap-2">
                {getExpiryItem('Insurance Expiry', v.insuranceExpiry)}
                {getExpiryItem('PUC Certificate Expiry', v.pucExpiry)}
                {getExpiryItem('Fitness Certificate Expiry', v.fitnessExpiry)}
              </div>

              {/* Service Tracking */}
              {(v.lastServiceDate || v.nextServiceDate || v.serviceNotes) && (
                <div className="flex flex-col gap-2 mt-2 pt-2 border-t border-border/20">
                  {v.lastServiceDate && (
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-muted-foreground flex items-center gap-1.5"><Activity size={12} /> Last Service Date:</span>
                      <span className="font-semibold text-foreground">{formatDate(v.lastServiceDate)}</span>
                    </div>
                  )}
                  {v.nextServiceDate && getExpiryItem('Next Service Due', v.nextServiceDate)}
                  {v.serviceNotes && (
                    <div className="text-xs text-muted-foreground italic mt-1 bg-muted/20 p-2 rounded-md border border-border/10">
                      Note: {v.serviceNotes}
                    </div>
                  )}
                </div>
              )}

              {/* Render custom fields */}
              {Array.isArray(v.customFields) && v.customFields.length > 0 && (
                <div className="flex flex-col gap-1.5 border-t border-border/20 pt-3 mt-1">
                  {v.customFields.map((f, idx) => (
                    <div key={idx} className="flex justify-between items-center text-xs">
                      <span className="text-muted-foreground">{f.label}:</span>
                      <span className="font-semibold text-foreground font-mono">{f.value}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Preview Modal — one pane for every stored format. See
          DocumentPreviewDialog for why this is no longer written per page. */}
      <DocumentPreviewDialog doc={previewDoc} onClose={() => setPreviewDoc(null)} />

      {/* Edit Vehicle Modal */}
      <Dialog open={!!editingVehicle} onOpenChange={(open) => !open && setEditingVehicle(null)}>
        {editingVehicle && (
          <DialogContent aria-describedby={undefined} className="max-w-2xl max-h-[90vh] flex flex-col py-6 overflow-y-auto border-border/50 bg-card/95 backdrop-blur-md">
            <DialogHeader className="p-0 pb-4 border-b border-border/30">
              <DialogTitle className="text-lg font-bold">Edit Vehicle Record</DialogTitle>
            </DialogHeader>

            

            <form onSubmit={handleEditSubmit} className="flex flex-col gap-5 mt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editVehicleName">Vehicle Name *</Label>
                  <Input
                    id="editVehicleName"
                    value={editVehicleName}
                    onChange={(e) => setEditVehicleName(e.target.value)}
                    disabled={editSaving}
                  />
                </div>

                <HolderSelect id="editHolderId" value={editHolderId} onChange={setEditHolderId} disabled={editSaving} />

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editVehicleNumber">Vehicle Number *</Label>
                  <Input
                    id="editVehicleNumber"
                    value={editVehicleNumber}
                    onChange={(e) => setEditVehicleNumber(e.target.value.toUpperCase())}
                    disabled={editSaving}
                    className="uppercase font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editOwnerName">Owner Name *</Label>
                  <Input
                    id="editOwnerName"
                    value={editOwnerName}
                    onChange={(e) => setEditOwnerName(e.target.value)}
                    disabled={editSaving}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editRegistrationDate">Registration Date *</Label>
                  <Input
                    id="editRegistrationDate"
                    type="date"
                    value={editRegistrationDate}
                    onChange={(e) => setEditRegistrationDate(e.target.value)}
                    disabled={editSaving}
                  />
                </div>
              </div>

              <div className="border border-dashed border-border rounded-xl p-4 bg-muted/10 flex flex-col gap-4">
                <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Expiry Timelines</span>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="editInsuranceExpiry" className="text-xs">Insurance Expiry *</Label>
                    <Input
                      id="editInsuranceExpiry"
                      type="date"
                      value={editInsuranceExpiry}
                      onChange={(e) => setEditInsuranceExpiry(e.target.value)}
                      disabled={editSaving}
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="editPucExpiry" className="text-xs">PUC Expiry *</Label>
                    <Input
                      id="editPucExpiry"
                      type="date"
                      value={editPucExpiry}
                      onChange={(e) => setEditPucExpiry(e.target.value)}
                      disabled={editSaving}
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="editFitnessExpiry" className="text-xs">Fitness Expiry *</Label>
                    <Input
                      id="editFitnessExpiry"
                      type="date"
                      value={editFitnessExpiry}
                      onChange={(e) => setEditFitnessExpiry(e.target.value)}
                      disabled={editSaving}
                    />
                  </div>
                </div>
              </div>

              <div className="border border-dashed border-border rounded-xl p-4 bg-muted/10 flex flex-col gap-4">
                <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Service Tracking</span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="editLastServiceDate" className="text-xs">Last Service Date</Label>
                    <Input
                      id="editLastServiceDate"
                      type="date"
                      value={editLastServiceDate}
                      onChange={(e) => setEditLastServiceDate(e.target.value)}
                      disabled={editSaving}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="editNextServiceDate" className="text-xs">Next Service Due Date</Label>
                    <Input
                      id="editNextServiceDate"
                      type="date"
                      value={editNextServiceDate}
                      onChange={(e) => setEditNextServiceDate(e.target.value)}
                      disabled={editSaving}
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editServiceNotes" className="text-xs">Service Notes</Label>
                  <Input
                    id="editServiceNotes"
                    placeholder="E.g. Changed oil, next time check brake pads"
                    value={editServiceNotes}
                    onChange={(e) => setEditServiceNotes(e.target.value)}
                    disabled={editSaving}
                  />
                </div>
              </div>

              {/* File Upload */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="editFile">Replace RC Copy / Insurance Document (Optional)</Label>
                <Input
                  id="editFile"
                  type="file"
                  accept={UPLOAD_ACCEPT_ATTRIBUTE}
                  onChange={handleEditFileChange}
                  disabled={editSaving}
                  className="h-10 text-sm"
                />
                {editingVehicle.filePath && (
                  <span className="text-xs text-muted-foreground mt-1">
                    Current File: {editingVehicle.filePath.split('/').pop()}
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

              <div className="flex justify-end gap-3 border-t border-border/30 pt-5 mt-4">
                <Button type="button" variant="secondary" onClick={() => setEditingVehicle(null)} disabled={editSaving}>
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
