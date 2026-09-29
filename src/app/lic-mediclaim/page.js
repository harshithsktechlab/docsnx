'use client';

import {
  formatDate } from '@/lib/dateHelper';
import React,
  { useEffect,
  useState } from 'react';
import { 
  FileCheck2,
  Plus,
  X,
  Upload,
  Search,
  Download,
  Trash2,
  Calendar,
  AlertCircle,
  Sparkles,
  RefreshCw,
  Coins,
  Share2,
  Printer,
  Eye,
  AlertTriangle,
  Lightbulb,
  CheckCircle2,
  Pencil,
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
import { UPLOAD_ACCEPT_ATTRIBUTE } from '@/lib/records/uploadTypes';
import HolderSelect, { ALL_MEMBERS, holderValue, holderPayload } from '@/app/components/HolderSelect';
import PageContainer from '@/app/components/PageContainer';
import DuplicateResolveDialog from '@/components/records/DuplicateResolveDialog';
import useDuplicateResolve from '@/components/records/useDuplicateResolve';
import { apiCall } from '@/lib/net/apiRequest';
import { postUpload, uploadErrorMessage } from '@/lib/records/uploadRequest';
import { toastApiError } from '@/lib/net/toastApiError';


export default function LicMediclaimPage() {
  const [policies, setPolicies] = useState([]);
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
  const [policyType, setPolicyType] = useState('lic'); // "lic" or "mediclaim"
  const [companyName, setCompanyName] = useState('');
  const [policyName, setPolicyName] = useState('');
  const [holderId, setHolderId] = useState(ALL_MEMBERS);
  const [policyNumber, setPolicyNumber] = useState('');
  const [insuredPerson, setInsuredPerson] = useState('');
  const [sumAssured, setSumAssured] = useState('');
  const [premiumAmount, setPremiumAmount] = useState('');
  const [premiumDueDate, setPremiumDueDate] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [file, setFile] = useState(null); // Policy Document
  const [customFields, setCustomFields] = useState([]);

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // AI loading status (for regenerating suggestions)
  const [regeneratingId, setRegeneratingId] = useState(null);

  // Edit Form State
  const [editingPolicy, setEditingPolicy] = useState(null);
  const [editPolicyType, setEditPolicyType] = useState('lic');
  const [editCompanyName, setEditCompanyName] = useState('');
  const [editPolicyName, setEditPolicyName] = useState('');
  const [editHolderId, setEditHolderId] = useState(ALL_MEMBERS);
  const [editPolicyNumber, setEditPolicyNumber] = useState('');
  const [editInsuredPerson, setEditInsuredPerson] = useState('');
  const [editSumAssured, setEditSumAssured] = useState('');
  const [editPremiumAmount, setEditPremiumAmount] = useState('');
  const [editPremiumDueDate, setEditPremiumDueDate] = useState('');
  const [editExpiryDate, setEditExpiryDate] = useState('');
  const [editFile, setEditFile] = useState(null);
  const [editCustomFields, setEditCustomFields] = useState([]);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const openEditModal = (p) => {
    setEditingPolicy(p);
    setEditPolicyType(p.policyType || 'lic');
    setEditCompanyName(p.companyName || '');
    setEditPolicyName(p.policyName || '');
    setEditHolderId(holderValue(p.holderId));
    setEditPolicyNumber(p.policyNumber || '');
    setEditInsuredPerson(p.insuredPerson || '');
    setEditSumAssured(p.sumAssured || '');
    setEditPremiumAmount(p.premiumAmount || '');
    setEditPremiumDueDate(p.premiumDueDate ? new Date(p.premiumDueDate).toISOString().split('T')[0] : '');
    setEditExpiryDate(p.expiryDate ? new Date(p.expiryDate).toISOString().split('T')[0] : '');
    setEditFile(null);
    setEditCustomFields(Array.isArray(p.customFields) ? [...p.customFields] : []);
    setEditError('');
  };

  const handleAiScan = async () => {
    const selectedFile = editingPolicy ? editFile : file;
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

        const extPolicyType = data.policyType || 'lic';
        const extCompanyName = data.companyName || '';
        const extPolicyName = data.policyName || '';
        const extPolicyNumber = data.policyNumber || '';
        const extInsuredPerson = data.insuredPerson || '';
        const extSumAssured = data.sumAssured || '';
        const extPremiumAmount = data.premiumAmount || '';
        const extPremiumDueDate = data.premiumDueDate ? data.premiumDueDate.substring(0, 10) : '';
        const extExpiryDate = data.expiryDate ? data.expiryDate.substring(0, 10) : '';

        if (editingPolicy) {
          if (extPolicyType) setEditPolicyType(extPolicyType);
          if (extCompanyName) setEditCompanyName(extCompanyName);
          if (extPolicyName) setEditPolicyName(extPolicyName);
          if (extPolicyNumber) setEditPolicyNumber(extPolicyNumber);
          if (extInsuredPerson) setEditInsuredPerson(extInsuredPerson);
          if (extSumAssured) setEditSumAssured(extSumAssured);
          if (extPremiumAmount) setEditPremiumAmount(extPremiumAmount);
          if (extPremiumDueDate) setEditPremiumDueDate(extPremiumDueDate);
          if (extExpiryDate) setEditExpiryDate(extExpiryDate);
        } else {
          if (extPolicyType) setPolicyType(extPolicyType);
          if (extCompanyName) setCompanyName(extCompanyName);
          if (extPolicyName) setPolicyName(extPolicyName);
          if (extPolicyNumber) setPolicyNumber(extPolicyNumber);
          if (extInsuredPerson) setInsuredPerson(extInsuredPerson);
          if (extSumAssured) setSumAssured(extSumAssured);
          if (extPremiumAmount) setPremiumAmount(extPremiumAmount);
          if (extPremiumDueDate) setPremiumDueDate(extPremiumDueDate);
          if (extExpiryDate) setExpiryDate(extExpiryDate);
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
      console.error('[lic-mediclaim] handler threw', err);
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
    if (!editingPolicy) return;
    if (!editPolicyType || !editCompanyName || !editPolicyName || !editPolicyNumber || !editInsuredPerson || !editSumAssured || !editPremiumAmount || !editPremiumDueDate) {
      setEditError('Please fill in required fields');
      return;
    }
    setEditSaving(true);
    setEditError('');

    const formData = new FormData();
    formData.append('policyType', editPolicyType);
    formData.append('companyName', editCompanyName);
    formData.append('policyName', editPolicyName);
    formData.append('holderId', holderPayload(editHolderId));
    formData.append('policyNumber', editPolicyNumber);
    formData.append('insuredPerson', editInsuredPerson);
    formData.append('sumAssured', editSumAssured);
    formData.append('premiumAmount', editPremiumAmount);
    formData.append('premiumDueDate', editPremiumDueDate);
    formData.append('customFields', JSON.stringify(editCustomFields));
    if (editExpiryDate) {
      formData.append('expiryDate', editExpiryDate);
    }
    if (editFile) {
      formData.append('file', editFile);
    }

    try {
      // `postUpload`, not `apiCall`: this is a multipart write. It carries the
      // 330s ceiling an upload needs — a phone photo on mobile data outruns the
      // 45s a JSON request gets — and the uploading/waiting boundary that
      // separates "nothing was sent, retry" from "this may already have saved".
      const upload = await postUpload(`/api/lic-mediclaim/${editingPolicy.id}`, formData, { method: 'PUT' });
      if (!upload.ok && (upload.kind !== 'http' || !upload.json)) {
        setEditError(uploadErrorMessage(upload, 'policy'));
        return;
      }
      const res = { ok: upload.ok, status: upload.status };
      const json = upload.json;
      // An EDIT names the record it is writing onto, so the server withdraws
      // both overwrite and keep-both: the prompt shows what this change would
      // collide with and links to it. No `resubmit` — there is nothing to send.
      if (duplicate.intercept(res, json, {
        newFile: editFile,
        newTitle: editPolicyName,
      })) return;
      if (json.success) {
        setEditingPolicy(null);
        fetchPolicies();
      } else {
        setEditError(json.error || 'Update failed');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[lic-mediclaim] handler threw', err);
      setEditError('Something went wrong updating policy details. Please try again.');
    } finally {
      setEditSaving(false);
    }
  };

  const fetchPolicies = async () => {
    try {
      const { json } = await apiCall('/api/lic-mediclaim');
      if (json.success) {
        setPolicies(json.licMediclaims);
      } else {
        setError(json.error || 'Failed to fetch policies');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[lic-mediclaim] handler threw', err);
      setError('Something went wrong fetching policies. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPolicies();
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
            const perm = u.permissions?.find(p => p.module === 'insurance' && !p.documentKey);
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
    setCompanyName('');
    setPolicyName('');
    setPolicyNumber('');
    setInsuredPerson('');
    setSumAssured('');
    setPremiumAmount('');
    setPremiumDueDate('');
    setExpiryDate('');
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
    if (!policyType || !companyName || !policyName || !policyNumber || !insuredPerson || !sumAssured || !premiumAmount || !premiumDueDate) {
      setFormError('Please fill in required fields');
      return;
    }
    setFormError('');
    setSaving(true);

    const formData = new FormData();
    formData.append('policyType', policyType);
    formData.append('companyName', companyName);
    formData.append('policyName', policyName);
    formData.append('holderId', holderPayload(holderId));
    formData.append('policyNumber', policyNumber);
    formData.append('insuredPerson', insuredPerson);
    formData.append('sumAssured', sumAssured);
    formData.append('premiumAmount', premiumAmount);
    formData.append('premiumDueDate', premiumDueDate);
    formData.append('customFields', JSON.stringify(customFields));
    if (expiryDate) {
      formData.append('expiryDate', expiryDate);
    }
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
      const upload = await postUpload('/api/lic-mediclaim', formData);
      if (!upload.ok && (upload.kind !== 'http' || !upload.json)) {
        setFormError(uploadErrorMessage(upload, 'policy'));
        return;
      }
      const res = { ok: upload.ok, status: upload.status };
      const json = upload.json;
      // Already on file. Not a failure — a question, and the prompt is where it
      // gets asked: keep the record on file, overwrite it, or keep both.
      if (duplicate.intercept(res, json, {
        newFile: file,
        newTitle: policyName,
        resubmit: (next) => handleSubmit(null, next),
      })) return;
      if (json.success) {
        closeAddForm();
        // Refresh list
        fetchPolicies();
      } else {
        setFormError(json.error || 'Save failed');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[lic-mediclaim] handler threw', err);
      setFormError('Something went wrong saving policy. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this policy record?')) return;
    try {
      const { json } = await apiCall(`/api/lic-mediclaim/${id}`, { method: 'DELETE' });
      if (json.success) {
        fetchPolicies();
      } else {
        toast.error(json.error || 'Failed to delete');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[lic-mediclaim] handler threw', err);
      toast.error('Something went wrong deleting record. Please try again.');
    }
  };

  const handleRegenerateAI = async (id) => {
    setRegeneratingId(id);
    try {
      const { json } = await apiCall(`/api/lic-mediclaim/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regenerateAI: true })
      });
      if (json.success) {
        fetchPolicies();
      } else {
        toast.error(json.error || 'Failed to regenerate AI suggestions');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[lic-mediclaim] handler threw', err);
      toast.error('Something went wrong regenerating suggestions. Please try again.');
    } finally {
      setRegeneratingId(null);
    }
  };

  const handleShare = async (p) => {
    const fields = [
      { label: 'Policy Type', value: p.policyType === 'lic' ? 'Life Insurance' : 'Mediclaim' },
      { label: 'Company Name', value: p.companyName },
      { label: 'Policy Name', value: p.policyName },
      { label: 'Policy Number', value: p.policyNumber },
      { label: 'Insured Person', value: p.insuredPerson },
      { label: 'Sum Assured', value: `INR ${Number(p.sumAssured).toLocaleString()}` },
      { label: 'Premium Amount', value: `INR ${Number(p.premiumAmount).toLocaleString()}` },
      { label: 'Premium Due Date', value: formatDate(p.premiumDueDate) },
      { label: 'Expiry Date', value: p.expiryDate ? formatDate(p.expiryDate) : '' }
    ];
    if (Array.isArray(p.customFields)) {
      p.customFields.forEach(f => {
        fields.push({ label: f.label, value: f.value });
      });
    }
    const analysisText = p.aiAnalysis 
      ? `AI Analysis:\nRisks: ${p.aiAnalysis.risks?.join(' | ')}\nOpportunities: ${p.aiAnalysis.opportunities?.join(' | ')}\nTips: ${p.aiAnalysis.tips?.join(' | ')}`
      : '';
    const res = await shareRecord(`Insurance Policy - ${p.policyName}`, fields, analysisText, p.filePath,
      { fileName: p.fileName, mimeType: p.mimeType, pageCount: p.pageCount });
    reportShareResult(res);
  };

  const handlePrint = (p) => {
    const fields = [
      { label: 'Policy Type', value: p.policyType === 'lic' ? 'Life Insurance' : 'Mediclaim' },
      { label: 'Company Name', value: p.companyName },
      { label: 'Policy Name', value: p.policyName },
      { label: 'Policy Number', value: p.policyNumber },
      { label: 'Insured Person', value: p.insuredPerson },
      { label: 'Sum Assured', value: `INR ${Number(p.sumAssured).toLocaleString()}` },
      { label: 'Premium Amount', value: `INR ${Number(p.premiumAmount).toLocaleString()}` },
      { label: 'Premium Due Date', value: formatDate(p.premiumDueDate) },
      { label: 'Expiry Date', value: p.expiryDate ? formatDate(p.expiryDate) : '' }
    ];
    if (Array.isArray(p.customFields)) {
      p.customFields.forEach(f => {
        fields.push({ label: f.label, value: f.value });
      });
    }
    const analysisText = p.aiAnalysis 
      ? `AI Analysis:\nRisks: ${p.aiAnalysis.risks?.join(' | ')}\nOpportunities: ${p.aiAnalysis.opportunities?.join(' | ')}\nTips: ${p.aiAnalysis.tips?.join(' | ')}`
      : '';
    printRecord(`Insurance Policy - ${p.policyName}`, fields, analysisText, p.filePath);
  };

  const getRemindersLabel = (dueDateStr) => {
    const due = new Date(dueDateStr);
    const now = new Date();
    const daysLeft = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
    
    if (daysLeft < 0) {
      return <span className="px-2.5 py-0.5 rounded-full border text-xs font-bold text-rose-400 bg-rose-500/10 border-rose-500/20">OVERDUE by {Math.abs(daysLeft)} days</span>;
    } else if (daysLeft <= 15) {
      return <span className="px-2.5 py-0.5 rounded-full border text-xs font-bold text-rose-400 bg-rose-500/10 border-rose-500/20">DUE IN {daysLeft} DAYS!</span>;
    } else if (daysLeft <= 30) {
      return <span className="px-2.5 py-0.5 rounded-full border text-xs font-bold text-amber-400 bg-amber-500/10 border-amber-500/20">Due in {daysLeft} days</span>;
    }
    return <span className="px-2.5 py-0.5 rounded-full border text-xs font-bold text-muted-foreground bg-muted/20 border-border/30">Due in {daysLeft} days</span>;
  };

  const filteredPolicies = policies.filter(p => {
    const matchesSearch = 
      p.companyName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.policyName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.policyNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.insuredPerson.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesType = selectedType === 'all' || p.policyType === selectedType;
    return matchesSearch && matchesType;
  });

  const getPolicyColorClasses = (type) => {
    switch (type) {
      case 'lic': return 'text-sky-400 bg-sky-500/10 border-sky-500/20';
      default: return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
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
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-9 w-24 rounded-lg" />
          ))}
        </div>
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
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground">LIC & Mediclaim</h1>
          <p className="text-muted-foreground text-sm">Manage life & health insurance coverages</p>
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

      {/* Add Policy Form */}
      {showAddForm && (
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass p-6 md:p-8 animate-scale-in">
          <CardHeader className="p-0 pb-4 border-b border-border/50 mb-6">
            <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
              <FileCheck2 className="text-pink-400" size={20} />
              <span>Save Insurance Record</span>
            </h2>
          </CardHeader>

          

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="policyType">Policy Type *</Label>
                <Select value={policyType} onValueChange={(val) => setPolicyType(val)} disabled={saving}>
                  <SelectTrigger id="policyType">
                    <SelectValue placeholder="Select Policy Type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="lic">LIC / Life Insurance</SelectItem>
                    <SelectItem value="mediclaim">Mediclaim / Health</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="policyNumber">Policy Number *</Label>
                <Input
                  id="policyNumber"
                  placeholder="e.g. 123456789"
                  value={policyNumber}
                  onChange={(e) => setPolicyNumber(e.target.value)}
                  disabled={saving}
                  className="font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="companyName">Company Name *</Label>
                <Input
                  id="companyName"
                  placeholder="e.g. LIC of India"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  disabled={saving}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="policyName">Policy Name *</Label>
                <Input
                  id="policyName"
                  placeholder="e.g. Jeevan Anand"
                  value={policyName}
                  onChange={(e) => setPolicyName(e.target.value)}
                  disabled={saving}
                />
              </div>


              <HolderSelect value={holderId} onChange={setHolderId} disabled={saving} />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="insuredPerson">Insured Person *</Label>
                <Input
                  id="insuredPerson"
                  placeholder="e.g. Sunil Gadhiya"
                  value={insuredPerson}
                  onChange={(e) => setInsuredPerson(e.target.value)}
                  disabled={saving}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sumAssured">Sum Assured (INR) *</Label>
                <Input
                  id="sumAssured"
                  type="number"
                  placeholder="500000"
                  value={sumAssured}
                  onChange={(e) => setSumAssured(e.target.value)}
                  disabled={saving}
                  className="font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="premiumAmount">Premium Amount (INR) *</Label>
                <Input
                  id="premiumAmount"
                  type="number"
                  placeholder="15000"
                  value={premiumAmount}
                  onChange={(e) => setPremiumAmount(e.target.value)}
                  disabled={saving}
                  className="font-mono"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="premiumDueDate">Premium Due Date *</Label>
                <Input
                  id="premiumDueDate"
                  type="date"
                  value={premiumDueDate}
                  onChange={(e) => setPremiumDueDate(e.target.value)}
                  disabled={saving}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expiryDate">Policy Expiry / Maturity Date (Optional)</Label>
              <Input
                id="expiryDate"
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                disabled={saving}
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
                        placeholder="Label (e.g. Agent Name)"
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
              <Label>Upload Policy Schedule Copy (Optional)</Label>
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
                {saving ? 'Analyzing Policy with AI...' : 'Save Policy'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* Toolbar Search / Filter */}
      <div className="flex flex-col gap-4 animate-fade-in">
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" size={18} />
          <Input
            placeholder="Search company, policy name, insured..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 h-11 bg-card border-border/50"
          />
        </div>

        {/* Tab Filters */}
        <div className="flex flex-wrap gap-2">
          {[
            { value: 'all', label: 'All Policies' },
            { value: 'lic', label: 'Life (LIC)' },
            { value: 'mediclaim', label: 'Health (Mediclaim)' },
          ].map((cat) => (
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

      {/* Error / List State */}
      {error ? (
        <div className="text-red-500 bg-red-500/10 p-4 rounded-lg">{error}</div>
      ) : filteredPolicies.length === 0 ? (
        <Card className="border-border/30 bg-card backdrop-blur p-12 text-center animate-fade-in">
          <FileCheck2 size={48} className="mx-auto text-faint mb-3" />
          <p className="text-muted-foreground text-sm font-medium">No policy records saved yet</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {filteredPolicies.map((p, index) => {
            const typeColorClass = getPolicyColorClasses(p.policyType);
            return (
              <Card 
                key={p.id}
                className="border-border/50 bg-card backdrop-blur shadow-glass hover:bg-card transition-colors p-5 flex flex-col gap-4 animate-fade-in"
              >
                {/* Header */}
                <div className="flex justify-between items-start gap-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="p-2 rounded-xl border shrink-0 text-pink-400 bg-pink-500/10 border-pink-500/20">
                      <FileCheck2 size={18} />
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="font-bold text-foreground text-sm truncate">{p.companyName}</span>
                      <span className="text-xs text-muted-foreground truncate mt-0.5">
                        {p.policyName} (<span className="font-mono text-foreground">{p.policyNumber}</span>)
                      </span>
                    </div>
                  </div>

                  <div className="relative flex items-center gap-1.5 shrink-0">
                    <Button 
                      onClick={() => handleShare(p)}
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
                    {p.filePath && (
                      <Button
                        onClick={() => setPreviewDoc({
                          name: p.policyName + ' - ' + p.companyName,
                          filePath: p.filePath,
                          mimeType: p.mimeType,
                          pageCount: p.pageCount
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
                          onClick: () => handlePrint(p),
                        },
                        {
                          key: 'download',
                          icon: <Download size={12} />,
                          label: 'Download',
                          onClick: () => {
                            downloadRecord(`${p.policyType === 'lic' ? 'LIC' : 'Mediclaim'} - ${p.policyName}`, [
                              { label: 'Policy Type', value: p.policyType === 'lic' ? 'Life Insurance' : 'Health Insurance (Mediclaim)' },
                              { label: 'Company Name', value: p.companyName },
                              { label: 'Policy Name', value: p.policyName },
                              { label: 'Policy Number', value: p.policyNumber },
                              { label: 'Insured Person', value: p.insuredPerson },
                              { label: 'Sum Assured', value: p.sumAssured },
                              { label: 'Premium Amount', value: p.premiumAmount },
                              { label: 'Premium Due Date', value: formatDate(p.premiumDueDate) },
                              { label: 'Expiry Date', value: p.expiryDate ? formatDate(p.expiryDate) : '' },
                              ...(Array.isArray(p.customFields) ? p.customFields.map(f => ({ label: f.label, value: f.value })) : [])
                            ], p.aiAnalysis 
                              ? `AI Analysis:\nRisks: ${p.aiAnalysis.risks?.join(' | ')}\nOpportunities: ${p.aiAnalysis.opportunities?.join(' | ')}\nTips: ${p.aiAnalysis.tips?.join(' | ')}`
                              : '', p.filePath);
                          },
                        },
                        {
                          key: 'edit',
                          icon: <Pencil size={12} />,
                          label: 'Edit',
                          onClick: () => openEditModal(p),
                        },
                        {
                          key: 'delete',
                          icon: <Trash2 size={12} />,
                          label: 'Delete',
                          destructive: true,
                          onClick: () => handleDelete(p.id),
                        },
                      ]}
                    />
                  </div>
                </div>

                {/* Type Badge */}
                <div>
                  <span className={`px-2 py-0.5 rounded border text-2xs font-bold tracking-wider ${typeColorClass}`}>
                    {p.policyType === 'lic' ? 'LIFE INSURANCE' : 'HEALTH INSURANCE'}
                  </span>
                </div>

                {/* Coverages / Premium Info Grid */}
                <div className="bg-muted/20 border border-border/30 rounded-xl p-3 text-xs grid grid-cols-2 gap-3">
                  <div>
                    <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground block mb-0.5">Insured Person</span>
                    <span className="font-semibold text-foreground">{p.insuredPerson}</span>
                  </div>
                  <div>
                    <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground block mb-0.5">Sum Assured</span>
                    <span className="font-bold text-foreground">INR {Number(p.sumAssured).toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground block mb-0.5">Premium Amount</span>
                    <span className="font-bold text-foreground flex items-center gap-1">
                      <Coins size={13} className="text-amber-400" /> INR {Number(p.premiumAmount).toLocaleString()}
                    </span>
                  </div>
                  <div>
                    <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground block mb-0.5">Premium Due Date</span>
                    <span className="font-semibold text-foreground">{formatDate(p.premiumDueDate)}</span>
                  </div>
                </div>

                {/* Premium reminder calculation */}
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Status:</span>
                  {getRemindersLabel(p.premiumDueDate)}
                </div>

                {/* Render custom fields */}
                {Array.isArray(p.customFields) && p.customFields.length > 0 && (
                  <div className="flex flex-col gap-1.5 border-t border-border/20 pt-3 mt-1">
                    {p.customFields.map((f, idx) => (
                      <div key={idx} className="flex justify-between items-center text-xs">
                        <span className="text-muted-foreground">{f.label}:</span>
                        <span className="font-semibold text-foreground font-mono">{f.value}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Gemini AI Insights Highlight Box */}
                {p.aiAnalysis && (
                  <div className="bg-gradient-to-br from-violet-500/5 to-pink-500/5 border border-violet-500/20 rounded-xl p-4 flex flex-col gap-3">
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-bold text-violet-400 flex items-center gap-1.5 uppercase tracking-wider">
                        <Sparkles size={13} className="text-violet-400" />
                        <span>AI Insights</span>
                      </span>
                      <Button 
                        onClick={() => handleRegenerateAI(p.id)}
                        disabled={regeneratingId === p.id}
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs text-violet-400 border-violet-500/30 hover:bg-violet-500/10 hover:text-violet-300 rounded-lg px-2.5 flex items-center gap-1.5"
                      >
                        <RefreshCw size={11} className={regeneratingId === p.id ? 'animate-spin' : ''} /> 
                        <span>{regeneratingId === p.id ? 'Regenerating...' : 'Refresh'}</span>
                      </Button>
                    </div>
                    
                    <div className="flex flex-col gap-2">
                      {p.aiAnalysis.risks?.length > 0 && (
                        <div className="flex items-start gap-2">
                          <AlertTriangle size={14} className="text-amber-500 mt-0.5 shrink-0" />
                          <div className="flex flex-col gap-0.5">
                            {p.aiAnalysis.risks.map((r, i) => <span key={i} className="text-xs text-muted-foreground">{r}</span>)}
                          </div>
                        </div>
                      )}
                      {p.aiAnalysis.opportunities?.length > 0 && (
                        <div className="flex items-start gap-2">
                          <CheckCircle2 size={14} className="text-emerald-500 mt-0.5 shrink-0" />
                          <div className="flex flex-col gap-0.5">
                            {p.aiAnalysis.opportunities.map((o, i) => <span key={i} className="text-xs text-muted-foreground">{o}</span>)}
                          </div>
                        </div>
                      )}
                      {p.aiAnalysis.tips?.length > 0 && (
                        <div className="flex items-start gap-2">
                          <Lightbulb size={14} className="text-blue-500 mt-0.5 shrink-0" />
                          <div className="flex flex-col gap-0.5">
                            {p.aiAnalysis.tips.map((t, i) => <span key={i} className="text-xs text-muted-foreground">{t}</span>)}
                          </div>
                        </div>
                      )}
                    </div>
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

      {/* Edit Policy Modal */}
      <Dialog open={!!editingPolicy} onOpenChange={(open) => !open && setEditingPolicy(null)}>
        {editingPolicy && (
          <DialogContent aria-describedby={undefined} className="max-w-2xl max-h-[90vh] flex flex-col py-6 overflow-y-auto border-border/50 bg-card/95 backdrop-blur-md">
            <DialogHeader className="p-0 pb-4 border-b border-border/30">
              <DialogTitle className="text-lg font-bold">Edit Policy Record</DialogTitle>
            </DialogHeader>

            

            <form onSubmit={handleEditSubmit} className="flex flex-col gap-5 mt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editPolicyType">Policy Type *</Label>
                  <Select value={editPolicyType} onValueChange={(val) => setEditPolicyType(val)} disabled={editSaving}>
                    <SelectTrigger id="editPolicyType">
                      <SelectValue placeholder="Select Policy Type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="lic">Life Insurance (LIC)</SelectItem>
                      <SelectItem value="mediclaim">Health Insurance (Mediclaim)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editCompanyName">Company Name *</Label>
                  <Input
                    id="editCompanyName"
                    value={editCompanyName}
                    onChange={(e) => setEditCompanyName(e.target.value)}
                    disabled={editSaving}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editPolicyName">Policy Name *</Label>
                  <Input
                    id="editPolicyName"
                    value={editPolicyName}
                    onChange={(e) => setEditPolicyName(e.target.value)}
                    disabled={editSaving}
                  />
                </div>

                <HolderSelect id="editHolderId" value={editHolderId} onChange={setEditHolderId} disabled={editSaving} />

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editPolicyNumber">Policy Number *</Label>
                  <Input
                    id="editPolicyNumber"
                    value={editPolicyNumber}
                    onChange={(e) => setEditPolicyNumber(e.target.value)}
                    disabled={editSaving}
                    className="font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editInsuredPerson">Insured Person *</Label>
                  <Input
                    id="editInsuredPerson"
                    value={editInsuredPerson}
                    onChange={(e) => setEditInsuredPerson(e.target.value)}
                    disabled={editSaving}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editSumAssured">Sum Assured *</Label>
                  <Input
                    id="editSumAssured"
                    type="number"
                    value={editSumAssured}
                    onChange={(e) => setEditSumAssured(e.target.value)}
                    disabled={editSaving}
                    className="font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editPremiumAmount">Premium Amount *</Label>
                  <Input
                    id="editPremiumAmount"
                    type="number"
                    value={editPremiumAmount}
                    onChange={(e) => setEditPremiumAmount(e.target.value)}
                    disabled={editSaving}
                    className="font-mono"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editPremiumDueDate">Premium Due Date *</Label>
                  <Input
                    id="editPremiumDueDate"
                    type="date"
                    value={editPremiumDueDate}
                    onChange={(e) => setEditPremiumDueDate(e.target.value)}
                    disabled={editSaving}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="editExpiryDate">Expiry Date</Label>
                <Input
                  id="editExpiryDate"
                  type="date"
                  value={editExpiryDate}
                  onChange={(e) => setEditExpiryDate(e.target.value)}
                  disabled={editSaving}
                />
              </div>

              {/* File Upload */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="editFile">Replace Policy Document (Optional)</Label>
                <Input
                  id="editFile"
                  type="file"
                  accept={UPLOAD_ACCEPT_ATTRIBUTE}
                  onChange={handleEditFileChange}
                  disabled={editSaving}
                  className="h-10 text-sm"
                />
                {editingPolicy.filePath && (
                  <span className="text-xs text-muted-foreground mt-1">
                    Current File: {editingPolicy.filePath.split('/').pop()}
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
                <Button type="button" variant="secondary" onClick={() => setEditingPolicy(null)} disabled={editSaving}>
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
