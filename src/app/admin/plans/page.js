'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  CreditCard, Plus, Pencil, Trash2, Trash, Tag, Sparkles,
  Loader2, Save, X, CheckCircle, Search, AlertTriangle
} from 'lucide-react';
import { clientGetMe } from '@/lib/clientAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogBody } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';
import { validatePricing } from '@/lib/planPricing';
import { orderPlansForAdmin } from '@/lib/planListOrder';


const BADGE_COLORS = [
  { value: 'secondary', label: 'Default (Secondary)', bgClass: 'bg-secondary border border-border' },
  { value: 'primary', label: 'Primary', bgClass: 'bg-primary' },
  { value: 'red', label: 'Red', bgClass: 'bg-red-500' },
  { value: 'orange', label: 'Orange', bgClass: 'bg-orange-500' },
  { value: 'amber', label: 'Amber', bgClass: 'bg-amber-500' },
  { value: 'yellow', label: 'Yellow', bgClass: 'bg-yellow-500' },
  { value: 'lime', label: 'Lime', bgClass: 'bg-lime-500' },
  { value: 'green', label: 'Green', bgClass: 'bg-green-500' },
  { value: 'emerald', label: 'Emerald', bgClass: 'bg-emerald-500' },
  { value: 'teal', label: 'Teal', bgClass: 'bg-teal-500' },
  { value: 'cyan', label: 'Cyan', bgClass: 'bg-cyan-500' },
  { value: 'sky', label: 'Sky Blue', bgClass: 'bg-sky-500' },
  { value: 'blue', label: 'Blue', bgClass: 'bg-blue-500' },
  { value: 'indigo', label: 'Indigo', bgClass: 'bg-indigo-500' },
  { value: 'violet', label: 'Violet', bgClass: 'bg-violet-500' },
  { value: 'purple', label: 'Purple', bgClass: 'bg-purple-500' },
  { value: 'fuchsia', label: 'Fuchsia', bgClass: 'bg-fuchsia-500' },
  { value: 'pink', label: 'Pink', bgClass: 'bg-pink-500' },
  { value: 'rose', label: 'Rose', bgClass: 'bg-rose-500' }
];

const EMPTY_FORM = {
  name: '',
  price: '',
  priceUsd: '',
  priceYearly: '',
  priceYearlyUsd: '',
  priceOneTime: '',
  priceOneTimeUsd: '',
  aiCredits: '0',
  // Which account this plan covers, and the quotas for each half. Present in
  // the form since 0058 — without them the API defaulted every saved plan to
  // personal / one seat / no companies, whatever the operator had in mind.
  appliesTo: 'personal',
  maxMembers: 1,
  maxMembersPerCompany: 0,
  maxCompanies: 0,
  // Blank is a LIFETIME plan (null duration), which planStatus reads as
  // "never expires" — a real choice, not an omission.
  durationDays: '365',
  storageLimitGB: '5',
  amcAmount: '0',
  amcAmountUsd: '0',
  isActive: true,
  isDefault: false,
  badgeColor: 'secondary',
};

