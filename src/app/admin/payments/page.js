'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import {
  Receipt, Download, Search, Loader2, IndianRupee, RefreshCw,
  Plus, Mail, Edit2, Trash2, ChevronUp, ChevronDown, ChevronsUpDown,
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, X, Filter
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import InvoicePreviewModal from '@/app/components/InvoicePreviewModal';
import { Eye } from 'lucide-react';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';


// ── Sort icon helper ────────────────────────────────────────────────────────
function SortIcon({ column, sortConfig }) {
  if (sortConfig.key !== column) return <ChevronsUpDown size={13} className="ml-1 opacity-40" />;
  return sortConfig.direction === 'asc'
    ? <ChevronUp size={13} className="ml-1 text-primary" />
    : <ChevronDown size={13} className="ml-1 text-primary" />;
}

// ── Sortable TH ─────────────────────────────────────────────────────────────
function SortableTh({ column, label, sortConfig, onSort, className = '' }) {
  return (
    <th
      className={`px-4 py-3 font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors ${className}`}
      onClick={() => onSort(column)}
    >
      <span className="inline-flex items-center">
        {label}
        <SortIcon column={column} sortConfig={sortConfig} />
      </span>
    </th>
  );
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const STATUS_OPTIONS = ['all', 'captured', 'created', 'failed', 'pending'];
const METHOD_OPTIONS = ['all', 'RAZORPAY', 'MANUAL'];

export default function AdminPaymentsPage() {
  // ── Data ─────────────────────────────────────────────────────────────────
  const [payments, setPayments] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [plans, setPlans] = useState([]);
  const [addons, setAddons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [platformConfig, setPlatformConfig] = useState(null);

  // ── Search & Filters ─────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterMethod, setFilterMethod] = useState('all');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');

  // ── Sort ─────────────────────────────────────────────────────────────────
  const [sortConfig, setSortConfig] = useState({ key: 'createdAt', direction: 'desc' });

  // ── Pagination ───────────────────────────────────────────────────────────
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // ── Modals ───────────────────────────────────────────────────────────────
  const [modalOpen, setModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [paymentType, setPaymentType] = useState('plan');
  const [formData, setFormData] = useState({ tenantId: '', planId: '', addonId: '', amount: '', paymentRef: '' });
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editData, setEditData] = useState({ id: '', amount: '', status: '', paymentRef: '' });

  const [previewInvoice, setPreviewInvoice] = useState(null);
  const [showPreview, setShowPreview] = useState(false);

  // ── Data fetching ─────────────────────────────────────────────────────────
  useEffect(() => {
    fetchPayments();
    fetchMetadata();
  }, []);

  const fetchPayments = async () => {
    setLoading(true);
    try {
      const { json: data } = await apiCall('/api/admin/payments');
      if (data.payments) {
        setPayments(data.payments);
      } else {
        toast.error('Failed to load payments.');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[admin/payments] handler threw', err);
      toast.error('Something went wrong loading payments. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const fetchMetadata = async () => {
    try {
      // `apiCall` resolves rather than rejecting, so one failing request no
      // longer discards the results of the others — `Promise.all` used to
      // throw the whole batch away and land in a catch that named none of them.
      const [{ json: tenantsData }, { json: plansData }, { json: addonsData }, { json: settingsData }] = await Promise.all([
        apiCall('/api/admin/tenants'),
        apiCall('/api/admin/plans', { cache: 'no-store' }),
        apiCall('/api/admin/addons'),
        apiCall('/api/admin/settings'),
      ]);
      if (tenantsData.tenants) setTenants(tenantsData.tenants);
      if (plansData.plans) setPlans(plansData.plans);
      if (addonsData.addons) setAddons(addonsData.addons);
      if (settingsData.config) setPlatformConfig(settingsData.config);
    } catch (err) {
      console.error('Failed to load metadata', err);
    }
  };

  // ── Sort handler ──────────────────────────────────────────────────────────
  const handleSort = (key) => {
    setSortConfig(prev =>
      prev.key === key
        ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' }
    );
    setPage(1);
  };

  // ── Reset filters ─────────────────────────────────────────────────────────
  const hasActiveFilters = search || filterStatus !== 'all' || filterMethod !== 'all' || filterDateFrom || filterDateTo;
  const resetFilters = () => {
    setSearch('');
    setFilterStatus('all');
    setFilterMethod('all');
    setFilterDateFrom('');
    setFilterDateTo('');
    setPage(1);
  };

  // ── Derived: filtered → sorted → paginated ────────────────────────────────
  const processedPayments = useMemo(() => {
    let result = [...payments];

    // 1. Search
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(p =>
        p.tenantName?.toLowerCase().includes(q) ||
        p.razorpayOrderId?.toLowerCase().includes(q) ||
        p.paymentRef?.toLowerCase().includes(q) ||
        p.planName?.toLowerCase().includes(q) ||
        p.addonName?.toLowerCase().includes(q)
      );
    }

    // 2. Filter: status
    if (filterStatus !== 'all') {
      result = result.filter(p => p.status?.toLowerCase() === filterStatus.toLowerCase());
    }

    // 3. Filter: method
    if (filterMethod !== 'all') {
      result = result.filter(p => (p.paymentMethod || 'RAZORPAY') === filterMethod);
    }

    // 4. Filter: date range
    if (filterDateFrom) {
      const from = new Date(filterDateFrom);
      result = result.filter(p => new Date(p.createdAt) >= from);
    }
    if (filterDateTo) {
      const to = new Date(filterDateTo);
      to.setHours(23, 59, 59, 999);
      result = result.filter(p => new Date(p.createdAt) <= to);
    }

    // 5. Sort
    result.sort((a, b) => {
      let aVal = a[sortConfig.key];
      let bVal = b[sortConfig.key];

      if (sortConfig.key === 'createdAt') {
        aVal = new Date(aVal).getTime();
        bVal = new Date(bVal).getTime();
      } else if (sortConfig.key === 'amount') {
        aVal = Number(aVal);
        bVal = Number(bVal);
      } else {
        aVal = (aVal || '').toString().toLowerCase();
        bVal = (bVal || '').toString().toLowerCase();
      }

      if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }, [payments, search, filterStatus, filterMethod, filterDateFrom, filterDateTo, sortConfig]);

  // ── Pagination ─────────────────────────────────────────────────────────────
  const totalCount = processedPayments.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(page, totalPages);
  const startIdx = (safePage - 1) * pageSize;
  const endIdx = Math.min(startIdx + pageSize, totalCount);
  const pagePayments = processedPayments.slice(startIdx, endIdx);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search, filterStatus, filterMethod, filterDateFrom, filterDateTo, pageSize]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const handleManualPayment = async () => {
    if (!formData.tenantId || !formData.amount) {
      toast.error('Tenant and Amount are required.');
      return;
    }
    setIsSubmitting(true);
    try {
      const { json: data } = await apiCall('/api/admin/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (data.success) {
        toast.success('Manual payment recorded successfully.');
        setModalOpen(false);
        setFormData({ tenantId: '', planId: '', addonId: '', amount: '', paymentRef: '' });
        fetchPayments();
      } else {
        toast.error(data.error || 'Failed to record payment.');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[admin/payments] handler threw', err);
      toast.error('Something went wrong while recording payment. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const openEditModal = (payment) => {
    setEditData({ id: payment.id, amount: payment.amount, status: payment.status, paymentRef: payment.paymentRef || '' });
    setEditModalOpen(true);
  };

  const handleEditSubmit = async () => {
    setIsSubmitting(true);
    try {
      const { json: data } = await apiCall(`/api/admin/payments/${editData.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: editData.amount, status: editData.status, paymentRef: editData.paymentRef }),
      });
      if (data.success) {
        toast.success('Payment updated successfully');
        setEditModalOpen(false);
        fetchPayments();
      } else {
        toast.error(data.error || 'Failed to update payment');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[admin/payments] handler threw', err);
      toast.error('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (payment) => {
    if (!confirm(`Are you sure you want to delete this payment of INR ${payment.amount}?`)) return;
    try {
      const { json: data } = await apiCall(`/api/admin/payments/${payment.id}`, { method: 'DELETE' });
      if (data.success) {
        toast.success('Payment deleted successfully');
        fetchPayments();
      } else {
        toast.error(data.error || 'Failed to delete payment');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[admin/payments] handler threw', err);
      toast.error('Something went wrong. Please try again.');
    }
  };

  const handlePreview = (p) => {
    const tenant = tenants.find(t => t.name === p.tenantName) || {};
    
    // Construct an invoice-like object
    const invoice = {
      invoiceNumber: p.razorpayOrderId || p.id,
      issuedDate: p.createdAt,
      dueDate: p.createdAt, // For payments, due date can just be issue date
      status: p.status,
      clientName: p.tenantName || 'Unknown',
      clientAddress: tenant.billingAddress || '',
      clientGstin: tenant.billingGst || '',
      amount: p.amount,
      currency: p.currency || 'INR',
      gstType: 'IGST', // Default or grab from config if possible
      notes: p.planName || p.addonName || 'Subscription / Services',
    };
    
    setPreviewInvoice(invoice);
    setShowPreview(true);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <PageContainer className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Receipt className="text-primary" size={32} />
            Payments
          </h1>
          <p className="text-muted-foreground mt-1">
            View all platform transactions and download automated invoices.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={fetchPayments} disabled={loading}>
            <RefreshCw size={16} className={'mr-2 ' + (loading ? 'animate-spin' : '')} />
            Refresh
          </Button>
          <Button onClick={() => setModalOpen(true)}>
            <Plus size={16} className="mr-2" /> Record Manual Payment
          </Button>
        </div>
      </div>

      {/* Main Card */}
      <Card className="border-border/40 shadow-sm">
        <CardHeader className="pb-3 space-y-4">
          {/* Row 1: Title + Search */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <CardTitle className="text-xl">Transaction History</CardTitle>
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search tenant, order ID, ref..."
                className="pl-9 h-9"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              {search && (
                <button
                  className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
                  onClick={() => setSearch('')}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          {/* Row 2: Filter Bar */}
          <div className="flex flex-wrap items-center gap-2">
            <Filter size={14} className="text-muted-foreground shrink-0" />

            {/* Status */}
            <Select value={filterStatus} onValueChange={v => setFilterStatus(v)}>
              <SelectTrigger className="h-8 w-[130px] text-xs">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                {STATUS_OPTIONS.filter(s => s !== 'all').map(s => (
                  <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Method */}
            <Select value={filterMethod} onValueChange={v => setFilterMethod(v)}>
              <SelectTrigger className="h-8 w-[130px] text-xs">
                <SelectValue placeholder="Method" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Methods</SelectItem>
                <SelectItem value="RAZORPAY">Razorpay</SelectItem>
                <SelectItem value="MANUAL">Manual</SelectItem>
              </SelectContent>
            </Select>

            {/* Date From */}
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">From</span>
              <Input
                type="date"
                className="h-8 w-[140px] text-xs"
                value={filterDateFrom}
                onChange={e => setFilterDateFrom(e.target.value)}
              />
            </div>

            {/* Date To */}
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">To</span>
              <Input
                type="date"
                className="h-8 w-[140px] text-xs"
                value={filterDateTo}
                onChange={e => setFilterDateTo(e.target.value)}
              />
            </div>

            {/* Clear */}
            {hasActiveFilters && (
              <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground" onClick={resetFilters}>
                <X size={12} className="mr-1" /> Clear filters
              </Button>
            )}

            {/* Results count */}
            <span className="ml-auto text-xs text-muted-foreground">
              {loading ? '' : `${totalCount} result${totalCount !== 1 ? 's' : ''}`}
            </span>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          <div className="rounded-b-md overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-muted/50 border-y">
                <tr>
                  <SortableTh column="createdAt" label="Date" sortConfig={sortConfig} onSort={handleSort} className="px-4 py-3" />
                  <SortableTh column="tenantName" label="Tenant" sortConfig={sortConfig} onSort={handleSort} className="px-4 py-3" />
                  <th className="px-4 py-3 font-medium text-muted-foreground">Item</th>
                  <SortableTh column="amount" label="Amount" sortConfig={sortConfig} onSort={handleSort} className="px-4 py-3" />
                  <SortableTh column="status" label="Status" sortConfig={sortConfig} onSort={handleSort} className="px-4 py-3" />
                  <th className="px-4 py-3 font-medium text-muted-foreground">Method</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground text-right">Invoice</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                      <Loader2 className="animate-spin mx-auto h-6 w-6" />
                    </td>
                  </tr>
                ) : pagePayments.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                      <div className="flex flex-col items-center gap-2">
                        <Search size={24} className="opacity-30" />
                        <span>No payments found{hasActiveFilters ? ' matching your filters' : ''}.</span>
                        {hasActiveFilters && (
                          <Button variant="ghost" size="sm" onClick={resetFilters}>Clear filters</Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : (
                  pagePayments.map(p => {
                    const method = p.paymentMethod || 'RAZORPAY';
                    const itemDesc = p.planName || p.addonName || 'Manual Entry';

                    return (
                      <tr key={p.id} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-3 whitespace-nowrap text-muted-foreground text-xs">
                          {new Date(p.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3 font-medium max-w-[180px] truncate" title={p.tenantName}>
                          {p.tenantName || 'Unknown'}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{itemDesc}</td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center font-semibold">
                            <IndianRupee size={12} className="mr-0.5" />
                            {Number(p.amount).toFixed(2)}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant={p.status === 'captured' ? 'success' : p.status === 'failed' ? 'destructive' : 'secondary'}
                            className="capitalize"
                          >
                            {p.status}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant="outline"
                            className={method === 'MANUAL' ? 'bg-purple-500/10 text-purple-500 border-purple-500/20' : ''}
                          >
                            {method}
                          </Badge>
                          {p.paymentRef && (
                            <div className="text-xs text-muted-foreground mt-1 max-w-[120px] truncate" title={p.paymentRef}>
                              Ref: {p.paymentRef}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            {method === 'MANUAL' && (
                              <>
                                <Button
                                  variant="ghost" size="sm"
                                  className="h-8 w-8 p-0 text-blue-500 hover:text-blue-600 hover:bg-blue-500/10"
                                  title="Edit Payment"
                                  onClick={() => openEditModal(p)}
                                >
                                  <Edit2 size={14} />
                                </Button>
                                <Button
                                  variant="ghost" size="sm"
                                  className="h-8 w-8 p-0 text-danger-action hover:text-danger-action hover:bg-destructive/10"
                                  title="Delete Payment"
                                  onClick={() => handleDelete(p)}
                                >
                                  <Trash2 size={14} />
                                </Button>
                              </>
                            )}
                            <Button
                              variant="ghost" size="sm"
                              className="h-8 w-8 p-0 text-gray-500 hover:text-gray-600 hover:bg-gray-500/10"
                              title="Preview Invoice"
                              onClick={() => handlePreview(p)}
                            >
                              <Eye size={14} />
                            </Button>
                            <a href={`/api/admin/payments/${p.id}/invoice`} target="_blank" rel="noopener noreferrer">
                              <Button
                                variant="ghost" size="sm"
                                className="h-8 w-8 p-0 text-blue-500 hover:text-blue-600 hover:bg-blue-500/10"
                                title="Download PDF"
                              >
                                <Download size={14} />
                              </Button>
                            </a>
                            <Button
                              variant="ghost" size="sm"
                              className="h-8 w-8 p-0 text-emerald-500 hover:text-emerald-600 hover:bg-emerald-500/10"
                              title="Email Invoice"
                              onClick={async (e) => {
                                const btn = e.currentTarget;
                                btn.disabled = true;
                                try {
                                  const { json: data } = await apiCall(`/api/admin/payments/${p.id}/invoice`, { method: 'POST', timeoutMs: 120_000 });
                                  if (data.success) toast.success('Invoice emailed successfully');
                                  else toast.error(data.error || 'Failed to send email');
                                } catch (err) {
                                  console.error('[admin/payments] invoice email threw', err);
                                  toast.error('Something went wrong sending the invoice.');
                                } finally {
                                  btn.disabled = false;
                                }
                              }}
                            >
                              <Mail size={14} />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Footer */}
          {!loading && totalCount > 0 && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 border-t bg-muted/20">
              {/* Showing X–Y of Z */}
              <p className="text-xs text-muted-foreground">
                Showing <span className="font-medium text-foreground">{startIdx + 1}–{endIdx}</span> of{' '}
                <span className="font-medium text-foreground">{totalCount}</span> payments
              </p>

              <div className="flex items-center gap-3">
                {/* Page size */}
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">Rows</span>
                  <Select value={String(pageSize)} onValueChange={v => setPageSize(Number(v))}>
                    <SelectTrigger className="h-7 w-[65px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAGE_SIZE_OPTIONS.map(s => (
                        <SelectItem key={s} value={String(s)}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Page nav */}
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline" size="icon" className="h-7 w-7"
                    onClick={() => setPage(1)} disabled={safePage === 1}
                    title="First page"
                  >
                    <ChevronsLeft size={14} />
                  </Button>
                  <Button
                    variant="outline" size="icon" className="h-7 w-7"
                    onClick={() => setPage(p => Math.max(1, p - 1))} disabled={safePage === 1}
                    title="Previous page"
                  >
                    <ChevronLeft size={14} />
                  </Button>

                  <span className="text-xs text-muted-foreground px-2 whitespace-nowrap">
                    Page <span className="font-medium text-foreground">{safePage}</span> of{' '}
                    <span className="font-medium text-foreground">{totalPages}</span>
                  </span>

                  <Button
                    variant="outline" size="icon" className="h-7 w-7"
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={safePage === totalPages}
                    title="Next page"
                  >
                    <ChevronRight size={14} />
                  </Button>
                  <Button
                    variant="outline" size="icon" className="h-7 w-7"
                    onClick={() => setPage(totalPages)} disabled={safePage === totalPages}
                    title="Last page"
                  >
                    <ChevronsRight size={14} />
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Record Manual Payment Modal */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record Manual Payment</DialogTitle>
            <DialogDescription>
              Manually record a payment made outside the platform (e.g. wire transfer, cash, cheque).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Tenant *</Label>
              <Select value={formData.tenantId || undefined} onValueChange={v => setFormData({ ...formData, tenantId: v })}>
                <SelectTrigger><SelectValue placeholder="Select a tenant" /></SelectTrigger>
                <SelectContent>
                  {tenants.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Payment Against</Label>
              <Select value={paymentType} onValueChange={v => {
                setPaymentType(v);
                if (v === 'plan') setFormData({ ...formData, addonId: '' });
                if (v === 'addon') setFormData({ ...formData, planId: '' });
                if (v === 'none') setFormData({ ...formData, planId: '', addonId: '' });
              }}>
                <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None / Custom</SelectItem>
                  <SelectItem value="plan">Subscription Plan</SelectItem>
                  <SelectItem value="addon">Add-on</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {paymentType === 'plan' && (
              <div className="space-y-2">
                <Label>Associated Plan</Label>
                <Select value={formData.planId || undefined} onValueChange={v => setFormData({ ...formData, planId: v })}>
                  <SelectTrigger><SelectValue placeholder="Select a plan" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {plans.map(p => <SelectItem key={p.id} value={p.id}>{p.name} - ₹{p.price}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}

            {paymentType === 'addon' && (
              <div className="space-y-2">
                <Label>Associated Add-on</Label>
                <Select value={formData.addonId || undefined} onValueChange={v => setFormData({ ...formData, addonId: v })}>
                  <SelectTrigger><SelectValue placeholder="Select an add-on" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {addons.map(a => <SelectItem key={a.id} value={a.id}>{a.name} - ₹{a.price}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <Label>Amount Received (INR) *</Label>
              <Input
                type="number" placeholder="0.00"
                value={formData.amount}
                onChange={e => setFormData({ ...formData, amount: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label>Payment Reference</Label>
              <Input
                placeholder="Cheque #, NEFT Ref, or notes..."
                value={formData.paymentRef}
                onChange={e => setFormData({ ...formData, paymentRef: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button onClick={handleManualPayment} disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Record Payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Manual Payment Modal */}
      <Dialog open={editModalOpen} onOpenChange={setEditModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Manual Payment</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Amount (INR) *</Label>
              <Input
                type="number"
                value={editData.amount}
                onChange={e => setEditData({ ...editData, amount: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={editData.status} onValueChange={v => setEditData({ ...editData, status: v })}>
                <SelectTrigger><SelectValue placeholder="Select status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="captured">Captured</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Payment Reference</Label>
              <Input
                value={editData.paymentRef}
                onChange={e => setEditData({ ...editData, paymentRef: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditModalOpen(false)}>Cancel</Button>
            <Button onClick={handleEditSubmit} disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <InvoicePreviewModal
        invoice={previewInvoice}
        platformConfig={platformConfig}
        open={showPreview}
        onOpenChange={setShowPreview}
      />
    </PageContainer>
  );
}
