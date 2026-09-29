'use client';

import React, { useEffect, useState } from 'react';
import { 
  FileText, Plus, Search, RefreshCw, X, 
  Download, Eye, AlertCircle, Loader2, Link as LinkIcon 
} from 'lucide-react';
import { shareRecord, downloadRecord } from '@/lib/sharePrintHelper';
import { generateInvoicePDF } from '@/lib/invoicePdfHelper';
import { clientGetMe } from '@/lib/clientAuth';
import { formatDate } from '@/lib/dateHelper';
import { toast } from 'sonner';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import InvoicePreviewModal from '@/app/components/InvoicePreviewModal';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';

// Razorpay payment link pre-filled on new invoices (test mode; swap for the live link at go-live).
const DEFAULT_PAYMENT_LINK = 'https://razorpay.com/payment-link/plink_Tfl4RPMTiUZbcu/test';

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  
  const [showAddForm, setShowAddForm] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const [user, setUser] = useState(null);
  const [tenants, setTenants] = useState([]);
  const [platformConfig, setPlatformConfig] = useState(null);

  // Form State
  const [tenantId, setTenantId] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [clientName, setClientName] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [clientGstin, setClientGstin] = useState('');
  const [clientAddress, setClientAddress] = useState('');
  const [clientStateCode, setClientStateCode] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [gstType, setGstType] = useState('EXEMPT');
  const [amount, setAmount] = useState(''); // Inclusive amount
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [paymentLink, setPaymentLink] = useState(DEFAULT_PAYMENT_LINK);

  // Invoice Preview State
  const [previewInvoice, setPreviewInvoice] = useState(null);
  const [showPreview, setShowPreview] = useState(false);

  const initData = async () => {
    try {
      setLoading(true);
      const me = await clientGetMe();
      if (me) setUser(me);

      // Fetch Platform Settings (Super admin or tenant should have access if it's public enough, 
      // but for generating PDF, we might need platform details. Let's fetch them if possible, or they can be passed)
      // Actually we need an endpoint for it if it's public. For now we will fetch from /api/admin/settings if super_admin.
      // Or we can create an endpoint if it fails.
      
      const { json: jsonInvoices } = await apiCall('/api/invoices');
      if (jsonInvoices.success) {
        setInvoices(jsonInvoices.invoices);
      }

      if (me?.role === 'SUPER_ADMIN') {
        const { json: jsonTenants } = await apiCall('/api/admin/tenants');
        if (jsonTenants.success) {
          setTenants(jsonTenants.tenants);
        }

        const { json: jsonSettings } = await apiCall('/api/admin/settings');
        if (jsonSettings.success) {
           setPlatformConfig(jsonSettings.config);
        }
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[invoices] handler threw', err);
      toast.error('Something went wrong loading data. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    initData();
  }, []);

  const handleTenantSelect = (selectedId) => {
    setTenantId(selectedId);
    const tenant = tenants.find(t => t.id === selectedId);
    if (tenant) {
      setClientName(tenant.billingName || tenant.name || '');
      setClientGstin(tenant.billingGst || '');
      setClientAddress(tenant.billingAddress || '');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    
    try {
      const { res, json } = await apiCall('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId,
          invoiceNumber,
          clientName,
          clientEmail,
          clientGstin,
          clientAddress,
          clientStateCode,
          clientPhone,
          currency,
          gstType,
          amount: parseFloat(amount),
          dueDate,
          notes,
          paymentLink,
          status: 'pending'
        })
      });
      
      if (json.success) {
        toast.success('Invoice created successfully');
        closeAddForm();
        initData();
      } else {
        toast.error(json.error || 'Failed to create invoice');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[invoices] handler threw', err);
      toast.error('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetForm = () => {
    setTenantId('');
    setInvoiceNumber('');
    setClientName('');
    setClientEmail('');
    setClientGstin('');
    setClientAddress('');
    setClientStateCode('');
    setClientPhone('');
    setAmount('');
    setDueDate('');
    setNotes('');
    setPaymentLink(DEFAULT_PAYMENT_LINK);
  };

  // One definition of "closed", shared by the header toggle and the Cancel
  // button, so neither can leave a half-typed invoice behind in state.
  const closeAddForm = () => {
    resetForm();
    setShowAddForm(false);
  };

  const handleDownload = (inv) => {
    generateInvoicePDF(inv, platformConfig || { 
      platformName: 'DocsNX', 
      platformEmail: 'billing@docsnx.com' 
    });
  };

  const handlePreview = (inv) => {
    setPreviewInvoice(inv);
    setShowPreview(true);
  };

  const filteredInvoices = invoices.filter(inv => 
    inv.invoiceNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
    inv.clientName.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <PageContainer>
      {/* Header Row */}
      <div className="flex items-center justify-between gap-4 animate-fade-in">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground">Invoices</h1>
          <p className="text-muted-foreground text-sm">Manage subscriptions and ad-hoc payments</p>
        </div>
        {user?.role === 'SUPER_ADMIN' && (
          <Button 
            onClick={() => (showAddForm ? closeAddForm() : setShowAddForm(true))}
            className="flex items-center gap-2 h-10 px-4"
          >
            {showAddForm ? <X size={16} /> : <Plus size={16} />}
            <span>{showAddForm ? 'Close Form' : 'New Invoice'}</span>
          </Button>
        )}
      </div>

      {showAddForm && user?.role === 'SUPER_ADMIN' && (
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass p-6 animate-scale-in">
          <CardHeader className="p-0 pb-4 border-b border-border/50 mb-6">
            <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
              <FileText className="text-primary" size={20} />
              <span>Create Invoice</span>
            </h2>
          </CardHeader>
          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label>Select Tenant (Client) *</Label>
                <Select value={tenantId} onValueChange={handleTenantSelect} required>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a tenant..." />
                  </SelectTrigger>
                  <SelectContent>
                    {tenants.map(t => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Invoice Number *</Label>
                <Input 
                  value={invoiceNumber} 
                  onChange={(e) => setInvoiceNumber(e.target.value)} 
                  required 
                  placeholder="INV-001"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Client Name *</Label>
                <Input 
                  value={clientName} 
                  onChange={(e) => setClientName(e.target.value)} 
                  required 
                  placeholder="Acme Corp"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Client GSTIN</Label>
                <Input 
                  value={clientGstin} 
                  onChange={(e) => setClientGstin(e.target.value)} 
                  placeholder="22AAAAA0000A1Z5"
                />
              </div>
              
              <div className="flex flex-col gap-1.5 md:col-span-2">
                <Label>Client Address</Label>
                <Input 
                  value={clientAddress} 
                  onChange={(e) => setClientAddress(e.target.value)} 
                  placeholder="123 Business Rd, City"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Client State Code</Label>
                <Input 
                  value={clientStateCode} 
                  onChange={(e) => setClientStateCode(e.target.value)} 
                  placeholder="e.g. 27"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Client Phone</Label>
                <Input 
                  value={clientPhone} 
                  onChange={(e) => setClientPhone(e.target.value)} 
                  placeholder="+91 9876543210"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Client Email</Label>
                <Input 
                  type="email"
                  value={clientEmail} 
                  onChange={(e) => setClientEmail(e.target.value)} 
                  placeholder="client@acme.com"
                />
              </div>
              
              <div className="flex flex-col gap-1.5">
                <Label>Currency *</Label>
                <Select value={currency} onValueChange={setCurrency}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="INR">INR (₹)</SelectItem>
                    <SelectItem value="USD">USD ($)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>GST Type *</Label>
                <Select value={gstType} onValueChange={setGstType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="EXEMPT">Exempt (0%)</SelectItem>
                    <SelectItem value="CGST_SGST">CGST + SGST (Intra-state, 18%)</SelectItem>
                    <SelectItem value="IGST">IGST (Inter-state, 18%)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Total Amount (Inclusive) *</Label>
                <Input 
                  type="number" 
                  step="0.01"
                  value={amount} 
                  onChange={(e) => setAmount(e.target.value)} 
                  required 
                  placeholder="5000.00"
                />
              </div>
              
              <div className="flex flex-col gap-1.5">
                <Label>Due Date *</Label>
                <Input 
                  type="date"
                  value={dueDate} 
                  onChange={(e) => setDueDate(e.target.value)} 
                  required 
                />
              </div>
              
              <div className="flex flex-col gap-1.5">
                <Label>Payment Link</Label>
                <Input 
                  value={paymentLink} 
                  onChange={(e) => setPaymentLink(e.target.value)} 
                  placeholder="https://razorpay.com/payment-link/..."
                />
              </div>
            </div>
            
            <div className="flex flex-col gap-1.5">
              <Label>Description / Items</Label>
              <Input 
                value={notes} 
                onChange={(e) => setNotes(e.target.value)} 
                placeholder="Software subscription for July..."
              />
            </div>

            {/* Cancel sits WITH Save, at the foot of the form, because that is
                where someone who has changed their mind actually is — the toggle up
                in the page header has long since scrolled away. It discards whatever
                was typed; see closeAddForm. */}
            <div className="mt-2 flex flex-col-reverse gap-3 md:flex-row md:justify-end">
              <Button type="button" variant="outline" onClick={closeAddForm} disabled={isSubmitting} className="px-6">
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting} className="w-full md:w-auto">
                {isSubmitting ? <Loader2 className="animate-spin mr-2" size={16} /> : null}
                {isSubmitting ? 'Creating...' : 'Create Invoice'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-4">
        <div className="relative w-full">
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground flex">
            <Search size={18} />
          </span>
          <Input
            placeholder="Search invoices by number or client..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 h-11 bg-background/20"
          />
        </div>
        <Button variant="outline" onClick={initData} className="h-11 px-4 border-border/50">
          <RefreshCw size={16} />
        </Button>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1,2,3].map(i => <Skeleton key={i} className="h-48 w-full rounded-2xl" />)}
        </div>
      ) : filteredInvoices.length === 0 ? (
        <div className="text-center py-20 bg-background/10 border-2 border-dashed border-border/50 rounded-2xl">
          <FileText size={48} className="mx-auto text-muted-foreground opacity-30 mb-4" />
          <p className="text-muted-foreground font-medium">No invoices found</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredInvoices.map((inv) => (
            <Card key={inv.id} className="border-border/50 bg-card backdrop-blur shadow-glass flex flex-col justify-between hover:border-primary/50 transition-colors">
              <div className="p-5 flex flex-col gap-2">
                <div className="flex justify-between items-start mb-2">
                  <div className="px-3 py-1 bg-primary/10 text-primary text-xs font-bold rounded-full">
                    {inv.status.toUpperCase()}
                  </div>
                  <h3 className="font-bold text-lg text-foreground">{inv.invoiceNumber}</h3>
                </div>
                <p className="text-sm text-foreground/80 font-medium">{inv.clientName}</p>
                <div className="flex items-baseline gap-1 mt-2">
                  <span className="text-2xl font-extrabold text-foreground tracking-tight">
                    {inv.currency === 'USD' ? '$' : '₹'}{Number(inv.amount).toLocaleString(inv.currency === 'USD' ? 'en-US' : 'en-IN')}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-3 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-border inline-block"></span>
                  Due: {formatDate(inv.dueDate)}
                </p>
              </div>
              <div className="p-4 border-t border-border/50 bg-background/30 flex justify-end gap-2">
                {inv.paymentLink && (
                  <Button variant="outline" size="sm" asChild>
                    <a href={inv.paymentLink} target="_blank" rel="noreferrer">
                      <LinkIcon size={14} className="mr-1.5" />
                      Pay
                    </a>
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => handlePreview(inv)}>
                  <Eye size={14} className="mr-1.5" />
                  View
                </Button>
                <Button variant="outline" size="sm" onClick={() => handleDownload(inv)}>
                  <Download size={14} className="mr-1.5" />
                  PDF
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <InvoicePreviewModal
        invoice={previewInvoice}
        platformConfig={platformConfig}
        open={showPreview}
        onOpenChange={setShowPreview}
      />
    </PageContainer>
  );
}
