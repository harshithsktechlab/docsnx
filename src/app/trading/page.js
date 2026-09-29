'use client';

import React, { useEffect, useState } from 'react';
import {
  TrendingUp,
  Plus,
  X,
  Search,
  Trash2,
  AlertCircle,
  Copy,
  Check,
  Award,
  Wallet,
  Share2,
  Printer,
  Download,
  Pencil,
  FileDown,
  Eye,
  Sparkles,
  Info
} from 'lucide-react';
import { shareRecord, printRecord, downloadRecord } from '@/lib/sharePrintHelper';
import { reportShareResult } from '@/lib/shareToast';
import { clientGetMe } from '@/lib/clientAuth';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import RowActionsMenu from '@/components/ui/row-actions-menu';
import { toast } from 'sonner';
import { acceptedFileFrom } from '@/app/components/acceptFile';
import { UPLOAD_ACCEPT_ATTRIBUTE } from '@/lib/records/uploadTypes';
import HolderSelect, { ALL_MEMBERS, holderValue, holderPayload } from '@/app/components/HolderSelect';
import PageContainer from '@/app/components/PageContainer';
import DocumentPreviewDialog from '@/components/DocumentPreviewDialog';
import DuplicateResolveDialog from '@/components/records/DuplicateResolveDialog';
import useDuplicateResolve from '@/components/records/useDuplicateResolve';
import { apiCall } from '@/lib/net/apiRequest';
import { postUpload } from '@/lib/records/uploadRequest';
import { toastApiError } from '@/lib/net/toastApiError';


