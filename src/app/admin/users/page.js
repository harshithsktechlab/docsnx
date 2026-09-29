'use client';
import { PasswordInput } from '@/components/ui/password-input';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Users, Plus, Trash2, Edit2, Search, Loader2
} from 'lucide-react';
import { clientGetMe } from '@/lib/clientAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogBody } from '@/components/ui/dialog';
import { toast } from 'sonner';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';


export default function UsersPage() {
  const router = useRouter();
  const [users, setUsers] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  
  const [showUserForm, setShowUserForm] = useState(false);
  const [editUser, setEditUser] = useState(null);
  const [userFormData, setUserFormData] = useState({
    name: '', email: '', password: '', role: 'TENANT_ADMIN', tenantId: ''
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function loadSession() {
      const me = await clientGetMe();
      if (!me.success || me.user.role !== 'SUPER_ADMIN') { router.push('/dashboard'); return; }
      await fetchTenants();
      await fetchUsers();
      setLoading(false);
    }
    loadSession();
  }, []);

  const fetchTenants = async () => {
    try {
      const { json: data } = await apiCall('/api/admin/tenants');
      if (data.success) setTenants(data.tenants || []);
    } catch (e) {
      console.error('Failed to load tenants', e);
    }
  };

  const fetchUsers = async () => {
    try {
      const { json: data } = await apiCall('/api/admin/users');
      if (data.success) setUsers(data.users || []);
    } catch (e) {
      console.error('Failed to load users', e);
    }
  };

  const openAddUserForm = () => {
    setEditUser(null);
    setUserFormData({ name: '', email: '', password: '', role: 'TENANT_ADMIN', tenantId: '' });
    setShowUserForm(true);
  };

  const openEditUserForm = (u) => {
    setEditUser(u);
    setUserFormData({ name: u.name, email: u.email, password: '', role: u.role, tenantId: u.tenantId });
    setShowUserForm(true);
  };

  const handleSaveUser = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const url = editUser ? `/api/admin/users/${editUser.id}` : '/api/admin/users';
      const method = editUser ? 'PUT' : 'POST';
      const payload = { ...userFormData };
      if (editUser && !payload.password) delete payload.password;
      
      const { json: data } = await apiCall(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (data.success) {
        toast.success(editUser ? 'User updated' : 'User created');
        setShowUserForm(false);
        await fetchUsers();
      } else {
        toast.error(data.error || 'Failed to save user');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[admin/users] handler threw', err);
      toast.error('Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteUser = async (user) => {
    if (!window.confirm(`Are you sure you want to delete ${user.name}?`)) return;
    try {
      const { json: data } = await apiCall(`/api/admin/users/${user.id}`, { method: 'DELETE' });
      if (data.success) {
        toast.success('User deleted');
        setUsers(prev => prev.filter(u => u.id !== user.id));
      } else {
        toast.error(data.error || 'Failed to delete user');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[admin/users] handler threw', err);
      toast.error('Something went wrong. Please try again.');
    }
  };

  const filteredUsers = users.filter(u => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || (u.tenantName && u.tenantName.toLowerCase().includes(q));
  });

  if (loading) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <Loader2 size={32} className="animate-spin text-primary/50" />
      </div>
    );
  }

  return (
    <PageContainer className="max-w-[1400px] gap-8 pb-32">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 animate-fade-in">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-primary to-orange-500 flex items-center justify-center flex-shrink-0">
            <Users size={22} className="text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-foreground">Platform Users</h1>
            <p className="text-muted-foreground text-sm">Manage all users across all tenant workspaces</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={openAddUserForm} className="flex-shrink-0 bg-primary hover:bg-primary/95 text-primary-foreground font-bold">
            <Plus size={16} className="mr-1" /> Create User
          </Button>
        </div>
      </div>

      <div className="relative animate-fade-in max-w-md">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
        <Input className="pl-9 h-9 text-xs" placeholder="Search users by name, email, or tenant..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
      </div>

      <div className="flex flex-col gap-3 animate-fade-in">
        {filteredUsers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4 text-muted-foreground border-2 border-dashed border-border rounded-2xl">
            <Users size={40} className="opacity-25" />
            <p className="font-semibold text-base text-foreground mb-1">No Users Found</p>
          </div>
        ) : (
          filteredUsers.map((u) => (
            <div key={u.id} className="flex items-center justify-between p-4 bg-card backdrop-blur border border-border/60 rounded-xl hover:shadow-glass-hover transition-all">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold">
                  {u.name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <div className="font-bold text-foreground flex items-center gap-2">
                    {u.name}
                    <Badge variant="secondary" className="text-2xs py-0">{u.role}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">{u.email} &bull; {u.tenantName || 'Unknown Tenant'}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="icon" onClick={() => openEditUserForm(u)} className="h-8 w-8"><Edit2 size={13} /></Button>
                <Button variant="outline" size="icon" onClick={() => handleDeleteUser(u)} className="h-8 w-8 text-danger-action border-destructive/30 hover:bg-destructive/10"><Trash2 size={13} /></Button>
              </div>
            </div>
          ))
        )}
      </div>

      <Dialog open={showUserForm} onOpenChange={setShowUserForm}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{editUser ? 'Edit User' : 'Create User'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSaveUser}>
            <DialogBody className="flex flex-col gap-4 py-4">
              <div className="flex flex-col gap-1.5">
                <Label>Name</Label>
                <Input required value={userFormData.name} onChange={e => setUserFormData(prev => ({ ...prev, name: e.target.value }))} disabled={saving} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Email</Label>
                <Input type="email" required value={userFormData.email} onChange={e => setUserFormData(prev => ({ ...prev, email: e.target.value }))} disabled={saving} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Password {editUser && <span className="text-xs text-muted-foreground font-normal">(Leave blank to keep unchanged)</span>}</Label>
                {/* This is the password of the user being created or edited, not
                    the admin's own — without this the browser offers to fill the
                    signed-in admin's credential straight into it. */}
                <PasswordInput autoComplete="new-password" required={!editUser} value={userFormData.password} onChange={e => setUserFormData(prev => ({ ...prev, password: e.target.value }))} disabled={saving} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Role</Label>
                <select className="flex h-9 w-full rounded-md border border-input bg-field px-3 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" value={userFormData.role} onChange={e => setUserFormData(prev => ({ ...prev, role: e.target.value }))} disabled={saving}>
                  <option value="TENANT_ADMIN">Tenant Admin</option>
                  <option value="SUPER_ADMIN">Super Admin</option>
                </select>
              </div>

            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowUserForm(false)} disabled={saving}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? <Loader2 size={14} className="animate-spin" /> : 'Save'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}
