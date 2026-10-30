'use client';

/**
 * One tenant as a single compact row that opens into its detail.
 *
 * Collapsed: name, mobile, plan, payment (or coupon), sign-up date, expiry.
 * Expanded: email, credits, add-ons, and who is on the personal and business
 * accounts. Storage / records / AI usage stay available as a quiet strip so the
 * old card's numbers are not lost.
 *
 * The toggle is its own <button>. The action buttons sit beside it, never
 * inside it — a button in a button is invalid HTML and breaks keyboard use.
 */
import React from 'react';
import {
  ChevronRight, Copy, Check, Info, Sparkles, CreditCard, Edit2, Trash2, Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/dateHelper';
import { storagePressure } from '@/lib/storagePressure';
import CreditMeter from '@/app/components/CreditMeter';

/** The same column template for the header strip and every row (md and up). */
export const TENANT_GRID =
  'md:grid-cols-[minmax(0,1.5fr)_8.5rem_minmax(0,1.6fr)_7rem_6.5rem_8rem_11rem]';

const GB = 1024 * 1024 * 1024;

const showsPersonal = (t) => t.accountType !== 'business';
const showsBusiness = (t) => t.accountType === 'business' || t.accountType === 'both';

const money = (amount, currency) => {
  const n = Number(amount || 0);
  const symbol = !currency || currency === 'INR' ? '₹' : `${currency} `;
  return `${symbol}${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
};

/** A null expiry on a tenant that holds a plan means lifetime, not "unknown". */
function Expiry({ date, hasPlan }) {
  if (!date) {
    return <span className="text-muted-foreground">{hasPlan ? 'No expiry' : '—'}</span>;
  }
  const expired = new Date(date) < new Date();
  return (
    <span className={cn('font-semibold', expired ? 'text-danger-text' : 'text-emerald-500')}>
      {expired ? 'Expired ' : ''}{formatDate(date)}
    </span>
  );
}

function Cell({ label, children }) {
  return (
    <div className="min-w-0 text-xs">
      <span className="md:hidden text-2xs uppercase tracking-wide text-muted-foreground block">{label}</span>
      {children}
    </div>
  );
}

function RosterLine({ member }) {
  return (
    <li className="flex items-center gap-1.5 text-xs">
      <span className="truncate">{member.name}</span>
      {member.role === 'TENANT_ADMIN' && (
        <Badge variant="secondary" className="text-2xs py-0 px-1 leading-none">Owner</Badge>
      )}
    </li>
  );
}

function PanelBlock({ title, children }) {
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <div className="text-2xs font-bold uppercase tracking-wider text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

export function TenantListHeader() {
  return (
    <div className={cn('hidden md:grid gap-x-3 pl-5 pr-4 pb-1 text-2xs font-bold uppercase tracking-wider text-muted-foreground', TENANT_GRID)}>
      <span className="pl-6">Tenant</span>
      <span>Mobile</span>
      <span>Plan</span>
      <span>Payment / Coupon</span>
      <span>Signed in</span>
      <span>Expires</span>
      <span className="text-right">Actions</span>
    </div>
  );
}

export default function TenantRow({
  tenant,
  isCurrentTenant,
  expanded,
  onToggle,
  copiedId,
  onCopy,
  busy,
  onDetails,
  onAddons,
  onChangePlan,
  onEdit,
  onDelete,
  onAdjustCredits,
}) {
  const panelId = `tenant-panel-${tenant.id}`;
  const counts = tenant._count || {};
  const storage = tenant.storageData;
  const storageState = storagePressure(storage);
  const ai = tenant.aiUsage || { promptTokens: 0, completionTokens: 0, cost: 0, costInr: 0 };
  const pay = tenant.latestPayment;
  const addons = tenant.activeAddons || [];
  const members = tenant.members || { personal: [], business: [] };
  const mobile = tenant.adminContact?.phoneNumber || tenant.billingPhone;
  // The person, not the auto-generated "<Name>'s Workspace" label.
  const displayName = tenant.adminContact?.name || tenant.contactName || tenant.billingName || tenant.name;
  const email = tenant.adminContact?.email || tenant.adminEmail || tenant.billingEmail;

  return (
    <li
      className={cn(
        'rounded-xl border border-border/60 border-l-4 bg-card transition-shadow hover:shadow-glass-hover list-none',
        isCurrentTenant ? 'border-l-primary' : 'border-l-border',
        !tenant.isActive && 'opacity-65',
      )}
    >
      <div className={cn('grid grid-cols-1 gap-x-3 gap-y-2 items-center px-4 py-3', TENANT_GRID)}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="flex items-center gap-2 min-w-0 text-left rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <ChevronRight size={16} className={cn('shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
          <span className="font-bold text-sm text-foreground truncate" title={tenant.name}>{displayName}</span>
          {isCurrentTenant && <Badge variant="default" className="bg-primary text-primary-foreground text-2xs shrink-0">Active Session</Badge>}
          {!tenant.isActive && <Badge variant="destructive" className="text-2xs shrink-0">Suspended</Badge>}
        </button>

        <Cell label="Mobile">
          <span className="truncate block">{mobile || '—'}</span>
        </Cell>

        <Cell label="Plan">
          <div className="flex flex-col items-start gap-1 min-w-0">
            {showsPersonal(tenant) && (
              <Badge variant="outline" className="max-w-full text-2xs border-primary/50 text-primary bg-primary/5" title={tenant.planName || 'Default Plan'}>
                <span className="truncate">{tenant.planName || 'Default Plan'}</span>
              </Badge>
            )}
            {showsBusiness(tenant) && (
              <Badge
                variant="outline"
                className="max-w-full text-2xs border-blue-500/50 text-blue-500 bg-blue-500/5"
                title={tenant.businessPlanName ? `Business: ${tenant.businessPlanName}` : 'No business plan'}
              >
                <span className="truncate">{tenant.businessPlanName ? `Biz · ${tenant.businessPlanName}` : 'Biz · none'}</span>
              </Badge>
            )}
          </div>
        </Cell>

        <Cell label="Payment / Coupon">
          {!pay ? (
            <span className="text-muted-foreground">—</span>
          ) : pay.couponCode ? (
            <Badge variant="secondary" className="font-mono text-2xs" title={`Saved ${money(pay.amountSaved, pay.currency)}`}>
              {pay.couponCode}
            </Badge>
          ) : (
            <span className="font-semibold text-foreground">{money(pay.amount, pay.currency)}</span>
          )}
        </Cell>

        <Cell label="Signed in">
          <span>{formatDate(tenant.createdAt) || '—'}</span>
        </Cell>

        <Cell label="Expires">
          <div className="flex flex-col">
            {showsPersonal(tenant) && (
              <span>
                {tenant.accountType === 'both' && <span className="text-muted-foreground">P </span>}
                <Expiry date={tenant.subscriptionExpiry} hasPlan />
              </span>
            )}
            {showsBusiness(tenant) && (
              <span>
                {tenant.accountType === 'both' && <span className="text-muted-foreground">B </span>}
                <Expiry date={tenant.businessPlanExpiry} hasPlan={Boolean(tenant.businessPlanId)} />
              </span>
            )}
          </div>
        </Cell>

        <div className="flex items-center gap-1 md:justify-end">
          <Button variant="outline" size="icon" className="h-8 w-8" title="Details" aria-label="Details" onClick={onDetails}>
            <Info size={13} />
          </Button>
          <Button variant="outline" size="icon" className="h-8 w-8 border-purple-600/30 text-purple-500 hover:bg-purple-600/10" title="Manage add-ons" aria-label="Manage add-ons" onClick={onAddons} disabled={busy}>
            <Sparkles size={13} />
          </Button>
          <Button variant="outline" size="icon" className="h-8 w-8 border-blue-600/30 text-blue-500 hover:bg-blue-600/10" title="Change plan" aria-label="Change plan" onClick={onChangePlan} disabled={busy}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <CreditCard size={13} />}
          </Button>
          <Button variant="outline" size="icon" className="h-8 w-8" title="Edit settings" aria-label="Edit settings" onClick={onEdit}>
            <Edit2 size={13} />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={onDelete}
            disabled={isCurrentTenant}
            title={isCurrentTenant ? 'Cannot delete active tenant' : 'Delete tenant'}
            aria-label="Delete tenant"
            className={cn('h-8 w-8', !isCurrentTenant && 'text-danger-action border-destructive/30 hover:bg-destructive/10 hover:text-danger-action')}
          >
            <Trash2 size={13} />
          </Button>
        </div>
      </div>

      {expanded && (
        <div id={panelId} className="border-t border-border/50 bg-muted/20 px-4 py-4 rounded-b-xl">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-x-6 gap-y-5">
            <PanelBlock title="Contact">
              <div className="text-xs break-all">{email || '—'}</div>
              <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                <span>ID</span>
                <code className="bg-muted px-1.5 py-0.5 rounded font-mono truncate">{tenant.id}</code>
                <button type="button" onClick={() => onCopy(tenant.id, `id-${tenant.id}`)} className="hover:text-foreground" aria-label="Copy tenant ID">
                  {copiedId === `id-${tenant.id}` ? <Check size={11} /> : <Copy size={11} />}
                </button>
              </div>
              <button
                type="button"
                onClick={() => onCopy(`${window.location.origin}/login`, tenant.id)}
                className="flex items-center gap-1 text-2xs text-muted-foreground hover:text-primary w-fit"
              >
                {copiedId === tenant.id ? <Check size={11} /> : <Copy size={11} />} Copy login URL
              </button>
            </PanelBlock>

            <PanelBlock title="Credits">
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div><div className="text-2xs text-muted-foreground">Total</div><div className="font-extrabold">{Number(tenant.credits?.granted || 0).toLocaleString('en-IN')}</div></div>
                <div><div className="text-2xs text-muted-foreground">Available</div><div className="font-extrabold">{Number(tenant.credits?.balance ?? tenant.aiCreditsBalance ?? 0).toLocaleString('en-IN')}</div></div>
                <div><div className="text-2xs text-muted-foreground">Used</div><div className="font-extrabold">{Number(tenant.credits?.used || 0).toLocaleString('en-IN')}</div></div>
              </div>
              {tenant.accountType === 'both' && (
                <div className="text-2xs text-muted-foreground">
                  Personal {Number(tenant.credits?.personal || 0).toLocaleString('en-IN')} · Business {Number(tenant.credits?.business || 0).toLocaleString('en-IN')}
                </div>
              )}
              <CreditMeter
                balance={tenant.credits?.balance ?? tenant.aiCreditsBalance}
                received={tenant.credits?.granted}
                used={tenant.credits?.used}
                onAdjust={onAdjustCredits}
              />
            </PanelBlock>

            <PanelBlock title="Add-ons bought">
              {addons.length === 0 ? (
                <span className="text-xs text-muted-foreground">None</span>
              ) : (
                <ul className="flex flex-col gap-1">
                  {addons.map((a) => (
                    <li key={a.id} className="text-xs">
                      <span className="font-semibold">{a.name}</span>
                      {a.quantity > 1 && <span className="text-muted-foreground"> ×{a.quantity}</span>}
                      <span className="text-muted-foreground">
                        {a.expiresAt ? ` · until ${formatDate(a.expiresAt)}` : ' · no expiry'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </PanelBlock>

            <PanelBlock title="Usage">
              <div className="text-2xs text-muted-foreground flex flex-col gap-0.5">
                <span>
                  {storage?.isGoogleDrive ? 'Drive' : 'Storage'}:{' '}
                  <span className={cn('font-semibold', storageState === 'full' ? 'text-destructive' : storageState === 'warning' ? 'text-amber-500' : 'text-foreground')}>
                    {(Number(storage?.currentBytes || 0) / GB).toFixed(2)} GB
                    {!storage?.unlimited && storage?.limitBytes ? ` / ${(storage.limitBytes / GB).toFixed(0)} GB` : ''}
                  </span>
                </span>
                <span>Records {counts.records || 0} · Files {counts.files || 0} · Creds {counts.credentials || 0}</span>
                <span>Seats {counts.members || 0} / {tenant.maxMembers || 1}</span>
                <span>
                  AI {Number(ai.promptTokens || 0).toLocaleString()} in / {Number(ai.completionTokens || 0).toLocaleString()} out
                  {' · '}${Number(ai.cost || 0).toFixed(4)} (₹{Number(ai.costInr || 0).toFixed(2)})
                  {' · '}{tenant.hasCustomApiKey ? 'Custom key' : 'Shared key'}
                </span>
              </div>
            </PanelBlock>

            {showsPersonal(tenant) && (
              <PanelBlock title={`Personal members (${members.personal.length})`}>
                {members.personal.length === 0 ? (
                  <span className="text-xs text-muted-foreground">None</span>
                ) : (
                  <ul className="flex flex-col gap-0.5">
                    {members.personal.map((m) => <RosterLine key={m.id} member={m} />)}
                  </ul>
                )}
              </PanelBlock>
            )}

            {showsBusiness(tenant) && (
              <div className="md:col-span-2 xl:col-span-2">
                <PanelBlock title="Business members">
                  {members.business.length === 0 ? (
                    <span className="text-xs text-muted-foreground">None</span>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
                      {members.business.map((g) => (
                        <div key={g.companyId ?? g.companyName} className="min-w-0">
                          <div className="text-xs font-bold truncate">{g.companyName} <span className="font-normal text-muted-foreground">({g.members.length})</span></div>
                          <ul className="flex flex-col gap-0.5 mt-0.5">
                            {g.members.map((m) => <RosterLine key={m.id} member={m} />)}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </PanelBlock>
              </div>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
