'use client';

import {
  formatDate } from '@/lib/dateHelper';
import React,
  { useEffect,
  useState } from 'react';
import { 
  PiggyBank,
  Plus,
  X,
  Search,
  Trash2,
  Calendar,
  AlertCircle,
  Sparkles,
  RefreshCw,
  ArrowUpRight,
  ArrowDownRight,
  Coins,
  Share2,
  Printer,
  Download,
  Pencil,
  FileDown,
  ListTodo,
  AlertTriangle,
  Lightbulb,
  CheckCircle2,
  Eye
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
import { Textarea } from '@/components/ui/textarea';
import RowActionsMenu from '@/components/ui/row-actions-menu';
import { toast } from 'sonner';
import HolderSelect, { ALL_MEMBERS, holderValue, holderPayload } from '@/app/components/HolderSelect';
import PageContainer from '@/app/components/PageContainer';
import DocumentPreviewDialog from '@/components/DocumentPreviewDialog';
import DuplicateResolveDialog from '@/components/records/DuplicateResolveDialog';
import useDuplicateResolve from '@/components/records/useDuplicateResolve';
import { apiCall } from '@/lib/net/apiRequest';


export default function InvestmentsPage() {
  const [investments, setInvestments] = useState([]);
  const [loading, setLoading] = useState(true);
  // Records in this module carry an attachment like every other vault
  // module does — the list simply never offered a way to open it.
  const [previewDoc, setPreviewDoc] = useState(null);
  const [error, setError] = useState('');
  const [canShare, setCanShare] = useState(false);

  // Search & Filter
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');

  // Form State
  const [showAddForm, setShowAddForm] = useState(false);
  const [category, setCategory] = useState('mutual_funds');
  const [title, setTitle] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [purchaseValue, setPurchaseValue] = useState('');
  const [currentValue, setCurrentValue] = useState('');
  const [quantity, setQuantity] = useState('');
  const [customFields, setCustomFields] = useState([]);
  
  // Custom metadata details depending on category
  const [detailTicker, setDetailTicker] = useState(''); // Shares / Mutual Funds
  const [detailLocation, setDetailLocation] = useState(''); // Property

  // Property Compliance Fields
  const [propertyTaxDueDate, setPropertyTaxDueDate] = useState('');
  const [propertyTaxReceiptUploaded, setPropertyTaxReceiptUploaded] = useState(false);
  const [has712Extract, setHas712Extract] = useState(false);
  const [hasNamunaD, setHasNamunaD] = useState(false);
  const [hasMap, setHasMap] = useState(false);

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // AI loading status (for regenerating research)
  const [regeneratingId, setRegeneratingId] = useState(null);

  // Edit Form State
  const [editingInvestment, setEditingInvestment] = useState(null);
  const [holderId, setHolderId] = useState(ALL_MEMBERS);
  const [editHolderId, setEditHolderId] = useState(ALL_MEMBERS);
  const [editCategory, setEditCategory] = useState('mutual_funds');
  const [editTitle, setEditTitle] = useState('');
  const [editPurchaseDate, setEditPurchaseDate] = useState('');
  const [editPurchaseValue, setEditPurchaseValue] = useState('');
  const [editCurrentValue, setEditCurrentValue] = useState('');
  const [editQuantity, setEditQuantity] = useState('');
  const [editCustomFields, setEditCustomFields] = useState([]);
  const [editDetailTicker, setEditDetailTicker] = useState('');
  const [editDetailLocation, setEditDetailLocation] = useState('');
  
  // Edit Property Compliance Fields
  const [editPropertyTaxDueDate, setEditPropertyTaxDueDate] = useState('');
  const [editPropertyTaxReceiptUploaded, setEditPropertyTaxReceiptUploaded] = useState(false);
  const [editHas712Extract, setEditHas712Extract] = useState(false);
  const [editHasNamunaD, setEditHasNamunaD] = useState(false);
  const [editHasMap, setEditHasMap] = useState(false);

  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const openEditModal = (inv) => {
    setEditingInvestment(inv);
    setEditHolderId(holderValue(inv.holderId));
    setEditCategory(inv.category || 'mutual_funds');
    setEditTitle(inv.title || '');
    setEditPurchaseDate(inv.purchaseDate ? new Date(inv.purchaseDate).toISOString().split('T')[0] : '');
    setEditPurchaseValue(inv.purchaseValue ? inv.purchaseValue.toString() : '');
    setEditCurrentValue(inv.currentValue ? inv.currentValue.toString() : '');
    setEditQuantity(inv.quantity ? inv.quantity.toString() : '');
    setEditCustomFields(Array.isArray(inv.customFields) ? [...inv.customFields] : []);
    
    // Details
    const detailsObj = inv.details && typeof inv.details === 'object' ? inv.details : {};
    setEditDetailTicker(detailsObj.ticker || '');
    setEditDetailLocation(detailsObj.location || '');

    setEditPropertyTaxDueDate(inv.propertyTaxDueDate ? new Date(inv.propertyTaxDueDate).toISOString().split('T')[0] : '');
    setEditPropertyTaxReceiptUploaded(inv.propertyTaxReceiptUploaded || false);
    setEditHas712Extract(inv.has712Extract || false);
    setEditHasNamunaD(inv.hasNamunaD || false);
    setEditHasMap(inv.hasMap || false);
    
    setEditError('');
  };

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    if (!editingInvestment) return;
    if (!editCategory || !editTitle || !editPurchaseDate || !editPurchaseValue || !editCurrentValue) {
      setEditError('Please fill in required fields');
      return;
    }
    setEditSaving(true);
    setEditError('');

    const detailsObj = {};
    if (editCategory === 'shares' || editCategory === 'mutual_funds') {
      detailsObj.ticker = editDetailTicker;
    } else if (editCategory === 'property') {
      detailsObj.location = editDetailLocation;
    }

    const payload = {
      holderId: holderPayload(editHolderId),
      category: editCategory,
      title: editTitle,
      purchaseDate: editPurchaseDate,
      purchaseValue: parseFloat(editPurchaseValue),
      currentValue: parseFloat(editCurrentValue),
      quantity: editQuantity ? parseFloat(editQuantity) : null,
      details: detailsObj,
      customFields: editCustomFields,
      propertyTaxDueDate: editPropertyTaxDueDate,
      propertyTaxReceiptUploaded: editPropertyTaxReceiptUploaded,
      has712Extract: editHas712Extract,
      hasNamunaD: editHasNamunaD,
      hasMap: editHasMap,
    };

    try {
      const { res, json } = await apiCall(`/api/investments/${editingInvestment.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      // An EDIT names the record it is writing onto, so the server withdraws
      // both overwrite and keep-both: the prompt shows what this change would
      // collide with and links to it. No `resubmit` — there is nothing to send.
      if (duplicate.intercept(res, json, {
        newFile: null,
        newTitle: editTitle,
      })) return;
      if (json.success) {
        setEditingInvestment(null);
        fetchInvestments();
      } else {
        setEditError(json.error || 'Update failed');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[investments] handler threw', err);
      setEditError('Something went wrong updating investment. Please try again.');
    } finally {
      setEditSaving(false);
    }
  };

  const fetchInvestments = async () => {
    try {
      const { json } = await apiCall('/api/investments');
      if (json.success) {
        setInvestments(json.investments);
      } else {
        setError(json.error || 'Failed to fetch investments');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[investments] handler threw', err);
      setError('Something went wrong fetching investments. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateFollowups = async (id) => {
    try {
      const loadingToast = toast.loading('Generating property follow-ups...');
      const { json: data } = await apiCall(`/api/investments/${id}/generate-followups`, { method: 'POST' });
      
      toast.dismiss(loadingToast);
      if (data.success) {
        toast.success(data.message || 'Follow-ups created successfully');
      } else {
        toast.error(data.error || 'Failed to generate follow-ups');
      }
    } catch (err) {
      console.error(err);
      toast.error('Failed to generate follow-ups');
    }
  };

  useEffect(() => {
    fetchInvestments();
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
    setTitle('');
    setPurchaseDate('');
    setPurchaseValue('');
    setCurrentValue('');
    setQuantity('');
    setDetailTicker('');
    setDetailLocation('');
    setPropertyTaxDueDate('');
    setPropertyTaxReceiptUploaded(false);
    setHas712Extract(false);
    setHasNamunaD(false);
    setHasMap(false);
    setCustomFields([]);
    setFormError('');
  };

  const closeAddForm = () => {
    resetAddForm();
    setShowAddForm(false);
  };

  const handleSubmit = async (e, answer = {}) => {
    if (e) e.preventDefault();
    if (!category || !title || !purchaseDate || !purchaseValue || !currentValue) {
      setFormError('Please fill in required fields');
      return;
    }
    setFormError('');
    setSaving(true);

    const detailsObj = {};
    if (category === 'shares' || category === 'mutual_funds') {
      detailsObj.ticker = detailTicker;
    } else if (category === 'property') {
      detailsObj.location = detailLocation;
    }

    const payload = {
      holderId: holderPayload(holderId),
      category,
      title,
      purchaseDate,
      purchaseValue: parseFloat(purchaseValue),
      currentValue: parseFloat(currentValue),
      quantity: quantity ? parseFloat(quantity) : null,
      details: detailsObj,
      customFields,
      propertyTaxDueDate,
      propertyTaxReceiptUploaded,
      has712Extract,
      hasNamunaD,
      hasMap
    };

    try {
      // The answer to the duplicate prompt, when this submit is one.
      if (answer.force) payload.forceSave = true;
      if (answer.keepBoth) payload.keepBoth = true;

      const { res, json } = await apiCall('/api/investments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      // Already on file. Not a failure — a question, and the prompt is where it
      // gets asked: keep the record on file, overwrite it, or keep both.
      if (duplicate.intercept(res, json, {
        newFile: null,
        newTitle: title,
        resubmit: (next) => handleSubmit(null, next),
      })) return;
      if (json.success) {
        closeAddForm();
        // Refresh list
        fetchInvestments();
      } else {
        setFormError(json.error || 'Save failed');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[investments] handler threw', err);
      setFormError('Something went wrong saving investment. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this investment record?')) return;
    try {
      const { json } = await apiCall(`/api/investments/${id}`, { method: 'DELETE' });
      if (json.success) {
        fetchInvestments();
      } else {
        toast.error(json.error || 'Failed to delete');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[investments] handler threw', err);
      toast.error('Something went wrong deleting record. Please try again.');
    }
  };

  const handleRegenerateAI = async (id) => {
    setRegeneratingId(id);
    try {
      const { json } = await apiCall(`/api/investments/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regenerateAI: true })
      });
      if (json.success) {
        fetchInvestments();
      } else {
        toast.error(json.error || 'Failed to regenerate AI research');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[investments] handler threw', err);
      toast.error('Something went wrong regenerating research note. Please try again.');
    } finally {
      setRegeneratingId(null);
    }
  };

  const handleShare = async (inv) => {
    const fields = [
      { label: 'Category', value: inv.category.replace('_', ' ').toUpperCase() },
      { label: 'Title', value: inv.title },
      { label: 'Purchase Date', value: formatDate(inv.purchaseDate) },
      { label: 'Purchase Value', value: `INR ${Number(inv.purchaseValue).toLocaleString()}` },
      { label: 'Current Value', value: `INR ${Number(inv.currentValue).toLocaleString()}` },
      { label: 'Quantity', value: inv.quantity ? Number(inv.quantity) : '' }
    ];
    if (inv.details && typeof inv.details === 'object') {
      if (inv.details.ticker) fields.push({ label: 'Ticker Symbol', value: inv.details.ticker });
      if (inv.details.location) fields.push({ label: 'Property Location', value: inv.details.location });
    }
    if (Array.isArray(inv.customFields)) {
      inv.customFields.forEach(f => {
        fields.push({ label: f.label, value: f.value });
      });
    }
    const analysisText = inv.aiAnalysis 
      ? `AI Analysis:\nRisks: ${inv.aiAnalysis.risks?.join(' | ')}\nOpportunities: ${inv.aiAnalysis.opportunities?.join(' | ')}\nTips: ${inv.aiAnalysis.tips?.join(' | ')}`
      : '';
    const res = await shareRecord(`Investment - ${inv.title}`, fields, analysisText);
    reportShareResult(res);
  };

  const handlePrint = (inv) => {
    const fields = [
      { label: 'Category', value: inv.category.replace('_', ' ').toUpperCase() },
      { label: 'Title', value: inv.title },
      { label: 'Purchase Date', value: formatDate(inv.purchaseDate) },
      { label: 'Purchase Value', value: `INR ${Number(inv.purchaseValue).toLocaleString()}` },
      { label: 'Current Value', value: `INR ${Number(inv.currentValue).toLocaleString()}` },
      { label: 'Quantity', value: inv.quantity ? Number(inv.quantity) : '' }
    ];
    if (inv.details && typeof inv.details === 'object') {
      if (inv.details.ticker) fields.push({ label: 'Ticker Symbol', value: inv.details.ticker });
      if (inv.details.location) fields.push({ label: 'Property Location', value: inv.details.location });
    }
    if (Array.isArray(inv.customFields)) {
      inv.customFields.forEach(f => {
        fields.push({ label: f.label, value: f.value });
      });
    }
    const analysisText = inv.aiAnalysis 
      ? `AI Analysis:\nRisks: ${inv.aiAnalysis.risks?.join(' | ')}\nOpportunities: ${inv.aiAnalysis.opportunities?.join(' | ')}\nTips: ${inv.aiAnalysis.tips?.join(' | ')}`
      : '';
    printRecord(`Investment - ${inv.title}`, fields, analysisText);
  };

  // Profit/Loss styling helper
  const getROIPanel = (purchaseVal, currentVal) => {
    const pVal = Number(purchaseVal);
    const cVal = Number(currentVal);
    const profit = cVal - pVal;
    const pct = pVal > 0 ? (profit / pVal) * 100 : 0;
    const isProfit = profit >= 0;

    return (
      <div className="flex flex-col items-end gap-1.5">
        <span className={`text-sm font-extrabold inline-flex items-center gap-1 ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
          {isProfit ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
          <span>{isProfit ? '+' : ''}{profit.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
        </span>
        <span className={`px-2 py-0.5 rounded border text-xs font-bold ${
          isProfit 
            ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' 
            : 'text-rose-400 bg-rose-500/10 border-rose-500/20'
        }`}>
          {isProfit ? '+' : ''}{pct.toFixed(2)}%
        </span>
      </div>
    );
  };

  const filteredInvestments = investments.filter(inv => {
    const matchesSearch = inv.title.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = selectedCategory === 'all' || inv.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const categories = [
    { value: 'all', label: 'All Assets' },
    { value: 'property', label: 'Property' },
    { value: 'shares', label: 'Shares' },
    { value: 'mutual_funds', label: 'Mutual Funds' },
    { value: 'gold_silver', label: 'Gold / Silver' },
  ];

  if (loading) {
    return (
      <PageContainer>
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-10 w-10 rounded-full" />
        </div>
        <Skeleton className="h-12 w-full rounded-xl" />
        <div className="flex gap-2">
          {[...Array(5)].map((_, i) => (
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
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground">Investments</h1>
          <p className="text-muted-foreground text-sm">Track stock equity, mutual funds, gold, & property valuations</p>
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

      {/* Add Investment Form */}
      {showAddForm && (
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass p-6 md:p-8 animate-scale-in">
          <CardHeader className="p-0 pb-4 border-b border-border/50 mb-6">
            <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
              <PiggyBank className="text-violet-400" size={20} />
              <span>Log New Investment Asset</span>
            </h2>
          </CardHeader>

          

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="category">Asset Category *</Label>
                <Select value={category} onValueChange={(val) => setCategory(val)} disabled={saving}>
                  <SelectTrigger id="category">
                    <SelectValue placeholder="Select Asset Category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mutual_funds">Mutual Funds</SelectItem>
                    <SelectItem value="shares">Shares / Stocks</SelectItem>
                    <SelectItem value="property">Real Estate / Property</SelectItem>
                    <SelectItem value="gold_silver">Gold / Silver</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="purchaseDate">Purchase Date *</Label>
                <Input
                  id="purchaseDate"
                  type="date"
                  value={purchaseDate}
                  onChange={(e) => setPurchaseDate(e.target.value)}
                  disabled={saving}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="title">Asset Title / Name *</Label>
              <Input
                id="title"
                placeholder="e.g. Parag Parikh Flexi Cap Fund"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={saving}
              />
            </div>


            <HolderSelect value={holderId} onChange={setHolderId} disabled={saving} />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="purchaseValue">Purchase Value (INR) *</Label>
                <Input
                  id="purchaseValue"
                  type="number"
                  placeholder="e.g. 50000"
                  value={purchaseValue}
                  onChange={(e) => setPurchaseValue(e.target.value)}
                  disabled={saving}
                  className="font-mono"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="currentValue">Current Value (INR) *</Label>
                <Input
                  id="currentValue"
                  type="number"
                  placeholder="e.g. 62000"
                  value={currentValue}
                  onChange={(e) => setCurrentValue(e.target.value)}
                  disabled={saving}
                  className="font-mono"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="quantity">Quantity / Units (Optional)</Label>
              <Input
                id="quantity"
                type="number"
                step="any"
                placeholder="e.g. 10.5 (shares), 25.123 (MF units), 50 (gold grams)"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                disabled={saving}
                className="font-mono"
              />
            </div>

            {/* Conditional Details based on category */}
            {(category === 'shares' || category === 'mutual_funds') && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="detailTicker">Stock Symbol / Fund Ticker (Optional)</Label>
                <Input
                  id="detailTicker"
                  placeholder="e.g. RELIANCE or INFOGRA"
                  value={detailTicker}
                  onChange={(e) => setDetailTicker(e.target.value.toUpperCase())}
                  disabled={saving}
                  className="uppercase font-mono"
                />
              </div>
            )}

            {category === 'property' && (
              <div className="flex flex-col gap-4 border p-4 rounded-lg bg-muted/10">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="detailLocation">Property Location / Address (Optional)</Label>
                  <Input
                    id="detailLocation"
                    placeholder="e.g. Flat 401, Pune IT Park Lane"
                    value={detailLocation}
                    onChange={(e) => setDetailLocation(e.target.value)}
                    disabled={saving}
                  />
                </div>
                
                <div className="flex flex-col gap-1.5 border-t pt-3 border-border/50">
                  <Label htmlFor="propertyTaxDueDate" className="text-violet-500 flex gap-2 items-center"><Calendar size={14}/> Property Tax Due Date</Label>
                  <Input
                    id="propertyTaxDueDate"
                    type="date"
                    value={propertyTaxDueDate}
                    onChange={(e) => setPropertyTaxDueDate(e.target.value)}
                    disabled={saving}
                  />
                </div>
                
                <div className="grid grid-cols-2 gap-3 pt-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={propertyTaxReceiptUploaded} onChange={(e) => setPropertyTaxReceiptUploaded(e.target.checked)} disabled={saving} className="h-4 w-4 rounded border-gray-300" />
                    Tax Receipt Uploaded
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={has712Extract} onChange={(e) => setHas712Extract(e.target.checked)} disabled={saving} className="h-4 w-4 rounded border-gray-300" />
                    Has 7/12 Extract
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={hasNamunaD} onChange={(e) => setHasNamunaD(e.target.checked)} disabled={saving} className="h-4 w-4 rounded border-gray-300" />
                    Has Namuna D
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={hasMap} onChange={(e) => setHasMap(e.target.checked)} disabled={saving} className="h-4 w-4 rounded border-gray-300" />
                    Has Property Map
                  </label>
                </div>
              </div>
            )}

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
                        placeholder="Label (e.g. Folio Number)"
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
                {saving ? 'Researching Asset with AI...' : 'Save Investment Record'}
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
            placeholder="Search by asset name..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 h-11 bg-card border-border/50"
          />
        </div>

        {/* Tab Filters */}
        <div className="flex flex-wrap gap-2">
          {categories.map((cat) => (
            <Button
              key={cat.value}
              variant={selectedCategory === cat.value ? "default" : "outline"}
              onClick={() => setSelectedCategory(cat.value)}
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
      ) : filteredInvestments.length === 0 ? (
        <Card className="border-border/30 bg-card backdrop-blur p-12 text-center animate-fade-in">
          <PiggyBank size={48} className="mx-auto text-faint mb-3" />
          <p className="text-muted-foreground text-sm font-medium">No investments registered yet</p>
        </Card>
      ) : (
        /* Investments Grid */
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {filteredInvestments.map((inv, index) => (
            <Card 
              key={inv.id}
              className="border-border/50 bg-card backdrop-blur shadow-glass hover:bg-card transition-colors p-5 flex flex-col gap-4 animate-fade-in"
            >
              {/* Header */}
              <div className="flex justify-between items-start gap-2">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div className="p-2 rounded-xl border shrink-0 text-violet-400 bg-violet-500/10 border-violet-500/20">
                    <PiggyBank size={18} />
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="font-bold text-foreground text-sm truncate">{inv.title}</span>
                    <span className="text-xs text-muted-foreground truncate mt-0.5">
                      {inv.category.replace('_', ' ').toUpperCase()} — {formatDate(inv.purchaseDate)}
                    </span>
                  </div>
                </div>                <div className="relative flex items-center gap-1.5 shrink-0">
                  <Button 
                    onClick={() => handleShare(inv)}
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
                  {inv.filePath && (
                    <Button
                      onClick={() => setPreviewDoc({
                        name: inv.title,
                        filePath: inv.filePath,
                        mimeType: inv.mimeType,
                        pageCount: inv.pageCount
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
                        onClick: () => handlePrint(inv),
                      },
                      {
                        key: 'download',
                        icon: <Download size={12} />,
                        label: 'Download',
                        onClick: () => {
                          const fields = [
                            { label: 'Category', value: inv.category.replace('_', ' ').toUpperCase() },
                            { label: 'Title', value: inv.title },
                            { label: 'Purchase Date', value: formatDate(inv.purchaseDate) },
                            { label: 'Purchase Value', value: `INR ${Number(inv.purchaseValue).toLocaleString()}` },
                            { label: 'Current Value', value: `INR ${Number(inv.currentValue).toLocaleString()}` },
                            { label: 'Quantity', value: inv.quantity ? Number(inv.quantity) : '' }
                          ];
                          if (inv.details && typeof inv.details === 'object') {
                            if (inv.details.ticker) fields.push({ label: 'Ticker Symbol', value: inv.details.ticker });
                            if (inv.details.location) fields.push({ label: 'Property Location', value: inv.details.location });
                          }
                          if (Array.isArray(inv.customFields)) {
                            inv.customFields.forEach(f => {
                              fields.push({ label: f.label, value: f.value });
                            });
                          }
                          const analysisText = inv.aiAnalysis 
                            ? `AI Analysis:\nRisks: ${inv.aiAnalysis.risks?.join(' | ')}\nOpportunities: ${inv.aiAnalysis.opportunities?.join(' | ')}\nTips: ${inv.aiAnalysis.tips?.join(' | ')}`
                            : '';
                          downloadRecord(`Investment - ${inv.title}`, fields, analysisText);
                        },
                      },
                      {
                        key: 'edit',
                        icon: <Pencil size={12} />,
                        label: 'Edit',
                        onClick: () => openEditModal(inv),
                      },
                      inv.category === 'property' && {
                        key: 'generatefollowups',
                        icon: <ListTodo size={12} />,
                        label: 'Generate Follow-ups',
                        onClick: () => handleGenerateFollowups(inv.id),
                      },
                      {
                        key: 'delete',
                        icon: <Trash2 size={12} />,
                        label: 'Delete',
                        destructive: true,
                        onClick: () => handleDelete(inv.id),
                      },
                    ]}
                  />
                </div>
              </div>

              {/* Valuation details & ROI panel */}
              <div className="flex justify-between items-center bg-muted/20 border border-border/30 rounded-xl p-3">
                <div className="flex gap-4">
                  <div>
                    <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground block mb-0.5">Purchase Value</span>
                    <span className="text-xs font-bold text-foreground font-mono">INR {Number(inv.purchaseValue).toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground block mb-0.5">Current Value</span>
                    <span className="text-xs font-bold text-foreground font-mono">INR {Number(inv.currentValue).toLocaleString()}</span>
                  </div>
                </div>

                {getROIPanel(inv.purchaseValue, inv.currentValue)}
              </div>

              {/* Quantity / Category metadata */}
              {(inv.quantity || inv.details || inv.category === 'property') && (
                <div className="flex flex-wrap gap-2 text-xs">
                  {inv.quantity && (
                    <Badge variant="secondary" className="text-xs font-semibold font-mono">
                      Qty: {Number(inv.quantity)}
                    </Badge>
                  )}
                  {inv.details && typeof inv.details === 'object' && (
                    <>
                      {inv.details.ticker && (
                        <Badge variant="outline" className="text-xs font-semibold font-mono">
                          Ticker: {inv.details.ticker}
                        </Badge>
                      )}
                      {inv.details.location && (
                        <Badge variant="outline" className="text-xs font-semibold">
                          Location: {inv.details.location}
                        </Badge>
                      )}
                    </>
                  )}
                  {inv.category === 'property' && (
                    <>
                      {inv.propertyTaxDueDate && (
                        <Badge variant="outline" className="text-xs text-violet-400 border-violet-500/30">
                          Tax Due: {formatDate(inv.propertyTaxDueDate)}
                        </Badge>
                      )}
                      <Badge variant="outline" className={`text-xs ${inv.propertyTaxReceiptUploaded ? 'text-emerald-400 border-emerald-500/30' : 'text-rose-400 border-rose-500/30'}`}>
                        Tax Receipt {inv.propertyTaxReceiptUploaded ? 'Yes' : 'No'}
                      </Badge>
                      <Badge variant="outline" className={`text-xs ${inv.has712Extract ? 'text-emerald-400 border-emerald-500/30' : 'text-rose-400 border-rose-500/30'}`}>
                        7/12 {inv.has712Extract ? 'Yes' : 'No'}
                      </Badge>
                      <Badge variant="outline" className={`text-xs ${inv.hasNamunaD ? 'text-emerald-400 border-emerald-500/30' : 'text-rose-400 border-rose-500/30'}`}>
                        Namuna D {inv.hasNamunaD ? 'Yes' : 'No'}
                      </Badge>
                      <Badge variant="outline" className={`text-xs ${inv.hasMap ? 'text-emerald-400 border-emerald-500/30' : 'text-rose-400 border-rose-500/30'}`}>
                        Map {inv.hasMap ? 'Yes' : 'No'}
                      </Badge>
                    </>
                  )}
                </div>
              )}

              {/* Render custom fields */}
              {Array.isArray(inv.customFields) && inv.customFields.length > 0 && (
                <div className="flex flex-col gap-1.5 border-t border-border/20 pt-3 mt-1">
                  {inv.customFields.map((f, idx) => (
                    <div key={idx} className="flex justify-between items-center text-xs">
                      <span className="text-muted-foreground">{f.label}:</span>
                      <span className="font-semibold text-foreground font-mono">{f.value}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Gemini AI Insights Highlight Box */}
              {inv.aiAnalysis && (
                <div className="bg-gradient-to-br from-violet-500/5 to-pink-500/5 border border-violet-500/20 rounded-xl p-4 flex flex-col gap-3 mt-2">
                  <div className="flex justify-between items-center">
                    <span className="text-xs font-bold text-violet-400 flex items-center gap-1.5 uppercase tracking-wider">
                      <Sparkles size={13} className="text-violet-400" />
                      <span>AI Insights</span>
                    </span>
                    <Button 
                      onClick={() => handleRegenerateAI(inv.id)}
                      disabled={regeneratingId === inv.id}
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs text-violet-400 border-violet-500/30 hover:bg-violet-500/10 hover:text-violet-300 rounded-lg px-2.5 flex items-center gap-1.5"
                    >
                      <RefreshCw size={11} className={regeneratingId === inv.id ? 'animate-spin' : ''} /> 
                      <span>{regeneratingId === inv.id ? 'Regenerating...' : 'Refresh'}</span>
                    </Button>
                  </div>
                  
                  <div className="flex flex-col gap-2">
                    {inv.aiAnalysis.risks?.length > 0 && (
                      <div className="flex items-start gap-2">
                        <AlertTriangle size={14} className="text-amber-500 mt-0.5 shrink-0" />
                        <div className="flex flex-col gap-0.5">
                          {inv.aiAnalysis.risks.map((r, i) => <span key={i} className="text-xs text-muted-foreground">{r}</span>)}
                        </div>
                      </div>
                    )}
                    {inv.aiAnalysis.opportunities?.length > 0 && (
                      <div className="flex items-start gap-2">
                        <CheckCircle2 size={14} className="text-emerald-500 mt-0.5 shrink-0" />
                        <div className="flex flex-col gap-0.5">
                          {inv.aiAnalysis.opportunities.map((o, i) => <span key={i} className="text-xs text-muted-foreground">{o}</span>)}
                        </div>
                      </div>
                    )}
                    {inv.aiAnalysis.tips?.length > 0 && (
                      <div className="flex items-start gap-2">
                        <Lightbulb size={14} className="text-blue-500 mt-0.5 shrink-0" />
                        <div className="flex flex-col gap-0.5">
                          {inv.aiAnalysis.tips.map((t, i) => <span key={i} className="text-xs text-muted-foreground">{t}</span>)}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

            </Card>
          ))}
        </div>
      )}

      {/* Preview Modal — one pane for every stored format. See
          DocumentPreviewDialog for why this is no longer written per page. */}
      <DocumentPreviewDialog doc={previewDoc} onClose={() => setPreviewDoc(null)} />

      {/* Edit Investment Modal */}
      <Dialog open={!!editingInvestment} onOpenChange={(open) => !open && setEditingInvestment(null)}>
        {editingInvestment && (
          <DialogContent aria-describedby={undefined} className="max-w-2xl max-h-[90vh] flex flex-col py-6 overflow-y-auto border-border/50 bg-card/95 backdrop-blur-md">
            <DialogHeader className="p-0 pb-4 border-b border-border/30">
              <DialogTitle className="text-lg font-bold">Edit Investment Record</DialogTitle>
            </DialogHeader>

            

            <form onSubmit={handleEditSubmit} className="flex flex-col gap-5 mt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editCategory">Category *</Label>
                  <Select value={editCategory} onValueChange={(val) => setEditCategory(val)} disabled={editSaving}>
                    <SelectTrigger id="editCategory">
                      <SelectValue placeholder="Select Category" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mutual_funds">Mutual Funds</SelectItem>
                      <SelectItem value="shares">Stocks / Shares</SelectItem>
                      <SelectItem value="gold">Gold / Precious Metals</SelectItem>
                      <SelectItem value="fixed_deposits">Fixed Deposits (FD)</SelectItem>
                      <SelectItem value="property">Real Estate / Property</SelectItem>
                      <SelectItem value="other">Other Assets</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editTitle">Asset Name *</Label>
                  <Input
                    id="editTitle"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    disabled={editSaving}
                  />
                </div>


                <HolderSelect id="editHolderId" value={editHolderId} onChange={setEditHolderId} disabled={editSaving} />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editPurchaseDate">Purchase Date *</Label>
                  <Input
                    id="editPurchaseDate"
                    type="date"
                    value={editPurchaseDate}
                    onChange={(e) => setEditPurchaseDate(e.target.value)}
                    disabled={editSaving}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editQuantity">Quantity (Optional)</Label>
                  <Input
                    id="editQuantity"
                    type="number"
                    step="any"
                    value={editQuantity}
                    onChange={(e) => setEditQuantity(e.target.value)}
                    disabled={editSaving}
                    className="font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editPurchaseValue">Purchase Value (INR) *</Label>
                  <Input
                    id="editPurchaseValue"
                    type="number"
                    step="any"
                    value={editPurchaseValue}
                    onChange={(e) => setEditPurchaseValue(e.target.value)}
                    disabled={editSaving}
                    className="font-mono"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editCurrentValue">Current Value (INR) *</Label>
                  <Input
                    id="editCurrentValue"
                    type="number"
                    step="any"
                    value={editCurrentValue}
                    onChange={(e) => setEditCurrentValue(e.target.value)}
                    disabled={editSaving}
                    className="font-mono"
                  />
                </div>
              </div>

              {/* Category-specific fields */}
              {(editCategory === 'shares' || editCategory === 'mutual_funds') && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editDetailTicker">Ticker Symbol (Optional)</Label>
                  <Input
                    id="editDetailTicker"
                    placeholder="e.g. INFY, Reliance"
                    value={editDetailTicker}
                    onChange={(e) => setEditDetailTicker(e.target.value)}
                    disabled={editSaving}
                    className="uppercase font-mono"
                  />
                </div>
              )}

              {editCategory === 'property' && (
                <div className="flex flex-col gap-4 border p-4 rounded-lg bg-muted/10">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="editDetailLocation">Property Location (Optional)</Label>
                    <Input
                      id="editDetailLocation"
                      placeholder="e.g. Flat 402, Mumbai"
                      value={editDetailLocation}
                      onChange={(e) => setEditDetailLocation(e.target.value)}
                      disabled={editSaving}
                    />
                  </div>

                  <div className="flex flex-col gap-1.5 border-t pt-3 border-border/50">
                    <Label htmlFor="editPropertyTaxDueDate" className="text-violet-500 flex gap-2 items-center"><Calendar size={14}/> Property Tax Due Date</Label>
                    <Input
                      id="editPropertyTaxDueDate"
                      type="date"
                      value={editPropertyTaxDueDate}
                      onChange={(e) => setEditPropertyTaxDueDate(e.target.value)}
                      disabled={editSaving}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3 pt-2">
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={editPropertyTaxReceiptUploaded} onChange={(e) => setEditPropertyTaxReceiptUploaded(e.target.checked)} disabled={editSaving} className="h-4 w-4 rounded border-gray-300" />
                      Tax Receipt Uploaded
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={editHas712Extract} onChange={(e) => setEditHas712Extract(e.target.checked)} disabled={editSaving} className="h-4 w-4 rounded border-gray-300" />
                      Has 7/12 Extract
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={editHasNamunaD} onChange={(e) => setEditHasNamunaD(e.target.checked)} disabled={editSaving} className="h-4 w-4 rounded border-gray-300" />
                      Has Namuna D
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={editHasMap} onChange={(e) => setEditHasMap(e.target.checked)} disabled={editSaving} className="h-4 w-4 rounded border-gray-300" />
                      Has Property Map
                    </label>
                  </div>
                </div>
              )}

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
                <Button type="button" variant="secondary" onClick={() => setEditingInvestment(null)} disabled={editSaving}>
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
