'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Users,
  ChevronRight,
  Bot,
} from 'lucide-react';
import { clientGetMe } from '@/lib/clientAuth';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion';
import {
  NAV_MODULES,
  BUSINESS_NAV_MODULES,
  UTILITY_MODULES,
  utilityNavPath,
} from '@/lib/moduleRegistry';
import { usePermittedCategories, navModulesFrom } from '@/lib/usePermittedCategories';
import { MODULE_COLORS, DEFAULT_MODULE_COLOR } from '@/lib/documentCategories';
import { moduleIcon } from '@/lib/moduleIcons';
import PageContainer from '@/app/components/PageContainer';
import PlanQuotaMeters from '@/app/components/PlanQuotaMeters';
import { ThemeToggle } from '@/components/ThemeToggle';
import { FontSizeToggle } from '@/components/FontSizeToggle';


/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE PHONE'S "MORE" SCREEN — one component, two workspaces              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Rendered by `/more` (the household) and by `/business/<id>/more` (one
 * company). It is a component rather than a page because the workspace is
 * carried by the URL by design — so navigating to a bare `/more` from inside a
 * company IS leaving that company, and the company needs a route of its own.
 *
 * `companyId` is what switches every workspace-scoped list below. It is
 * untrusted, exactly like everywhere else it appears: it comes from the address
 * bar, and every page and API it links to re-proves access on arrival.
 *
 * Plan & Usage, the admin panel and Appearance are tenant-level and identical in
 * both modes — a company does not have its own storage quota or theme.
 */
