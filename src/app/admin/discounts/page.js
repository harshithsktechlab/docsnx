'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Tag, Plus, Pencil, Trash2, CheckCircle, X, Loader2, Save, Search, Percent,
  Users, IndianRupee, Repeat
} from 'lucide-react';
import { clientGetMe } from '@/lib/clientAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogBody } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';


const EMPTY_FORM = {
  code: '',
  type: 'PERCENTAGE',
  discountAmount: '',
  maxUses: '',
  maxUsesPerTenant: '',
  expiresAt: '',
  planId: '',
  addonId: '',
  isActive: true,
};

/** A code the API returned without stats (it always sends them) reads as unused. */
const NO_USAGE = { totalUses: 0, uniqueAccounts: 0, totalSaved: 0, lastUsedAt: null };
const usageOf = (discount) => discount.usage || NO_USAGE;

const formatRupees = (value) =>
  `₹${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const SORTS = {
  newest: () => 0, // the API already orders by createdAt desc
  mostUsed: (a, b) => usageOf(b).totalUses - usageOf(a).totalUses,
  mostSaved: (a, b) => usageOf(b).totalSaved - usageOf(a).totalSaved,
};

export default function DiscountsPage() {
  const router = useRouter();
  const [discounts, setDiscounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [currentUser, setCurrentUser] = useState(null);
  const [showDialog, setShowDialog] = useState(false);
  const [editDiscount, setEditDiscount] = useState(null);
  const [formData, setFormData] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('newest');
  const [plans, setPlans] = useState([]);
  const [addons, setAddons] = useState([]);

  useEffect(() => {
    async function loadSession() {
      const me = await clientGetMe();
      if (!me.success || me.user.role !== 'SUPER_ADMIN') { router.push('/dashboard'); return; }
      setCurrentUser(me.user);
      fetchDiscounts();
      fetchPlansAndAddons();
    }
    loadSession();
  }, []);

  const fetchPlansAndAddons = async () => {
    try {
      // `apiCall` resolves rather than rejecting, so one failing request no
      // longer discards the results of the others — `Promise.all` used to
      // throw the whole batch away and land in a catch that named none of them.
      const [{ json: plansData }, { json: addonsData }] = await Promise.all([
        apiCall('/api/admin/plans', { cache: 'no-store' }),
        apiCall('/api/admin/addons'),
      ]);
      if (plansData.success) setPlans(plansData.plans || []);
      if (addonsData.success) setAddons(addonsData.addons || []);
    } catch (err) {
      console.error('Failed to load plans or addons', err);
    }
  };

  const fetchDiscounts = async () => {
    setLoading(true);
    try {
      const { json: data } = await apiCall('/api/admin/discounts');
      if (data.success) setDiscounts(data.discountCodes || []);
      else setError(data.error || 'Failed to load discount codes.');
    } catch (err) {
      // A throw here is a bug above, not a transport failure: `apiCall`
      // returns those as values and puts the real reason in `json.error`.
      console.error('[admin/discounts] handler threw', err);
      setError('Something went wrong loading discount codes. Please try again.');
    }
    finally { setLoading(false); }
  };

  const openAddDialog = () => {
    setFormData({ ...EMPTY_FORM });
    setEditDiscount(null);
    setShowDialog(true);
  };

  const openEditDialog = (discount) => {
    setFormData({
      code: discount.code || '',
      type: discount.type || 'PERCENTAGE',
      discountAmount: discount.discountAmount?.toString() || (discount.discountPct ? discount.discountPct.toString() : ''),
      maxUses: discount.maxUses?.toString() || '',
      maxUsesPerTenant: discount.maxUsesPerTenant?.toString() || '',
      expiresAt: discount.expiresAt ? new Date(discount.expiresAt).toISOString().slice(0, 16) : '',
      planId: discount.planId || '',
      addonId: discount.addonId || '',
      isActive: discount.isActive ?? true,
    });
    setEditDiscount(discount);
    setShowDialog(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!formData.code.trim()) { setError('Discount Code is required.'); return; }
    if (!formData.discountAmount || isNaN(Number(formData.discountAmount)) || Number(formData.discountAmount) <= 0) { 
      setError('Valid discount amount is required.'); return; 
    }
    if (formData.type === 'PERCENTAGE' && Number(formData.discountAmount) > 100) {
      setError('Percentage cannot exceed 100.'); return;
    }

    setSaving(true); setError(''); setSuccess('');
    try {
      const payload = {
        code: formData.code.trim().toUpperCase(),
        type: formData.type,
        discountAmount: Number(formData.discountAmount),
        maxUses: formData.maxUses ? Number(formData.maxUses) : null,
        maxUsesPerTenant: formData.maxUsesPerTenant ? Number(formData.maxUsesPerTenant) : null,
        expiresAt: formData.expiresAt ? new Date(formData.expiresAt).toISOString() : null,
        planId: formData.planId.trim() || null,
        addonId: formData.addonId.trim() || null,
        isActive: formData.isActive,
      };

      if (editDiscount) {
        const { json: data } = await apiCall(`/api/admin/discounts/${editDiscount.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (data.success) { setSuccess('Discount updated successfully.'); await fetchDiscounts(); setShowDialog(false); }
        else setError(data.error || 'Failed to update discount.');
      } else {
        const { json: data } = await apiCall('/api/admin/discounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (data.success) { setSuccess('Discount created successfully.'); await fetchDiscounts(); setShowDialog(false); }
        else setError(data.error || 'Failed to create discount.');
      }
    } catch (err) {
      // A throw here is a bug above, not a transport failure: `apiCall`
      // returns those as values and puts the real reason in `json.error`.
      console.error('[admin/discounts] handler threw', err);
      setError('Something went wrong saving discount. Please try again.');
    }
    finally { setSaving(false); }
  };

  const handleDelete = async (discount) => {
    if (!confirm(`Delete discount code "${discount.code}"?\n\nThis cannot be undone.`)) return;
    setError(''); setSuccess('');
    try {
      const { json: data } = await apiCall(`/api/admin/discounts/${discount.id}`, { method: 'DELETE' });
      if (data.success) { setSuccess(`Discount code "${discount.code}" deleted.`); await fetchDiscounts(); }
      else setError(data.error || 'Failed to delete discount.');
    } catch (err) {
      // A throw here is a bug above, not a transport failure: `apiCall`
      // returns those as values and puts the real reason in `json.error`.
      console.error('[admin/discounts] handler threw', err);
      setError('Something went wrong deleting discount. Please try again.');
    }
  };

  const filteredDiscounts = discounts.filter(d => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return true;
    return (d.code?.toLowerCase().includes(q));
  }).sort(SORTS[sortBy]);

  // Fleet-wide totals. Unique accounts are summed per code, so an account that
  // used two different codes counts once under each — the card says so in its
  // tooltip rather than claiming a count of distinct customers.
  const totals = discounts.reduce((acc, d) => {
    const u = usageOf(d);
    acc.uses += u.totalUses;
    acc.accounts += u.uniqueAccounts;
    acc.saved += u.totalSaved;
    if (d.isActive) acc.active += 1;
    return acc;
  }, { uses: 0, accounts: 0, saved: 0, active: 0 });

  return (
    <PageContainer className="space-y-8 pb-12 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 bg-card backdrop-blur-md p-6 rounded-3xl border border-border/50 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-yellow-400 via-orange-500 to-orange-600 flex items-center justify-center flex-shrink-0 shadow-lg shadow-orange-500/20 ring-1 ring-white/10">
            <Tag size={28} className="text-white" strokeWidth={1.5} />
          </div>
          <div>
            <h1 className="text-3xl font-black tracking-tight text-foreground bg-clip-text text-transparent bg-gradient-to-r from-foreground to-foreground/70">Discount Codes</h1>
            <p className="text-muted-foreground text-sm font-medium mt-1">Manage promotional codes for your tenants</p>
          </div>
        </div>
        <Button onClick={openAddDialog} className="flex-shrink-0 bg-primary hover:bg-primary/90 text-primary-foreground font-bold rounded-xl px-6 h-12 shadow-lg shadow-primary/25 transition-all hover:scale-[1.02]">
          <Plus size={18} className="mr-2" /> Create Discount
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

      {error && (
        <Alert variant="destructive" className="animate-in slide-in-from-top-2 rounded-2xl backdrop-blur-sm">
          <AlertDescription className="flex items-center justify-between text-sm font-semibold ml-2">
            <span>{error}</span>
            <button onClick={() => setError('')} className="p-1 hover:bg-destructive/20 rounded-full transition-colors"><X size={14} /></button>
          </AlertDescription>
        </Alert>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent aria-describedby={undefined} className="max-w-[600px] max-h-[90vh] overflow-y-auto border border-border/80 bg-card rounded-2xl shadow-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-xl font-black">
              <div className="p-2 bg-amber-500/10 rounded-lg text-amber-500">
                <Tag size={18} />
              </div>
              {editDiscount ? 'Edit Discount Code' : 'Create Discount Code'}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSave}>
            <DialogBody className="flex flex-col gap-5 pr-2">
              
              <div className="flex flex-col gap-2">
                <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Promo Code *</Label>
                <Input className="h-11 rounded-xl" placeholder="e.g. SUMMER50" value={formData.code} onChange={e => setFormData(prev => ({ ...prev, code: e.target.value.toUpperCase() }))} required disabled={saving} />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Type *</Label>
                  <select 
                    className="flex h-11 w-full rounded-xl border border-input bg-field px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    value={formData.type} 
                    onChange={e => setFormData(prev => ({ ...prev, type: e.target.value }))}
                    disabled={saving}
                  >
                    <option value="PERCENTAGE">Percentage (%)</option>
                    <option value="FIXED">Fixed Amount</option>
                  </select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Amount *</Label>
                  <Input type="number" min="1" step="1" placeholder="25" value={formData.discountAmount} onChange={e => setFormData(prev => ({ ...prev, discountAmount: e.target.value }))} required disabled={saving} className="h-11 rounded-xl" />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Total Max Uses</Label>
                  <Input type="number" min="1" placeholder="Leave blank for unlimited" value={formData.maxUses} onChange={e => setFormData(prev => ({ ...prev, maxUses: e.target.value }))} disabled={saving} className="h-11 rounded-xl" />
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Uses Per Tenant</Label>
                  <Input type="number" min="1" placeholder="Leave blank for unlimited" value={formData.maxUsesPerTenant} onChange={e => setFormData(prev => ({ ...prev, maxUsesPerTenant: e.target.value }))} disabled={saving} className="h-11 rounded-xl" />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Expires At</Label>
                <Input type="datetime-local" value={formData.expiresAt} onChange={e => setFormData(prev => ({ ...prev, expiresAt: e.target.value }))} disabled={saving} className="h-11 rounded-xl" />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Restrict to Plan</Label>
                  <select 
                    className="flex h-11 w-full rounded-xl border border-input bg-field px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    value={formData.planId} 
                    onChange={e => setFormData(prev => ({ ...prev, planId: e.target.value }))}
                    disabled={saving}
                  >
                    <option value="">No restriction (All Plans)</option>
                    {plans.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Restrict to Addon</Label>
                  <select 
                    className="flex h-11 w-full rounded-xl border border-input bg-field px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    value={formData.addonId} 
                    onChange={e => setFormData(prev => ({ ...prev, addonId: e.target.value }))}
                    disabled={saving}
                  >
                    <option value="">No restriction (All Add-ons)</option>
                    {addons.map(a => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-between p-4 rounded-xl bg-muted/30 border border-border/50">
                <div className="flex flex-col">
                  <span className="text-sm font-bold text-foreground">Status</span>
                  <span className="text-xs text-muted-foreground">Inactive codes cannot be used.</span>
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
                {editDiscount ? 'Save Changes' : 'Create Code'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Usage summary — totals across every code; per-code rows are in the table below */}
      {!loading && discounts.length > 0 && (
        <section className="flex flex-col gap-3 animate-fade-in">
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground px-1">All codes</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: 'Redemptions', value: totals.uses.toLocaleString('en-IN'), icon: Repeat },
            { label: 'Accounts', hint: 'Summed per code: an account that used two codes counts under each', value: totals.accounts.toLocaleString('en-IN'), icon: Users },
            { label: 'Discount Given', value: formatRupees(totals.saved), icon: IndianRupee },
            { label: 'Active Codes', value: `${totals.active} / ${discounts.length}`, icon: Tag },
          ].map(({ label, hint, value, icon: Icon }) => (
            <div key={label} title={hint} className="flex items-center gap-3 p-4 rounded-2xl bg-card backdrop-blur-md border border-border/50 shadow-sm min-w-0">
              <div className="p-2.5 rounded-xl bg-amber-500/10 text-amber-500 flex-shrink-0">
                <Icon size={18} />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground leading-tight">{label}</p>
                <p className="text-xl font-black text-foreground truncate">{value}</p>
              </div>
            </div>
          ))}
        </div>
        </section>
      )}

      {/* Search Bar + Sort */}
      {!loading && discounts.length > 0 && (
        <div className="flex flex-col sm:flex-row gap-3 animate-fade-in stagger-1">
          <div className="relative flex-1 max-w-md">
            <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-11 h-12 rounded-2xl bg-card backdrop-blur border-border/50 shadow-sm text-sm focus-visible:ring-primary/30 focus-visible:border-primary/50 transition-all" placeholder="Search discount codes..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1 hover:bg-muted rounded-full transition-colors">
                <X size={14} />
              </button>
            )}
          </div>
          <select
            aria-label="Sort discount codes"
            className="h-12 rounded-2xl border border-border/50 bg-card px-4 text-sm font-medium shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
          >
            <option value="newest">Newest first</option>
            <option value="mostUsed">Most used</option>
            <option value="mostSaved">Most discount given</option>
          </select>
        </div>
      )}

      {!loading && filteredDiscounts.length > 0 && (
        <UsageTable discounts={filteredDiscounts} />
      )}

      {/* Content */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-32 gap-4 text-muted-foreground">
          <div className="p-4 bg-primary/10 rounded-2xl">
            <Loader2 size={32} className="animate-spin text-primary" />
          </div>
          <p className="text-sm font-medium animate-pulse">Loading discount codes...</p>
        </div>
      ) : discounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-32 gap-5 bg-card backdrop-blur-sm border border-dashed border-border/60 rounded-3xl animate-in fade-in zoom-in-95 duration-500">
          <div className="w-20 h-20 bg-muted/50 rounded-full flex items-center justify-center mb-2">
            <Tag size={32} className="text-muted-foreground opacity-50" />
          </div>
          <div className="text-center max-w-sm px-4">
            <p className="font-black text-xl text-foreground mb-2">No Discount Codes</p>
            <p className="text-sm text-muted-foreground mb-6 leading-relaxed">You haven't created any promotional codes yet. Add your first code to offer discounts.</p>
            <Button onClick={openAddDialog} className="h-12 px-6 rounded-xl bg-primary hover:bg-primary/90 text-white font-bold shadow-lg shadow-primary/25 hover:scale-[1.02] transition-transform">
              <Plus size={18} className="mr-2" /> Create First Code
            </Button>
          </div>
        </div>
      ) : filteredDiscounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 bg-card backdrop-blur-sm border border-border/50 rounded-3xl animate-in fade-in duration-300">
          <div className="p-4 bg-muted/50 rounded-full mb-2">
            <Search size={28} className="text-muted-foreground opacity-60" />
          </div>
          <p className="font-bold text-lg text-foreground">No matching codes found</p>
          <p className="text-sm text-muted-foreground">Try adjusting your search terms.</p>
          <Button variant="link" onClick={() => setSearchQuery('')} className="mt-2 text-primary">Clear search</Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-6 animate-in slide-in-from-bottom-4 fade-in duration-500">
          {filteredDiscounts.map((discount) => (
            <Card
              key={discount.id}
              id={`code-${discount.id}`}
              className={cn(
                'relative overflow-hidden transition-all duration-300 bg-card backdrop-blur-xl border-border/50 flex flex-col rounded-3xl hover:-translate-y-1 hover:shadow-2xl',
                discount.isActive ? 'hover:shadow-amber-500/10 border-t-[6px] border-t-amber-500' : 'opacity-70 grayscale-[30%] border-t-[6px] border-t-muted-foreground'
              )}
            >
              {discount.isActive && <div className="absolute top-0 right-0 w-32 h-32 bg-amber-500/5 rounded-full blur-3xl -z-10" />}
              
              <CardContent className="p-6 flex flex-col flex-1 relative z-10">
                <div className="flex items-start justify-between gap-3 mb-5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1.5">
                      <h3 className="font-black text-xl text-foreground truncate font-mono">{discount.code}</h3>
                      {!discount.isActive && (
                        <Badge variant="secondary" className="text-xs font-bold bg-muted-foreground/20 text-muted-foreground rounded-md border-0">INACTIVE</Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0 bg-background/50 backdrop-blur p-1 rounded-xl border border-border/50">
                    <Button variant="ghost" size="icon" onClick={() => openEditDialog(discount)} className="h-8 w-8 rounded-lg hover:bg-primary/10 hover:text-primary transition-colors" title="Edit Code">
                      <Pencil size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(discount)}
                      title={'Delete Code'}
                      className="h-8 w-8 rounded-lg text-danger-action/70 hover:bg-destructive/10 hover:text-danger-action transition-colors"
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>

                <div className="mb-2 mt-auto">
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Discount</span>
                    <span className="text-3xl font-black text-amber-500">
                      {formatDiscount(discount)} OFF
                    </span>
                    {discount.maxUsesPerTenant && <span className="text-xs text-muted-foreground font-medium">Limit per tenant: {discount.maxUsesPerTenant}</span>}
                    {discount.expiresAt && <span className="text-xs text-muted-foreground font-medium">Expires: {new Date(discount.expiresAt).toLocaleDateString()}</span>}
                  </div>
                </div>

                <UsageStats discount={discount} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </PageContainer>
  );
}

const formatDiscount = (discount) =>
  discount.type === 'FIXED' ? `₹${discount.discountAmount}` : `${discount.discountAmount || discount.discountPct}%`;

const formatDate = (value) => (value ? new Date(value).toLocaleDateString() : 'Never');

/** "N / cap times" plus a fill bar when the code has a total cap. */
function UsedMeter({ discount }) {
  const { totalUses } = usageOf(discount);
  const cap = discount.maxUses;
  const pct = cap ? Math.min(100, Math.round((totalUses / cap) * 100)) : null;

  return (
    <div className="flex flex-col gap-1.5 min-w-[5.5rem]">
      <span className="text-sm font-black text-foreground whitespace-nowrap">
        {totalUses}{cap ? <span className="text-muted-foreground font-semibold"> / {cap}</span> : null}
        <span className="text-xs text-muted-foreground font-medium"> {totalUses === 1 ? 'time' : 'times'}</span>
      </span>
      {cap ? (
        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden" role="progressbar" aria-valuenow={totalUses} aria-valuemin={0} aria-valuemax={cap}>
          <div className={cn('h-full rounded-full', pct >= 100 ? 'bg-destructive' : 'bg-amber-500')} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

/** One row per code — the per-code statistics, with the code itself as the row heading. */
function UsageTable({ discounts }) {
  const sum = (key) => discounts.reduce((n, d) => n + usageOf(d)[key], 0);
  const th = 'px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground whitespace-nowrap';
  const td = 'px-4 py-3 whitespace-nowrap';

  return (
    <section className="bg-card backdrop-blur-md rounded-3xl border border-border/50 shadow-sm overflow-hidden animate-fade-in">
      <h2 className="px-5 pt-5 pb-3 text-sm font-black text-foreground">Usage by code</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 border-y border-border/50">
            <tr>
              <th scope="col" className={cn(th, 'sticky left-0 bg-muted')}>Code</th>
              <th scope="col" className={th}>Status</th>
              <th scope="col" className={th}>Discount</th>
              <th scope="col" className={th}>Used</th>
              <th scope="col" className={th}>Accounts</th>
              <th scope="col" className={th}>Discount given</th>
              <th scope="col" className={th}>Last used</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {discounts.map((discount) => {
              const usage = usageOf(discount);
              return (
                <tr key={discount.id} className="hover:bg-muted/30 transition-colors">
                  <th scope="row" className={cn(td, 'sticky left-0 bg-card text-left')}>
                    <a href={`#code-${discount.id}`} className="font-mono font-black text-foreground hover:text-primary">{discount.code}</a>
                  </th>
                  <td className={td}>
                    {discount.isActive
                      ? <Badge variant="success" className="text-xs font-bold rounded-md">Active</Badge>
                      : <Badge variant="secondary" className="text-xs font-bold bg-muted-foreground/20 text-muted-foreground rounded-md border-0">Inactive</Badge>}
                  </td>
                  <td className={cn(td, 'font-bold text-amber-500')}>{formatDiscount(discount)} off</td>
                  <td className={td}><UsedMeter discount={discount} /></td>
                  <td className={cn(td, 'font-bold')}>{usage.uniqueAccounts}</td>
                  <td className={cn(td, 'font-bold')}>{formatRupees(usage.totalSaved)}</td>
                  <td className={cn(td, 'text-muted-foreground')}>{formatDate(usage.lastUsedAt)}</td>
                </tr>
              );
            })}
          </tbody>
          {discounts.length > 1 && (
            <tfoot className="border-t border-border/50 bg-muted/40">
              <tr>
                <th scope="row" className={cn(td, 'sticky left-0 bg-muted text-left text-xs font-bold uppercase tracking-wider text-muted-foreground')}>Total</th>
                <td className={td} />
                <td className={td} />
                <td className={cn(td, 'font-black')}>{sum('totalUses')}</td>
                <td className={cn(td, 'font-black')} title="Summed per code: an account that used two codes counts under each">{sum('uniqueAccounts')}</td>
                <td className={cn(td, 'font-black')}>{formatRupees(sum('totalSaved'))}</td>
                <td className={td} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
}

/** Redemption stats on a code's card: uses (against its cap, if any), accounts, amount given. */
function UsageStats({ discount }) {
  const usage = usageOf(discount);

  return (
    <div className="mt-4 pt-4 border-t border-border/50 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Used</span>
        <UsedMeter discount={discount} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col">
          <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Accounts</span>
          <span className="text-sm font-black text-foreground">{usage.uniqueAccounts}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Saved</span>
          <span className="text-sm font-black text-foreground">{formatRupees(usage.totalSaved)}</span>
        </div>
      </div>
    </div>
  );
}
