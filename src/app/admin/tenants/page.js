'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Users, Plus, Trash2, Edit2, CheckCircle, AlertCircle,
  Loader2, Save, X, FileText, KeyRound, FolderOpen,
  Copy, Check, Search, Shield, Zap, CreditCard, Sparkles,
  Calendar, ToggleLeft, ToggleRight, Info, Ticket
} from 'lucide-react';
import { clientGetMe } from '@/lib/clientAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogBody } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { storagePressure } from '@/lib/storagePressure';
import { formatDate } from '@/lib/dateHelper';
import { DEFAULT_GEMINI_MODEL } from '@/lib/aiModels';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';


/**
 * The drawer's three building blocks. Local to this page on purpose — they are
 * label/value plumbing for one dialog, not a design-system component.
 */
function DetailSection({ title, children }) {
  return (
    <div className="flex flex-col gap-2 p-3.5 bg-muted/20 border border-border/50 rounded-xl">
      <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{title}</div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

/** An em dash for an absent value, so a blank row still reads as "we looked". */
function DetailRow({ label, value, badge }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-foreground font-semibold text-right break-words flex items-center gap-1.5">
        {value === null || value === undefined || value === '' ? <span className="text-faint font-normal">—</span> : value}
        {badge && <Badge variant="secondary" className="text-2xs py-0 px-1 rounded-sm leading-none">{badge}</Badge>}
      </span>
    </div>
  );
}

function DetailTable({ head, rows, empty }) {
  if (!rows.length) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border/50">
            {head.map(h => (
              <th key={h} className="text-left font-bold text-muted-foreground py-1.5 pr-3 whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border/30 last:border-0">
              {row.map((cell, j) => (
                <td key={j} className="py-1.5 pr-3 text-foreground align-top">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function TenantsPage() {
  const router = useRouter();
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [currentUser, setCurrentUser] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editTenant, setEditTenant] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    apiKey: '',
    aiProvider: 'gemini',
    aiModel: DEFAULT_GEMINI_MODEL,
    subscriptionPlanId: '',
    subscriptionExpiry: '',
    isActive: true,
    createAdmin: false,
    adminName: '',
    adminEmail: '',
    adminPassword: '',
    clearApiKey: false,
    billingName: '',
    billingGst: '',
    billingAddress: '',
    billingEmail: '',
    billingPhone: '',
    contactName: ''
  });
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedId, setCopiedId] = useState(null);
  const [plans, setPlans] = useState([]);

  // Add-ons state
  const [availableAddons, setAvailableAddons] = useState([]);
  const [tenantAddons, setTenantAddons] = useState([]);
  const [selectedAddon, setSelectedAddon] = useState('');
  const [grantingAddon, setGrantingAddon] = useState(false);
  const [showAddonsModal, setShowAddonsModal] = useState(false);
  const [addonsTenant, setAddonsTenant] = useState(null);

  // Payment processing state
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentTenant, setPaymentTenant] = useState(null);
  const [paymentPlanId, setPaymentPlanId] = useState('');
  const [overrideReason, setOverrideReason] = useState('');

  // Tenant detail drawer. Fetched lazily on open so the list payload stays light.
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [detailTenant, setDetailTenant] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const [showCreditsModal, setShowCreditsModal] = useState(false);
  const [creditsTenant, setCreditsTenant] = useState(null);
  const [creditsMode, setCreditsMode] = useState('delta'); // 'delta' | 'set'
  const [creditsDelta, setCreditsDelta] = useState('');
  const [creditsReason, setCreditsReason] = useState('');
  const [adjustingCredits, setAdjustingCredits] = useState(false);

  useEffect(() => {
    async function loadSession() {
      const me = await clientGetMe();
      if (!me.success || me.user.role !== 'SUPER_ADMIN') { router.push('/dashboard'); return; }
      setCurrentUser(me.user);
      fetchTenants();
      fetchAvailableAddons();
      fetchPlans();
    }
    loadSession();
  }, []);

  const fetchTenants = async () => {
    setLoading(true);
    try {
      const { json: data } = await apiCall('/api/admin/tenants');
      if (data.success) setTenants(data.tenants || []);
      else setError(data.error || 'Failed to load tenants.');
    } catch (err) {
      // A throw here is a bug above, not a transport failure: `apiCall`
      // returns those as values and puts the real reason in `json.error`.
      console.error('[admin/tenants] handler threw', err);
      setError('Something went wrong loading tenants. Please try again.');
    }
    finally { setLoading(false); }
  };

  const fetchAvailableAddons = async () => {
    try {
      const { json: data } = await apiCall('/api/admin/addons');
      if (data.success) setAvailableAddons(data.addons?.filter(a => a.isActive) || []);
    } catch (e) {
      console.error('Failed to load addons', e);
    }
  };

  const fetchPlans = async () => {
    try {
      const { json: data } = await apiCall('/api/admin/plans', { cache: 'no-store' });
      if (data.success) setPlans(data.plans?.filter(p => p.isActive) || []);
    } catch (e) {
      console.error('Failed to load plans', e);
    }
  };

  const handleNameChange = (val) => {
    setFormData(prev => ({ ...prev, name: val }));
  };

  const openAddForm = () => {
    setFormData({
      name: '',
      apiKey: '',
      aiProvider: 'gemini',
      aiModel: DEFAULT_GEMINI_MODEL,
      subscriptionPlanId: '',
      subscriptionExpiry: '',
      isActive: true,
      createAdmin: false,
      adminName: '',
      adminEmail: '',
      adminPassword: '',
      clearApiKey: false,
      billingName: '',
      billingGst: '',
      billingAddress: '',
      billingEmail: '',
      billingPhone: '',
      contactName: ''
    });
    setEditTenant(null);
    setShowAddForm(true);
  };

  const openEditForm = (tenant) => {
    setFormData({
      name: tenant.name,
      // Always blank. The listing no longer ships the stored key (it was the
      // CIPHERTEXT, and putting it back through PUT re-encrypted it), so a blank
      // field means "leave the key alone" — see `clearApiKey` to remove one.
      apiKey: '',
      aiProvider: tenant.aiProvider || 'gemini',
      aiModel: tenant.aiModel || DEFAULT_GEMINI_MODEL,
      subscriptionPlanId: tenant.subscriptionPlanId || '',
      subscriptionExpiry: tenant.subscriptionExpiry ? new Date(tenant.subscriptionExpiry).toISOString().split('T')[0] : '',
      isActive: tenant.isActive ?? true,
      createAdmin: false,
      adminName: '',
      adminEmail: '',
      adminPassword: '',
      clearApiKey: false,
      billingName: tenant.billingName || '',
      billingGst: tenant.billingGst || '',
      billingAddress: tenant.billingAddress || '',
      billingEmail: tenant.billingEmail || '',
      billingPhone: tenant.billingPhone || '',
      contactName: tenant.contactName || ''
    });
    setEditTenant(tenant); 
    setShowAddForm(true);
  };

  const openDetailModal = async (tenant) => {
    setDetailTenant(tenant);
    setDetail(null);
    setDetailError('');
    setShowDetailModal(true);
    setDetailLoading(true);
    try {
      const { json: data } = await apiCall(`/api/admin/tenants/${tenant.id}/overview`);
      if (data.success) setDetail(data);
      else setDetailError(data.error || 'Failed to load workspace details.');
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[admin/tenants] handler threw', err);
      setDetailError('Something went wrong loading workspace details. Please try again.');
    } finally {
      setDetailLoading(false);
    }
  };

  const openAddonsModal = (tenant) => {
    setAddonsTenant(tenant);
    setTenantAddons([]);
    setSelectedAddon('');
    fetchTenantAddons(tenant.id);
    setShowAddonsModal(true);
  };

  const fetchTenantAddons = async (tenantId) => {
    try {
      const { json: data } = await apiCall(`/api/admin/tenants/${tenantId}/addons`);
      if (data.success) {
        setTenantAddons(data.tenantAddons || []);
      }
    } catch (e) {
      console.error('Failed to load tenant addons', e);
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!formData.name.trim()) { setError('Name is required.'); return; }
    setSaving(true); setError(''); setSuccess('');
    try {
      const payload = {
        name: formData.name,
        aiProvider: formData.aiProvider,
        aiModel: formData.aiModel,
        subscriptionPlanId: formData.subscriptionPlanId || null,
        subscriptionExpiry: formData.subscriptionExpiry || null,
        isActive: formData.isActive,
        billingName: formData.billingName,
        billingGst: formData.billingGst,
        billingAddress: formData.billingAddress,
        billingEmail: formData.billingEmail,
        billingPhone: formData.billingPhone,
        contactName: formData.contactName,
        // Omitted entirely when blank so an edit that never touches the field
        // leaves the stored key untouched.
        ...(formData.apiKey.trim() ? { apiKey: formData.apiKey.trim() } : {}),
        ...(formData.clearApiKey ? { clearApiKey: true } : {})
      };

      if (editTenant) {
        const { json: data } = await apiCall(`/api/admin/tenants/${editTenant.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (data.success) { setSuccess('Tenant settings updated successfully.'); await fetchTenants(); setShowAddForm(false); }
        else setError(data.error || 'Failed to update tenant.');
      } else {
        const { json: data } = await apiCall('/api/admin/tenants', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
          ...payload,
          adminEmail: formData.createAdmin ? formData.adminEmail : undefined,
          adminName: formData.createAdmin ? formData.adminName : undefined,
          adminPassword: formData.createAdmin ? formData.adminPassword : undefined
          })
        });
        if (data.success) { setSuccess('Tenant created successfully.'); await fetchTenants(); setShowAddForm(false); }
        else setError(data.error || 'Failed to create tenant.');
      }
    } catch (err) {
      // A throw here is a bug above, not a transport failure: `apiCall`
      // returns those as values and puts the real reason in `json.error`.
      console.error('[admin/tenants] handler threw', err);
      setError('Something went wrong saving tenant. Please try again.');
    }
    finally { setSaving(false); }
  };

  const handleGrantAddon = async () => {
    if (!selectedAddon || !addonsTenant) return;
    setGrantingAddon(true);
    setError('');
    setSuccess('');
    try {
      const { json: data } = await apiCall(`/api/admin/tenants/${addonsTenant.id}/addons`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addonId: selectedAddon })
      });
      if (data.success) {
        setSuccess('Add-on granted successfully.');
        setSelectedAddon('');
        await fetchTenantAddons(addonsTenant.id);
        await fetchTenants(); // refresh stats
      } else {
        setError(data.error || 'Failed to grant add-on.');
      }
    } catch (e) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[admin/tenants] handler threw', e);
      setError('Something went wrong granting add-on. Please try again.');
    } finally {
      setGrantingAddon(false);
    }
  };

  const handleDelete = async (tenant) => {
    if (tenant.id === currentUser?.tenantId) { setError('Cannot delete your active tenant.'); return; }
    if (!confirm(`Delete "${tenant.name}"?\n\nWARNING: All associated data will be permanently deleted. This cannot be undone.`)) return;
    setError(''); setSuccess('');
    try {
      const { json: data } = await apiCall(`/api/admin/tenants/${tenant.id}`, { method: 'DELETE' });
      if (data.success) { setSuccess('Tenant workspace deleted successfully.'); setTenants(prev => prev.filter(t => t.id !== tenant.id)); }
      else setError(data.error || 'Failed to delete tenant.');
    } catch (err) {
      // A throw here is a bug above, not a transport failure: `apiCall`
      // returns those as values and puts the real reason in `json.error`.
      console.error('[admin/tenants] handler threw', err);
      setError('Something went wrong deleting tenant. Please try again.');
    }
  };

  const handleCopy = (text, id) => { navigator.clipboard.writeText(text); setCopiedId(id); setTimeout(() => setCopiedId(null), 2000); };

  const filteredTenants = tenants.filter(t => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return true;
    return t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q);
  });

  const openPaymentModal = (tenant) => {
    setPaymentTenant(tenant);
    setPaymentPlanId(plans.length > 0 ? plans[0].id : '');
    setOverrideReason('');
    setError(''); setSuccess('');
    setShowPaymentModal(true);
  };

  const hasDefaultPlan = plans.some(p => p.isDefault);

  const processPayment = async (e) => {
    e.preventDefault();
    if (!paymentPlanId) { setError('No active plan is available to assign. Create one under Admin → Plans.'); return; }
    if (!overrideReason.trim()) { setError('Reason is required'); return; }
    
    setIsProcessingPayment(true);
    setError(''); setSuccess('');
    
    try {
      const { res, json: data } = await apiCall(`/api/admin/tenants/${paymentTenant.id}/upgrade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: paymentPlanId, reason: overrideReason })
      });
      
      if (!res.ok || !data.success) {
        setError(data.error || 'Failed to change plan');
        setIsProcessingPayment(false);
        return;
      }

      setSuccess(`Plan applied. ${Number(data.creditsGranted || 0).toLocaleString()} AI credits granted.`);
      setShowPaymentModal(false);
      fetchTenants();
      
    } catch (e) {
      setError('Error initiating upgrade');
    }
    setIsProcessingPayment(false);
  };

  const openCreditsModal = (tenant) => {
    setCreditsTenant(tenant);
    setCreditsMode('delta');
    setCreditsDelta('');
    setCreditsReason('');
    setError(''); setSuccess('');
    setShowCreditsModal(true);
  };

  const switchCreditsMode = (mode) => {
    setCreditsMode(mode);
    setCreditsDelta('');
    setError('');
  };

  const adjustCredits = async (e) => {
    e.preventDefault();
    const value = Number(creditsDelta);

    if (creditsDelta.trim() === '' || !Number.isInteger(value)) {
      setError('Enter a whole number of credits');
      return;
    }
    if (creditsMode === 'delta' && value === 0) {
      setError('Enter a non-zero whole number of credits');
      return;
    }
    if (creditsMode === 'set' && value < 0) {
      setError('A balance cannot be negative');
      return;
    }
    if (!creditsReason.trim()) { setError('Reason is required'); return; }

    setAdjustingCredits(true);
    setError(''); setSuccess('');

    try {
      const payload = creditsMode === 'set'
        ? { mode: 'set', balance: value, reason: creditsReason }
        : { mode: 'delta', delta: value, reason: creditsReason };

      const { res, json: data } = await apiCall(`/api/admin/tenants/${creditsTenant.id}/credits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok || !data.success) {
        setError(data.error || 'Failed to adjust credits');
        setAdjustingCredits(false);
        return;
      }

      setSuccess(`AI credits updated: ${data.previousBalance} → ${data.newBalance}`);
      setShowCreditsModal(false);
      fetchTenants();
    } catch (e) {
      setError('Error adjusting credits');
    }
    setAdjustingCredits(false);
  };

  return (
    <PageContainer width="wide" className="space-y-6 pb-12">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3 animate-fade-in">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-primary to-orange-500 flex items-center justify-center flex-shrink-0">
            <Users size={22} className="text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-foreground">Sovereign Tenant Organizations</h1>
            <p className="text-muted-foreground text-sm">Control workspaces, custom Gemini keys, plans, and verify AI billing tokens</p>
          </div>
        </div>
        <Button onClick={openAddForm} className="flex-shrink-0 bg-primary hover:bg-primary/95 text-primary-foreground font-bold">
          <Plus size={16} /> Create Tenant
        </Button>
      </div>

      {/* Alerts */}
      {error && (
        <Alert variant="destructive" className="animate-scale-in">
          <AlertCircle size={15} />
          <AlertDescription className="flex items-center justify-between text-xs text-foreground font-semibold">
            <span>{error}</span>
            <button onClick={() => setError('')} className="ml-4"><X size={13} /></button>
          </AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert variant="success" className="animate-scale-in">
          <CheckCircle size={15} />
          <AlertDescription className="flex items-center justify-between text-xs text-foreground font-semibold">
            <span>{success}</span>
            <button onClick={() => setSuccess('')} className="ml-4"><X size={13} /></button>
          </AlertDescription>
        </Alert>
      )}

      {/* Change Plan Dialog */}
      <Dialog open={showPaymentModal} onOpenChange={setShowPaymentModal}>
        <DialogContent aria-describedby={undefined} className="max-w-[400px] border border-border/80 bg-card">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-primary font-bold">
              <CreditCard size={17} /> Change Subscription Plan
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={processPayment}>
            <div className="flex flex-col gap-4 py-4 px-6">
              <div className="flex flex-col gap-1.5">
                <Label>Select Plan</Label>
                {plans.length === 0 ? (
                  <p className="text-xs font-semibold text-danger-text">
                    No active plan is available to assign. Create one under Admin → Plans.
                  </p>
                ) : (
                  <select className="flex h-9 w-full rounded-md border border-input bg-field px-3 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" value={paymentPlanId} onChange={e => setPaymentPlanId(e.target.value)} required disabled={isProcessingPayment}>
                    {plans.map(plan => (
                      <option key={plan.id} value={plan.id}>{plan.name} (₹{plan.price})</option>
                    ))}
                  </select>
                )}
                <span className="text-xs text-muted-foreground">
                  The plan&apos;s AI credits are <span className="font-bold">added</span> to the current balance, not substituted for it. To replace a balance outright, use Adjust → Set exact balance.
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Reason for Override *</Label>
                <Input placeholder="e.g. Comped for demo, migration fix" value={overrideReason} onChange={e => setOverrideReason(e.target.value)} required disabled={isProcessingPayment} />
              </div>
              {error && <p className="text-xs font-semibold text-danger-text">{error}</p>}
            </div>
            <DialogFooter className="px-6 py-4 border-t">
              <Button type="button" variant="outline" onClick={() => setShowPaymentModal(false)} disabled={isProcessingPayment}>Cancel</Button>
              <Button type="submit" disabled={isProcessingPayment || plans.length === 0}>{isProcessingPayment ? <Loader2 size={14} className="animate-spin" /> : 'Apply Plan'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Adjust AI Credits Dialog */}
      <Dialog open={showCreditsModal} onOpenChange={setShowCreditsModal}>
        <DialogContent aria-describedby={undefined} className="max-w-[400px] border border-border/80 bg-card">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-primary font-bold">
              <Zap size={17} /> Adjust AI Credits
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={adjustCredits}>
            <div className="flex flex-col gap-4 py-4 px-6">
              <div className="text-xs text-muted-foreground">
                <span className="font-bold text-foreground">{creditsTenant?.name}</span> currently has{' '}
                <span className="font-bold text-foreground">{Number(creditsTenant?.aiCreditsBalance || 0).toLocaleString()}</span> credits.
              </div>
              <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-muted/40 border border-border/50">
                {[
                  { key: 'delta', label: 'Add / remove' },
                  { key: 'set', label: 'Set exact balance' }
                ].map(({ key, label }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => switchCreditsMode(key)}
                    disabled={adjustingCredits}
                    className={cn(
                      "rounded-md py-1.5 text-xs font-bold transition-colors disabled:opacity-50",
                      creditsMode === key
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>{creditsMode === 'set' ? 'New credit balance *' : 'Credits to add or remove *'}</Label>
                <Input
                  type="number"
                  step="1"
                  min={creditsMode === 'set' ? 0 : undefined}
                  placeholder={creditsMode === 'set' ? 'e.g. 5000' : 'e.g. 100 or -50'}
                  value={creditsDelta}
                  onChange={e => setCreditsDelta(e.target.value)}
                  required
                  disabled={adjustingCredits}
                />
                <span className="text-xs text-muted-foreground">
                  {creditsMode === 'set'
                    ? 'Replaces the current balance outright. Use 0 to clear all remaining credits.'
                    : 'Use a negative number to remove credits. The balance never goes below zero.'}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Reason *</Label>
                <Input placeholder="e.g. Trial top-up, support goodwill" value={creditsReason} onChange={e => setCreditsReason(e.target.value)} required disabled={adjustingCredits} />
              </div>
              {error && <p className="text-xs font-semibold text-danger-text">{error}</p>}
            </div>
            <DialogFooter className="px-6 py-4 border-t">
              <Button type="button" variant="outline" onClick={() => setShowCreditsModal(false)} disabled={adjustingCredits}>Cancel</Button>
              <Button type="submit" disabled={adjustingCredits}>{adjustingCredits ? <Loader2 size={14} className="animate-spin" /> : 'Apply'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Tenant detail drawer */}
      <Dialog open={showDetailModal} onOpenChange={setShowDetailModal}>
        <DialogContent aria-describedby={undefined} className="max-w-[760px] border border-border/80 bg-card">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-primary font-bold">
              <Info size={17} />
              {detailTenant?.name || 'Workspace'}
            </DialogTitle>
          </DialogHeader>
          <DialogBody className="max-h-[70vh] overflow-y-auto pr-1">
            {detailLoading ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 size={20} className="animate-spin" />
              </div>
            ) : detailError ? (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{detailError}</AlertDescription>
              </Alert>
            ) : detail ? (
              <Tabs defaultValue="contact" className="flex flex-col gap-4">
                <TabsList className="bg-muted/30 border border-border/60 p-1 rounded-xl h-auto flex flex-wrap gap-1">
                  {[
                    ['contact', 'Contact'],
                    ['plan', 'Plan & Billing'],
                    ['promos', 'Promo Codes'],
                    ['payments', 'Payments'],
                    ['credits', 'Credits'],
                    ['records', 'Records'],
                  ].map(([value, label]) => (
                    <TabsTrigger key={value} value={value} className="rounded-lg px-3 py-1.5 text-xs font-semibold">
                      {label}
                    </TabsTrigger>
                  ))}
                </TabsList>

                {/* ── Contact ─────────────────────────────────────────────── */}
                <TabsContent value="contact" className="flex flex-col gap-4">
                  <DetailSection title="Sign-in Owner">
                    {detail.contact.owner ? (
                      <>
                        <DetailRow label="Name" value={detail.contact.owner.name} />
                        {/*
                          One badge per contact. A tenant admin now clears each
                          channel with its OWN code, so a single "Verified" beside
                          the address could not speak for the handset — and before
                          0052 this badge was reporting a flag that a WhatsApp
                          code could set.
                        */}
                        <DetailRow label="Email" value={detail.contact.owner.email} badge={detail.contact.owner.emailVerified ? 'Verified' : 'Unverified'} />
                        <DetailRow label="Mobile" value={detail.contact.owner.phoneNumber} badge={detail.contact.owner.phoneVerified ? 'Verified' : 'Unverified'} />
                        <DetailRow label="Joined" value={formatDate(detail.contact.owner.createdAt)} />
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground">No workspace admin account exists yet.</p>
                    )}
                  </DetailSection>

                  <DetailSection title="Billing Contact">
                    <DetailRow label="Contact Person" value={detail.contact.billing.contactName} />
                    <DetailRow label="Billing Email" value={detail.contact.billing.billingEmail} />
                    <DetailRow label="Billing Phone" value={detail.contact.billing.billingPhone} />
                    <DetailRow label="Registered Name" value={detail.contact.billing.billingName} />
                    <DetailRow label="GSTIN" value={detail.contact.billing.billingGst} />
                    <DetailRow label="Address" value={detail.contact.billing.billingAddress} />
                  </DetailSection>

                  <DetailSection title={`Members (${detail.contact.members.length})`}>
                    <DetailTable
                      head={['Name', 'Role', 'Email', 'Mobile']}
                      rows={detail.contact.members.map(m => [
                        m.name,
                        m.role,
                        m.email || '—',
                        m.phoneNumber || '—',
                      ])}
                      empty="No members."
                    />
                  </DetailSection>
                </TabsContent>

                {/* ── Plan & Billing ──────────────────────────────────────── */}
                <TabsContent value="plan" className="flex flex-col gap-4">
                  <DetailSection title="Subscription">
                    <DetailRow
                      label="Plan"
                      value={detail.plan?.name}
                      badge={detail.plan?.isFallbackDefault ? 'Platform default — never assigned' : null}
                    />
                    <DetailRow label="Billing Cycle" value={detail.subscription.billingCycle} />
                    <DetailRow label="Monthly / Yearly / One-time" value={detail.plan ? `${detail.plan.price ?? '—'} / ${detail.plan.priceYearly ?? '—'} / ${detail.plan.priceOneTime ?? '—'}` : null} />
                    <DetailRow label="Expires" value={detail.subscription.expiry ? formatDate(detail.subscription.expiry) : (detail.plan?.isLifetime ? 'Lifetime' : 'No expiry')} />
                    <DetailRow label="Renewal Notice Stage" value={detail.subscription.planNoticeStage} />
                    <DetailRow label="AMC Last Paid" value={detail.subscription.amcLastPaidAt ? formatDate(detail.subscription.amcLastPaidAt) : null} />
                    <DetailRow label="AMC Next Due" value={detail.subscription.amcNextDueDate ? formatDate(detail.subscription.amcNextDueDate) : null} />
                  </DetailSection>

                  <DetailSection title="Entitlements">
                    <DetailRow label="Member Seats" value={`${detail.contact.members.length} / ${detail.entitlements.maxMembers}`} />
                    <DetailRow
                      label="Storage"
                      value={detail.entitlements.storage.unlimited
                        ? (detail.entitlements.storage.isGoogleDrive
                            ? `Google Drive · ${(detail.entitlements.storage.currentBytes / (1024 ** 3)).toFixed(2)} GB used, no limit read`
                            : 'Unlimited')
                        : `${(detail.entitlements.storage.currentBytes / (1024 ** 3)).toFixed(2)} GB / ${((detail.entitlements.storage.limitBytes || 0) / (1024 ** 3)).toFixed(0)} GB${detail.entitlements.storage.isGoogleDrive ? ' (Google Drive)' : ''}`}
                    />
                    {detail.entitlements.storage.isGoogleDrive && (
                      /* When the Drive figures above were last read from Google.
                         They are cached on the tenant row and refreshed by that
                         tenant's own sessions, so an idle workspace can show an
                         old measurement — which is only misleading if the age
                         is hidden. */
                      <DetailRow
                        label="Drive Quota Read"
                        value={detail.entitlements.storage.quotaCheckedAt
                          ? formatDate(detail.entitlements.storage.quotaCheckedAt)
                          : 'Never'}
                      />
                    )}
                    <DetailRow label="AI Credits" value={`${Number(detail.entitlements.aiCreditsBalance).toLocaleString()} / ${Number(detail.entitlements.planAiCredits).toLocaleString()}`} />
                    <DetailRow label="Vault Mode" value={detail.tenant.vaultMode} />
                    <DetailRow label="AI Key" value={detail.tenant.hasCustomApiKey ? `Dedicated key (${detail.tenant.aiProvider})` : 'Shared platform pool'} />
                    <DetailRow label="AI Model" value={detail.tenant.aiModel} />
                    <DetailRow label="Onboarding" value={detail.tenant.hasCompletedOnboarding ? 'Completed' : 'Not completed'} />
                    <DetailRow label="Google Account" value={detail.tenant.googleAccountEmail} />
                  </DetailSection>

                  <DetailSection title={`Add-ons (${detail.addons.length})`}>
                    <DetailTable
                      head={['Add-on', 'Status', 'Seats', 'Credits', 'Purchased', 'Expires']}
                      rows={detail.addons.map(a => [
                        a.name,
                        a.isActive ? 'Active' : 'Inactive',
                        a.extraMembers || 0,
                        a.aiCredits || 0,
                        formatDate(a.purchasedAt),
                        a.expiresAt ? formatDate(a.expiresAt) : 'Never',
                      ])}
                      empty="No add-ons granted."
                    />
                  </DetailSection>
                </TabsContent>

                {/* ── Promo codes ─────────────────────────────────────────── */}
                <TabsContent value="promos">
                  <DetailSection title={`Discount Codes Redeemed (${detail.promoCodes.length})`}>
                    <DetailTable
                      head={['Code', 'Discount', 'Saved', 'Used On', 'Payment']}
                      rows={detail.promoCodes.map(p => [
                        <span key="c" className="font-mono font-bold inline-flex items-center gap-1"><Ticket size={11} />{p.code}</span>,
                        p.type === 'PERCENTAGE' ? `${p.discountPct}%` : `${p.discountAmount ?? '—'} flat`,
                        p.amountSaved,
                        formatDate(p.usedAt),
                        p.paymentId ? `${p.paymentAmount ?? '—'} (${p.paymentStatus ?? 'unknown'})` : '—',
                      ])}
                      empty="This workspace has never redeemed a discount code."
                    />
                  </DetailSection>
                </TabsContent>

                {/* ── Payments ────────────────────────────────────────────── */}
                <TabsContent value="payments" className="flex flex-col gap-4">
                  <DetailSection title={`Payments (${detail.payments.length})`}>
                    <DetailTable
                      head={['Date', 'For', 'Amount', 'Status', 'Method', 'Ref']}
                      rows={detail.payments.map(p => [
                        formatDate(p.createdAt),
                        p.planName || p.addonName || '—',
                        `${p.currency} ${p.amount}`,
                        p.status,
                        p.paymentMethod,
                        p.paymentRef || p.razorpayOrderId || '—',
                      ])}
                      empty="No payments recorded."
                    />
                  </DetailSection>

                  <DetailSection title={`Invoices (${detail.invoices.length})`}>
                    <DetailTable
                      head={['Number', 'Type', 'Amount', 'Status', 'Issued', 'Due']}
                      rows={detail.invoices.map(i => [
                        i.invoiceNumber,
                        i.invoiceType,
                        `${i.currency} ${i.amount}`,
                        i.status,
                        formatDate(i.issuedDate),
                        formatDate(i.dueDate),
                      ])}
                      empty="No invoices issued."
                    />
                  </DetailSection>
                </TabsContent>

                {/* ── Credits ─────────────────────────────────────────────── */}
                <TabsContent value="credits" className="flex flex-col gap-4">
                  <DetailSection title={`Credit Ledger — balance ${Number(detail.credits.balance).toLocaleString()}`}>
                    <DetailTable
                      head={['Date', 'Change', 'Balance', 'Reason']}
                      rows={detail.credits.transactions.map(c => [
                        formatDate(c.createdAt),
                        <span key="a" className={c.amount >= 0 ? 'text-emerald-500 font-bold' : 'text-danger-text font-bold'}>
                          {c.amount > 0 ? '+' : ''}{c.amount.toLocaleString()}
                        </span>,
                        c.balanceAfter.toLocaleString(),
                        c.description,
                      ])}
                      empty="No credit movements."
                    />
                  </DetailSection>

                  <DetailSection title="AI Usage by Model">
                    <DetailTable
                      head={['Model', 'Calls', 'Prompt Tkn', 'Compl. Tkn', 'Cost']}
                      rows={detail.aiUsage.map(u => [
                        u.modelName,
                        Number(u.calls).toLocaleString(),
                        Number(u.promptTokens || 0).toLocaleString(),
                        Number(u.completionTokens || 0).toLocaleString(),
                        `$${Number(u.cost || 0).toFixed(4)}`,
                      ])}
                      empty="No AI calls recorded."
                    />
                  </DetailSection>
                </TabsContent>

                {/* ── Records ─────────────────────────────────────────────── */}
                <TabsContent value="records" className="flex flex-col gap-4">
                  <DetailSection title="Totals">
                    <DetailRow label="Records" value={detail.records.total.toLocaleString()} />
                    <DetailRow label="With an attachment" value={detail.records.files.toLocaleString()} />
                    <DetailRow label="Credentials" value={detail.records.credentials.toLocaleString()} />
                    <DetailRow label="Stored bytes" value={`${(detail.records.bytes / (1024 ** 2)).toFixed(1)} MB`} />
                  </DetailSection>

                  <DetailSection title="Records by Module">
                    <DetailTable
                      head={['Module', 'Records']}
                      rows={detail.records.byModule.map(m => [m.moduleName, m.count.toLocaleString()])}
                      empty="No records stored yet."
                    />
                  </DetailSection>
                </TabsContent>
              </Tabs>
            ) : null}
          </DialogBody>
          <DialogFooter className="px-6 py-4 border-t">
            <Button type="button" variant="outline" onClick={() => setShowDetailModal(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add/Edit Dialog */}
      <Dialog open={showAddForm} onOpenChange={setShowAddForm}>
        <DialogContent aria-describedby={undefined} className="max-w-[560px] border border-border/80 bg-card">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-primary font-bold">
              <Users size={17} />
              {editTenant ? 'Configure Tenant workspace' : 'Create New Tenant'}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSave}>
            <DialogBody className="flex flex-col gap-4 max-h-[65vh] overflow-y-auto pr-1">
              {!editTenant && !hasDefaultPlan && (
                <Alert variant="destructive" className="mb-2">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    No default subscription plan found. You must create a default plan in the Plans section before adding a tenant.
                  </AlertDescription>
                </Alert>
              )}
              
              <div className="flex flex-col gap-1.5">
                <Label>Workspace Name *</Label>
                <Input placeholder="e.g. Sharma Household or Acme Corp" value={formData.name} onChange={e => handleNameChange(e.target.value)} required disabled={saving} />
              </div>

              <Separator className="my-1 border-border/40" />

              <div className="text-xs font-bold text-primary uppercase tracking-wider">Billing Contact (Optional)</div>
              <p className="text-xs text-muted-foreground leading-relaxed -mt-2">
                Who to invoice and reach about this workspace. The sign-in owner&apos;s own name, email
                and mobile live on their member record and are edited under Users.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label>Contact Person</Label>
                  <Input placeholder="e.g. Rohan Nair" value={formData.contactName} onChange={e => setFormData(prev => ({ ...prev, contactName: e.target.value }))} disabled={saving} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Billing Email</Label>
                  <Input type="email" placeholder="accounts@example.com" value={formData.billingEmail} onChange={e => setFormData(prev => ({ ...prev, billingEmail: e.target.value }))} disabled={saving} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Billing Phone</Label>
                  <Input placeholder="+91 22 4000 1234" value={formData.billingPhone} onChange={e => setFormData(prev => ({ ...prev, billingPhone: e.target.value }))} disabled={saving} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Registered Name</Label>
                  <Input placeholder="e.g. Acme Pvt Ltd" value={formData.billingName} onChange={e => setFormData(prev => ({ ...prev, billingName: e.target.value }))} disabled={saving} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>GSTIN</Label>
                  <Input placeholder="27AABCA1234A1Z5" value={formData.billingGst} onChange={e => setFormData(prev => ({ ...prev, billingGst: e.target.value }))} disabled={saving} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Billing Address</Label>
                  <Input placeholder="Street, city, state, PIN" value={formData.billingAddress} onChange={e => setFormData(prev => ({ ...prev, billingAddress: e.target.value }))} disabled={saving} />
                </div>
              </div>

              <Separator className="my-1 border-border/40" />

              <div className="flex items-center justify-between p-2.5 rounded-lg bg-muted/20 border border-border/50">
                <div className="flex flex-col">
                  <span className="text-xs font-bold text-foreground">Workspace Status</span>
                  <span className="text-xs text-muted-foreground">Deactivated tenants cannot authenticate or view ledgers.</span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setFormData(prev => ({ ...prev, isActive: !prev.isActive }))}
                  className="h-8"
                >
                  {formData.isActive ? (
                    <span className="flex items-center gap-1 text-emerald-500 font-bold text-xs"><CheckCircle size={12} /> Active</span>
                  ) : (
                    <span className="flex items-center gap-1 text-muted-foreground font-bold text-xs"><X size={12} /> Deactivated</span>
                  )}
                </Button>
              </div>

              <Separator className="my-1 border-border/40" />

              <div className="text-xs font-bold text-primary uppercase tracking-wider">Tenant Private Key Provisioning (Optional)</div>
              <p className="text-xs text-muted-foreground leading-relaxed -mt-2">
                If provided, all AI scanning and tips for this tenant will use this key exclusively instead of the platform-wide keys pool.
              </p>
              <div className="flex flex-col gap-1.5">
                <Label>API Key (Gemini/OpenAI)</Label>
                <Input
                  type="password"
                  placeholder={editTenant?.hasCustomApiKey ? 'Key stored — leave blank to keep it' : 'api_key_...'}
                  value={formData.apiKey}
                  onChange={e => setFormData(prev => ({ ...prev, apiKey: e.target.value, clearApiKey: false }))}
                  disabled={formData.clearApiKey}
                />
                {editTenant?.hasCustomApiKey && (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={formData.clearApiKey}
                      onChange={e => setFormData(prev => ({ ...prev, clearApiKey: e.target.checked, apiKey: '' }))}
                    />
                    Remove the stored key and fall back to the shared pool
                  </label>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label>AI Key Provider</Label>
                  <select 
                    className="flex h-9 w-full rounded-md border border-input bg-field px-3 py-1 text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={formData.aiProvider}
                    onChange={e => setFormData(prev => ({ ...prev, aiProvider: e.target.value }))}
                  >
                    <option value="gemini">Google Gemini</option>
                    <option value="openai">OpenAI</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>AI Model Name</Label>
                  <Input placeholder={DEFAULT_GEMINI_MODEL} value={formData.aiModel} onChange={e => setFormData(prev => ({ ...prev, aiModel: e.target.value }))} />
                </div>
              </div>
              {!editTenant && (
                <>
                  <Separator className="my-1 border-border/40" />
                  <label className="flex items-center gap-2.5 cursor-pointer text-sm font-semibold text-foreground">
                    <input type="checkbox" className="w-4 h-4 rounded accent-primary" checked={formData.createAdmin} onChange={e => setFormData(prev => ({ ...prev, createAdmin: e.target.checked }))} disabled={saving} />
                    Initialize with Tenant Administrator account
                  </label>
                  {formData.createAdmin && (
                    <div className="flex flex-col gap-3 p-4 rounded-xl border border-border bg-muted/20 animate-fade-in">
                      <div className="flex flex-col gap-1.5">
                        <Label>Admin Name</Label>
                        <Input placeholder="e.g. Sunil Gadhiya" value={formData.adminName} onChange={e => setFormData(prev => ({ ...prev, adminName: e.target.value }))} disabled={saving} />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label>Admin Email *</Label>
                        <Input type="email" placeholder="admin@domain.com" value={formData.adminEmail} onChange={e => setFormData(prev => ({ ...prev, adminEmail: e.target.value }))} required={formData.createAdmin} disabled={saving} />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label>Admin Initial Password *</Label>
                        <Input type="password" placeholder="Secure password" value={formData.adminPassword} onChange={e => setFormData(prev => ({ ...prev, adminPassword: e.target.value }))} required={formData.createAdmin} disabled={saving} />
                      </div>
                    </div>
                  )}
                </>
              )}
            </DialogBody>
            <DialogFooter className="gap-2 pt-2 border-t border-border/40">
              <Button type="button" variant="secondary" onClick={() => setShowAddForm(false)} disabled={saving}>Cancel</Button>
              <Button type="submit" disabled={saving || (!editTenant && !hasDefaultPlan)} className="bg-primary text-primary-foreground font-bold">
                {saving ? <Loader2 size={15} className="animate-spin mr-1" /> : <Save size={15} className="mr-1" />}
                {editTenant ? 'Save Settings' : 'Create Tenant'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add-ons Dialog */}
      <Dialog open={showAddonsModal} onOpenChange={setShowAddonsModal}>
        <DialogContent aria-describedby={undefined} className="max-w-[500px] border border-border/80 bg-card">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-primary font-bold">
              <Sparkles size={17} />
              Manage Add-ons
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4 px-6">
            <div className="flex flex-col gap-3">
              {tenantAddons.length === 0 ? (
                <div className="text-xs text-muted-foreground italic">No add-ons currently assigned.</div>
              ) : (
                <div className="grid grid-cols-1 gap-2 max-h-48 overflow-y-auto pr-1">
                  {tenantAddons.map(ta => (
                    <div key={ta.id} className="flex flex-col p-2 bg-muted/20 border border-border/50 rounded-lg">
                      <span className="text-xs font-bold text-foreground">{ta.addon.name}</span>
                      <div className="flex items-center gap-2 mt-1">
                        {ta.addon.aiCredits > 0 && <span className="text-xs text-blue-500 bg-blue-500/10 px-1.5 rounded">+{ta.addon.aiCredits} AI Credits</span>}
                        {ta.addon.extraMembers > 0 && <span className="text-xs text-amber-500 bg-amber-500/10 px-1.5 rounded">+{ta.addon.extraMembers} Members</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2 mt-1">
                <select 
                  className="flex-1 h-9 rounded-md border border-input bg-field px-3 py-1 text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={selectedAddon}
                  onChange={e => setSelectedAddon(e.target.value)}
                  disabled={grantingAddon}
                >
                  <option value="">Select an Add-on to grant...</option>
                  {availableAddons.map(a => (
                    <option key={a.id} value={a.id}>{a.name} (₹{a.price})</option>
                  ))}
                </select>
                <Button 
                  type="button" 
                  size="sm" 
                  onClick={handleGrantAddon} 
                  disabled={!selectedAddon || grantingAddon}
                  className="h-9 shrink-0 bg-primary text-primary-foreground font-bold"
                >
                  {grantingAddon ? <Loader2 size={14} className="animate-spin mr-1" /> : <Plus size={14} className="mr-1" />} Grant
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter className="px-6 py-4 border-t">
            <Button type="button" variant="outline" onClick={() => setShowAddonsModal(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>



      {/* Search Bar */}
      {!loading && tenants.length > 0 && (
        <div className="relative max-w-sm animate-fade-in stagger-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9 h-9 text-xs" placeholder="Search workspaces..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X size={13} />
            </button>
          )}
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
          <Loader2 size={28} className="animate-spin text-primary" />
          <p className="text-sm">Loading organization workspaces...</p>
        </div>
      ) : tenants.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-4 text-muted-foreground border-2 border-dashed border-border rounded-2xl animate-fade-in">
          <Users size={40} className="opacity-25" />
          <div className="text-center">
            <p className="font-semibold text-base text-foreground mb-1">No Tenants Found</p>
            <p className="text-sm mb-5">Create the first tenant workspace to get started.</p>
            <Button onClick={openAddForm}><Plus size={15} className="mr-1" /> Create Your First Tenant</Button>
          </div>
        </div>
      ) : filteredTenants.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-14 gap-2 text-muted-foreground border border-border rounded-2xl animate-fade-in">
          <Search size={36} className="opacity-20" />
          <p className="font-semibold text-sm text-foreground">No matching workspaces</p>
          <p className="text-xs">Try a different search query.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4 animate-fade-in">
          {filteredTenants.map((tenant) => {
            const counts = tenant._count || {};
            const storage = tenant.storageData;
            const storagePct = storage && !storage.unlimited && storage.limitBytes
              ? Math.min(100, (storage.currentBytes / storage.limitBytes) * 100)
              : 0;
            // The same three states the tenant's own meter uses, so an admin
            // looking at a workspace sees what its owner sees.
            const storageState = storagePressure(storage);
            const isCurrentTenant = tenant.id === currentUser?.tenantId;
            const ai = tenant.aiUsage || { promptTokens: 0, completionTokens: 0, cost: 0 };

            return (
              <Card
                key={tenant.id}
                className={cn(
                  'border-l-4 transition-all hover:shadow-glass-hover bg-card backdrop-blur border-border/60',
                  isCurrentTenant ? 'border-l-primary' : 'border-l-border',
                  !tenant.isActive && 'opacity-65'
                )}
              >
                <CardContent className="p-5">
                  {/* Header Row */}
                  <div className="flex items-start justify-between gap-3 mb-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="font-extrabold text-lg text-foreground">{tenant.name}</span>
                        <Badge variant="secondary" className="font-mono text-xs flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleCopy(`${window.location.origin}/login`, tenant.id)}
                            className="hover:text-primary transition-colors ml-0.5"
                            title="Copy login URL"
                          >
                            {copiedId === tenant.id ? <Check size={9} /> : <Copy size={9} />}
                          </button>
                        </Badge>
                        {isCurrentTenant && <Badge variant="default" className="bg-primary text-primary-foreground">Active Session</Badge>}
                        {!tenant.isActive && <Badge variant="destructive">Suspended</Badge>}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                        <span>ID:</span>
                        <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">{tenant.id}</code>
                        <button
                          type="button"
                          onClick={() => handleCopy(tenant.id, `id-${tenant.id}`)}
                          className="text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {copiedId === `id-${tenant.id}` ? <Check size={10} /> : <Copy size={10} />}
                        </button>
                        <span className="text-faint">|</span>
                        
                        <span className="flex items-center gap-1 font-bold text-foreground">
                          <Badge variant="outline" className="text-xs border-primary/50 text-primary bg-primary/5">{tenant.planName || "Default Plan"}</Badge>
                        </span>
                        
                        {tenant.activeAddons?.map(addon => (
                          <Badge key={addon.id} variant="secondary" className="text-2xs border border-border">
                            {addon.name}
                          </Badge>
                        ))}

                        <span className="flex items-center gap-1 ml-1">
                          <Calendar size={11} />
                          {tenant.subscriptionExpiry ? (
                            <span className={cn(
                              "font-bold",
                              new Date(tenant.subscriptionExpiry) < new Date() ? "text-danger-text" : "text-emerald-500"
                            )}>
                              Expires {formatDate(tenant.subscriptionExpiry)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">No Expiry</span>
                          )}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <Button variant="outline" size="sm" onClick={() => openDetailModal(tenant)} className="h-8 text-xs font-bold">
                        <Info size={12} className="mr-1" />
                        Details
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => openAddonsModal(tenant)} disabled={isProcessingPayment} className="h-8 text-xs font-bold border-purple-600/30 hover:bg-purple-600/10 text-purple-500">
                        <Sparkles size={12} className="mr-1" />
                        Manage Add-ons
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => openPaymentModal(tenant)} disabled={isProcessingPayment} className="h-8 text-xs font-bold border-blue-600/30 hover:bg-blue-600/10 text-blue-500">
                        {isProcessingPayment ? <Loader2 size={12} className="animate-spin mr-1" /> : <CreditCard size={12} className="mr-1" />}
                        Change Plan
                      </Button>
                      <Button variant="outline" size="icon" onClick={() => openEditForm(tenant)} className="h-8 w-8" title="Edit Settings">
                        <Edit2 size={13} />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => handleDelete(tenant)}
                        disabled={isCurrentTenant}
                        title={isCurrentTenant ? 'Cannot delete active tenant' : 'Delete Tenant'}
                        className={cn('h-8 w-8', !isCurrentTenant && 'text-danger-action border-destructive/30 hover:bg-destructive/10 hover:text-danger-action')}
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-2">
                    {/* Quotas */}
                    <div className="flex flex-col gap-2 p-3.5 bg-muted/20 border border-border/50 rounded-xl">
                      <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                        <Shield size={11} className="text-blue-500" />
                        <span>Active Quotas</span>
                      </div>
                      
                      <div className="flex flex-col gap-2.5 mt-1">
                        {/* Storage */}
                        <div className="flex flex-col gap-1">
                          <div className="flex justify-between items-center text-2xs font-bold">
                            <span className="text-muted-foreground">
                              {storage?.isGoogleDrive ? 'Drive Storage' : 'Storage'}
                            </span>
                            {storage?.unlimited ? (
                              /* No ceiling to report — a Drive quota we have not
                                 read yet, or a pooled Workspace account. Said as
                                 that rather than as "unlimited", which is what
                                 this row claimed for every Drive tenant however
                                 full their Drive actually was. */
                              <span className="text-muted-foreground">
                                {storage?.isGoogleDrive
                                  ? `Google Drive · ${((storage?.currentBytes || 0) / (1024*1024*1024)).toFixed(2)} GB used, no limit read`
                                  : 'Unlimited'}
                              </span>
                            ) : (
                              <span className={cn(
                                storageState === 'full' ? 'text-destructive'
                                  : storageState === 'warning' ? 'text-amber-500' : 'text-foreground'
                              )}>
                                {`${((storage?.currentBytes || 0) / (1024*1024*1024)).toFixed(2)} GB`} / {`${((storage?.limitBytes || 0) / (1024*1024*1024)).toFixed(0)} GB`}
                                {` (${Math.round(storagePct)}%)`}
                              </span>
                            )}
                          </div>
                          {!storage?.unlimited && (
                            <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                              <div
                                className={cn(
                                  "h-full rounded-full",
                                  storageState === 'full' ? 'bg-destructive'
                                    : storageState === 'warning' ? 'bg-amber-500' : 'bg-primary'
                                )}
                                style={{ width: `${storagePct}%` }}
                              />
                            </div>
                          )}
                        </div>
                        
                        {/* Members */}
                        <div className="flex flex-col gap-1">
                          <div className="flex justify-between items-center text-2xs font-bold">
                            <span className="text-muted-foreground">Members</span>
                            <span className="text-foreground">
                              {counts.members || 0} / {tenant.maxMembers || 1}
                            </span>
                          </div>
                          <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                            <div
                              className={cn("h-full rounded-full", ((counts.members || 0) / (tenant.maxMembers || 1)) >= 1 ? "bg-destructive" : "bg-primary")}
                              style={{ width: `${Math.min(100, ((counts.members || 0) / (tenant.maxMembers || 1)) * 100)}%` }}
                            />
                          </div>
                        </div>

                        {/* AI Credits Balance */}
                        <div className="flex justify-between items-center text-2xs font-bold mt-1 pt-1 border-t border-border/50">
                          <span className="text-muted-foreground">AI Credits Bal.</span>
                          <div className="flex items-center gap-1.5">
                            <span className={cn("text-foreground", tenant.aiCreditsBalance <= 0 ? "text-danger-text" : "")}>
                              {Number(tenant.aiCreditsBalance || 0).toLocaleString()} <span className="text-muted-foreground font-normal">/ {Number(tenant.planAiCredits || 0).toLocaleString()} (Limit)</span>
                            </span>
                            <Button
                              type="button"
                              variant="link"
                              size="sm"
                              onClick={() => openCreditsModal(tenant)}
                              className="h-auto p-0 text-2xs font-bold"
                            >
                              Adjust
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                    {/* Database Records Stats */}
                    <div className="flex flex-col gap-2 p-3.5 bg-muted/20 border border-border/50 rounded-xl">
                      <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                        <FolderOpen size={11} className="text-primary" />
                        <span>Workspaces Database Records</span>
                      </div>
                      <div className="grid grid-cols-4 gap-2 text-center mt-1">
                        {[
                          { label: 'Members', count: counts.members || 0 },
                          { label: 'Records', count: counts.records || 0 },
                          { label: 'Files', count: counts.files || 0 },
                          { label: 'Creds', count: counts.credentials || 0 },
                        ].map(stat => (
                          <div key={stat.label} className="flex flex-col">
                            <span className="text-[16px] font-extrabold text-foreground">{stat.count}</span>
                            <span className="text-2xs font-bold text-muted-foreground">{stat.label}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* AI Token Consumption */}
                    <div className="flex flex-col gap-1.5 p-3.5 bg-muted/20 border border-border/50 rounded-xl">
                      <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center justify-between">
                        <div className="flex items-center gap-1">
                          <Zap size={11} className="text-amber-500" />
                          <span>AI Usage &amp; Cost metrics</span>
                        </div>
                        {tenant.hasCustomApiKey ? <Badge variant="success" className="text-2xs py-0 px-1 rounded-sm leading-none">Custom Key</Badge> : <Badge variant="secondary" className="text-2xs py-0 px-1 rounded-sm leading-none">Shared Key</Badge>}
                      </div>
                      <div className="grid grid-cols-3 gap-2 mt-1">
                        <div className="flex flex-col">
                          <span className="text-xs text-muted-foreground">Prompt Tkn</span>
                          <span className="text-sm font-extrabold text-foreground">{ai.promptTokens.toLocaleString()}</span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-xs text-muted-foreground">Compl. Tkn</span>
                          <span className="text-sm font-extrabold text-foreground">{ai.completionTokens.toLocaleString()}</span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-xs text-muted-foreground">Calculated Cost</span>
                          <span className="text-sm font-extrabold text-emerald-500">${ai.cost.toFixed(4)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </PageContainer>
  );
}

