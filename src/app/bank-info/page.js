'use client';

import React, { useEffect, useState } from 'react';
import {
  CreditCard,
  Plus,
  X,
  Search,
  Trash2,
  Eye,
  EyeOff,
  Copy,
  Check,
  AlertCircle,
  Building2,
  Lock,
  Share2,
  Printer,
  Download,
  Pencil,
  FileDown
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
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import RowActionsMenu from '@/components/ui/row-actions-menu';
import { toast } from 'sonner';
import StandaloneCards from './StandaloneCards';
import { LinkedCardRows } from '@/app/components/CategoryFieldInputs';
import {
  CARD_NETWORKS, CARD_TYPES, normaliseLinkedCards, parseLinkedCards,
} from '@/lib/records/linkedCards';
import HolderSelect, { ALL_MEMBERS, holderValue, holderPayload } from '@/app/components/HolderSelect';
import PageContainer from '@/app/components/PageContainer';
import DocumentPreviewDialog from '@/components/DocumentPreviewDialog';
import DuplicateResolveDialog from '@/components/records/DuplicateResolveDialog';
import useDuplicateResolve from '@/components/records/useDuplicateResolve';
import { apiCall } from '@/lib/net/apiRequest';


export default function BankInfoPage() {
  const [bankInfos, setBankInfos] = useState([]);
  const [creditCards, setCreditCards] = useState([]);
  const [loading, setLoading] = useState(true);
  // Records in this module carry an attachment like every other vault
  // module does — the list simply never offered a way to open it.
  const [previewDoc, setPreviewDoc] = useState(null);
  const [error, setError] = useState('');
  const [canShare, setCanShare] = useState(false);
  const [canAdd, setCanAdd] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [canDelete, setCanDelete] = useState(false);
  const [activeTab, setActiveTab] = useState('banks'); // 'banks' or 'cards'

  // Search & Filter
  const [searchTerm, setSearchTerm] = useState('');

  // Form State
  const [showAddForm, setShowAddForm] = useState(false);
  const [bankName, setBankName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountType, setAccountType] = useState('savings');
  const [ifscCode, setIfscCode] = useState('');
  const [branch, setBranch] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [netBankingUsername, setNetBankingUsername] = useState('');
  const [customFields, setCustomFields] = useState([]);
  
  // Card Editor Sub-state
  /**
   * The cards on the account being added, as `{ cards, text }`.
   *
   * <LinkedCardRows> is the SAME editor the sub-category form renders, and
   * that is the point: this page and /modules/bank_investments/… write the
   * same field of the same record, so two hand-rolled sub-forms were two
   * chances to store two shapes. See src/lib/records/linkedCards.ts.
   */
  const [cardsValue, setCardsValue] = useState({ cards: [], text: '' });

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // Edit Form State
  const [editingBank, setEditingBank] = useState(null);
  const [holderId, setHolderId] = useState(ALL_MEMBERS);
  const [editHolderId, setEditHolderId] = useState(ALL_MEMBERS);
  const [editBankName, setEditBankName] = useState('');
  const [editAccountNumber, setEditAccountNumber] = useState('');
  const [editAccountType, setEditAccountType] = useState('savings');
  const [editIfscCode, setEditIfscCode] = useState('');
  const [editBranch, setEditBranch] = useState('');
  const [editCustomerId, setEditCustomerId] = useState('');
  const [editNetBankingUsername, setEditNetBankingUsername] = useState('');
  const [editCustomFields, setEditCustomFields] = useState([]);
  const [editCardsValue, setEditCardsValue] = useState({ cards: [], text: '' });
  
  // Card Edit Temporary State (for edit modal card list manager)
  
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const openEditModal = (bank) => {
    setEditingBank(bank);
    setEditHolderId(holderValue(bank.holderId));
    setEditBankName(bank.bankName || '');
    setEditAccountNumber(bank.accountNumber || '');
    setEditAccountType(bank.accountType || 'savings');
    setEditIfscCode(bank.ifscCode || '');
    setEditBranch(bank.branch || '');
    setEditCustomerId(bank.customerId || '');
    setEditNetBankingUsername(bank.netBankingUsername || '');
    setEditCustomFields(Array.isArray(bank.customFields) ? [...bank.customFields] : []);
    
    // Every shape this field has ever held — the array these two probes were
    // written for, the wrapped object it is stored as now, and the free text
    // the sub-category form's textarea produced. See `parseLinkedCards`.
    setEditCardsValue(parseLinkedCards(bank.cards));
    setEditError('');
  };

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    if (!editingBank) return;
    if (!editBankName || !editAccountNumber || !editIfscCode) {
      setEditError('Bank Name, Account Number, and IFSC Code are required');
      return;
    }
    
    setEditSaving(true);
    setEditError('');

    try {
      const { res, json } = await apiCall(`/api/bank-info/${editingBank.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
        holderId: holderPayload(editHolderId),
        bankName: editBankName,
        accountNumber: editAccountNumber,
        accountType: editAccountType,
        ifscCode: editIfscCode,
        branch: editBranch,
        customerId: editCustomerId,
        netBankingUsername: editNetBankingUsername,
        customFields: editCustomFields,
        cards: normaliseLinkedCards(editCardsValue)
        })
      });
      // An EDIT names the record it is writing onto, so the server withdraws
      // both overwrite and keep-both: the prompt shows what this change would
      // collide with and links to it. No `resubmit` — there is nothing to send.
      if (duplicate.intercept(res, json, {
        newFile: null,
        newTitle: editBankName,
      })) return;
      if (json.success) {
        setEditingBank(null);
        fetchBankInfos();
      } else {
        setEditError(json.error || 'Update failed');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[bank-info] handler threw', err);
      setEditError('Something went wrong updating bank details. Please try again.');
    } finally {
      setEditSaving(false);
    }
  };

  // UI state
  const [visibleCards, setVisibleCards] = useState({});
  const [copiedId, setCopiedId] = useState(null);

  const fetchBankInfos = async () => {
    try {
      // `apiCall` resolves rather than rejecting, so one failing request no
      // longer discards the results of the others — `Promise.all` used to
      // throw the whole batch away and land in a catch that named none of them.
      const [{ res, json }, { json: ccJson }] = await Promise.all([
        apiCall('/api/bank-info'),
        apiCall('/api/credit-cards'),
      ]);
      
      if (json.success) {
        setBankInfos(json.bankInfos);
      } else {
        setError(json.error || 'Failed to fetch bank details');
      }
      
      if (ccJson.success) {
        setCreditCards(ccJson.creditCards);
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[bank-info] handler threw', err);
      setError('Something went wrong fetching bank details. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBankInfos();
    async function checkPermissions() {
      try {
        const meData = await clientGetMe();
        if (meData.success) {
          const u = meData.user;
          if (u.role === 'SUPER_ADMIN' || u.role === 'TENANT_ADMIN') {
            setCanShare(true);
            setCanAdd(true);
            setCanEdit(true);
            setCanDelete(true);
          } else {
            // The page's PRIMARY taxonomy module, and its MODULE DEFAULT row —
            // `!p.documentKey` skips the sub-category overrides 0024 added, which
            // answer for one category rather than for the button.
            const perm = u.permissions?.find(p => p.module === 'bank_investments' && !p.documentKey);
            setCanShare(!!perm?.canShare);
            setCanAdd(!!perm?.canAdd);
            setCanEdit(!!perm?.canEdit);
            setCanDelete(!!perm?.canDelete);
          }
        }
      } catch (err) {
        console.error('Error loading permissions:', err);
      }
    }
    checkPermissions();
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
    setBankName('');
    setAccountNumber('');
    setAccountType('savings');
    setIfscCode('');
    setBranch('');
    setCustomerId('');
    setNetBankingUsername('');
    setCardsValue({ cards: [], text: '' });
    setCustomFields([]);
    setFormError('');
  };

  const closeAddForm = () => {
    resetAddForm();
    setShowAddForm(false);
  };

  const handleSubmit = async (e, answer = {}) => {
    if (e) e.preventDefault();
    if (!bankName || !accountNumber || !ifscCode) {
      setFormError('Please fill in required fields (Bank Name, Account Number, and IFSC)');
      return;
    }
    
    setFormError('');
    setSaving(true);

    const payload = {
      holderId: holderPayload(holderId),
      bankName,
      accountNumber,
      accountType,
      ifscCode,
      branch,
      customerId,
      netBankingUsername,
      customFields,
      // JSON TEXT, never an array. `cards` is a sealed key and the seal step is
      // `encryptField(String(value))` — an array reached it as the literal
      // "[object Object]", which is why every card this page ever saved was
      // destroyed at write time. The route normalises again; this is the
      // browser's half of the same rule.
      cards: normaliseLinkedCards(cardsValue)
    };

    try {
      // The answer to the duplicate prompt, when this submit is one.
      if (answer.force) payload.forceSave = true;
      if (answer.keepBoth) payload.keepBoth = true;

      const { res, json } = await apiCall('/api/bank-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      // Already on file. Not a failure — a question, and the prompt is where it
      // gets asked: keep the record on file, overwrite it, or keep both.
      if (duplicate.intercept(res, json, {
        newFile: null,
        newTitle: bankName,
        resubmit: (next) => handleSubmit(null, next),
      })) return;
      if (json.success) {
        closeAddForm();
        // Refresh list
        fetchBankInfos();
      } else {
        setFormError(json.error || 'Save failed');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[bank-info] handler threw', err);
      setFormError('Something went wrong saving bank details. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this bank record?')) return;
    try {
      const { json } = await apiCall(`/api/bank-info/${id}`, { method: 'DELETE' });
      if (json.success) {
        fetchBankInfos();
      } else {
        toast.error(json.error || 'Failed to delete');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[bank-info] handler threw', err);
      toast.error('Something went wrong deleting record. Please try again.');
    }
  };

  const copyToClipboard = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const toggleCardVisibility = (cardId) => {
    setVisibleCards(prev => ({
      ...prev,
      [cardId]: !prev[cardId]
    }));
  };

  const handleShare = async (bank) => {
    const fields = [
      { label: 'Bank Name', value: bank.bankName },
      { label: 'Account Number', value: bank.accountNumber },
      { label: 'Account Type', value: bank.accountType.toUpperCase() },
      { label: 'IFSC Code', value: bank.ifscCode },
      { label: 'Branch', value: bank.branch },
      { label: 'Customer ID', value: bank.customerId },
      { label: 'NetBanking Username', value: bank.netBankingUsername }
    ];
    // `parseLinkedCards`, not `Array.isArray`: the field is stored as JSON text
    // now, so the bare-array test that used to pass here silently exported no
    // cards at all.
    parseLinkedCards(bank.cards).cards.forEach((card, idx) => {
      const name = card.cardName || `Card ${idx + 1}`;
      fields.push({ label: `${name} Holder`, value: card.cardHolder });
      fields.push({ label: `${name} Number`, value: card.cardNumber });
      fields.push({ label: `${name} Expiry`, value: card.cardExpiry });
    });
    if (Array.isArray(bank.customFields)) {
      bank.customFields.forEach(f => {
        fields.push({ label: f.label, value: f.value });
      });
    }
    const res = await shareRecord(`Bank Account - ${bank.bankName}`, fields);
    reportShareResult(res);
  };

  const handlePrint = (bank) => {
    const fields = [
      { label: 'Bank Name', value: bank.bankName },
      { label: 'Account Number', value: bank.accountNumber },
      { label: 'Account Type', value: bank.accountType.toUpperCase() },
      { label: 'IFSC Code', value: bank.ifscCode },
      { label: 'Branch', value: bank.branch },
      { label: 'Customer ID', value: bank.customerId },
      { label: 'NetBanking Username', value: bank.netBankingUsername }
    ];
    // `parseLinkedCards`, not `Array.isArray`: the field is stored as JSON text
    // now, so the bare-array test that used to pass here silently exported no
    // cards at all.
    parseLinkedCards(bank.cards).cards.forEach((card, idx) => {
      const name = card.cardName || `Card ${idx + 1}`;
      fields.push({ label: `${name} Holder`, value: card.cardHolder });
      fields.push({ label: `${name} Number`, value: card.cardNumber });
      fields.push({ label: `${name} Expiry`, value: card.cardExpiry });
    });
    if (Array.isArray(bank.customFields)) {
      bank.customFields.forEach(f => {
        fields.push({ label: f.label, value: f.value });
      });
    }
    printRecord(`Bank Account - ${bank.bankName}`, fields);
  };

  const filteredRecords = bankInfos.filter(rec => {
    return (
      rec.bankName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      rec.accountNumber.includes(searchTerm) ||
      (rec.branch && rec.branch.toLowerCase().includes(searchTerm.toLowerCase()))
    );
  });

  const getAccountBadgeClasses = (type) => {
    switch (type) {
      case 'savings': return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
      case 'current': return 'text-sky-400 bg-sky-500/10 border-sky-500/20';
      case 'nre': return 'text-amber-400 bg-amber-500/10 border-amber-500/20';
      default: return 'text-violet-400 bg-violet-500/10 border-violet-500/20';
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
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground">Bank Accounts</h1>
          <p className="text-muted-foreground text-sm">Manage bank statements, customer IDs, and debit/credit cards</p>
        </div>
        {canAdd && (
          <Button 
            onClick={() => (showAddForm ? closeAddForm() : setShowAddForm(true))}
            variant={showAddForm ? "destructive" : "default"}
            size="icon"
            className="h-10 w-10 rounded-full shadow-lg"
          >
            {showAddForm ? <X size={20} /> : <Plus size={20} />}
          </Button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-border/50 pb-2 animate-fade-in">
        <Button
          variant={activeTab === 'banks' ? 'default' : 'ghost'}
          onClick={() => setActiveTab('banks')}
          className="rounded-full px-6"
        >
          Bank Accounts
        </Button>
        <Button
          variant={activeTab === 'cards' ? 'default' : 'ghost'}
          onClick={() => setActiveTab('cards')}
          className="rounded-full px-6"
        >
          Standalone Cards
        </Button>
      </div>

      {/* Add Bank Info Form */}
      {showAddForm && (
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass p-6 md:p-8 animate-scale-in">
          <CardHeader className="p-0 pb-4 border-b border-border/50 mb-6">
            <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
              <Building2 className="text-primary" size={20} />
              <span>Save Account Details</span>
            </h2>
          </CardHeader>

          

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            {/* Bank Name — full width */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bankName">Bank Name *</Label>
              <Input
                id="bankName"
                placeholder="e.g. HDFC Bank"
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                disabled={saving}
              />
            </div>

            <HolderSelect value={holderId} onChange={setHolderId} disabled={saving} />

            {/* Account Number + Account Type */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="accountNumber">Account Number *</Label>
                <Input
                  id="accountNumber"
                  placeholder="501002345..."
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value.replace(/[^0-9]/g, ''))}
                  disabled={saving}
                  className="font-mono"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="accountType">Account Type *</Label>
                <Select value={accountType} onValueChange={(val) => setAccountType(val)} disabled={saving}>
                  <SelectTrigger id="accountType">
                    <SelectValue placeholder="Select Account Type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="savings">Savings</SelectItem>
                    <SelectItem value="current">Current</SelectItem>
                    <SelectItem value="nre">NRE</SelectItem>
                    <SelectItem value="nro">NRO</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* IFSC Code + Branch */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ifscCode">IFSC Code *</Label>
                <Input
                  id="ifscCode"
                  placeholder="HDFC0000123"
                  value={ifscCode}
                  onChange={(e) => setIfscCode(e.target.value.toUpperCase())}
                  disabled={saving}
                  className="font-mono"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="branch">Branch Name</Label>
                <Input
                  id="branch"
                  placeholder="Pune Main"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  disabled={saving}
                />
              </div>
            </div>

            {/* Customer ID + NetBanking Login */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="customerId">Customer ID / CIF</Label>
                <Input
                  id="customerId"
                  placeholder="8765432"
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  disabled={saving}
                  className="font-mono"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="netBankingUsername">NetBanking Login ID</Label>
                <Input
                  id="netBankingUsername"
                  placeholder="user_hdfc"
                  value={netBankingUsername}
                  onChange={(e) => setNetBankingUsername(e.target.value)}
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
                        placeholder="Label (e.g. UPI ID)"
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

            {/* The cards on this account — the same editor the sub-category
                form renders. See the note on the edit dialog below. */}
            <div className="border border-dashed border-border rounded-xl p-4 bg-muted/10">
              <LinkedCardRows
                value={cardsValue}
                onChange={setCardsValue}
                disabled={saving}
              />
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
                {saving ? 'Encrypting & Saving Account...' : 'Save Bank Record'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* Search Toolbar */}
      <div className="relative animate-fade-in">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" size={18} />
        <Input
          placeholder="Search by Bank Name or account..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-10 h-11 bg-card border-border/50"
        />
      </div>

      {/* Bank listings */}
      {activeTab === 'banks' && (
        <>
          {error ? (
        <div className="text-red-500 bg-red-500/10 p-4 rounded-lg">{error}</div>
      ) : filteredRecords.length === 0 ? (
        <Card className="border-border/30 bg-card backdrop-blur p-12 text-center animate-fade-in">
          <Building2 size={48} className="mx-auto text-faint mb-3" />
          <p className="text-muted-foreground text-sm font-medium">
            {searchTerm ? 'No matching bank accounts found' : 'No bank details stored yet'}
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {filteredRecords.map((bank, index) => (
            <Card 
              key={bank.id}
              className="border-border/50 bg-card backdrop-blur shadow-glass hover:bg-card transition-colors p-5 flex flex-col gap-4 animate-fade-in"
            >
              {/* Header */}
              <div className="flex justify-between items-start gap-2">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="p-2 rounded-xl border shrink-0 text-primary bg-primary-500/10 border-primary-500/20">
                    <Building2 size={18} />
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="font-bold text-foreground text-sm truncate">{bank.bankName}</span>
                    {/* `min-w-0`: a nested flex row keeps its min-content width
                        unless told otherwise, so a long branch name used to
                        spill past this column and under the action buttons. */}
                    <div className="flex min-w-0 items-center gap-2 mt-0.5">
                      <span className={`shrink-0 text-2xs font-bold tracking-wider px-2 py-0.5 rounded border ${getAccountBadgeClasses(bank.accountType)}`}>
                        {bank.accountType.toUpperCase()}
                      </span>
                      <span className="text-xs text-muted-foreground truncate">
                        {bank.branch || 'Main Branch'}
                      </span>
                    </div>
                  </div>
                </div>
                
                <div className="relative flex items-center gap-1.5 shrink-0">
                  <Button 
                    onClick={() => handleShare(bank)}
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
                  {bank.filePath && (
                    <Button
                      onClick={() => setPreviewDoc({
                        name: bank.bankName,
                        filePath: bank.filePath,
                        mimeType: bank.mimeType,
                        pageCount: bank.pageCount
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
                        onClick: () => handlePrint(bank),
                      },
                      {
                        key: 'download',
                        icon: <Download size={12} />,
                        label: 'Download',
                        onClick: () => {
                          downloadRecord(`Bank Account - ${bank.bankName}`, [
                            { label: 'Bank Name', value: bank.bankName },
                            { label: 'Account Number', value: bank.accountNumber },
                            { label: 'Account Type', value: bank.accountType.toUpperCase() },
                            { label: 'IFSC Code', value: bank.ifscCode },
                            { label: 'Branch', value: bank.branch },
                            { label: 'Customer ID', value: bank.customerId },
                            { label: 'Net Banking Username', value: bank.netBankingUsername },
                            ...(Array.isArray(bank.customFields) ? bank.customFields.map(f => ({ label: f.label, value: f.value })) : [])
                          ]);
                        },
                      },
                      canEdit && {
                        key: 'edit',
                        icon: <Pencil size={12} />,
                        label: 'Edit',
                        onClick: () => openEditModal(bank),
                      },
                      canDelete && {
                        key: 'delete',
                        icon: <Trash2 size={12} />,
                        label: 'Delete',
                        destructive: true,
                        onClick: () => handleDelete(bank.id),
                      },
                    ]}
                  />
                </div>
              </div>

              {/* Account Numbers and IFSC */}
              <div className="border border-border/30 bg-muted/20 rounded-xl p-3 text-xs grid grid-cols-2 gap-3">
                <div>
                  <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground block mb-0.5">Account No.</span>
                  <span className="font-mono font-semibold text-foreground flex items-center gap-1">
                    {bank.accountNumber}
                    <Button 
                      onClick={() => copyToClipboard(bank.accountNumber, `${bank.id}_acc`)} 
                      variant="ghost" 
                      size="icon" 
                      className="h-6 w-6 text-muted-foreground hover:bg-background rounded"
                    >
                      {copiedId === `${bank.id}_acc` ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                    </Button>
                  </span>
                </div>
                <div>
                  <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground block mb-0.5">IFSC Code</span>
                  <span className="font-mono font-semibold text-foreground flex items-center gap-1">
                    {bank.ifscCode}
                    <Button 
                      onClick={() => copyToClipboard(bank.ifscCode, `${bank.id}_ifsc`)} 
                      variant="ghost" 
                      size="icon" 
                      className="h-6 w-6 text-muted-foreground hover:bg-background rounded"
                    >
                      {copiedId === `${bank.id}_ifsc` ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                    </Button>
                  </span>
                </div>

                {bank.customerId && (
                  <div>
                    <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground block mb-0.5">Customer ID</span>
                    <span className="font-mono font-semibold text-foreground">{bank.customerId}</span>
                  </div>
                )}
                {bank.netBankingUsername && (
                  <div>
                    <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground block mb-0.5">Login ID</span>
                    <span className="font-semibold text-foreground">{bank.netBankingUsername}</span>
                  </div>
                )}
              </div>

              {/* ── The cards on this account ──────────────────────────
                  Read through `parseLinkedCards` rather than `Array.isArray`:
                  the field is JSON text now, and the bare-array test this
                  block used to open with simply never fired. */}
              {(() => {
                const linked = parseLinkedCards(bank.cards).cards;
                if (linked.length === 0) return null;
                const labelOf = (list, value) =>
                  list.find((o) => o.value === value)?.label ?? '';
                return (
                <div className="flex flex-col gap-2 mt-1">
                  <span className="text-xs uppercase font-bold tracking-wider text-primary flex items-center gap-1 mb-1">
                    <CreditCard size={12} /> Linked Cards ({linked.length})
                  </span>

                  {linked.map((card, cidx) => {
                    const cardUid = `${bank.id}_card_${cidx}`;
                    const isVisible = !!visibleCards[cardUid];
                    const digits = card.cardNumber.replace(/\D/g, '');
                    const descriptor = [
                      labelOf(CARD_NETWORKS, card.cardNetwork),
                      labelOf(CARD_TYPES, card.cardType),
                    ].filter(Boolean).join(' ');
                    return (
                      <div
                        key={card.id || cidx}
                        className="bg-gradient-to-br from-card/40 to-card/10 border border-border/20 rounded-xl p-3 flex flex-col gap-2"
                      >
                        <div className="flex justify-between items-center gap-2">
                          <span className="min-w-0 truncate text-muted-foreground text-xs font-semibold">
                            {card.cardName || card.cardHolder || descriptor || `Card ${cidx + 1}`}
                            {descriptor && (card.cardName || card.cardHolder) && (
                              <span className="ml-1.5 font-normal text-faint">{descriptor}</span>
                            )}
                          </span>
                          {digits && (
                            <Button
                              onClick={() => toggleCardVisibility(cardUid)}
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 shrink-0 text-muted-foreground hover:bg-background rounded"
                            >
                              {isVisible ? <EyeOff size={13} /> : <Eye size={13} />}
                            </Button>
                          )}
                        </div>

                        {digits && (
                          <div className="font-mono text-sm font-bold text-foreground flex justify-between items-center tracking-wide">
                            <span>
                              {isVisible
                                ? digits.replace(/(\d{4})/g, '$1 ').trim()
                                : `•••• •••• •••• ${digits.slice(-4)}`}
                            </span>
                            {isVisible && (
                              <Button
                                onClick={() => copyToClipboard(card.cardNumber, cardUid)}
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-muted-foreground hover:bg-background rounded"
                              >
                                {copiedId === cardUid ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                              </Button>
                            )}
                          </div>
                        )}

                        <div className="flex gap-6 text-xs text-muted-foreground">
                          {card.cardExpiry && (
                            <div>
                              <span className="text-2xs uppercase tracking-wider block">Expiry</span>
                              <span className="font-bold text-foreground">{card.cardExpiry}</span>
                            </div>
                          )}
                          {card.cardHolder && (
                            <div className="min-w-0">
                              <span className="text-2xs uppercase tracking-wider block">Cardholder</span>
                              <span className="truncate font-bold text-foreground">{card.cardHolder}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                );
              })()}

              {/* Render custom fields */}
              {Array.isArray(bank.customFields) && bank.customFields.length > 0 && (
                <div className="flex flex-col gap-1.5 border-t border-border/20 pt-3 mt-1">
                  {bank.customFields.map((f, idx) => (
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
      </>
      )}

      {/* Preview Modal — one pane for every stored format. See
          DocumentPreviewDialog for why this is no longer written per page. */}
      <DocumentPreviewDialog doc={previewDoc} onClose={() => setPreviewDoc(null)} />

      {/* Edit Modal */}
      <Dialog open={!!editingBank} onOpenChange={(open) => !open && setEditingBank(null)}>
        {editingBank && (
          <DialogContent aria-describedby={undefined} className="max-w-2xl max-h-[90vh] flex flex-col py-6 overflow-y-auto border-border/50 bg-card/95 backdrop-blur-md">
            <DialogHeader className="p-0 pb-4 border-b border-border/30">
              <DialogTitle className="text-lg font-bold">Edit Bank Account</DialogTitle>
            </DialogHeader>

            

            <form onSubmit={handleEditSubmit} className="flex flex-col gap-5 mt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editBankName">Bank Name *</Label>
                  <Input
                    id="editBankName"
                    value={editBankName}
                    onChange={(e) => setEditBankName(e.target.value)}
                    disabled={editSaving}
                  />
                </div>

                <HolderSelect id="editHolderId" value={editHolderId} onChange={setEditHolderId} disabled={editSaving} />

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editAccountNumber">Account Number *</Label>
                  <Input
                    id="editAccountNumber"
                    value={editAccountNumber}
                    onChange={(e) => setEditAccountNumber(e.target.value)}
                    disabled={editSaving}
                    className="font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editAccountType">Account Type *</Label>
                  <Select value={editAccountType} onValueChange={(val) => setEditAccountType(val)} disabled={editSaving}>
                    <SelectTrigger id="editAccountType">
                      <SelectValue placeholder="Select Account Type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="savings">Savings Account</SelectItem>
                      <SelectItem value="current">Current Account</SelectItem>
                      <SelectItem value="nre">NRE Account</SelectItem>
                      <SelectItem value="nro">NRO Account</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editIfscCode">IFSC Code *</Label>
                  <Input
                    id="editIfscCode"
                    value={editIfscCode}
                    onChange={(e) => setEditIfscCode(e.target.value)}
                    disabled={editSaving}
                    className="font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editBranch">Branch Name</Label>
                  <Input
                    id="editBranch"
                    value={editBranch}
                    onChange={(e) => setEditBranch(e.target.value)}
                    disabled={editSaving}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editCustomerId">Customer ID</Label>
                  <Input
                    id="editCustomerId"
                    value={editCustomerId}
                    onChange={(e) => setEditCustomerId(e.target.value)}
                    disabled={editSaving}
                    className="font-mono"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="editNetBankingUsername">Net Banking Username</Label>
                <Input
                  id="editNetBankingUsername"
                  value={editNetBankingUsername}
                  onChange={(e) => setEditNetBankingUsername(e.target.value)}
                  disabled={editSaving}
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

              {/* ── The cards on this account ──────────────────────────
                  <LinkedCardRows>, not a sub-form of its own. This page and
                  the sub-category form write the same field of the same
                  record; one editor is what stops them writing two shapes. */}
              <div className="flex flex-col gap-3 border-t border-border/30 pt-5 mt-2">
                <LinkedCardRows
                  value={editCardsValue}
                  onChange={setEditCardsValue}
                  disabled={editSaving}
                />
              </div>

              <div className="flex justify-end gap-3 border-t border-border/30 pt-5 mt-4">
                <Button type="button" variant="secondary" onClick={() => setEditingBank(null)} disabled={editSaving}>
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

      {activeTab === 'cards' && (
        <StandaloneCards 
          creditCards={creditCards} 
          fetchBankInfos={fetchBankInfos} 
          canAdd={canAdd}
          canEdit={canEdit}
          canDelete={canDelete}
        />
      )}

      {/* ── This record already exists ─────────────────────────────────────
          Both records rendered side by side, and the answer decides. */}
      <DuplicateResolveDialog {...duplicate.dialogProps} />
    </PageContainer>
  );
}
