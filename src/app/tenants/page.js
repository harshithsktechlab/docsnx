'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Users, Plus, Trash2, Edit2, CheckCircle, AlertCircle,
  Loader2, Save, X, FileText, KeyRound, FolderOpen,
  Copy, Check, Search, Shield, Zap, CreditCard, Sparkles,
  Calendar, ToggleLeft, ToggleRight
} from 'lucide-react';
import { clientGetMe } from '@/lib/clientAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogBody } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/dateHelper';
import { toast } from 'sonner';
import { DEFAULT_GEMINI_MODEL } from '@/lib/aiModels';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';


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
    adminPassword: ''
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
      console.error('[tenants] handler threw', err);
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
      adminPassword: ''
    });
    setEditTenant(null); 
    setShowAddForm(true);
  };

  const openEditForm = (tenant) => {
    setFormData({
      name: tenant.name,
      apiKey: tenant.apiKey || '',
      aiProvider: tenant.aiProvider || 'gemini',
      aiModel: tenant.aiModel || DEFAULT_GEMINI_MODEL,
      subscriptionPlanId: tenant.subscriptionPlanId || '',
      subscriptionExpiry: tenant.subscriptionExpiry ? new Date(tenant.subscriptionExpiry).toISOString().split('T')[0] : '',
      isActive: tenant.isActive ?? true,
      createAdmin: false,
      adminName: '',
      adminEmail: '',
      adminPassword: ''
    });
    setEditTenant(tenant); 
    setShowAddForm(true);
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
        apiKey: formData.apiKey,
        aiProvider: formData.aiProvider,
        aiModel: formData.aiModel,
        subscriptionPlanId: formData.subscriptionPlanId || null,
        subscriptionExpiry: formData.subscriptionExpiry || null,
        isActive: formData.isActive
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
      console.error('[tenants] handler threw', err);
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
      console.error('[tenants] handler threw', e);
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
      console.error('[tenants] handler threw', err);
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
    setShowPaymentModal(true);
  };

  const hasDefaultPlan = plans.some(p => p.isDefault);

  const processPayment = async (e) => {
    e.preventDefault();
    if (!paymentPlanId) return;
    if (!overrideReason.trim()) { setError('Reason is required'); return; }
    
    setIsProcessingPayment(true);
    setError(''); setSuccess('');
    
    try {
      const { json: data } = await apiCall(`/api/admin/tenants/${paymentTenant.id}/upgrade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: paymentPlanId, reason: overrideReason })
      });
      
      if (!data.success) {
        setError(data.error || 'Failed to manually override plan');
        setIsProcessingPayment(false);
        return;
      }

      setSuccess('Plan manually upgraded successfully!');
      setShowPaymentModal(false);
      fetchTenants();
      
    } catch (e) {
      setError('Error initiating upgrade');
    }
    setIsProcessingPayment(false);
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
      
      {success && (
        <Alert variant="success" className="animate-scale-in">
          <CheckCircle size={15} />
          <AlertDescription className="flex items-center justify-between text-xs text-foreground font-semibold">
            <span>{success}</span>
            <button onClick={() => setSuccess('')} className="ml-4"><X size={13} /></button>
          </AlertDescription>
        </Alert>
      )}

      {/* Manual Override Dialog */}
      <Dialog open={showPaymentModal} onOpenChange={setShowPaymentModal}>
        <DialogContent aria-describedby={undefined} className="max-w-[400px] border border-border/80 bg-card">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-primary font-bold">
              <CreditCard size={17} /> Manual Plan Override
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={processPayment}>
            <div className="flex flex-col gap-4 py-4 px-6">
              <div className="flex flex-col gap-1.5">
                <Label>Select Plan</Label>
                <select className="flex h-9 w-full rounded-md border border-input bg-field px-3 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" value={paymentPlanId} onChange={e => setPaymentPlanId(e.target.value)} required disabled={isProcessingPayment}>
                  {plans.map(plan => (
                    <option key={plan.id} value={plan.id}>{plan.name} (₹{plan.price})</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Reason for Override *</Label>
                <Input placeholder="e.g. Comped for demo, migration fix" value={overrideReason} onChange={e => setOverrideReason(e.target.value)} required disabled={isProcessingPayment} />
              </div>
            </div>
            <DialogFooter className="px-6 py-4 border-t">
              <Button type="button" variant="outline" onClick={() => setShowPaymentModal(false)} disabled={isProcessingPayment}>Cancel</Button>
              <Button type="submit" disabled={isProcessingPayment}>{isProcessingPayment ? <Loader2 size={14} className="animate-spin" /> : 'Set Plan'}</Button>
            </DialogFooter>
          </form>
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
                <Input type="password" placeholder="api_key_..." value={formData.apiKey} onChange={e => setFormData(prev => ({ ...prev, apiKey: e.target.value }))} />
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
            const totalRecords = (counts.documents || 0) + (counts.medicalRecords || 0) + (counts.passwords || 0) + (counts.bankInfos || 0) + (counts.tradingDemats || 0) + (counts.vehicles || 0) + (counts.licMediclaims || 0) + (counts.investments || 0);
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
                      <Button variant="outline" size="sm" onClick={() => openAddonsModal(tenant)} disabled={isProcessingPayment} className="h-8 text-xs font-bold border-purple-600/30 hover:bg-purple-600/10 text-purple-500">
                        <Sparkles size={12} className="mr-1" />
                        Manage Add-ons
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => openPaymentModal(tenant)} disabled={isProcessingPayment} className="h-8 text-xs font-bold border-blue-600/30 hover:bg-blue-600/10 text-blue-500">
                        {isProcessingPayment ? <Loader2 size={12} className="animate-spin mr-1" /> : <CreditCard size={12} className="mr-1" />}
                        Manual Override
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
                            <span className="text-muted-foreground">Storage</span>
                            {tenant.googleDriveEnabled ? (
                              <span className="text-emerald-500">Google Drive Synced (Unlimited)</span>
                            ) : (
                              <span className="text-foreground">
                                {tenant.storageData ? `${(tenant.storageData.currentBytes / (1024*1024*1024)).toFixed(2)} GB` : `0 GB`} / {tenant.storageData ? `${(tenant.storageData.limitBytes / (1024*1024*1024)).toFixed(0)} GB` : `0 GB`}
                              </span>
                            )}
                          </div>
                          {!tenant.googleDriveEnabled && (
                            <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                              <div 
                                className={cn("h-full rounded-full", (tenant.storageData?.currentBytes / tenant.storageData?.limitBytes) > 0.9 ? "bg-destructive" : "bg-primary")} 
                                style={{ width: `${tenant.storageData ? Math.min(100, (tenant.storageData.currentBytes / tenant.storageData.limitBytes) * 100) : 0}%` }}
                              />
                            </div>
                          )}
                        </div>
                        
                        {/* Members */}
                        <div className="flex flex-col gap-1">
                          <div className="flex justify-between items-center text-2xs font-bold">
                            <span className="text-muted-foreground">Members</span>
                            <span className="text-foreground">
                              {counts.users || 0} / {tenant.maxMembers || 1}
                            </span>
                          </div>
                          <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                            <div 
                              className={cn("h-full rounded-full", ((counts.users || 0) / (tenant.maxMembers || 1)) >= 1 ? "bg-destructive" : "bg-primary")} 
                              style={{ width: `${Math.min(100, ((counts.users || 0) / (tenant.maxMembers || 1)) * 100)}%` }}
                            />
                          </div>
                        </div>

                        {/* AI Credits Balance */}
                        <div className="flex justify-between items-center text-2xs font-bold mt-1 pt-1 border-t border-border/50">
                          <span className="text-muted-foreground">AI Credits Bal.</span>
                          <span className={cn("text-foreground", tenant.aiCreditsBalance <= 0 ? "text-danger-text" : "")}>
                            {Number(tenant.aiCreditsBalance || 0).toLocaleString()} <span className="text-muted-foreground font-normal">/ {Number(tenant.planAiCredits || 0).toLocaleString()} (Limit)</span>
                          </span>
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
                          { label: 'Users', count: counts.users || 0 },
                          { label: 'Docs', count: counts.documents || 0 },
                          { label: 'Creds', count: counts.passwords || 0 },
                          { label: 'Other', count: Math.max(0, totalRecords - (counts.users || 0) - (counts.documents || 0) - (counts.passwords || 0)) },
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
                        {tenant.apiKey ? <Badge variant="success" className="text-2xs py-0 px-1 rounded-sm leading-none">Custom Key</Badge> : <Badge variant="secondary" className="text-2xs py-0 px-1 rounded-sm leading-none">Shared Key</Badge>}
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

