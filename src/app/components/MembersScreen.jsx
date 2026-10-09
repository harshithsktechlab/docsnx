'use client';

import React, { useEffect, useRef, useState } from 'react';
import { 
  User, 
  Save, 
  CheckCircle2, 
  ChevronRight,
  ShieldAlert,
  Loader2,
  UserPlus,
  Edit,
  Trash2,
  Phone,
  Mail,
  X,
  Lock,
  AlertTriangle,
  Search,
  FileText,
  KeyRound,
  MessageCircle,
  Building2,
  LogIn,
  LogOut
} from 'lucide-react';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { clientGetMe } from '@/lib/clientAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSearchParams } from 'next/navigation';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';  // kept for admin info Alert
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import {
  PERMISSION_MODULE_KEYS,
  PERSONAL_PERMISSION_KEYS,
  BUSINESS_PERMISSION_KEYS,
  defaultPermissionsFor,
  utilityNavPath,
} from '@/lib/moduleRegistry';
import PermissionMatrix from '@/app/users/PermissionMatrix';

import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/dateHelper';
import { isFullyVerified } from '@/lib/verificationChannels';
import { isBlankPhone } from '@/lib/phone';
import { PhoneInput } from '@/components/ui/PhoneInput';
import { DataTable } from '@/components/ui/data-table';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';
import { withCompany } from '@/lib/net/useWorkspaceApi';
import { workspaceMenu } from '@/lib/workspaceNav';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   MEMBERS — one component, one roster per account                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Rendered by `/users` (the household) and by `/business/<id>/users` (one
 * company), the same way `MoreScreen` and `ProfileScreen` serve both.
 *
 * ── WHY THE ROSTER HAD TO SPLIT ────────────────────────────────────────────
 * A member belongs to ONE account — that was settled when the two permission
 * seeds were made disjoint. But the LIST never followed: from inside Acme this
 * page showed the household's members and Acme's employees together, and the
 * Add-member dialog asked "personal or business?" as a radio button even though
 * the workspace the admin was standing in already answered it.
 *
 * So `companyId` decides three things, and every one of them used to be a
 * question the admin had to answer twice:
 *
 *   · WHICH members are listed        — /api/users takes the same `?companyId=`
 *   · WHICH account a new one joins   — no scope picker; the workspace is it
 *   · WHICH company is never unticked — the "Works on" list below locks the
 *                                       one being stood in
 *
 * ── NONE OF IT IS A PERMISSION ─────────────────────────────────────────────
 * `companyId` comes from the address bar and is untrusted. Every call below
 * carries it and every route re-proves it with `hasCompanyAccess`; the page is
 * TENANT_ADMIN-only on top of that, server-side, on each of GET, POST, PUT and
 * DELETE.
 */
