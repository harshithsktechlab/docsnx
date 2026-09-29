'use client';

import React, { useEffect, useState } from 'react';
import {
  KeyRound,
  Plus,
  X,
  Search,
  Copy,
  Check,
  Eye,
  EyeOff,
  Trash2,
  ExternalLink,
  AlertCircle,
  FolderLock,
  Share2,
  Printer,
  Pencil,
  Download,
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
import HolderSelect, { ALL_MEMBERS, holderValue, holderPayload } from '@/app/components/HolderSelect';
import PageContainer from '@/app/components/PageContainer';
import { useWorkspaceApi } from '@/lib/net/useWorkspaceApi';


export default function PasswordsPage() {
  // Every request this page makes is scoped to the workspace in the URL:
  // the household at `/todos`, one company at `/business/<id>/todos`. See
  // useWorkspaceApi — `api` is `apiCall` with that already bound.
  const { api } = useWorkspaceApi();
  const [credentials, setCredentials] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [canShare, setCanShare] = useState(false);

  // Search & Filter
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');

  // Form State
  const [showAddForm, setShowAddForm] = useState(false);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('bank');
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [notes, setNotes] = useState('');
  const [holderId, setHolderId] = useState(ALL_MEMBERS);
  const [customFields, setCustomFields] = useState([]);
  
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // Edit Form State
  const [editingCred, setEditingCred] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [editCategory, setEditCategory] = useState('bank');
  const [editUrl, setEditUrl] = useState('');
  const [editUsername, setEditUsername] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editHolderId, setEditHolderId] = useState(ALL_MEMBERS);
  const [editCustomFields, setEditCustomFields] = useState([]);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const openEditModal = async (cred) => {
    setEditingCred(cred);
    setEditTitle(cred.title || '');
    setEditCategory(cred.category || 'bank');
    setEditUrl(cred.url || '');
    setEditUsername(cred.username || '');
    setEditNotes(cred.notes || '');
    setEditHolderId(holderValue(cred.holderId));
    setEditCustomFields(Array.isArray(cred.customFields) ? [...cred.customFields] : []);
    setEditError('');
    // The list never carries the secret, so `cred.password` is undefined here.
    // Unlock it before the field renders, or the form opens with an empty
    // Password box and refuses to save.
    const detail = await revealCredential(cred.id);
    setEditPassword(detail?.password || '');
  };

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    if (!editingCred) return;
    if (!editTitle || !editUsername || !editPassword) {
      setEditError('Title, Username, and Password are required');
      return;
    }
    setEditSaving(true);
    setEditError('');

    try {
      const { json } = await api(`/api/passwords/${editingCred.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
        title: editTitle,
        category: editCategory,
        url: editUrl,
        username: editUsername,
        password: editPassword,
        notes: editNotes,
        holderId: holderPayload(editHolderId),
        customFields: editCustomFields
        })
      });
      if (json.success) {
        setEditingCred(null);
        fetchCredentials();
      } else {
        setEditError(json.error || 'Update failed');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[passwords] handler threw', err);
      setEditError('Something went wrong updating credential. Please try again.');
    } finally {
      setEditSaving(false);
    }
  };

  // UI States
  const [visiblePasswords, setVisiblePasswords] = useState({}); // mapping ID to bool
  const [copiedId, setCopiedId] = useState(null); // tracking copy to clipboard animations
  /**
   * Secrets unlocked in THIS page view, keyed by credential id.
   *
   * The list endpoint strips the password on purpose — it lives in the tenant's
   * Drive store, not in the row — so nothing on a card can show, copy, share or
   * print it until it has been fetched one record at a time from
   * `GET /api/passwords/:id`, which is also what writes the reveal audit entry.
   * Cleared on every refetch so a stale secret never survives an edit.
   */
  const [revealed, setRevealed] = useState({});
  const [revealingId, setRevealingId] = useState(null);
  /**
   * The credential open in the read-only View dialog.
   *
   * Holds the LIST row, not a secret — the dialog reveals through
   * `revealCredential` like everything else, so it shares the `revealed` cache
   * with the card and cannot become a second, unaudited way to read a password.
   */
  const [viewingCred, setViewingCred] = useState(null);

  const revealCredential = async (id) => {
    if (revealed[id]) return revealed[id];
    setRevealingId(id);
    try {
      const { json } = await api(`/api/passwords/${id}`);
      if (!json.success) {
        toast.error(json.error || 'Could not unlock this credential');
        return null;
      }
      setRevealed(prev => ({ ...prev, [id]: json.password }));
      return json.password;
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[passwords] handler threw', err);
      toast.error('Something went wrong unlocking credential. Please try again.');
      return null;
    } finally {
      setRevealingId(null);
    }
  };

  const fetchCredentials = async () => {
    try {
      const { json } = await api('/api/passwords');
      if (json.success) {
        setCredentials(json.passwords);
        setRevealed({});
        setVisiblePasswords({});
      } else {
        setError(json.error || 'Failed to fetch credentials');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[passwords] handler threw', err);
      setError('Something went wrong fetching credentials. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCredentials();
    async function checkSharePermission() {
      try {
        const meData = await clientGetMe();
        if (meData.success) {
          const u = meData.user;
          if (u.role === 'SUPER_ADMIN' || u.role === 'TENANT_ADMIN') {
            setCanShare(true);
          } else {
            const perm = u.permissions?.find(p => p.module === 'passwords' && !p.documentKey);
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

  // ─── Closing the Add form ─────────────────────────────────────────────────
  // Every way out goes through these two, so "closed" has ONE definition and it
  // always clears. Before, the fields were reset only inside the success branch
  // of handleSubmit, so dismissing a half-typed entry left it sitting in state
  // to reappear whole the next time the form was opened.
  const resetAddForm = () => {
    setTitle('');
    setCategory('bank');
    setUrl('');
    setUsername('');
    setPassword('');
    setNotes('');
    setHolderId(ALL_MEMBERS);
    setCustomFields([]);
    setFormError('');
  };

  const closeAddForm = () => {
    resetAddForm();
    setShowAddForm(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title || !username || !password) {
      setFormError('Please fill in required fields (Title, Username, and Password)');
      return;
    }
    setFormError('');
    setSaving(true);

    try {
      const { json } = await api('/api/passwords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
        title, category, url, username, password, notes, customFields,
        holderId: holderPayload(holderId),
        }),
      });
      if (json.success) {
        closeAddForm();
        // Refresh list
        fetchCredentials();
      } else {
        setFormError(json.error || 'Save failed');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[passwords] handler threw', err);
      setFormError('Something went wrong saving password. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure you want to delete this credential?')) return;
    try {
      const { json } = await api(`/api/passwords/${id}`, { method: 'DELETE' });
      if (json.success) {
        fetchCredentials();
      } else {
        toast.error(json.error || 'Failed to delete');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[passwords] handler threw', err);
      toast.error('Something went wrong deleting credential. Please try again.');
    }
  };

  const togglePasswordVisibility = async (id) => {
    if (visiblePasswords[id]) {
      setVisiblePasswords(prev => ({ ...prev, [id]: false }));
      return;
    }
    // Flipping the icon is not enough: the secret is not on the card yet.
    const detail = await revealCredential(id);
    if (!detail) return;
    setVisiblePasswords(prev => ({ ...prev, [id]: true }));
  };

  const copyToClipboard = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => {
      setCopiedId(null);
    }, 2000);
  };

  const copySecret = async (cred) => {
    const detail = await revealCredential(cred.id);
    if (!detail?.password) return;
    copyToClipboard(detail.password, cred.id);
  };

  /**
   * The exported shape of one credential.
   *
   * Every export route — share, print, download — went out with
   * `Password: undefined` before, because the list payload has no secret in it.
   * They all build their field list here now, off the unlocked record.
   */
  const exportFields = (cred, secret) => {
    const fields = [
      { label: 'Title', value: cred.title },
      { label: 'Category', value: cred.category.toUpperCase() },
      { label: 'Belongs to', value: cred.holder?.name || 'All members' },
      { label: 'URL', value: cred.url },
      { label: 'Username', value: cred.username },
      { label: 'Password', value: secret }
    ];
    if (Array.isArray(cred.customFields)) {
      cred.customFields.forEach(f => {
        fields.push({ label: f.label, value: f.value });
      });
    }
    return fields;
  };

  const handleShare = async (cred) => {
    const detail = await revealCredential(cred.id);
    if (!detail) return;
    const res = await shareRecord(
      `Credentials - ${cred.title}`,
      exportFields(cred, detail.password),
      detail.notes ?? cred.notes,
    );
    reportShareResult(res);
  };

  const handlePrint = async (cred) => {
    const detail = await revealCredential(cred.id);
    if (!detail) return;
    printRecord(
      `Credentials - ${cred.title}`,
      exportFields(cred, detail.password),
      detail.notes ?? cred.notes,
    );
  };

  const handleDownload = async (cred) => {
    const detail = await revealCredential(cred.id);
    if (!detail) return;
    downloadRecord(
      `Credentials - ${cred.title}`,
      exportFields(cred, detail.password),
      detail.notes ?? cred.notes,
    );
  };

  const filteredCredentials = credentials.filter(cred => {
    const matchesSearch = 
      cred.title.toLowerCase().includes(searchTerm.toLowerCase()) || 
      cred.username.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (cred.notes && cred.notes.toLowerCase().includes(searchTerm.toLowerCase()));
    
    const matchesCategory = selectedCategory === 'all' || cred.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const categories = [
    { value: 'all', label: 'All' },
    { value: 'bank', label: 'Banks / Finance' },
    { value: 'social', label: 'Social Media' },
    { value: 'business', label: 'Business' },
    { value: 'personal', label: 'Personal' },
    { value: 'other', label: 'Other' },
  ];

  const getCategoryColorClasses = (category) => {
    switch (category) {
      case 'bank': return 'text-amber-400 bg-amber-500/10 border-amber-500/20';
      case 'social': return 'text-sky-400 bg-sky-500/10 border-sky-500/20';
      case 'business': return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
      case 'personal': return 'text-violet-400 bg-violet-500/10 border-violet-500/20';
      default: return 'text-rose-400 bg-rose-500/10 border-rose-500/20';
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
        <div className="flex gap-2">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-9 w-24 rounded-lg" />
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[...Array(6)].map((_, i) => (
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
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground">Secrets Vault</h1>
          <p className="text-muted-foreground text-sm">Securely store passwords and login credentials</p>
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

      {/* Add Credential Form */}
      {showAddForm && (
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass p-6 md:p-8 animate-scale-in">
          <CardHeader className="p-0 pb-4 border-b border-border/50 mb-6">
            <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
              <KeyRound className="text-sky-400" size={20} />
              <span>Add Secure Entry</span>
            </h2>
          </CardHeader>

          

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="title">Title *</Label>
                <Input
                  id="title"
                  placeholder="e.g. Google Main Account"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={saving}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="category">Category *</Label>
                <Select value={category} onValueChange={(val) => setCategory(val)} disabled={saving}>
                  <SelectTrigger id="category">
                    <SelectValue placeholder="Select Category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bank">Bank / Finance</SelectItem>
                    <SelectItem value="social">Social Media</SelectItem>
                    <SelectItem value="business">Business</SelectItem>
                    <SelectItem value="personal">Personal</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="url">Website URL</Label>
                <Input
                  id="url"
                  type="url"
                  placeholder="https://accounts.google.com"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={saving}
                />
              </div>

              <HolderSelect value={holderId} onChange={setHolderId} disabled={saving} />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="username">Username / Login ID *</Label>
                <Input
                  id="username"
                  placeholder="admin@gmail.com"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={saving}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="password">Password *</Label>
                <Input
                  id="password"
                  type="text"
                  placeholder="SecretPassword123"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={saving}
                  className="font-mono"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="notes">Secure Notes / Recovery Codes</Label>
              <Textarea
                id="notes"
                placeholder="Recovery codes: 1234, 5678. Answer to security question: Pune."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                disabled={saving}
                className="resize-none"
              />
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
                        placeholder="Label (e.g. Pin Number)"
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
                {saving ? 'Encrypting & Saving...' : 'Save Encrypted Secret'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* Search Toolbar */}
      <div className="flex flex-col gap-4 animate-fade-in">
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" size={18} />
          <Input
            placeholder="Search logins, titles..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 h-11 bg-card border-border/50"
          />
        </div>

        {/* Categories Tab */}
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
      ) : filteredCredentials.length === 0 ? (
        <Card className="border-border/30 bg-card backdrop-blur p-12 text-center animate-fade-in">
          <FolderLock size={48} className="mx-auto text-faint mb-3" />
          <p className="text-muted-foreground text-sm font-medium">No credentials saved in vault</p>
        </Card>
      ) : (
        /* Secrets Grid */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredCredentials.map((cred, index) => {
            const isVisible = !!visiblePasswords[cred.id];
            const secret = revealed[cred.id]?.password;
            const isUnlocking = revealingId === cred.id;
            const isCopied = copiedId === cred.id;
            const colorClass = getCategoryColorClasses(cred.category);
            return (
              <Card 
                key={cred.id}
                className="border-border/50 bg-card backdrop-blur shadow-glass hover:bg-card transition-colors p-5 flex flex-col gap-4 animate-fade-in"
              >
                {/* Title line */}
                <div className="flex justify-between items-start gap-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`p-2 rounded-xl border shrink-0 ${colorClass}`}>
                      <KeyRound size={18} />
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="font-bold text-foreground text-sm truncate">{cred.title}</span>
                      <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground mt-0.5">
                        {cred.category}
                      </span>
                      <span className="text-xs text-muted-foreground truncate mt-0.5">
                        {cred.holder?.name || 'All members'}
                      </span>
                    </div>
                  </div>

                  <div className="relative flex items-center gap-1.5 shrink-0">
                    <Button 
                      onClick={() => handleShare(cred)}
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-sky-400 hover:bg-sky-500/10 hover:text-sky-300 rounded-lg"
                      title="Share"
                    >
                      <Share2 size={14} />
                    </Button>
                    {/* View lives in the menu rather than as a second eye in
                        the header, because the two mean different things here:
                        the eye on the password line below reveals ONE field,
                        View shows the whole record — notes and custom fields
                        included, which the card truncates or hides. */}
                    <RowActionsMenu
                      variant="ghost"
                      iconSize={14}
                      triggerClassName="h-8 w-8 rounded-lg text-muted-foreground hover:bg-muted/10"
                      items={[
                        {
                          key: 'view',
                          icon: <Eye size={12} />,
                          label: 'View',
                          onClick: () => setViewingCred(cred),
                        },
                        {
                          key: 'print',
                          icon: <Printer size={12} />,
                          label: 'Print',
                          onClick: () => handlePrint(cred),
                        },
                        cred.url && {
                          key: 'openurl',
                          icon: <ExternalLink size={12} />,
                          label: 'Open URL',
                          onClick: () => window.open(cred.url, '_blank', 'noreferrer'),
                        },
                        {
                          key: 'download',
                          icon: <Download size={12} />,
                          label: 'Download',
                          onClick: () => handleDownload(cred),
                        },
                        {
                          key: 'edit',
                          icon: <Pencil size={12} />,
                          label: 'Edit',
                          onClick: () => openEditModal(cred),
                        },
                        {
                          key: 'delete',
                          icon: <Trash2 size={12} />,
                          label: 'Delete',
                          destructive: true,
                          onClick: () => handleDelete(cred.id),
                        },
                      ]}
                    />
                  </div>
                </div>

                {/* Username and password display card */}
                <div className="bg-muted/40 border border-border/30 rounded-xl p-3 flex flex-col gap-2.5">
                  <div className="flex justify-between items-center gap-2">
                    <div className="min-w-0">
                      <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground block mb-0.5">Username</span>
                      <span className="font-mono text-sm font-semibold truncate text-foreground block">{cred.username}</span>
                    </div>
                    <Button 
                      onClick={() => copyToClipboard(cred.username, `${cred.id}_usr`)}
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:bg-background shrink-0 rounded-md"
                    >
                      {copiedId === `${cred.id}_usr` ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                    </Button>
                  </div>

                  <div className="flex justify-between items-center gap-2 border-t border-border/20 pt-2.5">
                    <div className="min-w-0">
                      <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground block mb-0.5">Password</span>
                      <span className="font-mono text-sm font-semibold truncate text-foreground block tracking-wider">
                        {isUnlocking ? 'Unlocking…' : isVisible ? (secret || '— none stored —') : '••••••••'}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button 
                        onClick={() => togglePasswordVisibility(cred.id)}
                        variant="ghost"
                        size="icon"
                        disabled={isUnlocking}
                        title={isVisible ? 'Hide password' : 'Show password'}
                        className="h-7 w-7 text-muted-foreground hover:bg-background rounded-md"
                      >
                        {isVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                      </Button>
                      <Button 
                        onClick={() => copySecret(cred)}
                        disabled={isUnlocking}
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:bg-background rounded-md"
                      >
                        {isCopied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Notes */}
                {cred.notes && (
                  <p className="text-xs text-muted-foreground leading-relaxed bg-muted/20 p-2.5 rounded-xl border border-border/10">
                    {cred.notes}
                  </p>
                )}

                {/* Render custom fields */}
                {Array.isArray(cred.customFields) && cred.customFields.length > 0 && (
                  <div className="flex flex-col gap-1.5 border-t border-border/20 pt-3 mt-1">
                    {cred.customFields.map((f, idx) => (
                      <div key={idx} className="flex justify-between items-center text-xs">
                        <span className="text-muted-foreground">{f.label}:</span>
                        <span className="font-semibold text-foreground font-mono">{f.value}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/*
        View Credential Modal — read-only.

        The field list is `exportFields`, the SAME helper Share, Print and
        Download build their output from. That is deliberate: View then shows
        exactly what an export shows, and a field added to a credential later
        appears in all four places from one edit instead of three that agree and
        one that quietly does not.
      */}
      <Dialog open={!!viewingCred} onOpenChange={(open) => !open && setViewingCred(null)}>
        {viewingCred && (() => {
          const isVisible = !!visiblePasswords[viewingCred.id];
          const isUnlocking = revealingId === viewingCred.id;
          const secret = revealed[viewingCred.id]?.password;
          const notes = revealed[viewingCred.id]?.notes ?? viewingCred.notes;
          return (
            <DialogContent aria-describedby={undefined} className="max-w-2xl max-h-[90vh] flex flex-col py-6 overflow-y-auto border-border/50 bg-card/95 backdrop-blur-md">
              <DialogHeader className="p-0 pb-4 border-b border-border/30">
                <DialogTitle className="text-lg font-bold">{viewingCred.title}</DialogTitle>
              </DialogHeader>

              <div className="flex flex-col mt-4">
                {exportFields(viewingCred, secret).map((field) => {
                  // The secret is the one row that is not simply printed: it
                  // stays masked until asked for, because opening a record is
                  // not the same act as exposing its password — and revealing
                  // is what writes the audit entry.
                  const isSecret = field.label === 'Password';
                  return (
                    <div
                      key={field.label}
                      className="flex justify-between items-center gap-4 py-2.5 border-b border-border/20 last:border-b-0"
                    >
                      <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground shrink-0">
                        {field.label}
                      </span>
                      <div className="flex items-center gap-1 min-w-0">
                        <span className={`text-sm text-foreground text-right break-all ${isSecret ? 'font-mono tracking-wider' : ''}`}>
                          {isSecret
                            ? (isUnlocking ? 'Unlocking…' : isVisible ? (secret || '— none stored —') : '••••••••')
                            : (field.value || '—')}
                        </span>
                        {isSecret ? (
                          <>
                            <Button
                              onClick={() => togglePasswordVisibility(viewingCred.id)}
                              variant="ghost"
                              size="icon"
                              disabled={isUnlocking}
                              title={isVisible ? 'Hide password' : 'Show password'}
                              className="h-7 w-7 text-muted-foreground hover:bg-background shrink-0 rounded-md"
                            >
                              {isVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                            </Button>
                            <Button
                              onClick={() => copySecret(viewingCred)}
                              disabled={isUnlocking}
                              variant="ghost"
                              size="icon"
                              title="Copy password"
                              className="h-7 w-7 text-muted-foreground hover:bg-background shrink-0 rounded-md"
                            >
                              {copiedId === viewingCred.id ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>

              {notes && (
                <div className="mt-4">
                  <span className="text-xs uppercase font-bold tracking-wider text-muted-foreground block mb-1.5">Notes</span>
                  <p className="text-sm text-muted-foreground leading-relaxed bg-muted/20 p-3 rounded-xl border border-border/10 whitespace-pre-wrap">
                    {notes}
                  </p>
                </div>
              )}

              <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-border/30">
                <Button variant="outline" onClick={() => setViewingCred(null)}>Close</Button>
                <Button onClick={() => { setViewingCred(null); openEditModal(viewingCred); }}>
                  <Pencil size={14} className="mr-2" /> Edit
                </Button>
              </div>
            </DialogContent>
          );
        })()}
      </Dialog>

      {/* Edit Credential Modal */}
      <Dialog open={!!editingCred} onOpenChange={(open) => !open && setEditingCred(null)}>
        {editingCred && (
          <DialogContent aria-describedby={undefined} className="max-w-2xl max-h-[90vh] flex flex-col py-6 overflow-y-auto border-border/50 bg-card/95 backdrop-blur-md">
            <DialogHeader className="p-0 pb-4 border-b border-border/30">
              <DialogTitle className="text-lg font-bold">Edit Vault Password</DialogTitle>
            </DialogHeader>

            

            <form onSubmit={handleEditSubmit} className="flex flex-col gap-5 mt-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="editTitle">Title *</Label>
                <Input
                  id="editTitle"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  disabled={editSaving}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editCategory">Category *</Label>
                  <Select value={editCategory} onValueChange={(val) => setEditCategory(val)} disabled={editSaving}>
                    <SelectTrigger id="editCategory">
                      <SelectValue placeholder="Select Category" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bank">Bank / Financial</SelectItem>
                      <SelectItem value="social">Social Media</SelectItem>
                      <SelectItem value="business">Work / Business</SelectItem>
                      <SelectItem value="personal">Personal Log</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editUrl">Website URL</Label>
                  <Input
                    id="editUrl"
                    type="url"
                    value={editUrl}
                    onChange={(e) => setEditUrl(e.target.value)}
                    disabled={editSaving}
                  />
                </div>

                <HolderSelect
                  id="editHolderId"
                  value={editHolderId}
                  onChange={setEditHolderId}
                  disabled={editSaving}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editUsername">Username *</Label>
                  <Input
                    id="editUsername"
                    value={editUsername}
                    onChange={(e) => setEditUsername(e.target.value)}
                    disabled={editSaving}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="editPassword">Password *</Label>
                  <Input
                    id="editPassword"
                    value={editPassword}
                    onChange={(e) => setEditPassword(e.target.value)}
                    disabled={editSaving}
                    className="font-mono"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="editNotes">Notes / Hints</Label>
                <Textarea
                  id="editNotes"
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  rows={2}
                  disabled={editSaving}
                  className="resize-none"
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

              <div className="flex justify-end gap-3 border-t border-border/30 pt-5 mt-4">
                <Button type="button" variant="secondary" onClick={() => setEditingCred(null)} disabled={editSaving}>
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

    </PageContainer>
  );
}
