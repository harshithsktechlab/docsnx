'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Cloud,
  Loader2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Unplug,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { clientGetMe } from '@/lib/clientAuth';
import { setFlash } from '@/lib/flashToast';
// Toast the outcome of the OAuth round-trip, which comes back as ?google=<status>.
// Shared with the onboarding wizard, which starts the same flow.
import { connectResult, DRIVE_CHECKBOX_LABEL } from '@/lib/googleConnectResults';
import { storagePressure } from '@/lib/storagePressure';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';


interface GoogleIntegration {
  provider: string;
  configured: boolean;
  connected: boolean;
  enabled: boolean;
  /** False when the grant was given without the Drive checkbox ticked. */
  scopeOk: boolean;
  accountEmail: string | null;
  folderName: string;
  driveQuota: { currentBytes: number; limitBytes: number } | null;
  planStorage: { currentBytes: number; limitBytes: number };
}

const GB = 1024 * 1024 * 1024;

function formatGB(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'unlimited';
  return `${(bytes / GB).toFixed(2)} GB`;
}

export default function SettingsPage() {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [member, setMember] = useState<any | null>(null);
  const [integration, setIntegration] = useState<GoogleIntegration | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  // Account erasure. `workspaceName` is what the admin has to type back, so it
  // has to come from the server rather than anything the form remembers.
  const [workspaceName, setWorkspaceName] = useState('');
  const [deleteInput, setDeleteInput] = useState('');
  const [deleting, setDeleting] = useState(false);

  /**
   * ── FOUR ERASURES, ONE DIALOG ────────────────────────────────────────────
   *
   * `target` is which one is being confirmed, or null for none:
   *
   *   { kind: 'all' }                       the whole tenant — DELETE /api/account/delete
   *   { kind: 'personal' }                  the household   — POST /api/account/erase
   *   { kind: 'business' }                  every company   — POST /api/account/erase
   *   { kind: 'company', id, name }         one company     — DELETE /api/companies/<id>
   *
   * One dialog rather than four, because the GUARD is identical in all four —
   * type the name back exactly — and four copies of an irreversible confirmation
   * is four places for one of them to lose its guard. What differs is the copy
   * and the endpoint, and both are derived from `target`.
   */
  const [target, setTarget] = useState<
    | null
    | { kind: 'all' | 'personal' | 'business' }
    | { kind: 'company'; id: string; name: string }
  >(null);

  const [accountType, setAccountType] = useState<string>('personal');
  const [companies, setCompanies] = useState<Array<{ id: string; name: string }>>([]);

  const loadIntegration = useCallback(async () => {
    try {
      const { json: data } = await apiCall('/api/tenants/integrations/google');
      if (data.success) setIntegration(data.integration);
      else toast.error(data.error || 'Could not load integration status.');
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[settings] handler threw', err);
      toast.error('Something went wrong while loading integration status. Please try again.');
    }
  }, []);

  /**
   * Two settings pages behind one route.
   *
   * The workspace half — the Drive grant and the erase-everything button — is a
   * tenant admin's, and always was. A member used to be bounced to /dashboard
   * outright, which is fine until the plan lapses: /dashboard is locked then, so
   * bouncing them here would have left the one page they are told they can still
   * open sending them somewhere they cannot go.
   *
   * So a member is let in and shown their own account instead: no integration
   * calls, no danger zone. The API is still the real gate — /api/tenants/
   * integrations/google and /api/account/delete both answer 403 to a member
   * regardless of what this renders.
   */
  useEffect(() => {
    (async () => {
      const me = await clientGetMe();
      if (!me.success) {
        router.push('/login');
        return;
      }
      // The platform role has its own console at /admin/settings.
      if (me.user?.role === 'SUPER_ADMIN') {
        router.push('/admin/settings');
        return;
      }
      setWorkspaceName(me.user?.tenant?.name || '');
      setAccountType(me.user?.tenant?.accountType || 'personal');
      setCompanies(Array.isArray(me.companies) ? me.companies : []);
      if (me.user?.role !== 'TENANT_ADMIN') {
        setMember({ ...me.user, planStatus: me.planStatus || null });
        setLoading(false);
        return;
      }
      await loadIntegration();
      setLoading(false);
    })();
  }, [router, loadIntegration]);

  // The OAuth callback redirects back here with ?google=<status>; report it once
  // and clean the URL. Read from the location directly so the page does not need
  // a Suspense boundary for useSearchParams().
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('google');
    const result = connectResult(status);
    if (!result) return;
    if (result.ok) toast.success(result.message);
    else toast.error(result.message);
    // Only `google` is cleaned off. `?company=` is the workspace this page was
    // opened from — the shell reads it to keep the chip and the rail on that
    // company — and a bare `/settings` here would drop the user back into
    // Personal on the way home from Google's consent screen.
    params.delete('google');
    const rest = params.toString();
    router.replace(rest ? `/settings?${rest}` : '/settings');
  }, [router]);

  const persistEnabled = async (enabled: boolean) => {
    if (!integration) return;
    const previous = integration;
    setIntegration({ ...integration, enabled }); // optimistic
    setSaving(true);
    try {
      const { json: data } = await apiCall('/api/tenants/integrations/google', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!data.success) {
        setIntegration(previous); // rollback
        toast.error(data.error || 'Could not update the integration.');
        return;
      }
      toast.success(enabled ? 'Google Drive integration enabled.' : 'Google Drive integration paused.');
      await loadIntegration();
    } catch (err) {
      console.error('[settings] integration toggle threw', err);
      setIntegration(previous); // rollback
      toast.error('Something went wrong updating the integration. Nothing was changed.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = (checked: boolean) => {
    // Turning it off changes where uploads go and restores the plan quota, so confirm first.
    if (!checked) setConfirmDisable(true);
    else persistEnabled(true);
  };

  const handleDisconnect = async () => {
    setSaving(true);
    try {
      const { json: data } = await apiCall('/api/tenants/integrations/google', { method: 'DELETE' });
      if (!data.success) {
        toast.error(data.error || 'Could not disconnect Google Drive.');
        return;
      }
      toast.success(
        data.revokedAtGoogle
          ? 'Google Drive disconnected and access revoked.'
          : 'Google Drive disconnected. Remove the app from your Google account to fully revoke access.'
      );
      await loadIntegration();
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[settings] handler threw', err);
      toast.error('Something went wrong while disconnecting Google Drive. Please try again.');
    } finally {
      setSaving(false);
      setConfirmDisconnect(false);
    }
  };

  /**
   * What the admin must type, and where the request goes, per target.
   *
   * The company erasure confirms on the COMPANY's name rather than the
   * workspace's: the two dialogs are otherwise identical, and typing the
   * workspace name to delete one company inside it is the kind of muscle memory
   * that erases the wrong thing.
   */
  const targetConfirmName = target?.kind === 'company' ? target.name : workspaceName;

  const handleErase = async () => {
    if (!target) return;
    setDeleting(true);
    try {
      const request = target.kind === 'all'
        ? { url: '/api/account/delete', method: 'DELETE', body: { confirm: deleteInput } }
        : target.kind === 'company'
          ? { url: `/api/companies/${target.id}`, method: 'DELETE', body: { confirm: deleteInput } }
          : { url: '/api/account/erase', method: 'POST', body: { target: target.kind, confirm: deleteInput } };

      const { res, json: data } = await apiCall(request.url, {
        method: request.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      });
      if (!res.ok || !data.success) {
        toast.error(typeof data.error === 'string' ? data.error : 'Could not complete the deletion.');
        return;
      }

      // Reported rather than swallowed: a Drive failure never blocks the
      // erasure, but the admin is the only person who can remove what we could
      // not, and they will not go looking unless told.
      const driveNote = Array.isArray(data.driveFailures) && data.driveFailures.length > 0
        ? ' Some files could not be removed from your Google Drive: '
          + `${data.driveFailures.join(', ')}. Please delete them yourself.`
        : '';

      // ── SAID TO THE NEXT PAGE, NOT THIS ONE ───────────────────────────────
      // Both branches end in a HARD navigation, which unmounts this page and
      // the root <Toaster/> with it before a toast raised here has painted a
      // single frame. The erasure confirmation was therefore never seen: the
      // admin landed on /login with no word that it had worked. A flash is
      // written to sessionStorage, which survives a same-origin reload, and
      // Shell's useFlashToast raises it on arrival (src/lib/flashToast.ts).
      // One slot, so the Drive warning rides in the same sentence and colours
      // the whole message — "deleted, but…" is one fact, not two.
      if (target.kind === 'all') {
        // The server has already cleared the session cookie; a hard navigation
        // drops every bit of workspace state this tab still holds in memory.
        setFlash({
          message: `Your account and all its data have been permanently erased.${driveNote}`,
          type: driveNote ? 'warning' : 'success',
          pin: '/login',
          tag: 'account-erased',
          duration: driveNote ? 12000 : 8000,
        });
        window.location.href = '/login';
        return;
      }

      // The session survives a PARTIAL erasure, but the workspace switcher, the
      // nav and every cached list still describe the half that is now gone. A
      // hard reload is the honest way back to a consistent screen.
      setFlash({
        message: `${typeof data.message === 'string' ? data.message : 'Deleted permanently.'}${driveNote}`,
        type: driveNote ? 'warning' : 'success',
        pin: '/settings',
        tag: 'partial-erased',
        duration: driveNote ? 12000 : undefined,
      });
      window.location.href = '/settings';
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[settings] handler threw', err);
      toast.error('Something went wrong while deleting. Please try again.');
    } finally {
      setDeleting(false);
    }
  };

  const connectHref = '/api/auth/google?returnTo=/settings';

  const statusBadge = () => {
    if (!integration) return null;
    if (!integration.configured) return <Badge variant="muted">Not configured</Badge>;
    if (!integration.connected) return <Badge variant="outline">Not connected</Badge>;
    // Before "active": a grant without the Drive scope is connected in name
    // only, and calling it active is what left this page reassuring an admin
    // whose every record save was failing.
    if (!integration.scopeOk) return <Badge variant="warning">Permission missing</Badge>;
    if (integration.enabled) return <Badge variant="success">Connected &amp; active</Badge>;
    return <Badge variant="warning">Connected &mdash; paused</Badge>;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (member) {
    // Plain markup rather than the Card primitives used below: those components
    // are untyped JS, and every prop passed to one from a .tsx file raises a
    // spurious "children does not exist" error. The admin half of this page
    // predates that and carries the noise; new code need not add to it.
    const rows: Array<[string, string]> = [
      ['Name', member.name || '—'],
      ['Email', member.email || '—'],
      ['Workspace', workspaceName || '—'],
      ['Role', String(member.role || '').replace(/_/g, ' ').toLowerCase() || '—'],
    ];

    return (
      <PageContainer width="form" className="pb-12">
        <div className="flex flex-col gap-1.5 animate-fade-in">
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground flex items-center gap-2">
            <SlidersHorizontal className="text-primary w-8 h-8" />
            <span>Settings</span>
          </h1>
          <p className="text-muted-foreground text-sm">
            Your account in {workspaceName || 'this workspace'}
          </p>
        </div>

        <section className="rounded-2xl border border-border/50 bg-card backdrop-blur shadow-glass p-6 flex flex-col gap-4 animate-fade-in">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-bold text-primary">Account</h2>
            <p className="text-xs text-muted-foreground">How you are identified in this workspace.</p>
          </div>
          <dl className="flex flex-col gap-3 text-xs">
            {rows.map(([label, value]) => (
              <div
                key={label}
                className="flex items-center justify-between gap-4 border-b border-border/40 pb-2 last:border-b-0 last:pb-0"
              >
                <dt className="text-muted-foreground font-semibold">{label}</dt>
                <dd className="font-bold text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="rounded-2xl border border-border/50 bg-card backdrop-blur shadow-glass p-6 flex flex-col gap-1 animate-fade-in">
          <h2 className="text-lg font-bold text-foreground">Workspace settings</h2>
          <p className="text-xs text-muted-foreground">
            Google Drive, storage and workspace deletion are managed by your workspace admin.
            {member.planStatus?.admin?.name ? ` Ask ${member.planStatus.admin.name} if you need a change.` : ''}
          </p>
        </section>
      </PageContainer>
    );
  }

  const planLimit = integration?.planStorage.limitBytes ?? 0;
  const planUsed = integration?.planStorage.currentBytes ?? 0;
  const wouldExceedPlan = planUsed > planLimit;
  // Shared with the meter and the toast so the three cannot disagree.
  const drivePressure = storagePressure(integration?.driveQuota ?? null);

  return (
    <PageContainer width="form" className="pb-12">
      <div className="flex flex-col gap-1.5 animate-fade-in">
        <h1 className="text-3xl font-extrabold tracking-tight text-foreground flex items-center gap-2">
          <SlidersHorizontal className="text-primary w-8 h-8" />
          <span>Settings</span>
        </h1>
        <p className="text-muted-foreground text-sm">
          Manage integrations and preferences for your workspace
        </p>
      </div>

      <Tabs defaultValue="integrations" className="w-full space-y-6">
        <TabsList className="grid w-full max-w-xs grid-cols-2">
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="account">Account</TabsTrigger>
        </TabsList>

        <TabsContent value="integrations" className="space-y-6">
          <Card className="border-border/50 bg-card backdrop-blur shadow-glass animate-fade-in">
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1.5">
                  <CardTitle className="text-lg font-bold text-primary flex items-center gap-2">
                    <Cloud size={18} />
                    <span>Google Drive (BYOD)</span>
                  </CardTitle>
                  <CardDescription className="text-xs flex items-center gap-1.5">
                    <ShieldCheck size={12} className="text-emerald-400 shrink-0" />
                    <span>
                      Store your workspace records in your own Google Drive with zero-knowledge
                      encryption. Enabling this also lifts your plan&apos;s storage limit.
                    </span>
                  </CardDescription>
                </div>
                {statusBadge()}
              </div>
            </CardHeader>

            <CardContent className="flex flex-col gap-4 text-xs">
              {!integration?.configured && (
                <Alert variant="warning">
                  <AlertTriangle size={14} />
                  <AlertDescription className="text-xs">
                    Google integration is not configured on this server. Ask your administrator to
                    set <span className="font-mono">GOOGLE_CLIENT_ID</span> and{' '}
                    <span className="font-mono">GOOGLE_CLIENT_SECRET</span>.
                  </AlertDescription>
                </Alert>
              )}

              {/* Above the toggle and the quota, because nothing else on this
                  card is true while it holds: the account is linked, but the
                  Drive permission it needs was never granted, so every record
                  save fails. Destructive rather than warning — this is not a
                  degraded state, it is a broken one. */}
              {integration?.connected && !integration.scopeOk && (
                <Alert variant="destructive">
                  <AlertTriangle size={14} />
                  <AlertDescription className="text-xs">
                    Google Drive is linked without permission to store files, so records cannot
                    be saved. Reconnect below and tick{' '}
                    <span className="font-semibold">&ldquo;{DRIVE_CHECKBOX_LABEL}&rdquo;</span> on
                    Google&rsquo;s consent screen.
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-background/20 p-4">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <Label htmlFor="google-drive-toggle" className="text-sm font-bold text-foreground">
                    Enable Google integration
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    {integration?.connected
                      ? 'Pause without disconnecting — your Google account stays linked, so you can resume without signing in again.'
                      : 'Connect your Google account first to enable this.'}
                  </span>
                </div>
                <Switch
                  id="google-drive-toggle"
                  checked={!!integration?.enabled}
                  disabled={saving || !integration?.connected}
                  onCheckedChange={handleToggle}
                />
              </div>

              {integration?.connected && (
                <p className="text-muted-foreground leading-relaxed">
                  Linked account:{' '}
                  <span className="font-mono text-foreground">
                    {integration.accountEmail || 'unknown'}
                  </span>
                  . Records are written to a dedicated{' '}
                  <span className="font-mono">/{integration.folderName}</span> folder in that
                  Drive, one encrypted file per module.
                </p>
              )}

              {integration?.connected && integration.enabled && integration.driveQuota && (
                drivePressure === 'ok' ? (
                  <p className="text-muted-foreground leading-relaxed">
                    Drive storage in use: {formatGB(integration.driveQuota.currentBytes)} of{' '}
                    {formatGB(integration.driveQuota.limitBytes)}.
                  </p>
                ) : (
                  /* The same threshold as the sidebar meter and the warning
                     toast. This is the page an admin opens BECAUSE they were
                     warned, so it has to agree with the warning. */
                  <Alert variant={drivePressure === 'full' ? 'destructive' : 'warning'}>
                    <AlertTriangle size={14} />
                    <AlertDescription className="text-xs">
                      {drivePressure === 'full'
                        ? 'Your Google Drive is full'
                        : 'Your Google Drive is almost full'}
                      : {formatGB(integration.driveQuota.currentBytes)} of{' '}
                      {formatGB(integration.driveQuota.limitBytes)} used. Free up space in
                      Google Drive — uploads are refused once it is full.
                    </AlertDescription>
                  </Alert>
                )
              )}

              {integration?.connected && !integration.enabled && (
                <Alert variant="warning">
                  <AlertTriangle size={14} />
                  <AlertDescription className="text-xs">
                    The integration is paused. New uploads go to platform storage and your plan
                    limit of {formatGB(planLimit)} applies again. Files already in your Drive stay
                    there.
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>

            <CardFooter className="flex flex-wrap gap-3 pt-2">
              {/* The permission Google asks for as an optional tick box, named
                  before the admin leaves for the consent screen rather than
                  only in the banner above that explains why the last attempt
                  produced a connection that cannot store anything. */}
              <p className="w-full text-xs leading-relaxed text-muted-foreground">
                On Google&rsquo;s consent screen, tick{' '}
                <span className="font-semibold text-foreground">
                  &ldquo;{DRIVE_CHECKBOX_LABEL}&rdquo;
                </span>
                . It is optional there, and without it nothing can be saved to your Drive.
              </p>
              <Button
                onClick={() => {
                  window.location.href = connectHref;
                }}
                disabled={saving || !integration?.configured}
                className="font-bold h-10 px-5 text-xs bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-2"
              >
                <Cloud size={14} />
                <span>{integration?.connected ? 'Reconnect Google Drive' : 'Connect Google Drive'}</span>
              </Button>

              {integration?.connected && (
                <Button
                  variant="ghost"
                  onClick={() => setConfirmDisconnect(true)}
                  disabled={saving}
                  className="font-bold h-10 px-5 text-xs text-danger-action hover:bg-destructive/10 flex items-center gap-2"
                >
                  <Unplug size={14} />
                  <span>Disconnect</span>
                </Button>
              )}
            </CardFooter>
          </Card>
        </TabsContent>

        {/* The whole page already redirects anyone who is not a TENANT_ADMIN,
            so this tab is admin-only by construction. The API check is still
            the real gate. */}
        <TabsContent value="account" className="space-y-6">
          <Card className="border-destructive/40 bg-destructive/5 backdrop-blur shadow-glass animate-fade-in">
            <CardHeader>
              <CardTitle className="text-lg font-bold text-danger-text flex items-center gap-2">
                <AlertTriangle size={18} />
                <span>Danger zone</span>
              </CardTitle>
              <CardDescription className="text-xs">
                Deleting your account is permanent. There is no undo and no backup.
              </CardDescription>
            </CardHeader>

            <CardContent className="flex flex-col gap-4 text-xs">
              <div className="rounded-xl border border-border bg-background/20 p-4 flex flex-col gap-2">
                <p className="text-sm font-bold text-foreground">What gets erased</p>
                <p className="text-muted-foreground leading-relaxed">
                  Every document, record, password, member and audit entry in this
                  workspace &mdash; from our database <span className="font-bold">and</span> from
                  the <span className="font-mono">/{integration?.folderName || 'DocsNX_Data'}</span>{' '}
                  folder in your connected Google Drive. Drive files are deleted outright, not sent
                  to its bin, and we revoke our access to your Google account.{' '}
                  <span className="font-bold text-foreground">
                    We keep no backup, so we cannot restore any of it later.
                  </span>
                </p>
              </div>

              <div className="rounded-xl border border-border bg-background/20 p-4 flex flex-col gap-2">
                <p className="text-sm font-bold text-foreground">What we keep</p>
                <p className="text-muted-foreground leading-relaxed">
                  A minimal record of each member of this workspace &mdash; name, phone number and
                  email address &mdash; and nothing else. It is kept as the record that the
                  erasure happened, and it does not stop you signing up again.
                </p>
              </div>
            </CardContent>

            <CardFooter className="pt-2">
              <Button
                variant="destructive"
                onClick={() => {
                  setDeleteInput('');
                  setTarget({ kind: 'all' });
                }}
                disabled={deleting}
                className="font-bold h-10 px-5 text-xs flex items-center gap-2"
              >
                <Trash2 size={14} />
                <span>Delete the entire account</span>
              </Button>
            </CardFooter>
          </Card>

          {/*
            ── DELETING HALF AN ACCOUNT ────────────────────────────────────────
            Only offered to an account that HAS both halves. On a personal-only
            tenant "delete the business account" would delete nothing and report
            success, which an admin would reasonably read as their companies
            being gone; and erasing the personal half of a personal-only tenant
            is the whole-account deletion above, which someone who means it
            should reach deliberately rather than sideways. The API refuses both
            with a 409 regardless — this is what stops them being offered.
          */}
          {accountType === 'both' && (
            <Card className="border-destructive/40 bg-destructive/5 backdrop-blur shadow-glass animate-fade-in">
              <CardHeader>
                <CardTitle className="text-lg font-bold text-danger-text flex items-center gap-2">
                  <AlertTriangle size={18} />
                  <span>Delete one account</span>
                </CardTitle>
                <CardDescription className="text-xs">
                  Keep one half of {workspaceName} and erase the other. Permanent, with no backup.
                </CardDescription>
              </CardHeader>

              <CardContent className="flex flex-col gap-3 text-xs">
                <div className="rounded-xl border border-border bg-background/20 p-4 flex flex-col gap-2">
                  <p className="text-sm font-bold text-foreground">Personal account</p>
                  <p className="text-muted-foreground leading-relaxed">
                    Erases every household record, password, to-do and contact, and removes every
                    member added to the personal account. Your companies, their records and their
                    people are untouched. You keep your own login.
                  </p>
                  <Button
                    variant="destructive"
                    onClick={() => { setDeleteInput(''); setTarget({ kind: 'personal' }); }}
                    disabled={deleting}
                    className="font-bold h-9 px-4 text-xs flex items-center gap-2 self-start"
                  >
                    <Trash2 size={13} />
                    <span>Delete the personal account</span>
                  </Button>
                </div>

                <div className="rounded-xl border border-border bg-background/20 p-4 flex flex-col gap-2">
                  <p className="text-sm font-bold text-foreground">Business account</p>
                  <p className="text-muted-foreground leading-relaxed">
                    Erases <span className="font-bold text-foreground">every</span> company
                    {companies.length > 0 && <> ({companies.map((c) => c.name).join(', ')})</>}, all
                    of their records, and the employees who worked only on them. Your household is
                    untouched.
                  </p>
                  <Button
                    variant="destructive"
                    onClick={() => { setDeleteInput(''); setTarget({ kind: 'business' }); }}
                    disabled={deleting}
                    className="font-bold h-9 px-4 text-xs flex items-center gap-2 self-start"
                  >
                    <Trash2 size={13} />
                    <span>Delete the business account</span>
                  </Button>
                </div>

                {companies.length > 0 && (
                  <div className="rounded-xl border border-border bg-background/20 p-4 flex flex-col gap-2">
                    <p className="text-sm font-bold text-foreground">A single company</p>
                    <p className="text-muted-foreground leading-relaxed">
                      Erases that company&rsquo;s records and its folder on your Google Drive, and
                      removes the members who worked on no other company. The rest of the business
                      account carries on.
                    </p>
                    <div className="flex flex-col gap-2">
                      {companies.map((company) => (
                        <div
                          key={company.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-background/30 px-3 py-2"
                        >
                          <span className="truncate text-sm font-bold text-foreground">
                            {company.name}
                          </span>
                          <Button
                            variant="destructive"
                            onClick={() => {
                              setDeleteInput('');
                              setTarget({ kind: 'company', id: company.id, name: company.name });
                            }}
                            disabled={deleting}
                            className="h-8 px-3 text-2xs font-bold flex items-center gap-1.5"
                          >
                            <Trash2 size={12} />
                            <span>Delete</span>
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* Pause confirmation — spells out the storage consequences with real numbers. */}
      <Dialog open={confirmDisable} onOpenChange={setConfirmDisable}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn off Google integration?</DialogTitle>
            <DialogDescription className="text-xs">
              Your Google account stays linked, so you can turn this back on without signing in again.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3 py-4 text-xs text-muted-foreground">
            <p>
              New uploads will go to platform storage and your plan limit of{' '}
              <span className="font-bold text-foreground">{formatGB(planLimit)}</span> will apply
              again. You are currently using{' '}
              <span className="font-bold text-foreground">{formatGB(planUsed)}</span>.
            </p>
            {wouldExceedPlan && (
              <Alert variant="destructive">
                <AlertTriangle size={14} />
                <AlertDescription className="text-xs">
                  You are already over your plan limit. New uploads will be rejected until you
                  upgrade your plan or delete some files.
                </AlertDescription>
              </Alert>
            )}
            <p>
              Files already uploaded to your Google Drive stay in your Drive and remain reachable
              through their existing links — nothing is deleted or moved.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDisable(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                setConfirmDisable(false);
                await persistEnabled(false);
              }}
              disabled={saving}
            >
              Turn off
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disconnect confirmation — destructive, requires a fresh consent flow to undo. */}
      <Dialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect Google Drive?</DialogTitle>
            <DialogDescription className="text-xs">
              This revokes DocsNX&apos;s access to your Google account and deletes the stored
              credentials.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3 py-4 text-xs text-muted-foreground">
            <p>
              To reconnect later you will have to sign in to Google and grant access again. If you
              only want to stop syncing for now, turn the integration off instead — that keeps the
              connection.
            </p>
            <p>
              Files already in your Drive are not deleted. Your plan limit of{' '}
              <span className="font-bold text-foreground">{formatGB(planLimit)}</span> applies to new
              uploads.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDisconnect(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDisconnect}
              disabled={saving}
              className="flex items-center gap-2"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Unplug size={14} />}
              <span>Disconnect</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        ── ONE CONFIRMATION, FOUR SCOPES ──────────────────────────────────────
        The button stays disabled until the name is typed back EXACTLY — the same
        check every one of the four APIs enforces independently. Load-bearing
        rather than ceremonial: each of these is irreversible, none has a backup
        to restore from, and each destroys data in a third party's storage.

        The company scope confirms on the COMPANY's name, not the workspace's, so
        the muscle memory of typing the workspace name cannot erase the wrong
        thing.
      */}
      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (deleting) return;
          if (!open) { setTarget(null); setDeleteInput(''); }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {target?.kind === 'company'
                ? `Delete ${target.name} permanently?`
                : target?.kind === 'personal'
                  ? 'Delete the personal account permanently?'
                  : target?.kind === 'business'
                    ? 'Delete the business account permanently?'
                    : 'Delete this account permanently?'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              This cannot be undone, and we keep no backup to restore from.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4 py-4 text-xs text-muted-foreground">
            <Alert variant="destructive">
              <AlertTriangle size={14} />
              <AlertDescription className="text-xs">
                {target?.kind === 'company' ? (
                  <>
                    Every record, password, to-do and contact filed under{' '}
                    <span className="font-bold text-foreground">{target.name}</span> is erased from
                    our database and permanently deleted from your Google Drive. Members who worked
                    on no other company lose their access.{' '}
                    <span className="font-bold text-foreground">
                      Your household and your other companies are not touched.
                    </span>
                  </>
                ) : target?.kind === 'personal' ? (
                  <>
                    Every household record, password, to-do and contact in{' '}
                    <span className="font-bold text-foreground">{workspaceName}</span> is erased,
                    and every member added to the personal account loses their login.{' '}
                    <span className="font-bold text-foreground">
                      Your companies and their records are not touched.
                    </span>
                  </>
                ) : target?.kind === 'business' ? (
                  <>
                    <span className="font-bold text-foreground">Every</span> company in{' '}
                    <span className="font-bold text-foreground">{workspaceName}</span> is erased,
                    along with all of their records and the employees who worked only on them.{' '}
                    <span className="font-bold text-foreground">
                      Your household is not touched.
                    </span>
                  </>
                ) : (
                  <>
                    Every document, record and password in{' '}
                    <span className="font-bold text-foreground">{workspaceName}</span> is erased from
                    our database and permanently deleted from your Google Drive. Every member
                    loses access immediately.
                  </>
                )}
              </AlertDescription>
            </Alert>
            <p className="leading-relaxed">
              {target?.kind === 'company' || target?.kind === 'business' || target?.kind === 'personal'
                ? 'For each member removed we retain only their name, phone number and email '
                  + 'address, as the record that the deletion happened. Everything else is gone '
                  + 'for good.'
                : 'We retain only your name, phone number and email address as the record that '
                  + 'this account was deleted. Everything else is gone for good.'}
            </p>
            <div className="flex flex-col gap-2">
              <Label htmlFor="delete-confirm" className="text-xs font-bold text-foreground">
                Type <span className="font-mono text-danger-text">{targetConfirmName}</span> to confirm
              </Label>
              <Input
                id="delete-confirm"
                value={deleteInput}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDeleteInput(e.target.value)}
                placeholder={targetConfirmName}
                autoComplete="off"
                disabled={deleting}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => { setTarget(null); setDeleteInput(''); }}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleErase}
              disabled={
                deleting
                || !targetConfirmName
                || deleteInput.trim() !== targetConfirmName.trim()
              }
              className="flex items-center gap-2"
            >
              {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              <span>
                {target?.kind === 'company' ? 'Delete company' : 'Delete permanently'}
              </span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </PageContainer>
  );
}