export default function MembersScreen({ companyId = null }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [currentUser, setCurrentUser] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, totalCount: 0 });

  // Selected standard user to edit
  const [selectedUser, setSelectedUser] = useState(null);
  // Copy of their permissions for editing
  const [userPermissions, setUserPermissions] = useState([]);
  /**
   * The companies the selected member works on, edited alongside their
   * permissions and saved by the same button.
   *
   * The workspace's own company is not kept here as something tickable — it is
   * always granted, forced in by the route — so this list only ever decides the
   * OTHER companies, which is the rare case it exists for.
   */
  const [userCompanyIds, setUserCompanyIds] = useState([]);
  const [saving, setSaving] = useState(false);

  // Modals state
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);

  /**
   * ── REMOVE-MEMBER DIALOG ────────────────────────────────────────────────
   * Two steps. `choice` asks what the admin actually means: turn the member's
   * sign-in off and keep them in the workspace (`signin_off`), remove them and
   * keep their records (`retain`), or remove them and pick records to delete
   * (`delete`). `pick` is that picker.
   *
   * The picked ids are held as arrays rather than derived from the loaded rows
   * because the list is searchable and paged — a tick must survive the row
   * scrolling out of the result set, or an admin who searches to find one more
   * record would silently lose everything they had already chosen.
   */
  const [removeTarget, setRemoveTarget] = useState(null);
  const [removeStep, setRemoveStep] = useState('choice');
  const [removeMode, setRemoveMode] = useState('retain');
  const [removeRecords, setRemoveRecords] = useState(null);
  const [removeLoading, setRemoveLoading] = useState(false);
  const [removeSearch, setRemoveSearch] = useState('');
  const [removePage, setRemovePage] = useState(1);
  const [pickedDocIds, setPickedDocIds] = useState([]);
  const [pickedPwdIds, setPickedPwdIds] = useState([]);
  const [removing, setRemoving] = useState(false);
  const [togglingSignIn, setTogglingSignIn] = useState(false);
  // "Give access" dialog: the member being given access, the temporary
  // password they will sign in with, and the server's refusal if any.
  const [giveAccessTarget, setGiveAccessTarget] = useState(null);
  const [giveAccessPassword, setGiveAccessPassword] = useState('');
  const [giveAccessError, setGiveAccessError] = useState('');

  /**
   * Which account a newly added member belongs to, and therefore which half of
   * the taxonomy they are seeded with.
   *
   * DERIVED from the workspace, not asked. This was a radio button and a
   * company checklist inside the Add-member dialog — two controls answering a
   * question the admin had already answered by being where they are, and the
   * one way to add somebody to the wrong account.
   *
   * The server resolves it independently and does not trust this value: the
   * company on the request wins, and a `personal` tenant has no business side
   * to add anyone to whatever a payload says.
   */
  const addAccountScope = companyId ? 'business' : 'personal';
  // The companies this admin can reach — the same list the workspace switcher
  // renders. Used to turn the id in the URL into words, and to draw the tab
  // strip; never to decide access, which every route re-proves.
  const [availableCompanies, setAvailableCompanies] = useState([]);
  const workspaceName = availableCompanies.find((c) => c.id === companyId)?.name || null;

  /**
   * The workspaces this admin can move between, Personal first.
   *
   * Through `workspaceMenu` rather than by mapping `availableCompanies`
   * directly: it is the one place that knows a personal-only tenant has no
   * business half and that a member added to one account is not shown the
   * other. Two lists answering that question would eventually disagree.
   */
  const wsMenu = workspaceMenu(
    currentUser?.tenant?.accountType,
    availableCompanies,
    currentUser,
  );
  // Built with `utilityNavPath`, the same function the sidebar and the More
  // screen use, so this strip cannot point somewhere those two do not.
  const workspaceTabs = [
    ...(wsMenu.hasPersonal ? [{ id: null, name: 'Personal', href: '/users' }] : []),
    ...wsMenu.companies.map((c) => ({
      id: c.id, name: c.name, href: utilityNavPath('/users', c.id),
    })),
  ];

  // Default permissions for a new standard user, for the account above.
  // Source of truth: src/lib/moduleRegistry.js — do NOT edit this list here.
  const defaultAddPerms = defaultPermissionsFor(addAccountScope);

  // Guards the admin-side resend so a double click cannot fire two codes — the
  // second would race the first and the member is told a live code is invalid.
  const [resendingVerification, setResendingVerification] = useState(false);

  // Add User Form State
  const [addName, setAddName] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [addPassword, setAddPassword] = useState('');
  const [addPhone, setAddPhone] = useState('');
  const [addDob, setAddDob] = useState('');
  const [addAnniversary, setAddAnniversary] = useState('');
  const [addStep, setAddStep] = useState(1); // 1 = details, 2 = access
  const [addPermissions, setAddPermissions] = useState(defaultAddPerms);
  const [addError, setAddError] = useState('');
  const [adding, setAdding] = useState(false);
  const [tempPasswordView, setTempPasswordView] = useState('');

  // Edit User Form State
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editRole, setEditRole] = useState('STANDARD');
  const [editDob, setEditDob] = useState('');
  const [editAnniversary, setEditAnniversary] = useState('');
  const [editError, setEditError] = useState('');
  const [updating, setUpdating] = useState(false);

  const fetchUsers = async () => {
    try {
      const search = window.location.search;
      const { json } = await apiCall(withCompany(`/api/users${search}`, companyId));
      if (json.success) {
        setUsers(json.users);
        if (json.pagination) {
          setPagination(json.pagination);
        }
        if (selectedUser) {
          const fresh = json.users.find(u => u.id === selectedUser.id);
          if (fresh) setSelectedUser(fresh);
        }
      } else {
        toast.error(json.error || 'Failed to fetch users');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[users] handler threw', err);
      toast.error('Something went wrong fetching users. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    async function load() {
      const meData = await clientGetMe();
      if (meData.success) {
        setCurrentUser(meData.user);
        // The companies THIS admin can reach — the same list the workspace
        // switcher renders, so the picker below cannot offer one the record
        // routes would then refuse.
        setAvailableCompanies(Array.isArray(meData.companies) ? meData.companies : []);
      }
      await fetchUsers();
    }
    load();
    // `companyId` is a dependency, not decoration: switching workspaces changes
    // the route but not the mount, so without it the new workspace would render
    // the previous one's roster until something else forced a fetch.
  }, [searchParams, companyId]);

  /**
   * ── ARRIVING FROM A "BELONGS TO" PICKER ─────────────────────────────────
   *
   * `<HolderSelect>` opens this page in a new tab as `/users?add=1&close=1`
   * (plus `&name=` when a scan read a name it could not place) so an admin who
   * finds the person missing from the dropdown can add them without abandoning
   * the half-filled record on the tab they came from.
   *
   * Runs ONCE, not on every `searchParams` change: the query string outlives
   * the dialog, so re-running would reopen it the moment the admin closed it.
   */
  const addDeepLinkHandled = useRef(false);
  useEffect(() => {
    if (addDeepLinkHandled.current) return;
    if (searchParams.get('add') !== '1') return;
    addDeepLinkHandled.current = true;
    setShowAddModal(true);
    const prefill = searchParams.get('name');
    if (prefill) setAddName(prefill);
  }, [searchParams]);

  /** True when this tab was opened by a picker and should close itself again. */
  const closeOnDone = searchParams.get('close') === '1';

  // A member selected in one workspace is not in the next one's list. Clearing
  // it is what stops the detail panel showing an Acme employee under the
  // household's heading after a switch.
  //
  // The add form's grid goes with it: the two accounts seed different halves of
  // the taxonomy, so carrying one workspace's ticks into the other would offer
  // a new member modules that account does not have.
  useEffect(() => {
    setSelectedUser(null);
    setUserCompanyIds([]);
    setAddPermissions(defaultPermissionsFor(companyId ? 'business' : 'personal'));
    // `defaultAddPerms` is derived from `companyId` and would re-run this on
    // every render if it were the dependency — the id itself is the fact.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);


  const handleSelectUser = (user) => {
    setSelectedUser(user);
    // Module list is the source of truth from moduleRegistry.js — do NOT duplicate here.
    //
    // Two grains since 0024: one DEFAULT row per module (documentKey null), plus
    // whichever sub-category OVERRIDES this member already has. Overrides are
    // carried through as they are and never invented — seeding all 83 would make
    // a category added later invisible rather than inherited.
    //
    // Seeded with THIS workspace's modules plus whatever the member is actually
    // granted elsewhere — not all of both accounts. The matrix shows the rows it
    // is handed, so seeding every key put the household's modules at the top of
    // a company member's grid. Granting across accounts is still one click away
    // behind the matrix's "show the other account" disclosure.
    const accountKeys = companyId ? BUSINESS_PERMISSION_KEYS : PERSONAL_PERMISSION_KEYS;
    const grantedKeys = new Set(
      (user.permissions || [])
        .filter(p => !p.documentKey && (p.canView || p.canAdd || p.canEdit || p.canDelete || p.canShare))
        .map(p => p.module),
    );
    const seedKeys = PERMISSION_MODULE_KEYS.filter(m => accountKeys.includes(m) || grantedKeys.has(m));
    const defaults = seedKeys.map(m => {
      const existing = user.permissions?.find(p => p.module === m && !p.documentKey) || {};
      return {
        module: m,
        documentKey: null,
        canView:   existing.canView   ?? false,
        canAdd:    existing.canAdd    ?? false,
        canEdit:   existing.canEdit   ?? false,
        canDelete: existing.canDelete ?? false,
        canShare:  existing.canShare  ?? false
      };
    });
    const overrides = (user.permissions || [])
      .filter(p => p.documentKey)
      .map(p => ({
        module: p.module,
        documentKey: p.documentKey,
        canView: !!p.canView,
        canAdd: !!p.canAdd,
        canEdit: !!p.canEdit,
        canDelete: !!p.canDelete,
        canShare: !!p.canShare,
      }));
    setUserPermissions([...defaults, ...overrides]);
    // Sent by GET /api/users only inside a company workspace, and empty for an
    // admin — they reach every company without a row, so there is nothing here
    // a tick could take away.
    setUserCompanyIds(Array.isArray(user.companyIds) ? user.companyIds : []);
  };

  /**
   * The company being stood in is never toggled: leaving it is Remove Member,
   * and a member who works on nothing is one no roster would list again.
   */
  const toggleUserCompany = (id) => {
    if (id === companyId) return;
    setUserCompanyIds((prev) => (
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    ));
  };

  const handleSavePermissions = async (e) => {
    e.preventDefault();
    if (!selectedUser) return;
    setSaving(true);

    try {
      const { json } = await apiCall(withCompany(`/api/users/${selectedUser.id}`, companyId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          permissions: userPermissions,
          // Only from inside a company, and only for a member who can hold a
          // grant at all. The route ignores it otherwise, and forces this
          // workspace's own company into whatever is sent.
          ...(companyId && selectedUser.role === 'STANDARD'
            ? { companyIds: userCompanyIds }
            : {}),
        })
      });
      if (json.success) {
        toast.success('Permissions updated successfully!');
        await fetchUsers();
      } else {
        toast.error(json.error || 'Failed to update permissions');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[users] handler threw', err);
      toast.error('Something went wrong saving permissions. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateUser = async (e) => {
    e.preventDefault();
    // Mobile and email are both optional: the member is added as a record only.
    // A contact is needed when you give them access. See
    // src/lib/userContactValidation.ts and POST /api/users/[id]/sign-in.
    if (!addName || !addPassword) {
      toast.error('Please fill in Name and Password.');
      return;
    }
    // Only step 2 creates. A submit from step 1 (Enter in a field, or any
    // stray submit) means "next", never "create with default access".
    if (addStep !== 2) {
      setAddStep(2);
      return;
    }
    setAdding(true);
    setAddError('');
    try {
      const { json } = await apiCall(withCompany('/api/users', companyId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
        name: addName,
        // null, not '': the column is nullable and its unique index treats
        // NULLs as non-colliding, but two empty strings would be duplicates.
        email: addEmail || null,
        password: addPassword,
        // An untouched PhoneInput still holds its country code ('+91').
        phoneNumber: isBlankPhone(addPhone) ? null : addPhone,
        // Always STANDARD: the role picker is gone, because a member
        // is never anything else. See the Add dialog for the reasoning.
        role: 'STANDARD',
        permissions: addPermissions,
        // Which account this member belongs to. Derived from the workspace,
        // and the workspace also rides on the URL as `?companyId=` — the server
        // resolves it from there and this field is only the older, weaker way
        // of saying the same thing. Sending it is the request, not the grant.
        accountScope: addAccountScope,
        dob: addDob || null,
        anniversaryDate: addAnniversary || null
        })
      });
      if (json.success) {
        toast.success(`Successfully added user: ${addName}`);
        // The temporary password, HELD here rather than read back off
        // `addPassword` by the panel below — the reset a few lines down runs in
        // the same batch, so the panel that exists to show the password was
        // rendering an empty box.
        setTempPasswordView(addPassword);

        // Reset
        setAddName('');
        setAddEmail('');
        setAddPassword('');
        setAddPhone('');
        setAddDob('');
        setAddAnniversary('');
        setAddStep(1);
        setAddPermissions(defaultAddPerms);

        await fetchUsers();
      } else {
        toast.error(json.error || 'Failed to create user');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[users] handler threw', err);
      toast.error('Something went wrong adding member. Please try again.');
    } finally {
      setAdding(false);
    }
  };

  /**
   * Re-trigger this member's first-login WhatsApp code.
   *
   * The route answers honestly rather than generically — it is authenticated and
   * tenant-scoped, so there is no enumeration to protect against — which means a
   * gateway that rejected the send surfaces here as an error the admin can act
   * on, instead of a success toast for a message that never left.
   */
  const handleResendVerification = async () => {
    if (!selectedUser || resendingVerification) return;
    setResendingVerification(true);
    try {
      const { json } = await apiCall(withCompany(`/api/users/${selectedUser.id}/resend-verification`, companyId), {
        method: 'POST',
      });
      if (json.success) {
        toast.success(json.message || 'Verification code sent.');
      } else {
        toast.error(json.error || 'Failed to send verification code');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[users] handler threw', err);
      toast.error('Something went wrong sending verification code. Please try again.');
    } finally {
      setResendingVerification(false);
    }
  };

  const handleOpenEditModal = () => {
    if (!selectedUser) return;
    setEditName(selectedUser.name || '');
    setEditEmail(selectedUser.email || '');
    setEditPassword('');
    setEditPhone(selectedUser.phoneNumber || '');
    setEditRole(selectedUser.role || 'STANDARD');
    setEditDob(selectedUser.profile?.personalDetails?.dob || '');
    setEditAnniversary(selectedUser.profile?.personalDetails?.anniversaryDate || '');
    setEditError('');
    setShowEditModal(true);
  };

  const handleSaveDetails = async (e) => {
    e.preventDefault();
    // Mobile is optional for a member, required for an admin. The API also
    // refuses to clear both contacts of a member who has access — see
    // PUT /api/users/[id].
    if (!editName) {
      toast.error('Name is required.');
      return;
    }
    if (editRole !== 'STANDARD' && isBlankPhone(editPhone)) {
      toast.error('Mobile Number is required for an admin.');
      return;
    }
    setUpdating(true);
    setEditError('');
    try {
      const { json } = await apiCall(withCompany(`/api/users/${selectedUser.id}`, companyId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
        name: editName,
        // Always sent, so clearing the field actually clears the column — the
        // route reads '' as a deliberate removal and `undefined` as untouched.
        email: editEmail,
        password: editPassword || undefined,
        phoneNumber: isBlankPhone(editPhone) ? null : editPhone,
        role: editRole,
        dob: editDob || null,
        anniversaryDate: editAnniversary || null
        })
      });
      if (json.success) {
        toast.success('User details saved successfully!');
        setShowEditModal(false);
        await fetchUsers();
      } else {
        toast.error(json.error || 'Failed to save details');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[users] handler threw', err);
      toast.error('Something went wrong saving details. Please try again.');
    } finally {
      setUpdating(false);
    }
  };

  /** How many records one page of the picker shows. */
  const REMOVE_PAGE_SIZE = 100;

  /** Only a member's sign-in can be turned off, never an admin's or your own. */
  const canTurnOffSignIn = (u) =>
    !!u && u.role === 'STANDARD' && u.id !== currentUser?.id && !u.signInDisabledAt;

  /**
   * Whether there is anything to delete. The delete card is only offered when
   * there is: with nothing filed it led to an empty picker whose only button
   * was disabled.
   */
  const removableTotal = removeRecords
    ? removeRecords.totals.documents + removeRecords.totals.passwords
    : 0;

  const openRemoveDialog = () => {
    if (!selectedUser) return;
    if (selectedUser.id === currentUser?.id) {
      toast.error('Cannot delete yourself!');
      return;
    }
    setRemoveTarget(selectedUser);
    setRemoveStep('choice');
    // Default to the reversible choice whenever it is on offer.
    setRemoveMode(canTurnOffSignIn(selectedUser) ? 'signin_off' : 'retain');
    setRemoveRecords(null);
    setRemoveSearch('');
    setRemovePage(1);
    setPickedDocIds([]);
    setPickedPwdIds([]);
  };

  const closeRemoveDialog = () => {
    setRemoveTarget(null);
    setRemoveRecords(null);
  };

  /**
   * Loads what is filed under the member. Titles and categories only — the
   * endpoint will not return a sealed field, and this dialog has no business
   * showing one.
   */
  const fetchRemovableRecords = async (userId, search, page) => {
    setRemoveLoading(true);
    try {
      const qs = new URLSearchParams({
        page: String(page),
        limit: String(REMOVE_PAGE_SIZE),
        ...(search ? { search } : {}),
      });
      const { json } = await apiCall(withCompany(`/api/users/${userId}/records?${qs}`, companyId));
      if (json.success) {
        setRemoveRecords(json);
      } else {
        toast.error(json.error || 'Could not load this member\u2019s records');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[users] handler threw', err);
      toast.error('Something went wrong loading records. Please try again.');
    } finally {
      setRemoveLoading(false);
    }
  };

  // The counts on step 1 come from the same call that fills step 2, so opening
  // the dialog loads once and the picker is already populated when reached.
  useEffect(() => {
    if (!removeTarget) return;
    fetchRemovableRecords(removeTarget.id, removeSearch, removePage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removeTarget?.id, removeSearch, removePage]);

  const togglePicked = (ids, setIds, id) => {
    setIds(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  };

  const pickedCount = pickedDocIds.length + pickedPwdIds.length;

  /**
   * Turns a member's sign-in off or back on. They stay in the roster and in
   * every holder picker either way, so their records can still be filed.
   * Reversible, which is why there is no confirm step.
   */
  const handleSetSignIn = async (target, enabled) => {
    setTogglingSignIn(true);
    try {
      const { json } = await apiCall(withCompany(`/api/users/${target.id}/sign-in`, companyId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!json.success) {
        toast.error(json.error || 'Could not change sign-in');
        return false;
      }
      toast.success(enabled
        ? `${target.name} can sign in again.`
        : `${target.name} can no longer sign in. They stay in the workspace, and you can keep adding their records.`);
      const signInDisabledAt = enabled ? null : new Date().toISOString();
      setSelectedUser((u) => (u && u.id === target.id ? { ...u, signInDisabledAt } : u));
      await fetchUsers();
      return true;
    } catch (err) {
      console.error('[users] handler threw', err);
      toast.error('Something went wrong changing sign-in. Please try again.');
      return false;
    } finally {
      setTogglingSignIn(false);
    }
  };

  const openGiveAccess = (target) => {
    setGiveAccessTarget(target);
    setGiveAccessPassword(generateTempPassword());
    setGiveAccessError('');
  };

  /**
   * Gives a member who was added as a record only the ability to sign in.
   * Nothing is sent now: their verification code (WhatsApp, or email when
   * WhatsApp is off) goes out when they first sign in with this password.
   */
  const handleGiveAccess = async () => {
    const target = giveAccessTarget;
    if (!target) return;
    if (giveAccessPassword.length < 8) {
      setGiveAccessError('Use a temporary password of at least 8 characters.');
      return;
    }
    setTogglingSignIn(true);
    setGiveAccessError('');
    try {
      const { json } = await apiCall(withCompany(`/api/users/${target.id}/sign-in`, companyId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, password: giveAccessPassword }),
      });
      if (!json.success) {
        setGiveAccessError(json.error || 'Could not give access');
        return;
      }
      toast.success(`${target.name} now has access. They verify with a code when they first sign in.`);
      setSelectedUser((u) => (u && u.id === target.id ? { ...u, signInDisabledAt: null } : u));
      setGiveAccessTarget(null);
      await fetchUsers();
    } catch (err) {
      console.error('[users] handler threw', err);
      setGiveAccessError('Something went wrong giving access. Please try again.');
    } finally {
      setTogglingSignIn(false);
    }
  };

  const handleConfirmRemoval = async () => {
    if (!removeTarget) return;
    if (removeStep === 'choice' && removeMode === 'signin_off') {
      if (await handleSetSignIn(removeTarget, false)) closeRemoveDialog();
      return;
    }
    // A 'delete' with nothing ticked would revoke access and destroy nothing,
    // which is the 'retain' path wearing the wrong label. The button is
    // disabled in that state; this is the guard behind it.
    if (removeStep === 'pick' && pickedCount === 0) return;

    setRemoving(true);
    try {
      const { json } = await apiCall(withCompany(`/api/users/${removeTarget.id}`, companyId), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
        removeStep === 'pick'
        ? { mode: 'delete', documentIds: pickedDocIds, passwordIds: pickedPwdIds }
        : { mode: 'retain' }
        ),
      });
      if (json.success) {
        const gone = json.deleted?.documents || json.deleted?.passwords
          ? ` ${json.deleted.documents} record(s) and ${json.deleted.passwords} password entry(s) were deleted.`
          : ' Their records were kept.';
        toast.success(`Removed ${removeTarget.name}.${gone}`);
        closeRemoveDialog();
        setSelectedUser(null);
        await fetchUsers();
      } else {
        toast.error(json.error || 'Failed to remove member');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[users] handler threw', err);
      toast.error('Something went wrong removing member. Please try again.');
    } finally {
      setRemoving(false);
    }
  };

  const getRoleBadgeVariant = (role) => {
    switch (role) {
      case 'SUPER_ADMIN': return 'destructive';
      case 'TENANT_ADMIN': return 'warning';
      default: return 'secondary';
    }
  };

  if (loading) {
    return (
      <PageContainer width="narrow">
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-80" />
          </div>
        </div>
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass p-6">
          <Skeleton className="h-6 w-36 mb-4" />
          <div className="flex flex-col gap-3">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-lg" />
            ))}
          </div>
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer width="narrow">
      
      {/* Header. It names the workspace, because the two rosters look alike at
          a glance and the only thing distinguishing them is whose they are. */}
      <div className="flex items-center justify-between gap-4 animate-fade-in">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground">
            Members &amp; Permissions
          </h1>
          <p className="text-muted-foreground text-sm">
            {companyId
              ? `${workspaceName || 'This company'} — who works on this company and what they can reach`
              : 'The household\u2019s members, and what each of them can reach'}
          </p>
        </div>
        <Button
          onClick={() => {
            setAddPassword(generateTempPassword());
            setShowAddModal(true);
          }}
          className="flex items-center gap-2 h-10 px-4"
        >
          <UserPlus size={16} />
          <span>Add Member</span>
        </Button>
      </div>

      {/*
        ── THE WORKSPACE STRIP ────────────────────────────────────────────────
        One tab per account: Personal, then each company. They are not tabs in
        the usual sense — each is a NAVIGATION to that workspace's own /users
        route, so Back works, a company opens in a new tab, and a refresh stays
        put. The rosters behind them never mix.

        Drawn from `workspaceMenu`, the same builder the switcher chip uses, so
        this cannot offer a company the switcher does not. Absent when there is
        only one workspace to be in — which is every personal-only tenant, and
        every member who belongs to a single account.
      */}
      {workspaceTabs.length > 1 && (
        <div className="flex flex-wrap gap-1 border-b border-border animate-fade-in">
          {workspaceTabs.map((t) => {
            const active = t.id === (companyId || null);
            return (
              <button
                key={t.id || 'personal'}
                type="button"
                onClick={() => router.push(t.href)}
                className={`flex items-center gap-2 px-4 py-2.5 -mb-px border-b-2 text-sm font-bold transition-colors ${
                  active
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {t.id ? <Building2 size={15} /> : <User size={15} />}
                <span className="max-w-[12rem] truncate">{t.name}</span>
              </button>
            );
          })}
        </div>
      )}

      {/*
        ── WHERE THE COMPANY GRAIN IS DECIDED ─────────────────────────────────
        Not here any more. A "Company Access" checklist used to sit above this
        roster, and it was the one control that could contradict the split:
        it listed EVERY member of the tenant, so Acme's card showed the
        household and Beta's employees under a heading saying who was on Acme.

        Adding a member from inside a company already grants that company —
        POST /api/users forces the workspace into the grant set — so for the
        normal flow the checklist decided nothing. What it could still do was
        tick a PERSONAL member into this roster, producing somebody who is
        listed here and 404s on every edit, because `refuseOutsideWorkspace`
        will not answer for a member of the other account.

        The one case it served honestly — a person who works on two of this
        account's companies — moved onto that member's own screen below, where
        it reads as a fact about the member rather than a roster of strangers.
      */}

      {/* User Selector List */}
      {!selectedUser ? (
        <DataTable
          data={users}
          loading={loading}
          pagination={pagination}
          filterDefinitions={[
            {
              key: 'role',
              label: 'Role',
              options: [
                { value: 'STANDARD', label: 'Standard' },
                { value: 'TENANT_ADMIN', label: 'Admin' }
              ]
            }
          ]}
          columns={[
            {
              header: 'Name',
              key: 'name',
              sortable: true,
              render: (u) => (
                <div className="flex items-center gap-3 cursor-pointer" onClick={() => handleSelectUser(u)}>
                  <span className="w-8 h-8 rounded-lg flex items-center justify-center bg-primary/10 text-primary">
                    <User size={16} />
                  </span>
                  <span className="font-bold">{u.name}</span>
                </div>
              )
            },
            {
              header: 'Email',
              key: 'email',
              sortable: true
            },
            {
              header: 'Role',
              key: 'role',
              render: (u) => (
                <div className="flex items-center gap-1.5">
                  <Badge variant={getRoleBadgeVariant(u.role)}>{u.role}</Badge>
                  {hasNoAccess(u) ? <NoAccessBadge /> : u.signInDisabledAt && <SignInOffBadge />}
                </div>
              )
            },
            {
              header: 'Action',
              key: 'action',
              render: (u) => (
                <Button variant="ghost" size="sm" onClick={() => handleSelectUser(u)}>
                  Manage <ChevronRight size={14} className="ml-1" />
                </Button>
              )
            }
          ]}
          /* The tap target is the whole card, and the card belongs to the table
             now (<RecordCard>) — so the handler goes through `onCardClick`
             rather than onto chrome this callback no longer draws. */
          onCardClick={handleSelectUser}
          renderCard={(u) => (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <span className="w-10 h-10 rounded-xl flex items-center justify-center bg-primary/10 text-primary">
                    <User size={18} />
                  </span>
                  <div className="flex flex-col">
                    <span className="font-bold">{u.name}</span>
                    {/*
                      The number first: it is what this member signs in with,
                      and their address is optional — falling back the other way
                      would leave a blank line under half the names.
                    */}
                    <span className="text-xs text-muted-foreground">{u.phoneNumber || u.email || '—'}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={getRoleBadgeVariant(u.role)} className="text-xs">{u.role}</Badge>
                  {hasNoAccess(u) ? <NoAccessBadge /> : u.signInDisabledAt && <SignInOffBadge />}
                </div>
              </div>
          )}
        />
      ) : (
        /* Edit User / Permissions Screen */
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass animate-fade-in">
          <CardContent className="p-6 md:p-8 flex flex-col gap-6">
            
            {/* Header of selected user */}
            <div className="flex flex-col md:flex-row justify-between items-start gap-4 border-b border-border pb-6">
              <div className="flex flex-col gap-1 min-w-0">
                <span className="text-xs text-muted-foreground uppercase font-bold tracking-wider">User Details & Access Matrix</span>
                <h3 className="text-2xl font-extrabold text-foreground truncate">{selectedUser.name}</h3>
                <div className="flex flex-col gap-1.5 mt-2">
                  {selectedUser.phoneNumber && (
                    <span className="text-xs text-muted-foreground flex items-center gap-2">
                      <Phone size={13} /> {selectedUser.phoneNumber}
                      {/*
                        The badge belongs to the NUMBER, so it reads the number's
                        own flag. It used to read `emailVerified`, which for a
                        member was the WhatsApp flag wearing the wrong name — and
                        since 0052 that column means the address and nothing else.
                      */}
                      {selectedUser.phoneVerified === false && !hasNoAccess(selectedUser) && (
                        <Badge variant="outline" className="text-xs font-normal">Unverified</Badge>
                      )}
                    </span>
                  )}
                  {/* Optional, so the row is absent rather than empty. */}
                  {selectedUser.email && (
                    <span className="text-xs text-muted-foreground flex items-center gap-2">
                      <Mail size={13} /> {selectedUser.email}
                    </span>
                  )}
                  {selectedUser.profile?.personalDetails?.dob && (
                    <span className="text-xs text-muted-foreground flex items-center gap-2">
                      🎂 Birthday: {formatDate(selectedUser.profile.personalDetails.dob)}
                    </span>
                  )}
                  {selectedUser.profile?.personalDetails?.anniversaryDate && (
                    <span className="text-xs text-muted-foreground flex items-center gap-2">
                      💑 Anniversary: {formatDate(selectedUser.profile.personalDetails.anniversaryDate)}
                    </span>
                  )}
                  <div className="mt-1 flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">Role:</span>
                    <Badge variant={getRoleBadgeVariant(selectedUser.role)}>{selectedUser.role}</Badge>
                    {hasNoAccess(selectedUser) ? <NoAccessBadge /> : selectedUser.signInDisabledAt && <SignInOffBadge />}
                  </div>
                </div>
              </div>
              
              <div className="flex flex-wrap gap-2 w-full md:w-auto">
                {/*
                  Only for a member who has not cleared their first login. Their
                  code goes out over WhatsApp alone, and the bridge can be down
                  at any point after they were added — this is the only way for
                  the admin who created them to send another one. The member's
                  own Resend button needs a password they may never have used.
                */}
                {!isFullyVerified(selectedUser) && !selectedUser.signInDisabledAt && (
                  <Button
                    onClick={handleResendVerification}
                    variant="outline"
                    disabled={resendingVerification}
                    className="flex items-center gap-1.5 text-xs h-9"
                  >
                    {resendingVerification
                      ? <Loader2 size={12} className="animate-spin" />
                      : <MessageCircle size={12} />}
                    Resend Verification Code
                  </Button>
                )}

                <Button 
                  onClick={handleOpenEditModal}
                  variant="outline"
                  className="flex items-center gap-1.5 text-xs h-9"
                >
                  <Edit size={12} /> Edit Details
                </Button>
                
                {hasNoAccess(selectedUser) ? (
                  <Button
                    onClick={() => openGiveAccess(selectedUser)}
                    disabled={togglingSignIn}
                    className="flex items-center gap-1.5 text-xs h-9"
                  >
                    <KeyRound size={12} />
                    Give Access
                  </Button>
                ) : selectedUser.signInDisabledAt ? (
                  <Button
                    onClick={() => handleSetSignIn(selectedUser, true)}
                    variant="outline"
                    disabled={togglingSignIn}
                    className="flex items-center gap-1.5 text-xs h-9"
                  >
                    {togglingSignIn ? <Loader2 size={12} className="animate-spin" /> : <LogIn size={12} />}
                    Turn On Sign-in
                  </Button>
                ) : canTurnOffSignIn(selectedUser) && (
                  <Button
                    onClick={() => handleSetSignIn(selectedUser, false)}
                    variant="outline"
                    disabled={togglingSignIn}
                    className="flex items-center gap-1.5 text-xs h-9"
                  >
                    {togglingSignIn ? <Loader2 size={12} className="animate-spin" /> : <LogOut size={12} />}
                    Turn Off Sign-in
                  </Button>
                )}

                {selectedUser.id !== currentUser?.id && (
                  <Button 
                    onClick={openRemoveDialog}
                    variant="destructive"
                    className="flex items-center gap-1.5 text-xs h-9"
                  >
                    <Trash2 size={12} /> Remove Member
                  </Button>
                )}
                
                <Button 
                  onClick={() => setSelectedUser(null)}
                  variant="secondary"
                  className="text-xs h-9"
                >
                  Back to List
                </Button>
              </div>
            </div>

            {selectedUser.role === 'TENANT_ADMIN' || selectedUser.role === 'SUPER_ADMIN' ? (
              <Alert>
                <ShieldAlert size={18} />
                <AlertDescription className="text-xs text-muted-foreground leading-relaxed">
                  This user is an <strong className="text-foreground font-bold">Administrator</strong>. Administrators bypass all permission checks and implicitly hold view, add, edit, and delete privileges across all modules.
                </AlertDescription>
              </Alert>
            ) : (
              /*
               * ── THE PERMISSION MATRIX ──────────────────────────────────
               * Two grains. A module's own row is its DEFAULT — what every one
               * of its sub-categories obeys unless told otherwise. Expanding it
               * lists the sub-categories, each of which either inherits (the
               * common case, and no row is stored) or carries an OVERRIDE.
               *
               * The markup lives in ./PermissionMatrix.jsx because the Add
               * dialog renders the very same thing; it used to carry its own
               * flat module-only copy, which is why a new member could not be
               * given sub-category access until after they existed.
               */
              <form onSubmit={handleSavePermissions} className="flex flex-col gap-6">
                {/*
                  ── WORKS ON: THE COMPANY GRAIN, AT THE MEMBER GRAIN ────────
                  Above the matrix because it is the coarser question: WHICH
                  companies this person can open at all, where the matrix says
                  what they may do once inside — and the matrix applies the same
                  way in every one of them.

                  Absent unless there is a choice to make. One company means one
                  permanently-ticked row, which is a control that decides
                  nothing; the household has no companies at all.
                */}
                {companyId && availableCompanies.length > 1 && (
                  <div className="flex flex-col gap-2 rounded-xl border border-border/50 bg-muted/20 p-4">
                    <div className="flex items-center gap-2">
                      <Building2 size={15} className="text-muted-foreground" />
                      <h4 className="text-sm font-bold text-foreground">Works on</h4>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Which of this account&rsquo;s companies {selectedUser.name} can open.
                      Most members work on one; tick another only if they genuinely do.
                    </p>

                    <div className="flex flex-col gap-1 mt-1">
                      {availableCompanies.map((c) => {
                        const here = c.id === companyId;
                        return (
                          <label
                            key={c.id}
                            className={`flex items-center gap-3 rounded-lg border border-border/50 px-3 py-2 text-sm ${
                              here ? 'opacity-70' : 'cursor-pointer hover:bg-muted/40'
                            }`}
                          >
                            <Checkbox
                              checked={here || userCompanyIds.includes(c.id)}
                              disabled={here || saving}
                              onCheckedChange={() => toggleUserCompany(c.id)}
                            />
                            <span className="min-w-0 flex-1 truncate">{c.name}</span>
                            {here && (
                              <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                                <Lock size={11} /> This workspace
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </div>

                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Taking them off {workspaceName || 'this company'} is{' '}
                      <strong className="font-semibold text-foreground">Remove Member</strong>,
                      not a tick — a member who works on nothing appears in no list and
                      could never be reached again. Untick another company from that
                      company&rsquo;s own Members page.
                    </p>
                  </div>
                )}

                {/* No explainer Alert here any more: the matrix carries the same
                    sentence in its own section heading, and printing it twice,
                    once in a banner and once ten pixels below, read as noise. */}
                <PermissionMatrix value={userPermissions} onChange={setUserPermissions} />

                <Button 
                  type="submit" 
                  disabled={saving}
                  className="w-full md:w-auto h-11 px-6 mt-2"
                >
                  {saving ? (
                    <>
                      <Loader2 size={16} className="animate-spin" /> Saving Permissions...
                    </>
                  ) : (
                    <>
                      <Save size={16} /> Save User Permissions
                    </>
                  )}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      {/* ==================== ADD MEMBER MODAL ==================== */}
      <Dialog open={showAddModal} onOpenChange={(open) => { if(!open) { setShowAddModal(false); setAddError(''); setTempPasswordView(''); setAddStep(1); } }}>
        <DialogContent aria-describedby={undefined} className="max-w-[700px] border-border/50 bg-popover/95 backdrop-blur shadow-glass h-[85vh] flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle className="text-lg font-bold flex items-center gap-2 text-foreground">
              <UserPlus className="text-primary" size={20} />
              <span>Add Member</span>
            </DialogTitle>
          </DialogHeader>

          {tempPasswordView ? (
            <div className="flex flex-col flex-1 items-center justify-center gap-4 text-center py-10">
              <CheckCircle2 size={48} className="text-emerald-500" />
              <h3 className="text-xl font-bold">Member Added!</h3>
              <p className="text-muted-foreground text-sm max-w-sm">
                The member has been added without access — nothing has been sent to them. When you want them to
                sign in, open their profile and choose Give Access; they verify with a code at their first sign-in.
                Their temporary password for now:
              </p>
              <div className="bg-muted border border-border p-4 rounded-xl flex items-center justify-center min-w-[250px] mt-2">
                <span className="font-mono text-xl font-bold text-foreground tracking-wider">{tempPasswordView}</span>
              </div>
              {closeOnDone && (
                <p className="text-xs text-muted-foreground max-w-sm">
                  This tab will close. Back on the record you were filling in, this member is now
                  selectable under “Belongs to”.
                </p>
              )}
              <Button
                onClick={() => {
                  setShowAddModal(false);
                  setTempPasswordView('');
                  // Opened by a holder picker in another tab: hand focus back to
                  // the record that sent us here. A browser that refuses the
                  // close just leaves the admin on this page, which is where the
                  // Done button has always left them.
                  if (closeOnDone) window.close();
                }}
                className="mt-4"
              >
                Done
              </Button>
            </div>
          ) : (
            <div className="flex flex-col flex-1 overflow-y-auto pr-2 px-6">


              <form id="addForm" onSubmit={handleCreateUser} className="flex flex-col gap-6 py-2">
                {/* Basic Details — step 1 of 2.
                    Conditionally RENDERED, not `hidden`: Tailwind's preflight
                    ships `[hidden]:where(...)`, and `:where()` contributes zero
                    specificity, so that rule ties with `.flex{display:flex}` on
                    this very element and loses on source order — the attribute
                    does nothing and both steps show at once. Unmounting costs
                    nothing here because every field below is controlled by
                    page-level state, so stepping back keeps what was typed. */}
                {addStep === 1 && (
                <div className="flex flex-col gap-4">
                  <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider border-b border-border/50 pb-2">Basic Details</h4>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="addName">Full Name *</Label>
                      <Input
                        id="addName"
                        placeholder="e.g. Priyan Sharma"
                        value={addName}
                        onChange={(e) => setAddName(e.target.value)}
                        disabled={adding}
                      />
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="addEmail">Email Address <span className="text-muted-foreground font-normal">(optional)</span></Label>
                      <Input
                        id="addEmail"
                        type="email"
                        placeholder="priyan@sharma.com"
                        value={addEmail}
                        onChange={(e) => setAddEmail(e.target.value)}
                        disabled={adding}
                      />
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="addPassword">Temporary Password *</Label>
                      <div className="relative">
                        <Input
                          id="addPassword"
                          type="text"
                          placeholder="Set temporary password"
                          value={addPassword}
                          onChange={(e) => setAddPassword(e.target.value)}
                          disabled={adding}
                          className="font-mono pr-10"
                        />
                        <Lock size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-faint" />
                      </div>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <PhoneInput
                        id="addPhone"
                        label="Mobile Number (optional)"
                        value={addPhone}
                        onChange={setAddPhone}
                        disabled={adding}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-2">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="addDob">Date of Birth</Label>
                      <Input 
                        id="addDob"
                        type="date" 
                        value={addDob}
                        onChange={(e) => setAddDob(e.target.value)}
                        disabled={adding}
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="addAnniversary">Anniversary Date</Label>
                      <Input 
                        id="addAnniversary"
                        type="date" 
                        value={addAnniversary}
                        onChange={(e) => setAddAnniversary(e.target.value)}
                        disabled={adding}
                      />
                    </div>
                  </div>

                  {/* No role picker: a member is always a standard user.
                      Promotion to admin is a separate, deliberate act on the
                      member's own screen, not a dropdown beside their phone
                      number — an admin bypasses every permission check, so it
                      must never be something you pick by accident while typing
                      in a date of birth. */}
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Lock size={12} />
                    Added as a <strong className="text-foreground">standard member</strong>. Their
                    access is whatever you grant on the next step.
                  </p>
                </div>
                )}

                {/* Initial Permissions — the SAME matrix as the edit screen, so a
                    member can be given sub-category access at the moment of
                    creation instead of only afterwards on another screen. */}
                {addStep === 2 && (
                <div className="flex flex-col gap-4 mt-2">
                  {/* One sentence of framing, then the matrix owns the structure:
                      it carries its own section headings, and each row says in
                      plain words what it grants. */}
                  <div className="flex flex-col gap-1">
                    <h4 className="text-sm font-bold text-foreground">Access</h4>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      What this member can see and do. Everything here can be changed later from
                      their profile.
                    </p>
                  </div>

                  {/*
                      ── WHICH ACCOUNT: THE WORKSPACE ALREADY SAID ────────────
                      This was a two-button picker plus a company checklist.
                      Both are gone: adding a member from inside Acme adds them
                      to Acme, and from the household adds them to the
                      household. The workspace is on the URL, the URL is on the
                      request, and the server resolves the account from that
                      rather than from anything this dialog sends.

                      What is left is a line saying which account, because the
                      dialog is a modal and a modal hides the heading behind it —
                      "add a member" with no account named is the one thing here
                      that must not be ambiguous.
                  */}
                  <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
                    {companyId ? <Building2 size={15} className="shrink-0 text-primary" />
                               : <User size={15} className="shrink-0 text-primary" />}
                    <span className="text-xs text-muted-foreground">
                      Joining{' '}
                      <span className="font-bold text-foreground">
                        {companyId ? (workspaceName || 'this company') : 'the personal account'}
                      </span>
                      {companyId
                        ? ' — they will see this company\u2019s records and no household ones.'
                        : ' — they will see household records and no company ones.'}
                    </span>
                  </div>

                  <PermissionMatrix value={addPermissions} onChange={setAddPermissions} showPresets />
                </div>
                )}
              </form>
            </div>
          )}

          {!tempPasswordView && (
            <DialogFooter className="mt-4 gap-2 pt-4 border-t border-border/50 shrink-0 sm:justify-between">
              <span className="hidden text-xs font-semibold text-muted-foreground sm:inline">
                Step {addStep} of 2 · {addStep === 1 ? 'Details' : 'Access'}
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    if (addStep === 2) { setAddStep(1); return; }
                    setShowAddModal(false);
                    setAddError('');
                  }}
                  disabled={adding}
                >
                  {addStep === 2 ? 'Back' : 'Cancel'}
                </Button>
                {/* Distinct keys, so React mounts a NEW element for each step.
                    Without them it reuses one <button> and patches it to
                    type="submit" inside its own click — the Next click's
                    setAddStep(2) flushes before the browser's default action,
                    which then submits #addForm and creates the member with
                    default access, skipping this step entirely. */}
                {addStep === 1 ? (
                  <Button
                    key="add-next"
                    type="button"
                    onClick={() => {
                      if (!addName || !addPassword) {
                        toast.error('Please fill in Name and Password.');
                        return;
                      }
                      setAddStep(2);
                    }}
                    disabled={adding}
                  >
                    Next: Access
                  </Button>
                ) : (
                  <Button key="add-create" form="addForm" type="submit" disabled={adding}>
                    {adding ? <Loader2 size={16} className="animate-spin" /> : 'Create Member'}
                  </Button>
                )}
              </div>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      {/* ==================== EDIT MEMBER DETAILS MODAL ==================== */}
      <Dialog open={showEditModal} onOpenChange={(open) => { if(!open) { setShowEditModal(false); setEditError(''); } }}>
        <DialogContent aria-describedby={undefined} className="max-w-[500px] border-border/50 bg-popover/95 backdrop-blur shadow-glass">
          <DialogHeader>
            <DialogTitle className="text-lg font-bold flex items-center gap-2 text-foreground">
              <Edit className="text-primary" size={20} />
              <span>Edit Details: {selectedUser?.name}</span>
            </DialogTitle>
          </DialogHeader>



          <form onSubmit={handleSaveDetails} className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="editName">Full Name *</Label>
              <Input
                id="editName"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                disabled={updating}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="editEmail">Email Address <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input
                id="editEmail"
                type="email"
                value={editEmail}
                onChange={(e) => setEditEmail(e.target.value)}
                disabled={updating}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="editPassword">Password (leave blank to keep current)</Label>
              <Input
                id="editPassword"
                type="password"
                placeholder="Enter new password"
                value={editPassword}
                onChange={(e) => setEditPassword(e.target.value)}
                disabled={updating}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <PhoneInput
                id="editPhone"
                label={editRole === 'STANDARD' ? 'Mobile Number (optional)' : 'Mobile Number *'}
                value={editPhone}
                onChange={setEditPhone}
                disabled={updating}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Role is shown, not picked. Changing what a member IS belongs
                  with the permission screen, not in a details form beside their
                  anniversary date — see the Add dialog for the same reasoning.
                  editRole still rides along in the PUT so the value round-trips
                  unchanged. */}
              <div className="flex flex-col gap-1.5">
                <Label>Role</Label>
                <div className="flex h-10 items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-3">
                  <Badge variant={getRoleBadgeVariant(editRole)} className="text-xs font-bold">
                    {editRole === 'TENANT_ADMIN' ? 'Admin' : 'Standard'}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {editRole === 'TENANT_ADMIN' ? 'Bypasses all permission checks' : 'Access set by permissions'}
                  </span>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="editDob">Date of Birth</Label>
                <Input 
                  id="editDob"
                  type="date" 
                  value={editDob}
                  onChange={(e) => setEditDob(e.target.value)}
                  disabled={updating}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="editAnniversary">Anniversary Date</Label>
              <Input 
                id="editAnniversary"
                type="date" 
                value={editAnniversary}
                onChange={(e) => setEditAnniversary(e.target.value)}
                disabled={updating}
              />
            </div>

            <DialogFooter className="mt-4 gap-2">
              <Button 
                type="button" 
                variant="secondary"
                onClick={() => {
                  setShowEditModal(false);
                  setEditError('');
                }}
                disabled={updating}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={updating}>
                {updating ? <Loader2 size={16} className="animate-spin" /> : 'Save Changes'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ==================== GIVE ACCESS ====================
          A member added as a record only gets sign-in here. Nothing is sent
          now; their code goes out at their first sign-in. */}
      <Dialog open={!!giveAccessTarget} onOpenChange={(open) => { if (!open) setGiveAccessTarget(null); }}>
        <DialogContent className="max-w-[460px] border-border/50 bg-popover/95 backdrop-blur shadow-glass">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><KeyRound size={18} /> Give Access</DialogTitle>
            <DialogDescription>
              {giveAccessTarget?.name} will be able to sign in with{' '}
              {[giveAccessTarget?.phoneNumber && 'their mobile number', giveAccessTarget?.email && 'their email']
                .filter(Boolean).join(' or ') || 'a mobile number or email (add one with Edit Details first)'}
              {' '}and this temporary password. At their first sign-in they get a verification code on
              WhatsApp, or by email if WhatsApp is off or they have no number.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="give-access-password">Temporary Password</Label>
            <div className="flex gap-2">
              <Input
                id="give-access-password"
                value={giveAccessPassword}
                onChange={(e) => setGiveAccessPassword(e.target.value)}
                className="font-mono"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  navigator.clipboard?.writeText(giveAccessPassword).then(
                    () => toast.success('Password copied'),
                    () => toast.error('Could not copy'),
                  );
                }}
              >
                Copy
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Share this with them before they sign in.</p>
            {giveAccessError && (
              <Alert variant="destructive">
                <AlertDescription>{giveAccessError}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGiveAccessTarget(null)} disabled={togglingSignIn}>Cancel</Button>
            <Button onClick={handleGiveAccess} disabled={togglingSignIn} className="flex items-center gap-1.5">
              {togglingSignIn ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
              Give Access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ==================== REMOVE MEMBER ====================
          Two steps, because removing a member and destroying the workspace's
          records ABOUT that member are different intents and the old
          confirm() could not tell them apart. Step 1 picks the intent; step 2
          is the per-record picker, which opens with NOTHING ticked — this
          deletes Drive objects permanently, so the safe state has to be the
          default one. */}
      <Dialog open={!!removeTarget} onOpenChange={(open) => { if (!open) closeRemoveDialog(); }}>
        <DialogContent aria-describedby={undefined} className="max-w-[640px] border-border/50 bg-popover/95 backdrop-blur shadow-glass max-h-[85vh] flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle className="text-lg font-bold flex items-center gap-2 text-foreground">
              <AlertTriangle className="text-destructive" size={20} />
              <span>Remove {removeTarget?.name}</span>
            </DialogTitle>
          </DialogHeader>

          {removeStep === 'choice' && (
            <div className="flex flex-col gap-3 py-2 overflow-y-auto">
              {/* The reversible choice, first and preselected whenever it applies:
                  most admins who reach for "remove" only want the person unable
                  to sign in, and removal takes them out of every holder picker. */}
              {canTurnOffSignIn(removeTarget) && (
                /* eslint-disable-next-line no-restricted-syntax --
                   <Button> is sized and centred for a label; these are
                   full-width multi-line choice cards, and bending it into one
                   would mean overriding its height, alignment, wrapping and
                   padding until nothing of the component was left. */
                <button
                  type="button"
                  onClick={() => setRemoveMode('signin_off')}
                  className={`text-left rounded-lg border p-3 transition ${removeMode === 'signin_off' ? 'border-primary bg-primary/5' : 'border-border/60 hover:border-border'}`}
                >
                  <div className="font-semibold text-sm text-foreground">Turn off sign-in only</div>
                  <div className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {removeTarget?.name} can no longer sign in, but stays in the workspace. You can
                    keep adding and managing their records, and turn sign-in back on at any time.
                  </div>
                </button>
              )}

              {/* eslint-disable-next-line no-restricted-syntax -- as above. */}
              <button
                type="button"
                onClick={() => setRemoveMode('retain')}
                className={`text-left rounded-lg border p-3 transition ${removeMode === 'retain' ? 'border-primary bg-primary/5' : 'border-border/60 hover:border-border'}`}
              >
                <div className="font-semibold text-sm text-foreground">Remove member, keep records</div>
                <div className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  {removeTarget?.name} is removed from the workspace and can no longer sign in.{' '}
                  {removeLoading || !removeRecords
                    ? 'Everything filed under them stays in the vault.'
                    : removableTotal === 0
                      ? 'Nothing is filed under them.'
                      : `All ${removeRecords.totals.documents} record(s) and ${removeRecords.totals.passwords} password entry(s) filed under them stay in the vault.`}
                  {' '}New records can no longer be filed under them.
                </div>
              </button>

              {!removeLoading && removableTotal > 0 && (
                /* eslint-disable-next-line no-restricted-syntax -- as above. */
                <button
                  type="button"
                  onClick={() => setRemoveMode('delete')}
                  className={`text-left rounded-lg border p-3 transition ${removeMode === 'delete' ? 'border-destructive bg-destructive/5' : 'border-border/60 hover:border-border'}`}
                >
                  <div className="font-semibold text-sm text-foreground">Remove member and delete records</div>
                  <div className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Pick which of their records and password entries to delete permanently.
                    Anything you leave unticked stays in the vault.
                  </div>
                </button>
              )}

              {/* The part an admin would otherwise assume the other way round. */}
              {removeMode !== 'signin_off' && (
                <p className="text-xs text-muted-foreground leading-relaxed border-t border-border/50 pt-3">
                  Removal is permanent. If this person is added again later they start as a
                  new member, and records kept here will not be reassigned to them
                  automatically.
                </p>
              )}
            </div>
          )}

          {removeStep === 'pick' && (
            <div className="flex flex-col gap-3 py-2 min-h-0 flex-1">
              <div className="relative shrink-0">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={removeSearch}
                  onChange={(e) => { setRemovePage(1); setRemoveSearch(e.target.value); }}
                  placeholder="Search these records by title…"
                  className="pl-8 h-9 text-sm"
                />
              </div>

              <div className="overflow-y-auto flex-1 min-h-0 flex flex-col gap-4 pr-1">
                {removeLoading && (
                  <div className="flex items-center justify-center py-8 text-muted-foreground">
                    <Loader2 size={18} className="animate-spin" />
                  </div>
                )}

                {!removeLoading && removeRecords && (
                  <>
                    <RemovalSection
                      icon={<FileText size={13} />}
                      title="Records"
                      rows={removeRecords.documents}
                      total={removeRecords.totals.documents}
                      picked={pickedDocIds}
                      onToggle={(id) => togglePicked(pickedDocIds, setPickedDocIds, id)}
                      onSelectAll={() => setPickedDocIds([...new Set([...pickedDocIds, ...removeRecords.documents.map((r) => r.id)])])}
                      onClear={() => setPickedDocIds(pickedDocIds.filter((id) => !removeRecords.documents.some((r) => r.id === id)))}
                    />
                    <RemovalSection
                      icon={<KeyRound size={13} />}
                      title="Password entries"
                      rows={removeRecords.passwords}
                      total={removeRecords.totals.passwords}
                      picked={pickedPwdIds}
                      onToggle={(id) => togglePicked(pickedPwdIds, setPickedPwdIds, id)}
                      onSelectAll={() => setPickedPwdIds([...new Set([...pickedPwdIds, ...removeRecords.passwords.map((r) => r.id)])])}
                      onClear={() => setPickedPwdIds(pickedPwdIds.filter((id) => !removeRecords.passwords.some((r) => r.id === id)))}
                    />
                  </>
                )}
              </div>

              {removeRecords && (removeRecords.totals.documents > REMOVE_PAGE_SIZE || removeRecords.totals.passwords > REMOVE_PAGE_SIZE) && (
                <div className="flex items-center justify-between shrink-0 text-xs text-muted-foreground border-t border-border/50 pt-2">
                  <span>Page {removePage}</span>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="h-7 text-xs"
                      disabled={removePage === 1 || removeLoading}
                      onClick={() => setRemovePage((n) => Math.max(1, n - 1))}>Previous</Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs"
                      disabled={removeLoading || (removeRecords.documents.length < REMOVE_PAGE_SIZE && removeRecords.passwords.length < REMOVE_PAGE_SIZE)}
                      onClick={() => setRemovePage((n) => n + 1)}>Next</Button>
                  </div>
                </div>
              )}

              <p className="text-xs shrink-0 border-t border-border/50 pt-3 leading-relaxed">
                {pickedCount === 0 ? (
                  <span className="text-muted-foreground">
                    Tick the records to delete. Nothing is selected, so nothing will be deleted —
                    go back and choose &ldquo;Remove member, keep records&rdquo; if that is what you want.
                  </span>
                ) : (
                  <span className="text-destructive font-medium">
                    {pickedDocIds.length} record(s) and {pickedPwdIds.length} password entry(s)
                    will be permanently deleted, including their encrypted files. This cannot be undone.
                  </span>
                )}
              </p>
            </div>
          )}

          <DialogFooter className="mt-2 gap-2 pt-3 border-t border-border/50 shrink-0 sm:justify-between">
            <Button
              variant="secondary"
              onClick={() => (removeStep === 'pick' ? setRemoveStep('choice') : closeRemoveDialog())}
              disabled={removing}
            >
              {removeStep === 'pick' ? 'Back' : 'Cancel'}
            </Button>

            {removeStep === 'choice' && removeMode === 'delete' ? (
              <Button onClick={() => setRemoveStep('pick')} disabled={removeLoading || removableTotal === 0}>
                Choose records <ChevronRight size={14} />
              </Button>
            ) : (
              <Button
                variant={removeStep === 'choice' && removeMode === 'signin_off' ? 'default' : 'destructive'}
                onClick={handleConfirmRemoval}
                disabled={removing || togglingSignIn || (removeStep === 'pick' && pickedCount === 0)}
              >
                {removing || togglingSignIn ? <Loader2 size={16} className="animate-spin" /> : (
                  removeStep === 'pick'
                    ? `Remove and delete ${pickedCount}`
                    : removeMode === 'signin_off' ? 'Turn off sign-in' : 'Remove member'
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </PageContainer>
  );
}

/**
 * Marks a member whose sign-in the admin turned off. They are still a member,
 * so this sits beside the role rather than replacing anything.
 */
/**
 * Added as a record only and never given access: sign-in is off and they have
 * never verified. Turning sign-in off for a member who already signed in is a
 * different state ("Sign-in off"), with its own button to turn it back on.
 */
function hasNoAccess(u) {
  return !!u && u.role === 'STANDARD' && !!u.signInDisabledAt && !u.emailVerified && !u.phoneVerified;
}

function generateTempPassword() {
  return Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-2).toUpperCase() + '!';
}

function NoAccessBadge() {
  return (
    <Badge variant="outline" className="text-xs font-normal text-muted-foreground">No access</Badge>
  );
}

function SignInOffBadge() {
  return (
    <Badge variant="outline" className="text-xs font-normal text-muted-foreground">Sign-in off</Badge>
  );
}

/**
 * One tickable group in the removal picker.
 *
 * `rows` is the page currently loaded; `picked` is every id chosen across all
 * pages and searches, which is why "Select all" unions rather than replaces and
 * "Clear" subtracts only what is on screen.
 */
function RemovalSection({ icon, title, rows, total, picked, onToggle, onSelectAll, onClear }) {
  const pickedHere = rows.filter((r) => picked.includes(r.id)).length;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
          {icon} {title}
          <span className="text-muted-foreground font-normal">({total})</span>
        </span>
        {rows.length > 0 && (
          <div className="flex gap-1">
            <Button variant="link" size="sm" onClick={onSelectAll}
              className="h-auto px-1 py-0 text-xs font-normal">Select all</Button>
            <Button variant="link" size="sm" onClick={onClear} disabled={pickedHere === 0}
              className="h-auto px-1 py-0 text-xs font-normal text-muted-foreground">Clear</Button>
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground italic px-1 py-2">Nothing filed here.</p>
      ) : (
        <div className="flex flex-col rounded-lg border border-border/50 divide-y divide-border/40">
          {rows.map((row) => (
            <label key={row.id} className="flex items-start gap-2.5 p-2.5 cursor-pointer hover:bg-muted/40">
              <Checkbox
                checked={picked.includes(row.id)}
                onCheckedChange={() => onToggle(row.id)}
                className="mt-0.5"
              />
              <span className="flex flex-col min-w-0">
                <span className="text-xs font-medium text-foreground truncate">{row.title}</span>
                <span className="text-xs text-muted-foreground">
                  {row.category || 'Uncategorised'} · {formatDate(row.createdAt)}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