export default function TradingDematPage() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  // Records in this module carry an attachment like every other vault
  // module does — the list simply never offered a way to open it.
  const [previewDoc, setPreviewDoc] = useState(null);
  const [error, setError] = useState('');
  const [canShare, setCanShare] = useState(false);

  // Search & Filter
  const [searchTerm, setSearchTerm] = useState('');

  // Form State
  const [showAddForm, setShowAddForm] = useState(false);
  const [brokerName, setBrokerName] = useState('');
  const [clientId, setClientId] = useState('');
  const [dematAccountNumber, setDematAccountNumber] = useState('');
  const [loginUsername, setLoginUsername] = useState('');
  const [nomineeName, setNomineeName] = useState('');
  const [details, setDetails] = useState('');
  const [customFields, setCustomFields] = useState([]);

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // AI Auto-fill states
  const [file, setFile] = useState(null);
  const [aiScanning, setAiScanning] = useState(false);
  const [aiMessage, setAiMessage] = useState('');

  // Edit Form State
  const [editingAccount, setEditingAccount] = useState(null);
  const [holderId, setHolderId] = useState(ALL_MEMBERS);
  const [editHolderId, setEditHolderId] = useState(ALL_MEMBERS);
  const [editBrokerName, setEditBrokerName] = useState('');
  const [editClientId, setEditClientId] = useState('');
  const [editDematAccountNumber, setEditDematAccountNumber] = useState('');
  const [editLoginUsername, setEditLoginUsername] = useState('');
  const [editNomineeName, setEditNomineeName] = useState('');
  const [editDetails, setEditDetails] = useState('');
  const [editCustomFields, setEditCustomFields] = useState([]);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const openEditModal = (acc) => {
    setEditingAccount(acc);
    setEditHolderId(holderValue(acc.holderId));
    setEditBrokerName(acc.brokerName || '');
    setEditClientId(acc.clientId || '');
    setEditDematAccountNumber(acc.dematAccountNumber || '');
    setEditLoginUsername(acc.loginUsername || '');
    setEditNomineeName(acc.nomineeName || '');
    setEditDetails(acc.details || '');
    setEditCustomFields(Array.isArray(acc.customFields) ? [...acc.customFields] : []);
    setEditError('');
  };

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    if (!editingAccount) return;
    if (!editBrokerName || !editClientId) {
      setEditError('Broker Name and Client ID are required');
      return;
    }
    setEditSaving(true);
    setEditError('');

    try {
      const { res, json } = await apiCall(`/api/trading/${editingAccount.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
        holderId: holderPayload(editHolderId),
        brokerName: editBrokerName,
        clientId: editClientId,
        dematAccountNumber: editDematAccountNumber,
        loginUsername: editLoginUsername,
        nomineeName: editNomineeName,
        details: editDetails,
        customFields: editCustomFields
        })
      });
      // An EDIT names the record it is writing onto, so the server withdraws
      // both overwrite and keep-both: the prompt shows what this change would
      // collide with and links to it. No `resubmit` — there is nothing to send.
      if (duplicate.intercept(res, json, {
        newFile: null,
        newTitle: `${editBrokerName} Demat`,
      })) return;
      if (json.success) {
        setEditingAccount(null);
        fetchAccounts();
      } else {
        setEditError(json.error || 'Update failed');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[trading] handler threw', err);
      setEditError('Something went wrong updating account details. Please try again.');
    } finally {
      setEditSaving(false);
    }
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

        if (data.brokerName) setBrokerName(data.brokerName);
        if (data.clientId) setClientId(data.clientId);
        if (data.dematAccountNumber) setDematAccountNumber(data.dematAccountNumber);
        if (data.loginUsername) setLoginUsername(data.loginUsername);
        if (data.nomineeName) setNomineeName(data.nomineeName);

        toast.success('Auto-filled fields from document!');
      } else {
        toast.error(json.error || 'Failed to scan document');
      }
    } catch (err) {
      console.error(err);
      console.error('[trading] AI scan handler threw', err);
      toast.error('Something went wrong reading this document. Fill the form in below.');
    } finally {
      setAiScanning(false);
      setAiMessage('');
    }
  };

  const [copiedId, setCopiedId] = useState(null);

  const fetchAccounts = async () => {
    try {
      const { json } = await apiCall('/api/trading');
      if (json.success) {
        setAccounts(json.tradingDemats);
      } else {
        setError(json.error || 'Failed to fetch accounts');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[trading] handler threw', err);
      setError('Something went wrong fetching demat accounts. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAccounts();
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
            const perm = u.permissions?.find(p => p.module === 'bank_investments' && !p.documentKey);
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
    setBrokerName('');
    setClientId('');
    setDematAccountNumber('');
    setLoginUsername('');
    setNomineeName('');
    setDetails('');
    setCustomFields([]);
    setFile(null);
    setFormError('');
  };

  const closeAddForm = () => {
    resetAddForm();
    setShowAddForm(false);
  };

  const handleSubmit = async (e, answer = {}) => {
    if (e) e.preventDefault();
    if (!brokerName || !clientId) {
      setFormError('Please fill in required fields (Broker Name and Client ID)');
      return;
    }
    setFormError('');
    setSaving(true);

    try {
      const { res, json } = await apiCall('/api/trading', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holderId: holderPayload(holderId), brokerName, clientId, dematAccountNumber, loginUsername, nomineeName, details, customFields, forceSave: Boolean(answer.force), keepBoth: Boolean(answer.keepBoth) })
      });
      // Already on file. Not a failure — a question, and the prompt is where it
      // gets asked: keep the record on file, overwrite it, or keep both.
      if (duplicate.intercept(res, json, {
        newFile: file,
        newTitle: `${brokerName} Demat`,
        resubmit: (next) => handleSubmit(null, next),
      })) return;
      if (json.success) {
        closeAddForm();
        // Refresh list
        fetchAccounts();
      } else {
        setFormError(json.error || 'Save failed');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[trading] handler threw', err);
      setFormError('Something went wrong saving Demat account. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this Demat account record?')) return;
    try {
      const { json } = await apiCall(`/api/trading/${id}`, { method: 'DELETE' });
      if (json.success) {
        fetchAccounts();
      } else {
        toast.error(json.error || 'Failed to delete');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[trading] handler threw', err);
      toast.error('Something went wrong deleting record. Please try again.');
    }
  };

  const copyToClipboard = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleShare = async (acc) => {
    const fields = [
      { label: 'Broker Name', value: acc.brokerName },
      { label: 'Client Code', value: acc.clientId },
      { label: 'Demat BO ID', value: acc.dematAccountNumber },
      { label: 'Login Username', value: acc.loginUsername },
      { label: 'Nominee', value: acc.nomineeName }
    ];
    if (Array.isArray(acc.customFields)) {
      acc.customFields.forEach(f => {
        fields.push({ label: f.label, value: f.value });
      });
    }
    const res = await shareRecord(`Trading & Demat Account - ${acc.brokerName}`, fields, acc.details);
    reportShareResult(res);
  };

  const handlePrint = (acc) => {
    const fields = [
      { label: 'Broker Name', value: acc.brokerName },
      { label: 'Client Code', value: acc.clientId },
      { label: 'Demat BO ID', value: acc.dematAccountNumber },
      { label: 'Login Username', value: acc.loginUsername },
      { label: 'Nominee', value: acc.nomineeName }
    ];
    if (Array.isArray(acc.customFields)) {
      acc.customFields.forEach(f => {
        fields.push({ label: f.label, value: f.value });
      });
    }
    printRecord(`Trading & Demat Account - ${acc.brokerName}`, fields, acc.details);
  };

  const filteredAccounts = accounts.filter(acc => {
    return (
      acc.brokerName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      acc.clientId.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (acc.dematAccountNumber && acc.dematAccountNumber.includes(searchTerm))
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
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground">Trading & Demat</h1>
          <p className="text-muted-foreground text-sm">Manage stock trading credentials and BO/Demat numbers</p>
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

      {/* Add Account Form */}
      {showAddForm && (
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass p-6 md:p-8 animate-scale-in">
          <CardHeader className="p-0 pb-4 border-b border-border/50 mb-6">
            <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
              <TrendingUp className="text-emerald-400" size={20} />
              <span>Save Trading Account</span>
            </h2>
          </CardHeader>

          

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div className="bg-muted/30 p-3 rounded-lg border border-border/50">
              <Label className="text-sm font-semibold">Attach Document for AI Auto-fill</Label>
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
                      {file ? file.name : 'Select file to scan (optional)'}
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

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="brokerName">Broker Name *</Label>
                <Input
                  id="brokerName"
                  placeholder="e.g. Zerodha, Groww"
                  value={brokerName}
                  onChange={(e) => setBrokerName(e.target.value)}
                  disabled={saving}
                />
              </div>

              <HolderSelect value={holderId} onChange={setHolderId} disabled={saving} />

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="clientId">Client ID / Code *</Label>
                <Input
                  id="clientId"
                  placeholder="e.g. AB1234"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value.toUpperCase())}
                  disabled={saving}
                  className="uppercase"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="dematAccountNumber">Demat BO Account No.</Label>
                <Input
                  id="dematAccountNumber"
                  placeholder="120816000..."
                  value={dematAccountNumber}
                  onChange={(e) => setDematAccountNumber(e.target.value.replace(/[^0-9]/g, ''))}
                  disabled={saving}
                  className="font-mono"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="loginUsername">Login Username</Label>
                <Input
                  id="loginUsername"
                  placeholder="e.g. sunil_groww"
                  value={loginUsername}
                  onChange={(e) => setLoginUsername(e.target.value)}
                  disabled={saving}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="nomineeName">Nominee Name</Label>
              <Input
                id="nomineeName"
                placeholder="e.g. Sweta Gadhiya (Wife)"
                value={nomineeName}
                onChange={(e) => setNomineeName(e.target.value)}
                disabled={saving}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="details">Account Notes / Details</Label>
              <Textarea
                id="details"
                placeholder="e.g. Linked bank account: HDFC. API access keys active."
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                rows={3}
                disabled={saving}
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
                        placeholder="Label (e.g. Password Key)"
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
                {saving ? 'Saving account details...' : 'Save Demat Details'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* Search Toolbar */}
      <div className="relative animate-fade-in">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" size={18} />
        <Input
          placeholder="Search by Broker or Client ID..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-10 h-11 bg-card border-border/50"
        />
      </div>

      {/* Error / List State */}
      {error ? (
        <div className="text-red-500 bg-red-500/10 p-4 rounded-lg">{error}</div>
      ) : filteredAccounts.length === 0 ? (
        <Card className="border-border/30 bg-card backdrop-blur p-12 text-center animate-fade-in">
          <TrendingUp size={48} className="mx-auto text-faint mb-3" />
          <p className="text-muted-foreground text-sm font-medium">No Demat accounts stored yet</p>
        </Card>
      ) : (
        /* Accounts List */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredAccounts.map((acc, index) => (
            <Card 
              key={acc.id}
              className="border-border/50 bg-card backdrop-blur shadow-glass hover:bg-card transition-colors p-5 flex flex-col gap-4 animate-fade-in"
            >
              {/* Header */}
              <div className="flex justify-between items-start gap-2">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="p-2 rounded-xl border shrink-0 text-emerald-400 bg-emerald-500/10 border-emerald-500/20">
                    <TrendingUp size={18} />
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="font-bold text-foreground text-sm truncate">{acc.brokerName}</span>
                    <span className="text-xs text-muted-foreground mt-0.5">
                      Client ID: <strong className="font-mono text-foreground">{acc.clientId}</strong>
                    </span>
                  </div>
                </div>

                <div className="relative flex items-center gap-1.5 shrink-0">
                  <Button 
                    onClick={() => handleShare(acc)}
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-sky-400 hover:bg-sky-500/10 hover:text-sky-300 rounded-lg"
                    title="Share"
                  >
                    <Share2 size={14} />
                  </Button>
                  {/* The card below already prints every field of the
                      record, so View means one thing: open the attached
                      scan. This used to answer the click with a toast
                      saying the details were on the card — true, and no
                      help at all to someone looking for the scan. */}
                  {acc.filePath && (
                    <Button
                      onClick={() => setPreviewDoc({
                        name: acc.brokerName,
                        filePath: acc.filePath,
                        mimeType: acc.mimeType,
                        pageCount: acc.pageCount
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
                        onClick: () => handlePrint(acc),
                      },
                      {
                        key: 'download',
                        icon: <Download size={12} />,
                        label: 'Download',
                        onClick: () => {
                          downloadRecord(`Trading Account - ${acc.brokerName}`, [
                            { label: 'Broker Name', value: acc.brokerName },
                            { label: 'Client ID', value: acc.clientId },
                            { label: 'Demat Account Number', value: acc.dematAccountNumber },
                            { label: 'Login Username', value: acc.loginUsername },
                            { label: 'Nominee Name', value: acc.nomineeName },
                            ...(Array.isArray(acc.customFields) ? acc.customFields.map(f => ({ label: f.label, value: f.value })) : [])
                          ], acc.details);
                        },
                      },
                      {
                        key: 'edit',
                        icon: <Pencil size={12} />,
                        label: 'Edit',
                        onClick: () => openEditModal(acc),
                      },
                      {
                        key: 'delete',
                        icon: <Trash2 size={12} />,
                        label: 'Delete',
                        destructive: true,
                        onClick: () => handleDelete(acc.id),
                      },
                    ]}
                  />
                </div>
              </div>

              {/* Account Numbers and Demat Numbers */}
              <div className="border border-border/30 bg-muted/20 rounded-xl p-3 text-xs grid grid-cols-2 gap-3">
                <div>
                  <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground block mb-0.5">Client Code</span>
                  <span className="font-mono font-semibold text-foreground flex items-center gap-1">
                    {acc.clientId}
                    <Button 
                      onClick={() => copyToClipboard(acc.clientId, `${acc.id}_client`)} 
                      variant="ghost" 
                      size="icon" 
                      className="h-6 w-6 text-muted-foreground hover:bg-background rounded"
                    >
                      {copiedId === `${acc.id}_client` ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                    </Button>
                  </span>
                </div>
                
                {acc.dematAccountNumber && (
                  <div>
                    <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground block mb-0.5">Demat BO ID</span>
                    <span className="font-mono font-semibold text-foreground flex items-center gap-1">
                      {acc.dematAccountNumber}
                      <Button 
                        onClick={() => copyToClipboard(acc.dematAccountNumber, `${acc.id}_demat`)} 
                        variant="ghost" 
                        size="icon" 
                        className="h-6 w-6 text-muted-foreground hover:bg-background rounded"
                      >
                        {copiedId === `${acc.id}_demat` ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                      </Button>
                    </span>
                  </div>
                )}

                {acc.loginUsername && (
                  <div>
                    <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground block mb-0.5">Login Username</span>
                    <span className="font-mono font-semibold text-foreground">{acc.loginUsername}</span>
                  </div>
                )}

                {acc.nomineeName && (
                  <div>
                    <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground block mb-0.5">Nominee</span>
                    <span className="font-semibold text-foreground flex items-center gap-1">
                      <Award size={13} className="text-emerald-400 shrink-0" />
                      <span className="truncate">{acc.nomineeName}</span>
                    </span>
                  </div>
                )}
              </div>

              {/* Notes */}
              {acc.details && (
                <p className="text-xs text-muted-foreground leading-relaxed bg-muted/20 p-2.5 rounded-xl border border-border/10">
                  {acc.details}
                </p>
              )}

              {/* Render custom fields */}
              {Array.isArray(acc.customFields) && acc.customFields.length > 0 && (
                <div className="flex flex-col gap-1.5 border-t border-border/20 pt-3 mt-1">
                  {acc.customFields.map((f, idx) => (
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

      {/* Edit Trading Account Modal */}
      <Dialog open={!!editingAccount} onOpenChange={(open) => !open && setEditingAccount(null)}>
        {editingAccount && (
          <DialogContent aria-describedby={undefined} className="max-w-2xl max-h-[90vh] flex flex-col py-6 overflow-y-auto border-border/50 bg-card/95 backdrop-blur-md">
            <DialogHeader className="p-0 pb-4 border-b border-border/30">
              <DialogTitle className="text-lg font-bold">Edit Trading & Demat Account</DialogTitle>
            </DialogHeader>

            

            <form onSubmit={handleEditSubmit} className="flex flex-col gap-5 mt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editBrokerName">Broker Name *</Label>
                  <Input
                    id="editBrokerName"
                    value={editBrokerName}
                    onChange={(e) => setEditBrokerName(e.target.value)}
                    disabled={editSaving}
                  />
                </div>

                <HolderSelect id="editHolderId" value={editHolderId} onChange={setEditHolderId} disabled={editSaving} />

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editClientId">Client ID / Code *</Label>
                  <Input
                    id="editClientId"
                    value={editClientId}
                    onChange={(e) => setEditClientId(e.target.value.toUpperCase())}
                    disabled={editSaving}
                    className="uppercase"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editDematAccountNumber">Demat BO Account No.</Label>
                  <Input
                    id="editDematAccountNumber"
                    value={editDematAccountNumber}
                    onChange={(e) => setEditDematAccountNumber(e.target.value.replace(/[^0-9]/g, ''))}
                    disabled={editSaving}
                    className="font-mono"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editLoginUsername">Login Username</Label>
                  <Input
                    id="editLoginUsername"
                    value={editLoginUsername}
                    onChange={(e) => setEditLoginUsername(e.target.value)}
                    disabled={editSaving}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="editNomineeName">Nominee Name</Label>
                <Input
                  id="editNomineeName"
                  value={editNomineeName}
                  onChange={(e) => setEditNomineeName(e.target.value)}
                  disabled={editSaving}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="editDetails">Account Notes / Details</Label>
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

              <div className="flex justify-end gap-3 border-t border-border/30 pt-5 mt-4">
                <Button type="button" variant="secondary" onClick={() => setEditingAccount(null)} disabled={editSaving}>
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
