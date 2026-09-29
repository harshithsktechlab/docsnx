'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE WORKSPACE STRIP FOR THE ACCOUNT-LEVEL PAGES                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Billing, AI Credits and Audit Logs each render one tab per workspace. Written
 * once, here, for the same reason `workspaceNav.ts` exists: three copies of a
 * tab strip is three chances for one page to offer a company another does not.
 *
 * ── THESE ARE NOT THE SAME TABS AS THE ROSTER'S ────────────────────────────
 * The strip in MembersScreen.jsx looks identical and behaves differently on
 * purpose: each of ITS tabs is a NAVIGATION to that workspace's own route
 * (`/users` vs `/business/<id>/users`), because a company has a roster page of
 * its own.
 *
 * These pages do not. There is one /audit-logs, and the workspace is a FILTER on
 * it — so these tabs push a `?company=` search param and stay put. Same look,
 * because to a user it is the same gesture; different mechanism, because the
 * thing behind it is different.
 *
 * The param still lives in the URL rather than in state, which is what keeps
 * Back working, lets a tab be opened in a new browser tab, and survives a
 * refresh — the properties the roster strip gets for free from being links.
 *
 * ── SUMMARY IS NOT A WORKSPACE ─────────────────────────────────────────────
 * `includeSummary` adds a leading tab meaning "all of it", which is the ABSENCE
 * of the filter rather than another value of it. Audit Logs wants it; Billing
 * does not (an account-wide bill is not a thing you can pay).
 */
import { Building2, LayoutGrid, User } from 'lucide-react';
import { workspaceMenu } from '@/lib/workspaceNav';

/** The `?company=` value meaning the household. See resolveWorkspaceFilter. */
export const PERSONAL_PARAM = 'personal';

/**
 * The tabs to draw, given what /api/auth/me returned.
 *
 * Exported separately from the component so a caller can ask "is there more than
 * one workspace here?" without rendering anything — the strip hides itself for a
 * personal-only tenant, and a page may want to hide a whole card alongside it.
 */
export function workspaceTabsFor({ accountType, companies, viewer, includeSummary }) {
  const menu = workspaceMenu(accountType, companies, viewer);

  /**
   * No companies means nothing to split, so there are no tabs at all.
   *
   * Returning `[Summary, Personal]` here would be worse than useless: on a
   * personal-only tenant — which is most of them — the two would be the SAME
   * list under two names, and a strip whose options are indistinguishable
   * teaches a user that the strip does not do anything.
   *
   * This also covers a member who belongs to one account: `workspaceMenu`
   * already filters `companies` down to what they may reach, so someone with a
   * single workspace gets a page identical to the one they had before tabs
   * existed.
   */
  if (menu.companies.length === 0) return [];

  const tabs = [];
  if (includeSummary) tabs.push({ key: null, name: 'Summary', kind: 'summary' });
  // Only an account that HAS a household half is offered one. A business-only
  // tenant's "Personal" tab would be a filter matching nothing.
  if (menu.hasPersonal) {
    tabs.push({ key: PERSONAL_PARAM, name: 'Personal', kind: 'personal' });
  }
  for (const company of menu.companies) {
    tabs.push({ key: company.id, name: company.name, kind: 'business' });
  }
  return tabs;
}

const ICONS = { summary: LayoutGrid, personal: User, business: Building2 };

export default function WorkspaceTabs({
  tabs,
  /** The active `?company=` value: null = Summary, 'personal', or a company id. */
  active,
  onSelect,
  /** Optional per-tab trailing label, e.g. an entry count or a spend figure. */
  badgeFor,
  className = '',
}) {
  // One tab is not a choice, and a strip offering it is furniture that answers
  // nothing. Every personal-only tenant sees this branch.
  if (!tabs || tabs.length < 2) return null;

  return (
    <div
      role="tablist"
      aria-label="Workspace"
      className={`flex flex-wrap gap-1 border-b border-border animate-fade-in ${className}`}
    >
      {tabs.map((tab) => {
        const isActive = (tab.key ?? null) === (active ?? null);
        const Icon = ICONS[tab.kind] || Building2;
        const badge = badgeFor ? badgeFor(tab) : null;
        return (
          <button
            key={tab.key || 'summary'}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(tab.key)}
            className={`flex items-center gap-2 px-4 py-2.5 -mb-px border-b-2 text-sm font-bold transition-colors ${
              isActive
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon size={15} />
            <span className="max-w-[12rem] truncate">{tab.name}</span>
            {badge !== null && badge !== undefined && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-2xs font-bold text-muted-foreground">
                {badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