export default function MoreScreen({ companyId = null }) {
  const router = useRouter();
  const [user, setUser] = useState(null);
  // The same two objects the sidebar feeds its quota meters. They ride along on
  // the `clientGetMe()` call this page already makes — no second request.
  const [planDetails, setPlanDetails] = useState(null);
  const [storageData, setStorageData] = useState(null);
  // Only to NAME the company in the heading. The company this page is scoped to
  // comes from the URL; this list is what turns that id into words.
  const [companies, setCompanies] = useState([]);
  // Same filter the sidebar applies: a member is not offered a sub-category
  // whose page would refuse them.
  const { categories: permittedCategories } = usePermittedCategories();
  // The same builder the sidebar and the company dashboard call, with the same
  // arguments — so the rail, the dashboard grid and this page can never offer
  // three different sets of modules for one workspace.
  const navModules = navModulesFrom(
    permittedCategories,
    companyId ? BUSINESS_NAV_MODULES : NAV_MODULES,
    companyId ? 'business' : 'personal',
    companyId ? `/business/${companyId}` : '',
  );

  useEffect(() => {
    async function loadUser() {
      const data = await clientGetMe();
      if (data.success) {
        setUser(data.user);
        setPlanDetails(data.planDetails || null);
        setStorageData(data.storageData || null);
        setCompanies(Array.isArray(data.companies) ? data.companies : []);
      }
    }
    loadUser();
  }, []);

  // Null until /api/auth/me answers, and null for an id this member cannot
  // reach — the heading falls back rather than printing `undefined`.
  const companyName = companies.find((c) => c.id === companyId)?.name || null;

  const isSuperAdmin = user?.role === 'SUPER_ADMIN';

  /* ── NO ACCOUNT ROWS ON THIS PAGE ──────────────────────────────────────
     Billing, AI Credits, Settings and Audit Logs were all listed here, in two
     different cards, because the desktop sidebar's Account group was
     `hidden lg:flex` and a phone had no other route to them. It has one now:
     the avatar menu in the header (AccountMenu.jsx) is on every width. They
     are gone from here by the same rule they arrived under — on the page
     once, not twice. Plan & Usage keeps its METERS, which is what a phone
     user comes to this page for and which exist nowhere else on a phone. */

  const adminModules = user?.role === 'SUPER_ADMIN'
    ? [
        { name: 'Tenant Management', path: '/tenants', icon: Users, color: '#3b82f6', desc: 'Add, edit, or delete sovereign tenants' },
        { name: 'AI Key Settings', path: '/ai-settings', icon: Bot, color: '#8b5cf6', desc: 'Manage model rotation and API key pool' },
        // No audit-logs entry: that trail is tenant-owned and TENANT_ADMIN-only.
      ]
    : [
        // Company-prefixed like everything else here: from inside Acme this used
        // to be the household's roster, reached from a screen headed with the
        // company's name.
        { name: 'User Management', path: utilityNavPath('/users', companyId), icon: Users, color: '#3b82f6', desc: 'Add/edit members & configure permissions' },
        // Settings and Audit Logs are in the header's account menu now, on
        // every width. The roster is not: it is a workspace concern, it is
        // company-prefixed, and it has no business in a menu about the account.
      ];

  /**
   * Mobile navigation for the 14 master modules.
   *
   * Derived from moduleRegistry.js rather than hand-listed. The list this
   * replaced named ten modules out of fifteen and had drifted — five were
   * unreachable from a phone at all, which is exactly what a hand-maintained
   * copy of a generated list does over time.
   */
  // Prefixed with the company, by the same rule the sidebar's Workspace group
  // uses. An unprefixed link here would walk the user out of Acme and into the
  // household's passwords without saying so. There are no exclusions left —
  // `/profile` was one until a company gained a profile of its own.
  // `/users` is the null-keyed entry and stays out: it is TENANT_ADMIN-only and
  // already on this page as "User Management" under the admin panel below —
  // on the page once, not twice.
  const utilityLinks = UTILITY_MODULES
    .filter((m) => m.key !== null)
    .map((m) => ({ ...m, path: utilityNavPath(m.path, companyId) }));

  const handleModuleClick = (path) => {
    router.push(path);
  };

  return (
    <PageContainer width="narrow">
      {/* The heading names the workspace. On a phone this page is reached from
          a bottom-nav tab, not from the switcher chip, so without it there is
          nothing on screen saying which of the two accounts these modules
          belong to — and the two taxonomies look alike at a glance. */}
      <div className="flex flex-col gap-1 mb-2 animate-fade-in">
        <h1 className="text-3xl font-extrabold tracking-tight text-foreground">More Modules</h1>
        <p className="text-muted-foreground text-sm">
          {companyId
            ? `${companyName || 'This company'} — company records and workspace`
            : 'Access your complete ledger control suite'}
        </p>
      </div>

      {/* ── Plan & Usage ────────────────────────────────────────────────────
          The same meters the desktop sidebar footer shows. They used to live
          only inside that <aside>, which is `hidden lg:flex` — so a tenant's AI
          consumption, the thing they are billed for, was unreadable on every
          phone. Placed first because it is what a phone user comes here for.
          `!isSuperAdmin` matches the sidebar's own gate: the platform admin has
          no plan of their own. */}
      {!isSuperAdmin && planDetails && (
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass animate-fade-in">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg font-bold text-primary">Plan &amp; Usage</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <PlanQuotaMeters
              planDetails={planDetails}
              storageData={storageData}
              aiCreditsBalance={user?.tenant?.aiCreditsBalance}
              size="lg"
            />
          </CardContent>
        </Card>
      )}

      {/* The 14 master modules, each expanding to its sub-categories. */}
      {user?.role !== 'SUPER_ADMIN' && (
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass animate-fade-in stagger-1">
          <CardHeader className="pb-1">
            <CardTitle className="text-lg font-bold text-primary">Records Management</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {/* One open at a time: 14 modules with up to 16 sub-categories each
                is a very long page on a phone if several can be open. */}
            <Accordion type="single" collapsible className="w-full">
              {navModules.map((mod) => {
                const colors = MODULE_COLORS[mod.key] || DEFAULT_MODULE_COLOR;
                // The module's own icon, not its ordinal: a bare number in a
                // coloured square reads as a bullet point and says nothing
                // about what the category holds.
                const Icon = moduleIcon(mod.key);
                return (
                  <AccordionItem key={mod.key} value={mod.key}>
                    <AccordionTrigger className="py-3.5">
                      <span className="flex items-center gap-3 min-w-0">
                        <span
                          className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                          style={{ color: colors.fg, backgroundColor: colors.bg }}
                        >
                          <Icon size={16} />
                        </span>
                        <span className="flex flex-col gap-0.5 min-w-0 text-left">
                          <span className="text-sm font-bold text-foreground truncate">{mod.name}</span>
                          <span className="text-xs font-medium text-muted-foreground">
                            {mod.subCategories.length} sub-categor{mod.subCategories.length === 1 ? 'y' : 'ies'}
                          </span>
                        </span>
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="pb-3">
                      <div className="flex flex-col gap-1 pl-12 pr-1">
                        {/* The module as a whole, so a phone can reach the
                            overview the sidebar's flyout header opens. */}
                        <button
                          onClick={() => handleModuleClick(mod.path)}
                          className="flex items-center justify-between gap-2 w-full min-h-11 py-2 px-3 rounded-lg text-left border border-primary/30 bg-primary/5 hover:bg-primary/10 transition-colors touch-manipulation"
                        >
                          <span className="text-xs font-bold text-primary">
                            Module overview
                          </span>
                          <ChevronRight size={14} className="text-primary shrink-0" />
                        </button>
                        {mod.subCategories.map((sub) => (
                          <button
                            key={sub.documentKey}
                            onClick={() => handleModuleClick(sub.path)}
                            className="flex items-center justify-between gap-2 w-full min-h-11 py-2 px-3 rounded-lg text-left border border-border/40 bg-background/20 hover:bg-muted/30 transition-colors touch-manipulation"
                          >
                            <span className="text-xs font-semibold text-foreground/90 min-w-0 break-words">
                              {sub.name}
                            </span>
                            <ChevronRight size={14} className="text-muted-foreground shrink-0" />
                          </button>
                        ))}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                );
              })}
            </Accordion>
          </CardContent>
        </Card>
      )}

      {/* Everything that is not a record module. */}
      {user?.role !== 'SUPER_ADMIN' && (
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass animate-fade-in stagger-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg font-bold text-primary">Workspace</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {utilityLinks.map((mod) => (
              <button
                key={mod.path}
                onClick={() => handleModuleClick(mod.path)}
                className="flex items-center justify-between gap-2 w-full min-h-11 p-4 rounded-xl border border-border bg-background/20 hover:bg-muted/30 transition-colors touch-manipulation"
              >
                <span className="text-sm font-bold text-foreground truncate">{mod.name}</span>
                <ChevronRight size={16} className="text-muted-foreground shrink-0" />
              </button>
            ))}
            {/* Both workspaces now, company-prefixed. This was personal-only
                while a company had no analysis page to reach — it has one, and
                a phone is the surface with no sidebar to reach it from.

                Backup & Restore below takes NO prefix and should not: it
                exports the whole tenant, both halves of the account at once,
                so there is no company version of it to point at. */}
            <button
              onClick={() => handleModuleClick(utilityNavPath('/documents', companyId))}
              className="flex items-center justify-between gap-2 w-full min-h-11 p-4 rounded-xl border border-border bg-background/20 hover:bg-muted/30 transition-colors touch-manipulation"
            >
              <span className="text-sm font-bold text-foreground truncate">Document Manager</span>
              <ChevronRight size={16} className="text-muted-foreground shrink-0" />
            </button>
            <button
              onClick={() => handleModuleClick(utilityNavPath('/analysis', companyId))}
              className="flex items-center justify-between gap-2 w-full min-h-11 p-4 rounded-xl border border-border bg-background/20 hover:bg-muted/30 transition-colors touch-manipulation"
            >
              <span className="text-sm font-bold text-foreground truncate">AI Portfolio Analysis</span>
              <ChevronRight size={16} className="text-muted-foreground shrink-0" />
            </button>
            <button
              onClick={() => handleModuleClick('/backup')}
              className="flex items-center justify-between gap-2 w-full min-h-11 p-4 rounded-xl border border-border bg-background/20 hover:bg-muted/30 transition-colors touch-manipulation"
            >
              <span className="text-sm font-bold text-foreground truncate">Backup &amp; Restore</span>
              <ChevronRight size={16} className="text-muted-foreground shrink-0" />
            </button>
          </CardContent>
        </Card>
      )}

      {/* Admin Modules (Tenant Admin or Super Admin) */}
      {(user?.role === 'TENANT_ADMIN' || user?.role === 'SUPER_ADMIN') && (
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass animate-fade-in stagger-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg font-bold text-secondary">System Admin Control Panel</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {adminModules.map((mod, i) => {
              const Icon = mod.icon;
              return (
                <div 
                  key={mod.name}
                  className={`flex items-center justify-between p-4 rounded-xl border border-border bg-background/20 hover:bg-muted/30 transition-colors cursor-pointer animate-fade-in stagger-${Math.min(i + 1, 6)}`}
                  onClick={() => handleModuleClick(mod.path)}
                >
                  <div className="flex items-center gap-4 min-w-0">
                    <span 
                      className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                      style={{ 
                        color: mod.color,
                        backgroundColor: `${mod.color}15`
                      }}
                    >
                      <Icon size={20} />
                    </span>
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-sm font-bold text-foreground truncate">{mod.name}</span>
                      <span className="text-xs text-muted-foreground truncate">{mod.desc}</span>
                    </div>
                  </div>
                  <ChevronRight size={16} className="text-muted-foreground flex-shrink-0 ml-2" />
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* ── Appearance ──────────────────────────────────────────────────────
          Both controls used to sit in `hidden md:flex` inside a header that is
          itself `lg:hidden`, so they showed only in the 768–1023px tablet band
          and on no phone at all — and there was no theme control anywhere else
          in the app. The header now carries the theme button on every width;
          the text-size stepper is too wide for it and lives here.

          Not role-gated: a platform admin reads the same screen everyone
          else does. */}
      <Card className="border-border/50 bg-card backdrop-blur shadow-glass animate-fade-in">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg font-bold text-primary">Appearance</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3 min-h-11 p-4 rounded-xl border border-border bg-background/20">
            <span className="text-sm font-bold text-foreground">Theme</span>
            <ThemeToggle variant="segmented" />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 min-h-11 p-4 rounded-xl border border-border bg-background/20">
            <span className="text-sm font-bold text-foreground">Text size</span>
            <FontSizeToggle />
          </div>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