export default function PlansPage() {
  const router = useRouter();
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [currentUser, setCurrentUser] = useState(null);
  const [showDialog, setShowDialog] = useState(false);
  const [editPlan, setEditPlan] = useState(null);
  const [formData, setFormData] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  /**
   * Every failure on this screen wrote into `error` state that NOTHING
   * RENDERED — the success banner below had no destructive twin — so a refused
   * request looked like a dead button. That is what "I can't delete plans"
   * was: the route answers a permanent delete with a reason (the plan is still
   * active, it is its account type's default, or a tenant, payment or discount
   * code still points at it), `apiCall` hands that reason back under
   * `json.error`, and the page threw it away.
   *
   * The toast as well as the banner, because the banner sits at the top of the
   * page and the card whose trash icon was clicked is usually several rows
   * down a grid — an explanation off-screen explains nothing.
   */
  const reportError = (message) => {
    setError(message);
    toast.error(message, { id: 'admin-plans-error', duration: 8000 });
  };

  useEffect(() => {
    async function loadSession() {
      const me = await clientGetMe();
      if (!me.success || me.user.role !== 'SUPER_ADMIN') { router.push('/dashboard'); return; }
      setCurrentUser(me.user);
      fetchPlans();
    }
    loadSession();
  }, []);

  const fetchPlans = async () => {
    setLoading(true);
    try {
      // `no-store` as well as the route's own header: this runs immediately
      // after every save, and a browser that already stored a response under the
      // old `stale-while-revalidate` header would keep answering it from disk
      // for the rest of that window — the fresh list would only appear on the
      // next page load, which was the bug.
      const { json: data } = await apiCall('/api/admin/plans', { cache: 'no-store' });
      if (data.success) setPlans(data.plans || []);
      else reportError(data.error || 'Failed to load plans.');
    } catch (err) {
      // A throw here is a bug above, not a transport failure: `apiCall`
      // returns those as values and puts the real reason in `json.error`.
      console.error('[admin/plans] handler threw', err);
      reportError('Something went wrong loading plans. Please try again.');
    }
    finally { setLoading(false); }
  };

  const openAddDialog = () => {
    setFormData({ ...EMPTY_FORM });
    setEditPlan(null);
    setShowDialog(true);
  };

  const openEditDialog = (plan) => {
    setFormData({
      name: plan.name || '',
      price: plan.price?.toString() || '',
      priceUsd: plan.priceUsd?.toString() || '',
      priceYearly: plan.priceYearly?.toString() || '',
      priceYearlyUsd: plan.priceYearlyUsd?.toString() || '',
      priceOneTime: plan.priceOneTime?.toString() || '',
      priceOneTimeUsd: plan.priceOneTimeUsd?.toString() || '',
      aiCredits: plan.aiCredits?.toString() || '0',
      appliesTo: plan.appliesTo || 'personal',
      maxMembers: plan.maxMembers || 1,
      maxMembersPerCompany: plan.maxMembersPerCompany || 0,
      maxCompanies: plan.maxCompanies || 0,
      durationDays: plan.durationDays === null || plan.durationDays === undefined
        ? '' : String(plan.durationDays),
      storageLimitGB: plan.storageLimitGB?.toString() || '5',
      amcAmount: plan.amcAmount?.toString() || '0',
      amcAmountUsd: plan.amcAmountUsd?.toString() || '0',
      isActive: plan.isActive ?? true,
      isDefault: plan.isDefault ?? false,
      badgeColor: plan.badgeColor || 'secondary',
    });
    setEditPlan(plan);
    setShowDialog(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!formData.name.trim()) { reportError('Plan Name is required.'); return; }
    /**
     * At least ONE cycle must be priced — not the monthly one specifically.
     * Requiring monthly made every plan in the live price list unsaveable
     * through this screen, because all of them are annual-only.
     *
     * The same function the API validates with, so the form cannot accept
     * something the route then refuses.
     */
    const priceError = validatePricing(formData);
    if (priceError) { reportError(priceError); return; }

    setSaving(true); setError(''); setSuccess('');
    try {
      const payload = {
        name: formData.name.trim(),
        // null, not 0: an empty monthly price REMOVES that cycle. Zero would
        // render "Free" on the card and sell a year's plan for nothing.
        price: formData.price === '' ? null : Number(formData.price),
        priceUsd: Number(formData.priceUsd) || 0,
        priceYearly: formData.priceYearly ? Number(formData.priceYearly) : null,
        priceYearlyUsd: formData.priceYearlyUsd ? Number(formData.priceYearlyUsd) : null,
        priceOneTime: formData.priceOneTime ? Number(formData.priceOneTime) : null,
        priceOneTimeUsd: formData.priceOneTimeUsd ? Number(formData.priceOneTimeUsd) : null,
        aiCredits: Number(formData.aiCredits) || 0,
        appliesTo: formData.appliesTo,
        maxMembers: Number(formData.maxMembers),
        maxMembersPerCompany: Number(formData.maxMembersPerCompany) || 0,
        maxCompanies: Number(formData.maxCompanies) || 0,
        durationDays: formData.durationDays === '' ? null : Number(formData.durationDays),
        storageLimitGB: Number(formData.storageLimitGB) || 5,
        amcAmount: Number(formData.amcAmount) || 0,
        amcAmountUsd: Number(formData.amcAmountUsd) || 0,
        isActive: formData.isActive,
        isDefault: formData.isDefault,
        badgeColor: formData.badgeColor,
      };

      if (editPlan) {
        const { json: data } = await apiCall(`/api/admin/plans/${editPlan.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (data.success) { setSuccess('Plan updated successfully.'); await fetchPlans(); setShowDialog(false); }
        else reportError(data.error || 'Failed to update plan.');
      } else {
        const { json: data } = await apiCall('/api/admin/plans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (data.success) { setSuccess('Plan created successfully.'); await fetchPlans(); setShowDialog(false); }
        else reportError(data.error || 'Failed to create plan.');
      }
    } catch (err) {
      // A throw here is a bug above, not a transport failure: `apiCall`
      // returns those as values and puts the real reason in `json.error`.
      console.error('[admin/plans] handler threw', err);
      reportError('Something went wrong saving plan. Please try again.');
    }
    finally { setSaving(false); }
  };

  const handleDeactivate = async (plan) => {
    if (!confirm(`Deactivate "${plan.name}" plan?\n\nThis will hide it from available plans for tenants. You can re-activate it later.`)) return;
    setError(''); setSuccess('');
    try {
      const { json: data } = await apiCall(`/api/admin/plans/${plan.id}`, { method: 'DELETE' });
      if (data.success) { setSuccess(`Plan "${plan.name}" deactivated.`); await fetchPlans(); }
      else reportError(data.error || 'Failed to deactivate plan.');
    } catch (err) {
      // A throw here is a bug above, not a transport failure: `apiCall`
      // returns those as values and puts the real reason in `json.error`.
      console.error('[admin/plans] handler threw', err);
      reportError('Something went wrong deactivating plan. Please try again.');
    }
  };

  /**
   * The second step behind the trash icon on an INACTIVE plan.
   *
   * Deactivation already hides a plan from tenants, so what was left over was a
   * screen that accumulated dead rows — a plan typed twice, a draft price list
   * — with no way to clear them. The API refuses this for any plan a tenant,
   * payment or discount code still points at, so the confirm below promises
   * only what it can deliver.
   */
  const handleDeletePermanently = async (plan) => {
    if (!confirm(`Permanently delete "${plan.name}"?\n\nThe plan is removed from the database. This cannot be undone.`)) return;
    setError(''); setSuccess('');
    try {
      const { json: data } = await apiCall(`/api/admin/plans/${plan.id}?permanent=true`, { method: 'DELETE' });
      if (data.success) { setSuccess(`Plan "${plan.name}" deleted.`); await fetchPlans(); }
      else reportError(data.error || 'Failed to delete plan.');
    } catch (err) {
      // A throw here is a bug above, not a transport failure: `apiCall`
      // returns those as values and puts the real reason in `json.error`.
      console.error('[admin/plans] handler threw', err);
      reportError('Something went wrong deleting plan. Please try again.');
    }
  };

  const formatPrice = (price) => {
    if (price === 0) return 'Free';
    return `₹${Number(price).toLocaleString('en-IN')}`;
  };

  // Search, then live plans first and retired ones after. See planListOrder.ts.
  const filteredPlans = orderPlansForAdmin(plans, searchQuery);

  return (
    <PageContainer className="space-y-8 pb-12 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 bg-card backdrop-blur-md p-6 rounded-3xl border border-border/50 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary via-blue-500 to-indigo-600 flex items-center justify-center flex-shrink-0 shadow-lg shadow-primary/20 ring-1 ring-white/10">
            <CreditCard size={28} className="text-white" strokeWidth={1.5} />
          </div>
          <div>
            <h1 className="text-3xl font-black tracking-tight text-foreground bg-clip-text text-transparent bg-gradient-to-r from-foreground to-foreground/70">Subscription Plans</h1>
            <p className="text-muted-foreground text-sm font-medium mt-1">Design and manage pricing tiers for your tenants</p>
          </div>
        </div>
        <Button onClick={openAddDialog} className="flex-shrink-0 bg-primary hover:bg-primary/90 text-primary-foreground font-bold rounded-xl px-6 h-12 shadow-lg shadow-primary/25 transition-all hover:scale-[1.02]">
          <Plus size={18} className="mr-2" /> Create Plan
        </Button>
      </div>

      {/* Alerts */}
      {error && (
        <Alert variant="destructive" className="animate-in slide-in-from-top-2 rounded-2xl backdrop-blur-sm">
          <AlertTriangle size={18} />
          <AlertDescription className="flex items-center justify-between gap-3 text-sm font-semibold ml-2">
            <span>{error}</span>
            <button onClick={() => setError('')} className="p-1 hover:bg-danger-surface rounded-full transition-colors shrink-0"><X size={14} /></button>
          </AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert variant="success" className="animate-in slide-in-from-top-2 rounded-2xl backdrop-blur-sm">
          <CheckCircle size={18} />
          <AlertDescription className="flex items-center justify-between text-sm font-semibold ml-2">
            <span>{success}</span>
            <button onClick={() => setSuccess('')} className="p-1 hover:bg-emerald-500/20 rounded-full transition-colors"><X size={14} /></button>
          </AlertDescription>
        </Alert>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent aria-describedby={undefined} className="max-w-[520px] border border-border/80 bg-card rounded-2xl shadow-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-xl font-black">
              <div className="p-2 bg-primary/10 rounded-lg text-primary">
                <CreditCard size={18} />
              </div>
              {editPlan ? 'Edit Subscription Plan' : 'Create New Plan'}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSave}>
            <DialogBody className="flex flex-col gap-5 max-h-[65vh] overflow-y-auto pr-2 custom-scrollbar">
              <div className="grid grid-cols-1 gap-5">
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Plan Name *</Label>
                  <Input className="h-11 rounded-xl" placeholder="e.g. Pro Monthly" value={formData.name} onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))} required disabled={saving} />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 items-start">
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Price (₹) *</Label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">₹</span>
                    <Input className="pl-8 h-11 rounded-xl" type="number" min="0" step="1" placeholder="4999" value={formData.price} onChange={e => setFormData(prev => ({ ...prev, price: e.target.value }))} required disabled={saving} />
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Price ($)</Label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">$</span>
                    <Input className="pl-8 h-11 rounded-xl" type="number" min="0" step="1" placeholder="59" value={formData.priceUsd} onChange={e => setFormData(prev => ({ ...prev, priceUsd: e.target.value }))} disabled={saving} />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 items-start mt-2">
                  <div className="flex flex-col gap-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">AMC Amount (₹)</Label>
                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">₹</span>
                      <Input className="pl-8 h-11 rounded-xl bg-card" type="number" min="0" step="1" placeholder="500" value={formData.amcAmount} onChange={e => setFormData(prev => ({ ...prev, amcAmount: e.target.value }))} disabled={saving} />
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">AMC Amount ($)</Label>
                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">$</span>
                      <Input className="pl-8 h-11 rounded-xl bg-card" type="number" min="0" step="1" placeholder="10" value={formData.amcAmountUsd} onChange={e => setFormData(prev => ({ ...prev, amcAmountUsd: e.target.value }))} disabled={saving} />
                    </div>
                  </div>
                </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 items-start">
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Price (Yearly) (₹)</Label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">₹</span>
                    <Input className="pl-8 h-11 rounded-xl" type="number" min="0" step="1" placeholder="49990" value={formData.priceYearly} onChange={e => setFormData(prev => ({ ...prev, priceYearly: e.target.value }))} disabled={saving} />
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Price (Yearly) ($)</Label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">$</span>
                    <Input className="pl-8 h-11 rounded-xl" type="number" min="0" step="1" placeholder="499" value={formData.priceYearlyUsd} onChange={e => setFormData(prev => ({ ...prev, priceYearlyUsd: e.target.value }))} disabled={saving} />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 items-start">
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Price (One-Time) (₹)</Label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">₹</span>
                    <Input className="pl-8 h-11 rounded-xl" type="number" min="0" step="1" placeholder="199999" value={formData.priceOneTime} onChange={e => setFormData(prev => ({ ...prev, priceOneTime: e.target.value }))} disabled={saving} />
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Price (One-Time) ($)</Label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">$</span>
                    <Input className="pl-8 h-11 rounded-xl" type="number" min="0" step="1" placeholder="1999" value={formData.priceOneTimeUsd} onChange={e => setFormData(prev => ({ ...prev, priceOneTimeUsd: e.target.value }))} disabled={saving} />
                  </div>
                </div>
              </div>

              {/*
                ── WHICH ACCOUNT THIS PLAN COVERS ─────────────────────────────
                Decides which billing tab it is offered in and which quotas
                below mean anything. A plan saved without this was silently
                personal, however its seat counts were filled in.
              */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Account</Label>
                  <select
                    className="h-11 rounded-xl border border-border bg-background px-3 text-sm font-semibold text-foreground"
                    value={formData.appliesTo}
                    onChange={e => setFormData(prev => ({ ...prev, appliesTo: e.target.value }))}
                    disabled={saving}
                  >
                    <option value="personal">Personal</option>
                    <option value="business">Business</option>
                    <option value="both">Personal + Business</option>
                  </select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    Duration (days)
                  </Label>
                  <Input className="h-11 rounded-xl" type="number" min="1" step="1" placeholder="365" value={formData.durationDays} onChange={e => setFormData(prev => ({ ...prev, durationDays: e.target.value }))} disabled={saving} />
                  <span className="text-2xs text-muted-foreground">Leave blank for a lifetime plan that never expires.</span>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">AI Credits (per cycle)</Label>
                  <Input className="h-11 rounded-xl" type="number" min="0" placeholder="0" value={formData.aiCredits} onChange={e => setFormData(prev => ({ ...prev, aiCredits: e.target.value }))} disabled={saving} />
                </div>
                {/* Personal seats. Shown only for a plan that covers the
                    household — on a business-only plan the number means nothing
                    and inviting one is inviting a wrong answer. */}
                {formData.appliesTo !== 'business' && (
                  <div className="flex flex-col gap-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                      Members (personal, incl. admin)
                    </Label>
                    <Input className="h-11 rounded-xl" type="number" min="1" step="1" placeholder="1" value={formData.maxMembers} onChange={e => setFormData(prev => ({ ...prev, maxMembers: e.target.value }))} disabled={saving} />
                  </div>
                )}
              </div>

              {/* The business quotas, for the axes this plan actually covers. */}
              {formData.appliesTo !== 'personal' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <div className="flex flex-col gap-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Companies</Label>
                    <Input className="h-11 rounded-xl" type="number" min="0" step="1" placeholder="1" value={formData.maxCompanies} onChange={e => setFormData(prev => ({ ...prev, maxCompanies: e.target.value }))} disabled={saving} />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                      Members in EACH company
                    </Label>
                    <Input className="h-11 rounded-xl" type="number" min="0" step="1" placeholder="5" value={formData.maxMembersPerCompany} onChange={e => setFormData(prev => ({ ...prev, maxMembersPerCompany: e.target.value }))} disabled={saving} />
                    <span className="text-2xs text-muted-foreground">Per company, not a total across the account.</span>
                  </div>
                </div>
              )}
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Storage Limit (GB)</Label>
                  <Input className="h-11 rounded-xl" type="number" min="1" step="1" placeholder="5" value={formData.storageLimitGB} onChange={e => setFormData(prev => ({ ...prev, storageLimitGB: e.target.value }))} disabled={saving} />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Badge Color</Label>
                  <Select 
                    value={formData.badgeColor} 
                    onValueChange={val => setFormData(prev => ({ ...prev, badgeColor: val }))} 
                    disabled={saving}
                  >
                    <SelectTrigger className="h-11 rounded-xl">
                      <SelectValue placeholder="Select color" />
                    </SelectTrigger>
                    <SelectContent>
                      {BADGE_COLORS.map(color => (
                        <SelectItem key={color.value} value={color.value}>
                          <div className="flex items-center gap-2">
                            <div className={cn("w-3.5 h-3.5 rounded-full shadow-sm", color.bgClass)} />
                            <span>{color.label}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-2 justify-center pt-6">
                  <div className="flex items-center gap-2">
                    <input 
                      type="checkbox" 
                      id="isDefault" 
                      className="rounded border-border/50 bg-muted/50 text-primary focus:ring-primary h-4 w-4"
                      checked={formData.isDefault}
                      onChange={(e) => setFormData(prev => ({ ...prev, isDefault: e.target.checked }))}
                    />
                    <Label htmlFor="isDefault" className="text-xs font-semibold text-muted-foreground cursor-pointer">Default Plan (Trial)</Label>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between p-4 rounded-xl bg-muted/30 border border-border/50">
                <div className="flex flex-col">
                  <span className="text-sm font-bold text-foreground">Plan Status</span>
                  <span className="text-xs text-muted-foreground">Inactive plans are hidden from tenants.</span>
                </div>
                <Button
                  type="button"
                  variant={formData.isActive ? "success" : "outline"}
                  size="sm"
                  onClick={() => setFormData(prev => ({ ...prev, isActive: !prev.isActive }))}
                  className={cn("h-9 rounded-lg transition-all w-[100px] border", formData.isActive ? "border-transparent shadow-lg shadow-success/20" : "bg-muted text-muted-foreground hover:bg-muted/80 border-border")}
                >
                  {formData.isActive ? (
                    <span className="flex items-center gap-2 font-bold"><CheckCircle size={14} /> Active</span>
                  ) : (
                    <span className="flex items-center gap-2 font-bold"><X size={14} /> Inactive</span>
                  )}
                </Button>
              </div>
            </DialogBody>
            <DialogFooter className="gap-3 pt-6 pb-2">
              <Button type="button" variant="ghost" className="rounded-xl font-semibold" onClick={() => setShowDialog(false)} disabled={saving}>Cancel</Button>
              <Button type="submit" disabled={saving} className="bg-primary text-primary-foreground font-bold rounded-xl px-8 shadow-lg shadow-primary/20 hover:scale-[1.02] transition-transform">
                {saving ? <Loader2 size={16} className="animate-spin mr-2" /> : <Save size={16} className="mr-2" />}
                {editPlan ? 'Save Changes' : 'Create Plan'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Search Bar */}
      {!loading && plans.length > 0 && (
        <div className="relative max-w-md animate-fade-in stagger-1">
          <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-11 h-12 rounded-2xl bg-card backdrop-blur border-border/50 shadow-sm text-sm focus-visible:ring-primary/30 focus-visible:border-primary/50 transition-all" placeholder="Search plans by name..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1 hover:bg-muted rounded-full transition-colors">
              <X size={14} />
            </button>
          )}
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-32 gap-4 text-muted-foreground">
          <div className="p-4 bg-primary/10 rounded-2xl">
            <Loader2 size={32} className="animate-spin text-primary" />
          </div>
          <p className="text-sm font-medium animate-pulse">Loading subscription plans...</p>
        </div>
      ) : plans.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-32 gap-5 bg-card backdrop-blur-sm border border-dashed border-border/60 rounded-3xl animate-in fade-in zoom-in-95 duration-500">
          <div className="w-20 h-20 bg-muted/50 rounded-full flex items-center justify-center mb-2">
            <CreditCard size={32} className="text-muted-foreground opacity-50" />
          </div>
          <div className="text-center max-w-sm px-4">
            <p className="font-black text-xl text-foreground mb-2">No Subscription Plans</p>
            <p className="text-sm text-muted-foreground mb-6 leading-relaxed">You haven't created any pricing tiers yet. Add your first plan to allow tenants to subscribe.</p>
            <Button onClick={openAddDialog} className="h-12 px-6 rounded-xl bg-primary hover:bg-primary/90 text-white font-bold shadow-lg shadow-primary/25 hover:scale-[1.02] transition-transform">
              <Plus size={18} className="mr-2" /> Create First Plan
            </Button>
          </div>
        </div>
      ) : filteredPlans.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 bg-card backdrop-blur-sm border border-border/50 rounded-3xl animate-in fade-in duration-300">
          <div className="p-4 bg-muted/50 rounded-full mb-2">
            <Search size={28} className="text-muted-foreground opacity-60" />
          </div>
          <p className="font-bold text-lg text-foreground">No matching plans found</p>
          <p className="text-sm text-muted-foreground">Try adjusting your search terms.</p>
          <Button variant="link" onClick={() => setSearchQuery('')} className="mt-2 text-primary">Clear search</Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 animate-in slide-in-from-bottom-4 fade-in duration-500">
          {filteredPlans.map((plan) => (
            <Card
              key={plan.id}
              className={cn(
                'relative overflow-hidden transition-all duration-300 bg-card backdrop-blur-xl border-border/50 flex flex-col rounded-3xl hover:-translate-y-1 hover:shadow-2xl',
                plan.isActive ? 'hover:shadow-primary/10 border-t-[6px] border-t-primary' : 'opacity-70 grayscale-[30%] border-t-[6px] border-t-muted-foreground'
              )}
            >
              {/* Optional: Glow effect in background */}
              {plan.isActive && <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 rounded-full blur-3xl -z-10" />}
              
              <CardContent className="p-6 flex flex-col flex-1 relative z-10">
                {/* Plan Header */}
                <div className="flex items-start justify-between gap-3 mb-5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1.5">
                      <h3 className="font-black text-xl text-foreground truncate">{plan.name}</h3>
                      {!plan.isActive && (
                        <Badge variant="secondary" className="text-xs font-bold bg-muted-foreground/20 text-muted-foreground rounded-md border-0">INACTIVE</Badge>
                      )}
                      {plan.isDefault && (
                        <Badge variant="secondary" className="text-xs font-bold bg-primary/20 text-primary rounded-md border-0">DEFAULT</Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0 bg-background/50 backdrop-blur p-1 rounded-xl border border-border/50">
                    <Button variant="ghost" size="icon" onClick={() => openEditDialog(plan)} className="h-8 w-8 rounded-lg hover:bg-primary/10 hover:text-primary transition-colors" title="Edit Plan">
                      <Pencil size={14} />
                    </Button>
                    {/*
                      One icon, two acts, decided by the plan's own state: a live
                      plan is deactivated (reversible, and what a super admin
                      wants nine times in ten), an already-inactive one is
                      deleted for good. The button used to be simply DISABLED on
                      an inactive plan, which left no way to clear a mistyped
                      plan off this screen at all.
                    */}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => (plan.isActive ? handleDeactivate(plan) : handleDeletePermanently(plan))}
                      title={plan.isActive ? 'Deactivate Plan' : 'Delete Plan Permanently'}
                      className={cn(
                        'h-8 w-8 rounded-lg transition-colors hover:bg-destructive/10 hover:text-danger-action',
                        plan.isActive ? 'text-danger-action/70' : 'text-danger-action'
                      )}
                    >
                      {plan.isActive ? <Trash2 size={14} /> : <Trash size={14} />}
                    </Button>
                  </div>
                </div>

                {/* Price Display */}
                <div className="mb-6 flex flex-col gap-1">
                  <div className="flex items-baseline gap-1.5 flex-wrap">
                    <span className="text-2xl font-black tracking-tighter text-foreground">
                      {formatPrice(plan.price)}
                    </span>
                    {plan.priceUsd > 0 && (
                      <span className="text-sm text-muted-foreground font-bold">
                        / ${Number(plan.priceUsd).toLocaleString()}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider ml-1">/ MONTH</span>
                  </div>

                  {plan.priceYearly && (
                    <div className="flex items-baseline gap-1.5 flex-wrap">
                      <span className="text-lg font-bold text-foreground/80">
                        {formatPrice(plan.priceYearly)}
                      </span>
                      {plan.priceYearlyUsd > 0 && (
                        <span className="text-xs text-muted-foreground font-semibold">
                          / ${Number(plan.priceYearlyUsd).toLocaleString()}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider ml-1">/ YEAR</span>
                    </div>
                  )}

                  {plan.priceOneTime && (
                    <div className="flex items-baseline gap-1.5 flex-wrap">
                      <span className="text-lg font-bold text-foreground/80">
                        {formatPrice(plan.priceOneTime)}
                      </span>
                      {plan.priceOneTimeUsd > 0 && (
                        <span className="text-xs text-muted-foreground font-semibold">
                          / ${Number(plan.priceOneTimeUsd).toLocaleString()}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider ml-1">/ ONE-TIME</span>
                    </div>
                  )}
                </div>

                {/* Details & AI Credits */}
                <div className="flex flex-col gap-4 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-muted-foreground bg-muted/50 px-2 py-1 rounded-md border border-border/50">
                      Members: {plan.maxMembers || 1}
                    </span>
                    <span className="text-xs font-semibold text-muted-foreground bg-muted/50 px-2 py-1 rounded-md border border-border/50">
                      Storage: {plan.storageLimitGB || 5} GB
                    </span>
                    {plan.isLifetime && Number(plan.amcAmount) > 0 && (
                      <span className="text-xs font-semibold text-emerald-600 bg-emerald-500/10 px-2 py-1 rounded-md border border-emerald-500/20">
                        AMC: ₹{plan.amcAmount}/yr
                      </span>
                    )}
                  </div>
                  {plan.aiCredits > 0 && (
                    <div className="mt-auto pt-5">
                      <span className="text-sm font-black uppercase tracking-widest text-primary flex items-center gap-1.5 mb-3">
                        <Sparkles size={16} /> +{plan.aiCredits} AI Credits
                      </span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
