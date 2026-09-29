'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE COMPANY WORKSPACE — /business/<companyId>/dashboard                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The landing page the workspace switcher points at, and the same component the
 * household's `/dashboard` renders — see `WorkspaceDashboard` for why the two
 * are one file and what makes this one a company's.
 *
 * ── WHAT THIS PAGE USED TO BE, AND WHY IT CHANGED ──────────────────────────
 * A grid of the company's modules — first on its own, then above the counts
 * that were added when switching between five companies was landing on five
 * pages identical down to the tenant's name in the header.
 *
 * The counts were the half worth keeping. The grid was not: the rail lists the
 * same modules, the More tab lists them at phone width, and a third copy of
 * that list was the bulk of a page meant to summarise the workspace. What
 * remains is what belongs to this company alone — its documents, credentials,
 * tasks, contacts and renewals, its setup and its growth — and none of the
 * TENANT-level facts (the plan, the Drive grant, the encryption key), which
 * would be the same number stated once per company.
 */
import WorkspaceDashboard from '@/app/components/WorkspaceDashboard';

export default function BusinessWorkspacePage() {
  return <WorkspaceDashboard />;
}
