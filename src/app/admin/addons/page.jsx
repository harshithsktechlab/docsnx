'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus, Pencil, Trash2, Sparkles, X, CheckCircle, Search, Puzzle, Loader2
} from 'lucide-react';
import { clientGetMe } from '@/lib/clientAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/dialog';
import { ConfirmModal } from '@/components/ui/Modal';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';


const EMPTY_FORM = {
  name: '',
  code: '',
  description: '',
  priceYearly: '',
  priceOneTime: '',
  priceYearlyUsd: '',
  priceOneTimeUsd: '',
  billingCycle: 'MONTHLY',
  aiCredits: 0,
  extraMembers: 0,
  // Since 0058: an add-on can also sell a company, or a seat inside each one.
  // Without these two the "Additional company" and "Additional user (business)"
  // products in the live price list cannot be edited at all.
  extraMembersPerCompany: 0,
  extraCompanies: 0,
  storageLimitGB: 0,
  isActive: true,
};

export default function AddonsPage() {
  const router = useRouter();
  const [addons, setAddons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [currentUser, setCurrentUser] = useState(null);
  const [showDialog, setShowDialog] = useState(false);
  const [editAddon, setEditAddon] = useState(null);
  const [formData, setFormData] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [confirmAddon, setConfirmAddon] = useState(null);
  const [deactivating, setDeactivating] = useState(false);

  useEffect(() => {
    async function loadSession() {
      const me = await clientGetMe();
      if (!me.success || me.user.role !== 'SUPER_ADMIN') { router.push('/dashboard'); return; }
      setCurrentUser(me.user);
      fetchAddons();
    }
    loadSession();
  }, []);

  const fetchAddons = async () => {
    setLoading(true);
    try {
      const { json: data } = await apiCall('/api/admin/addons');
      if (data.success) setAddons(data.addons || []);
      else setError(data.error || 'Failed to load add-ons.');
    } catch (err) {
      // A throw here is a bug above, not a transport failure: `apiCall`
      // returns those as values and puts the real reason in `json.error`.
      console.error('[admin/addonsx] handler threw', err);
      setError('Something went wrong loading add-ons. Please try again.');
    }
    finally { setLoading(false); }
  };

  const openAddDialog = () => {
    setFormData({ ...EMPTY_FORM });
    setEditAddon(null);
    setShowDialog(true);
  };

  const openEditDialog = (addon) => {
    setFormData({
      name: addon.name || '',
      code: addon.code || '',
      description: addon.description || '',
      priceYearly: addon.priceYearly?.toString() || '',
      priceOneTime: addon.priceOneTime?.toString() || '',
      priceYearlyUsd: addon.priceYearlyUsd?.toString() || '',
      priceOneTimeUsd: addon.priceOneTimeUsd?.toString() || '',
      billingCycle: addon.billingCycle || 'MONTHLY',
      aiCredits: addon.aiCredits || 0,
      extraMembers: addon.extraMembers || 0,
      extraMembersPerCompany: addon.extraMembersPerCompany || 0,
      extraCompanies: addon.extraCompanies || 0,
      storageLimitGB: addon.storageLimitGB || 0,
      isActive: addon.isActive ?? true,
    });
    setEditAddon(addon);
    setShowDialog(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!formData.name.trim() || !formData.code.trim()) { setError('Add-on Name and Code are required.'); return; }

    setSaving(true); setError(''); setSuccess('');
    try {
      const payload = {
        name: formData.name.trim(),
        code: formData.code.trim().toUpperCase(),
        description: formData.description,
        price: null,
        priceYearly: formData.priceYearly ? Number(formData.priceYearly) : null,
        priceOneTime: formData.priceOneTime ? Number(formData.priceOneTime) : null,
        priceUsd: null,
        priceYearlyUsd: formData.priceYearlyUsd ? Number(formData.priceYearlyUsd) : null,
        priceOneTimeUsd: formData.priceOneTimeUsd ? Number(formData.priceOneTimeUsd) : null,
        billingCycle: 'MONTHLY',
        aiCredits: Number(formData.aiCredits),
        extraMembers: Number(formData.extraMembers),
        extraMembersPerCompany: Number(formData.extraMembersPerCompany),
        extraCompanies: Number(formData.extraCompanies),
        storageLimitGB: Number(formData.storageLimitGB),
        isActive: formData.isActive,
      };

      if (editAddon) {
        const { json: data } = await apiCall(`/api/admin/addons/${editAddon.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (data.success) { setSuccess('Add-on updated successfully.'); await fetchAddons(); setShowDialog(false); }
        else setError(data.error || 'Failed to update add-on.');
      } else {
        const { json: data } = await apiCall('/api/admin/addons', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (data.success) { setSuccess('Add-on created successfully.'); await fetchAddons(); setShowDialog(false); }
        else setError(data.error || 'Failed to create add-on.');
      }
    } catch (err) {
      // A throw here is a bug above, not a transport failure: `apiCall`
      // returns those as values and puts the real reason in `json.error`.
      console.error('[admin/addonsx] handler threw', err);
      setError('Something went wrong saving add-on. Please try again.');
    }
    finally { setSaving(false); }
  };

  const handleDeactivateRequest = (addon) => {
    setConfirmAddon(addon);
  };

  const handleDeactivateConfirm = async () => {
    if (!confirmAddon) return;
    setError(''); setSuccess('');
    setDeactivating(true);
    try {
      const { json: data } = await apiCall(`/api/admin/addons/${confirmAddon.id}`, { method: 'DELETE' });
      if (data.success) {
        setSuccess(`Add-on "${confirmAddon.name}" deactivated.`);
        await fetchAddons();
      } else {
        setError(data.error || 'Failed to deactivate add-on.');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[admin/addonsx] handler threw', err);
      setError('Something went wrong deactivating add-on. Please try again.');
    } finally {
      setDeactivating(false);
      setConfirmAddon(null);
    }
  };

  const formatPrice = (price) => {
    if (price === null || price === undefined || price === '' || Number(price) === 0) return 'Free';
    return `₹${Number(price).toLocaleString('en-IN')}`;
  };

  const formatUsd = (price) => {
    if (price === null || price === undefined || price === '' || Number(price) === 0) return '$0';
    return `$${Number(price).toLocaleString('en-US')}`;
  };

  const filteredAddons = addons.filter(p => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return true;
    return (p.name?.toLowerCase().includes(q)) || (p.code?.toLowerCase().includes(q));
  });

  return (
    <PageContainer className="space-y-8 pb-12 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 bg-card backdrop-blur-md p-6 rounded-3xl border border-border/50 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center flex-shrink-0 shadow-lg shadow-purple-500/20 ring-1 ring-white/10">
            <Puzzle size={28} className="text-white" strokeWidth={1.5} />
          </div>
          <div>
            <h1 className="text-3xl font-black tracking-tight text-foreground bg-clip-text text-transparent bg-gradient-to-r from-foreground to-foreground/70">Add-ons</h1>
            <p className="text-muted-foreground text-sm font-medium mt-1">Manage extra features and capacity limits for your tenants</p>
          </div>
        </div>
        <Button onClick={openAddDialog} className="flex-shrink-0 bg-primary hover:bg-primary/90 text-primary-foreground font-bold rounded-xl px-6 h-12 shadow-lg shadow-primary/25 transition-all hover:scale-[1.02]">
          <Plus size={18} className="mr-2" /> Create Add-on
        </Button>
      </div>

      {/* Alerts */}
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
              <div className="p-2 bg-purple-500/10 rounded-lg text-purple-500">
                <Puzzle size={18} />
              </div>
              {editAddon ? 'Edit Add-on' : 'Create New Add-on'}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSave}>
            <DialogBody className="flex flex-col gap-5 max-h-[65vh] overflow-y-auto pr-2 custom-scrollbar">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Name *</Label>
                  <Input className="h-11 rounded-xl" placeholder="e.g. Extra 5 Members" value={formData.name} onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))} required disabled={saving} />
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Code *</Label>
                  <Input className="h-11 rounded-xl" placeholder="e.g. EXTRA_MEMBERS" value={formData.code} onChange={e => setFormData(prev => ({ ...prev, code: e.target.value.toUpperCase() }))} required disabled={saving} />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 items-start">
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Price (Yearly) (₹)</Label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">₹</span>
                    <Input className="pl-8 h-11 rounded-xl" type="number" min="0" step="1" placeholder="4990" value={formData.priceYearly} onChange={e => setFormData(prev => ({ ...prev, priceYearly: e.target.value }))} disabled={saving} />
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Price (Yearly) ($)</Label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">$</span>
                    <Input className="pl-8 h-11 rounded-xl" type="number" min="0" step="1" placeholder="49" value={formData.priceYearlyUsd} onChange={e => setFormData(prev => ({ ...prev, priceYearlyUsd: e.target.value }))} disabled={saving} />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 items-start">
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Price (One-Time) (₹)</Label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">₹</span>
                    <Input className="pl-8 h-11 rounded-xl" type="number" min="0" step="1" placeholder="19999" value={formData.priceOneTime} onChange={e => setFormData(prev => ({ ...prev, priceOneTime: e.target.value }))} disabled={saving} />
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Price (One-Time) ($)</Label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">$</span>
                    <Input className="pl-8 h-11 rounded-xl" type="number" min="0" step="1" placeholder="199" value={formData.priceOneTimeUsd} onChange={e => setFormData(prev => ({ ...prev, priceOneTimeUsd: e.target.value }))} disabled={saving} />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Extra AI Credits</Label>
                  <Input className="h-11 rounded-xl" type="number" min="0" step="1" placeholder="0" value={formData.aiCredits} onChange={e => setFormData(prev => ({ ...prev, aiCredits: e.target.value }))} disabled={saving} />
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    Extra Members (personal)
                  </Label>
                  <Input className="h-11 rounded-xl" type="number" min="0" step="1" placeholder="0" value={formData.extraMembers} onChange={e => setFormData(prev => ({ ...prev, extraMembers: e.target.value }))} disabled={saving} />
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Storage (GB)</Label>
                  <Input className="h-11 rounded-xl" type="number" min="0" step="1" placeholder="0" value={formData.storageLimitGB} onChange={e => setFormData(prev => ({ ...prev, storageLimitGB: e.target.value }))} disabled={saving} />
                </div>
              </div>

              {/*
                ── THE BUSINESS ENTITLEMENTS ──────────────────────────────────
                "Members in each company" raises the PER-COMPANY allowance, not
                a tenant-wide total — a business plan sells "N companies, M
                members in each", and this add-on raises M. Selling it as a pool
                would be a different product with the same number in it.
              */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    Extra Members in EACH company
                  </Label>
                  <Input className="h-11 rounded-xl" type="number" min="0" step="1" placeholder="0" value={formData.extraMembersPerCompany} onChange={e => setFormData(prev => ({ ...prev, extraMembersPerCompany: e.target.value }))} disabled={saving} />
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Extra Companies</Label>
                  <Input className="h-11 rounded-xl" type="number" min="0" step="1" placeholder="0" value={formData.extraCompanies} onChange={e => setFormData(prev => ({ ...prev, extraCompanies: e.target.value }))} disabled={saving} />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Description</Label>
                <Input className="h-11 rounded-xl" placeholder="Add-on description" value={formData.description} onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))} disabled={saving} />
              </div>

              <div className="flex items-center justify-between p-4 rounded-xl bg-muted/30 border border-border/50">
                <div className="flex flex-col">
                  <span className="text-sm font-bold text-foreground">Status</span>
                  <span className="text-xs text-muted-foreground">Inactive add-ons cannot be purchased.</span>
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

              {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

              <div className="flex justify-end gap-3 pt-4 border-t border-border mt-2">
                <Button variant="outline" type="button" onClick={() => setShowDialog(false)} className="rounded-xl font-bold">Cancel</Button>
                <Button type="submit" disabled={saving} className="rounded-xl font-bold px-6 shadow-md">
                  {saving ? <Loader2 className="animate-spin" size={18} /> : 'Save Add-on'}
                </Button>
              </div>
            </DialogBody>
          </form>
        </DialogContent>
      </Dialog>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="animate-spin" size={32} />
        </div>
      ) : addons.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 bg-card backdrop-blur-sm border border-border/50 rounded-3xl animate-in fade-in duration-500 shadow-sm">
          <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center mb-6 ring-8 ring-background">
            <Puzzle size={32} className="text-muted-foreground opacity-50" />
          </div>
          <div className="text-center max-w-sm px-4">
            <p className="font-black text-xl text-foreground mb-2">No Add-ons</p>
            <p className="text-sm text-muted-foreground mb-6 leading-relaxed">You haven't created any add-ons yet.</p>
            <Button onClick={openAddDialog} className="h-12 px-6 rounded-xl bg-primary hover:bg-primary/90 text-white font-bold shadow-lg shadow-primary/25 hover:scale-[1.02] transition-transform">
              <Plus size={18} className="mr-2" /> Create First Add-on
            </Button>
          </div>
        </div>
      ) : filteredAddons.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 bg-card backdrop-blur-sm border border-border/50 rounded-3xl animate-in fade-in duration-300">
          <div className="p-4 bg-muted/50 rounded-full mb-2">
            <Search size={28} className="text-muted-foreground opacity-60" />
          </div>
          <p className="font-bold text-lg text-foreground">No matching add-ons found</p>
          <p className="text-sm text-muted-foreground">Try adjusting your search terms.</p>
          <Button variant="link" onClick={() => setSearchQuery('')} className="mt-2 text-primary">Clear search</Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 animate-in slide-in-from-bottom-4 fade-in duration-500">
          {filteredAddons.map((addon) => (
            <Card
              key={addon.id}
              className={cn(
                'relative overflow-hidden transition-all duration-300 bg-card backdrop-blur-xl border-border/50 flex flex-col rounded-3xl hover:-translate-y-1 hover:shadow-2xl',
                addon.isActive ? 'hover:shadow-primary/10 border-t-[6px] border-t-purple-500' : 'opacity-70 grayscale-[30%] border-t-[6px] border-t-muted-foreground'
              )}
            >
              {addon.isActive && <div className="absolute top-0 right-0 w-32 h-32 bg-purple-500/5 rounded-full blur-3xl -z-10" />}
              
              <CardContent className="p-6 flex flex-col flex-1 relative z-10">
                <div className="flex items-start justify-between gap-3 mb-5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1.5">
                      <h3 className="font-black text-xl text-foreground truncate">{addon.name}</h3>
                      {!addon.isActive && (
                        <Badge variant="secondary" className="text-xs font-bold bg-muted-foreground/20 text-muted-foreground rounded-md border-0">INACTIVE</Badge>
                      )}
                    </div>
                    <div className="inline-block bg-muted/50 px-2 py-0.5 rounded-md border border-border/50">
                      <span className="font-mono text-xs font-bold text-muted-foreground tracking-widest">{addon.code}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0 bg-background/50 backdrop-blur p-1 rounded-xl border border-border/50">
                    <Button variant="ghost" size="icon" onClick={() => openEditDialog(addon)} className="h-8 w-8 rounded-lg hover:bg-primary/10 hover:text-primary transition-colors">
                      <Pencil size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDeactivateRequest(addon)}
                      className="h-8 w-8 rounded-lg text-muted-foreground hover:text-danger-action hover:bg-destructive/10"
                      title="Deactivate Add-on"
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>

                <div className="mb-6">
                  <div className="flex flex-col gap-2 flex-wrap">
                    {addon.priceYearly && (
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-2xl font-black tracking-tighter text-foreground">
                          {formatPrice(addon.priceYearly)}
                        </span>
                        <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider ml-1">/ YEAR</span>
                        {addon.priceYearlyUsd && (
                          <span className="text-xs font-bold text-muted-foreground ml-1">({formatUsd(addon.priceYearlyUsd)})</span>
                        )}
                      </div>
                    )}
                    {addon.priceOneTime && (
                      <div className="flex items-baseline gap-1.5">
                        <span className={cn("font-black tracking-tighter text-foreground", !addon.priceYearly ? "text-2xl" : "text-lg text-foreground/80")}>
                          {formatPrice(addon.priceOneTime)}
                        </span>
                        <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider ml-1">/ ONE-TIME</span>
                        {addon.priceOneTimeUsd && (
                          <span className="text-xs font-bold text-muted-foreground ml-1">({formatUsd(addon.priceOneTimeUsd)})</span>
                        )}
                      </div>
                    )}
                    {!addon.priceYearly && !addon.priceOneTime && (
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-2xl font-black tracking-tighter text-emerald-500">Free</span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex flex-col gap-4 flex-1">
                  <div className="flex flex-col gap-2">
                    {addon.description && (
                      <p className="text-sm text-muted-foreground font-medium italic mb-2">
                        "{addon.description}"
                      </p>
                    )}
                    {addon.aiCredits > 0 && (
                       <span className="text-xs font-semibold text-muted-foreground bg-blue-500/10 text-blue-500 px-2 py-1 rounded-md border border-blue-500/20 inline-block w-fit">
                         +{addon.aiCredits} AI Credits
                       </span>
                    )}
                    {addon.extraMembers > 0 && (
                       <span className="text-xs font-semibold text-muted-foreground bg-amber-500/10 text-amber-500 px-2 py-1 rounded-md border border-amber-500/20 inline-block w-fit">
                         +{addon.extraMembers} Members
                       </span>
                    )}
                    {addon.storageLimitGB > 0 && (
                       <span className="text-xs font-semibold text-muted-foreground bg-purple-500/10 text-purple-500 px-2 py-1 rounded-md border border-purple-500/20 inline-block w-fit">
                         +{addon.storageLimitGB} GB Storage
                       </span>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ConfirmModal
        isOpen={!!confirmAddon}
        onClose={() => setConfirmAddon(null)}
        onConfirm={handleDeactivateConfirm}
        title="Deactivate Add-on?"
        description={`Are you sure you want to deactivate "${confirmAddon?.name}"? It will be hidden from available add-ons for tenants.`}
        confirmText="Deactivate"
        cancelText="Cancel"
        variant="destructive"
        loading={deactivating}
      />
    </PageContainer>
  );
}
