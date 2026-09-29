'use client';

/**
 * The member's lock screen.
 *
 * A tenant admin whose plan lapses is sent to /billing, where they can pay. A
 * member cannot: /api/payments/create-order is admin-only, and /billing itself
 * redirects anyone who is not a TENANT_ADMIN back to /dashboard — which, with
 * Shell now redirecting a locked user away from /dashboard, would bounce the two
 * against each other forever.
 *
 * So members land here instead: what happened, when, who can fix it, and the one
 * page they can still open.
 */

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, Mail, Settings as SettingsIcon, LogOut, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { clientGetMe, clientLogout } from '@/lib/clientAuth';
import { lockAxisLabel, workspaceLock } from '@/lib/workspaceLock';
import { formatDate } from '@/lib/dateHelper';
import PageContainer from '@/app/components/PageContainer';


export default function PlanExpiredScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [plan, setPlan] = useState(null);
  const [user, setUser] = useState(null);
  const [lock, setLock] = useState(null);
  const [companies, setCompanies] = useState([]);

  useEffect(() => {
    (async () => {
      const me = await clientGetMe();
      if (!me.success) {
        router.push('/login');
        return;
      }
      const status = me.planStatus || {};
      /**
       * This screen is only ever reached for the PERSONAL half: Shell sends a
       * member here when the workspace they are in is locked, and a company
       * workspace has its own URL that Shell would bounce to instead. So the
       * axis is personal, and the interesting question is whether a company
       * half is still open for them to go to.
       */
      const lock = workspaceLock(status, null);
      // Renewed in another tab, or never locked at all — nothing to see here.
      if (!lock.locked) {
        router.push('/dashboard');
        return;
      }
      setLock(lock);
      setCompanies(Array.isArray(me.companies) ? me.companies : []);
      // The admin can actually pay; send them to the page that takes payment.
      if (me.user?.role === 'TENANT_ADMIN') {
        router.push('/billing?expired=1');
        return;
      }
      setUser(me.user);
      setPlan(status);
      setLoading(false);
    })();
  }, [router]);

  const handleLogout = async () => {
    await clientLogout();
    router.push('/login');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="animate-spin text-muted-foreground" size={28} />
      </div>
    );
  }

  const admin = plan?.admin || null;

  return (
    <PageContainer width="compact">
      <Card className="border-destructive/40 bg-destructive/5 backdrop-blur shadow-glass animate-fade-in">
        <CardHeader className="text-center">
          <div className="mx-auto mb-3 h-14 w-14 rounded-2xl bg-destructive/15 flex items-center justify-center">
            <Lock className="text-danger-text" size={26} />
          </div>
          <CardTitle className="text-xl font-bold text-danger-text">
            {/* Named only on an account that HAS two halves — "your Personal
                plan expired" is noise to a household that has only one. */}
            {plan?.accountType === 'both'
              ? `Your ${lockAxisLabel(lock?.axis || 'personal')} account is locked`
              : plan?.expiresAt ? 'Your plan has expired' : 'No active plan'}
          </CardTitle>
          <CardDescription className="text-xs">
            {plan?.expiresAt
              ? `${plan.planName || 'Your subscription'} ended on ${formatDate(plan.expiresAt)}.`
              : `${user?.tenant?.name || 'This workspace'} does not have a subscription yet.`}
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-5 text-xs">
          <div className="rounded-xl border border-border bg-background/20 p-4 flex flex-col gap-2">
            <p className="text-sm font-bold text-foreground">What this means</p>
            <p className="text-muted-foreground leading-relaxed">
              Documents, records, passwords, the dashboard, search and AI are locked for
              everyone in{' '}
              <span className="font-bold text-foreground">{user?.tenant?.name || 'this workspace'}</span>
              {lock?.otherHalfOpen ? "'s personal account" : ''}{' '}
              until the subscription is renewed. Nothing has been deleted &mdash; every record is
              exactly where you left it and comes back the moment the plan is active again.
            </p>
          </div>

          {/*
            ── THE OTHER HALF IS STILL OPEN ───────────────────────────────────
            Only reachable on an account whose two halves lapse on different
            dates. Without this the member is stranded on a renewal screen for
            an account they may not even use, with the one they are paying for
            sitting behind a switcher they cannot see from here.
          */}
          {lock?.otherHalfOpen && companies.length > 0 && (
            <div className="rounded-xl border border-primary/40 bg-primary/5 p-4 flex flex-col gap-2">
              <p className="text-sm font-bold text-foreground">
                Your business account is still active
              </p>
              <p className="text-muted-foreground leading-relaxed">
                Only the personal side is locked. Your companies are unaffected and you can
                keep working in them.
              </p>
              <div className="flex flex-wrap gap-2 mt-1">
                {companies.map((company) => (
                  <Button
                    key={company.id}
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    onClick={() => router.push(`/business/${company.id}/dashboard`)}
                  >
                    Open {company.name}
                  </Button>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-xl border border-border bg-background/20 p-4 flex flex-col gap-2">
            <p className="text-sm font-bold text-foreground">Who can renew it</p>
            {admin ? (
              <p className="text-muted-foreground leading-relaxed">
                Only your workspace admin can pay for a plan. Ask{' '}
                <span className="font-bold text-foreground">{admin.name}</span> to renew from their
                Billing page.
              </p>
            ) : (
              <p className="text-muted-foreground leading-relaxed">
                Only a workspace admin can pay for a plan. Ask your admin to renew from their
                Billing page.
              </p>
            )}
            {admin?.email && (
              <Button
                variant="outline"
                size="sm"
                className="self-start gap-2 mt-1"
                onClick={() => {
                  window.location.href =
                    `mailto:${admin.email}?subject=${encodeURIComponent('DocsNX plan renewal')}` +
                    `&body=${encodeURIComponent(
                      `Hi ${admin.name},\n\nOur DocsNX workspace is locked because the plan expired. Could you renew it from the Billing page?\n\nThanks,\n${user?.name || ''}`,
                    )}`;
                }}
              >
                <Mail size={14} />
                <span>Email {admin.name}</span>
              </Button>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="gap-2" onClick={() => router.push('/settings')}>
              <SettingsIcon size={14} />
              <span>Settings</span>
            </Button>
            <Button variant="ghost" size="sm" className="gap-2 text-danger-action hover:bg-destructive/10" onClick={handleLogout}>
              <LogOut size={14} />
              <span>Log out</span>
            </Button>
          </div>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
