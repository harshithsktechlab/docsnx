'use client';

import React, { useEffect, useState } from 'react';
import {
  PhoneCall,
  Plus,
  X,
  Search,
  Trash2,
  AlertCircle,
  User,
  Share2,
  Printer,
  Pencil,
  Mail,
  MapPin,
  FileText,
  Sparkles,
  Upload,
  Info,
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
import { Textarea } from '@/components/ui/textarea';
import RowActionsMenu from '@/components/ui/row-actions-menu';
import { toast } from 'sonner';
import { acceptedFileFrom } from '@/app/components/acceptFile';
import { UPLOAD_ACCEPT_ATTRIBUTE } from '@/lib/records/uploadTypes';
import PageContainer from '@/app/components/PageContainer';
import { useWorkspaceApi } from '@/lib/net/useWorkspaceApi';
import { postUpload } from '@/lib/records/uploadRequest';
import { toastApiError } from '@/lib/net/toastApiError';


export default function ImportantContactsPage() {
  // Every request this page makes is scoped to the workspace in the URL:
  // the household at `/todos`, one company at `/business/<id>/todos`. See
  // useWorkspaceApi — `api` is `apiCall` with that already bound.
  const { api } = useWorkspaceApi();
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [canShare, setCanShare] = useState(false);

  // Search & Filter
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRole, setSelectedRole] = useState('all');

  // Form State
  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // Edit State
  const [editingContact, setEditingContact] = useState(null);
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState('');
  const [editPhoneNumber, setEditPhoneNumber] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editAddress, setEditAddress] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  // AI scanning states
  const [file, setFile] = useState(null);
  const [editFile, setEditFile] = useState(null);
  const [aiScanning, setAiScanning] = useState(false);
  const [aiMessage, setAiMessage] = useState('');

  const fetchContacts = async () => {
    try {
      const { json } = await api('/api/important-contacts');
      if (json.success) {
        setContacts(json.emergencyContacts || []);
      } else {
        setError(json.error || 'Failed to fetch important contacts');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[important-contacts] handler threw', err);
      setError('Something went wrong fetching important contacts. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchContacts();
    async function checkPermissions() {
      try {
        const meData = await clientGetMe();
        if (meData.success) {
          const u = meData.user;
          if (u.role === 'SUPER_ADMIN' || u.role === 'TENANT_ADMIN') {
            setCanShare(true);
          } else {
            // 'emergency' is not a permission key — PERMISSION_MODULE_KEYS has
            // 'emergency_contacts' — so this always found nothing and canShare
            // was permanently false for every STANDARD user.
            const perm = u.permissions?.find(p => p.module === 'emergency_contacts' && !p.documentKey);
            setCanShare(!!perm?.canShare);
          }
        }
      } catch (err) {
        console.error('Error loading permissions:', err);
      }
    }
    checkPermissions();
  }, []);

  const handleFileChange = async (e) => {
    const chosen = await acceptedFileFrom(e);
    if (chosen) setFile(chosen);
  };

  const handleEditFileChange = async (e) => {
    const chosen = await acceptedFileFrom(e);
    if (chosen) setEditFile(chosen);
  };

  const handleAiScan = async () => {
    const selectedFile = editingContact ? editFile : file;
    if (!selectedFile) {
      toast.error('Please select or upload a document file first to use AI Auto-fill.');
      return;
    }

    setAiScanning(true);
    setAiMessage('Uploading & scanning document page contents with AI...');

    try {
      const formData = new FormData();
      formData.append('files', selectedFile);

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
        const data = proposed.extractedData;
        const title = proposed.title || '';

        // Safely extract proposed values
        const extName = data.name || title || '';
        const extRole = data.role || '';
        const extPhone = data.phoneNumber || '';
        const extEmail = data.email || '';
        const extAddress = data.address || '';
        const extNotes = data.notes || '';

        if (editingContact) {
          if (extName) setEditName(extName);
          if (extRole) setEditRole(extRole);
          if (extPhone) setEditPhoneNumber(extPhone);
          if (extEmail) setEditEmail(extEmail);
          if (extAddress) setEditAddress(extAddress);
          if (extNotes) setEditNotes(extNotes);
        } else {
          if (extName) setName(extName);
          if (extRole) setRole(extRole);
          if (extPhone) setPhoneNumber(extPhone);
          if (extEmail) setEmail(extEmail);
          if (extAddress) setAddress(extAddress);
          if (extNotes) setNotes(extNotes);
        }

        setAiMessage('AI Auto-fill successful! Form fields updated.');
        setTimeout(() => setAiMessage(''), 3000);
      } else {
        // Reached only when the scan genuinely came back with nothing to fill
        // in — every other cause returned above with its own sentence.
        toast.error(json.error
          || 'The scan did not find these fields on this document — fill them in below.');
        setAiMessage('');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[important-contacts] handler threw', err);
      toast.error('Something went wrong calling AI Scan endpoint. Please try again.');
      setAiMessage('');
    } finally {
      setAiScanning(false);
    }
  };

  // ─── Closing the Add form ─────────────────────────────────────────────────
  // Every way out goes through these two, so "closed" has ONE definition and it
  // always clears. Before, the fields were reset only inside the success branch
  // of handleSubmit, so dismissing a half-typed entry left it sitting in state
  // to reappear whole the next time the form was opened.
  const resetAddForm = () => {
    setName('');
    setRole('');
    setPhoneNumber('');
    setEmail('');
    setAddress('');
    setNotes('');
    setFile(null);
    setFormError('');
  };

  const closeAddForm = () => {
    resetAddForm();
    setShowAddForm(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !role.trim() || !phoneNumber.trim()) {
      setFormError('Name, Role, and Phone Number are required fields');
      return;
    }
    setFormError('');
    setSaving(true);

    try {
      const { json } = await api('/api/important-contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
        name: name.trim(),
        role: role.trim(),
        phoneNumber: phoneNumber.trim(),
        email: email.trim() || null,
        address: address.trim() || null,
        notes: notes.trim() || null
        })
      });
      if (json.success) {
        closeAddForm();
        fetchContacts();
      } else {
        setFormError(json.error || 'Failed to add contact');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[important-contacts] handler threw', err);
      setFormError('Something went wrong adding important contact. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const openEditModal = (c) => {
    setEditingContact(c);
    setEditName(c.name || '');
    setEditRole(c.role || '');
    setEditPhoneNumber(c.phoneNumber || '');
    setEditEmail(c.email || '');
    setEditAddress(c.address || '');
    setEditNotes(c.notes || '');
    setEditFile(null);
    setEditError('');
  };

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    if (!editingContact) return;
    if (!editName.trim() || !editRole.trim() || !editPhoneNumber.trim()) {
      setEditError('Name, Role, and Phone Number are required fields');
      return;
    }
    setEditSaving(true);
    setEditError('');

    try {
      const { json } = await api(`/api/important-contacts/${editingContact.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
        name: editName.trim(),
        role: editRole.trim(),
        phoneNumber: editPhoneNumber.trim(),
        email: editEmail.trim() || null,
        address: editAddress.trim() || null,
        notes: editNotes.trim() || null
        })
      });
      if (json.success) {
        setEditingContact(null);
        setEditFile(null);
        fetchContacts();
      } else {
        setEditError(json.error || 'Failed to update contact');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[important-contacts] handler threw', err);
      setEditError('Something went wrong updating contact. Please try again.');
    } finally {
      setEditSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this important contact?')) return;
    try {
      const { json } = await api(`/api/important-contacts/${id}`, { method: 'DELETE' });
      if (json.success) {
        fetchContacts();
      } else {
        toast.error(json.error || 'Failed to delete');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[important-contacts] handler threw', err);
      toast.error('Something went wrong deleting contact. Please try again.');
    }
  };

  const handleShare = async (c) => {
    const fields = [
      { label: 'Name', value: c.name },
      { label: 'Role/Type', value: c.role },
      { label: 'Phone', value: c.phoneNumber },
      { label: 'Email', value: c.email || 'N/A' },
      { label: 'Address', value: c.address || 'N/A' }
    ];
    const res = await shareRecord(`Important Contact - ${c.name}`, fields, c.notes);
    reportShareResult(res);
  };

  const handlePrint = (c) => {
    const fields = [
      { label: 'Name', value: c.name },
      { label: 'Role/Type', value: c.role },
      { label: 'Phone', value: c.phoneNumber },
      { label: 'Email', value: c.email || 'N/A' },
      { label: 'Address', value: c.address || 'N/A' }
    ];
    printRecord(`Important Contact`, fields, c.notes);
  };

  // Get unique roles from all contacts to build dynamic filters
  const uniqueRoles = ['all', ...new Set(contacts.map(c => c.role).filter(Boolean))];

  const filteredContacts = contacts.filter(c => {
    const matchesSearch = 
      c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.role.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (c.phoneNumber && c.phoneNumber.includes(searchTerm)) ||
      (c.notes && c.notes.toLowerCase().includes(searchTerm.toLowerCase()));
    
    const matchesRole = selectedRole === 'all' || c.role === selectedRole;
    return matchesSearch && matchesRole;
  });

  const getRoleBadgeColor = (roleName) => {
    const lower = roleName.toLowerCase();
    if (lower.includes('doctor') || lower.includes('hospital') || lower.includes('medical') || lower.includes('pediatrician')) {
      return 'text-rose-400 bg-rose-500/10 border-rose-500/20';
    }
    if (lower.includes('police') || lower.includes('security') || lower.includes('fire')) {
      return 'text-amber-400 bg-amber-500/10 border-amber-500/20';
    }
    if (lower.includes('insurance') || lower.includes('agent') || lower.includes('lawyer')) {
      return 'text-sky-400 bg-sky-500/10 border-sky-500/20';
    }
    if (lower.includes('plumber') || lower.includes('electrician') || lower.includes('handyman') || lower.includes('maintenance')) {
      return 'text-violet-400 bg-violet-500/10 border-violet-500/20';
    }
    return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
  };

  if (loading) {
    return (
      <PageContainer>
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-10 w-10 rounded-full" />
        </div>
        <Skeleton className="h-12 w-full rounded-xl" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-48 w-full rounded-2xl" />
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
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground">Important Contacts</h1>
          <p className="text-muted-foreground text-sm">Quick-dial directory for doctors, services, agents and advisors</p>
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

      {/* Error Alert */}
      

      {/* Add Contact Form */}
      {showAddForm && (
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass p-6 md:p-8 animate-scale-in">
          <CardHeader className="p-0 pb-4 border-b border-border/50 mb-6">
            <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
              <PhoneCall className="text-sky-400" size={20} />
              <span>Add New Contact</span>
            </h2>
          </CardHeader>

          

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="name">Contact Name *</Label>
                <Input
                  id="name"
                  placeholder="e.g. Dr. Kulkarni, Apollo Clinic"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={saving}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="role">Role / Relationship *</Label>
                <Input
                  id="role"
                  placeholder="e.g. Pediatrician, Insurance Agent, Plumber"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  disabled={saving}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="phoneNumber">Phone Number *</Label>
                <Input
                  id="phoneNumber"
                  placeholder="e.g. +91 98765 43210"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  disabled={saving}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email">Email Address</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="e.g. doctor@hospital.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={saving}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="address">Address</Label>
              <Input
                id="address"
                placeholder="e.g. Shop 4, Rosewood Residency, Mumbai"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                disabled={saving}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="notes">Special Instructions / Notes</Label>
              <Textarea
                id="notes"
                placeholder="e.g. Off on Wednesdays, available for house calls at short notice."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                disabled={saving}
                className="resize-none"
              />
            </div>

            {/* Document Upload with AI Auto-fill visual button */}
            <div className="flex flex-col gap-2.5 border-t border-border/30 pt-4 mt-2">
              <Label>Attach/Scan business card or document to auto-fill details</Label>
              <div className="flex flex-col sm:flex-row gap-3 items-center">
                <div className="border-2 border-dashed border-border/50 rounded-xl p-4 text-center bg-card hover:bg-card transition-colors relative cursor-pointer flex-1 w-full">
                  <input
                    type="file"
                    accept={UPLOAD_ACCEPT_ATTRIBUTE}
                    onChange={handleFileChange}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    disabled={saving || aiScanning}
                  />
                  <Upload size={18} className="mx-auto text-muted-foreground mb-1" />
                  <p className="text-xs font-semibold text-foreground truncate max-w-[280px] mx-auto">
                    {file ? file.name : 'Select file to scan'}
                  </p>
                </div>

                <Button 
                  type="button" 
                  variant="outline"
                  onClick={handleAiScan}
                  disabled={aiScanning || saving}
                  className="h-12 w-full sm:w-auto px-4 bg-sky-500/10 border-sky-500/30 text-sky-400 hover:bg-sky-500/20 hover:text-sky-300 font-bold flex gap-2 shrink-0 shadow-sm"
                >
                  <Sparkles size={15} className={aiScanning ? 'animate-spin' : ''} />
                  <span>{aiScanning ? 'Scanning...' : 'Auto-fill with AI'}</span>
                </Button>
              </div>
              {aiMessage && (
                <div className="flex items-center gap-1.5 text-xs text-info-text font-medium">
                  <Info size={13} />
                  <span>{aiMessage}</span>
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
                {saving ? 'Saving contact...' : 'Add Contact'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* Search & Filters */}
      <div className="flex flex-col gap-4 animate-fade-in">
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" size={18} />
          <Input
            placeholder="Search by name, role, phone, details..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 h-11 bg-card border-border/50"
          />
        </div>

        {uniqueRoles.length > 2 && (
          <div className="flex flex-wrap gap-2">
            {uniqueRoles.map((roleOpt) => (
              <Button
                key={roleOpt}
                variant={selectedRole === roleOpt ? "default" : "outline"}
                onClick={() => setSelectedRole(roleOpt)}
                className="h-9 px-4 text-xs font-semibold rounded-lg capitalize"
              >
                {roleOpt === 'all' ? 'All Roles' : roleOpt}
              </Button>
            ))}
          </div>
        )}
      </div>

      {/* Contacts List */}
      {filteredContacts.length === 0 ? (
        <Card className="border-border/30 bg-card backdrop-blur p-12 text-center animate-fade-in">
          <PhoneCall size={48} className="mx-auto text-faint mb-3" />
          <p className="text-muted-foreground text-sm font-medium">No important contacts found</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredContacts.map((c) => {
            const colorClass = getRoleBadgeColor(c.role);
            return (
              <Card 
                key={c.id}
                className="border-border/50 bg-card backdrop-blur shadow-glass hover:bg-card transition-colors p-5 flex flex-col justify-between gap-4 animate-fade-in"
              >
                <div className="flex flex-col gap-3">
                  <div className="flex justify-between items-start gap-2">
                    <div className="flex flex-col min-w-0">
                      <span className="font-bold text-foreground text-base truncate">{c.name}</span>
                      <Badge variant="outline" className={`w-fit mt-1.5 text-xs font-bold uppercase ${colorClass}`}>
                        {c.role}
                      </Badge>
                    </div>

                    <div className="relative flex items-center gap-1.5 shrink-0">
                      <Button 
                        onClick={() => handleShare(c)}
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-sky-400 hover:bg-sky-500/10 hover:text-sky-300 rounded-lg"
                        title="Share"
                      >
                        <Share2 size={14} />
                      </Button>
                      <Button 
                        onClick={() => handlePrint(c)}
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-pink-400 hover:bg-pink-500/10 hover:text-pink-300 rounded-lg"
                        title="Print"
                      >
                        <Printer size={14} />
                      </Button>

                      <RowActionsMenu
                        variant="ghost"
                        iconSize={14}
                        triggerClassName="h-8 w-8 rounded-lg text-muted-foreground hover:bg-muted/10"
                        items={[
                          {
                            key: 'download',
                            icon: <FileDown size={12} />,
                            label: 'Download',
                            onClick: () => {
                              downloadRecord(`Important Contact - ${c.name}`, [
                                { label: 'Name', value: c.name },
                                { label: 'Role/Relation', value: c.role },
                                { label: 'Phone Number', value: c.phoneNumber },
                                { label: 'Email', value: c.email },
                                { label: 'Address', value: c.address }
                              ], c.notes);
                            },
                          },
                          {
                            key: 'edit',
                            icon: <Pencil size={12} />,
                            label: 'Edit',
                            onClick: () => openEditModal(c),
                          },
                          {
                            key: 'delete',
                            icon: <Trash2 size={12} />,
                            label: 'Delete',
                            destructive: true,
                            onClick: () => handleDelete(c.id),
                          },
                        ]}
                      />
                    </div>
                  </div>

                  {/* Contact Info Details */}
                  <div className="flex flex-col gap-2 border-t border-border/30 pt-3.5 mt-1 text-xs">
                    <a 
                      href={`tel:${c.phoneNumber}`}
                      className="flex items-center gap-2 text-foreground font-bold hover:text-primary transition-colors py-1 group"
                    >
                      <PhoneCall size={14} className="text-emerald-400 group-hover:animate-bounce shrink-0" />
                      <span>{c.phoneNumber}</span>
                    </a>
                    
                    {c.email && (
                      <a 
                        href={`mailto:${c.email}`}
                        className="flex items-center gap-2 text-muted-foreground hover:text-primary transition-colors py-0.5"
                      >
                        <Mail size={14} className="text-sky-400 shrink-0" />
                        <span className="truncate">{c.email}</span>
                      </a>
                    )}
                    
                    {c.address && (
                      <div className="flex items-start gap-2 text-muted-foreground py-0.5">
                        <MapPin size={14} className="text-rose-400 shrink-0 mt-0.5" />
                        <span className="leading-snug">{c.address}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Notes */}
                {c.notes && (
                  <div className="bg-muted/40 border border-border/30 rounded-xl p-2.5 mt-1 text-xs text-muted-foreground leading-relaxed flex items-start gap-1.5">
                    <FileText size={12} className="text-violet-400 shrink-0 mt-0.5" />
                    <span className="italic whitespace-pre-wrap">{c.notes}</span>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Edit Contact Modal */}
      <Dialog open={!!editingContact} onOpenChange={(open) => !open && setEditingContact(null)}>
        {editingContact && (
          <DialogContent aria-describedby={undefined} className="max-w-2xl max-h-[90vh] flex flex-col py-6 overflow-y-auto border-border/50 bg-card/95 backdrop-blur-md">
            <DialogHeader className="p-0 pb-4 border-b border-border/30">
              <DialogTitle className="text-lg font-bold">Edit Important Contact</DialogTitle>
            </DialogHeader>

            

            <form onSubmit={handleEditSubmit} className="flex flex-col gap-5 mt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editName">Contact Name *</Label>
                  <Input
                    id="editName"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    disabled={editSaving}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editRole">Role / Relationship *</Label>
                  <Input
                    id="editRole"
                    value={editRole}
                    onChange={(e) => setEditRole(e.target.value)}
                    disabled={editSaving}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editPhoneNumber">Phone Number *</Label>
                  <Input
                    id="editPhoneNumber"
                    value={editPhoneNumber}
                    onChange={(e) => setEditPhoneNumber(e.target.value)}
                    disabled={editSaving}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editEmail">Email Address</Label>
                  <Input
                    id="editEmail"
                    type="email"
                    value={editEmail}
                    onChange={(e) => setEditEmail(e.target.value)}
                    disabled={editSaving}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="editAddress">Address</Label>
                <Input
                  id="editAddress"
                  value={editAddress}
                  onChange={(e) => setEditAddress(e.target.value)}
                  disabled={editSaving}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="editNotes">Special Instructions / Notes</Label>
                <Textarea
                  id="editNotes"
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  rows={3}
                  disabled={editSaving}
                  className="resize-none"
                />
              </div>

              <div className="flex flex-col gap-2.5 border-t border-border/30 pt-4 mt-2">
                <Label>Attach/Scan business card or document to auto-fill details</Label>
                <div className="flex flex-col sm:flex-row gap-3 items-center">
                  <div className="border-2 border-dashed border-border/50 rounded-xl p-4 text-center bg-card hover:bg-card transition-colors relative cursor-pointer flex-1 w-full">
                    <input
                      type="file"
                      accept={UPLOAD_ACCEPT_ATTRIBUTE}
                      onChange={handleEditFileChange}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      disabled={editSaving || aiScanning}
                    />
                    <Upload size={18} className="mx-auto text-muted-foreground mb-1" />
                    <p className="text-xs font-semibold text-foreground truncate max-w-[280px] mx-auto">
                      {editFile ? editFile.name : 'Select file to scan'}
                    </p>
                  </div>

                  <Button 
                    type="button" 
                    variant="outline"
                    onClick={handleAiScan}
                    disabled={aiScanning || editSaving}
                    className="h-12 w-full sm:w-auto px-4 bg-sky-500/10 border-sky-500/30 text-sky-400 hover:bg-sky-500/20 hover:text-sky-300 font-bold flex gap-2 shrink-0 shadow-sm"
                  >
                    <Sparkles size={15} className={aiScanning ? 'animate-spin' : ''} />
                    <span>{aiScanning ? 'Scanning...' : 'Auto-fill with AI'}</span>
                  </Button>
                </div>
                {aiMessage && (
                  <div className="flex items-center gap-1.5 text-xs text-info-text font-medium">
                    <Info size={13} />
                    <span>{aiMessage}</span>
                  </div>
                )}
              </div>

              <Button 
                type="submit" 
                disabled={editSaving}
                className="mt-2 w-full h-11"
              >
                {editSaving ? 'Updating contact...' : 'Save Changes'}
              </Button>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </PageContainer>
  );
}
