'use client';

/**
 * `/dashboard` — the HOUSEHOLD's workspace.
 *
 * The same component `/business/<companyId>/dashboard` renders. On this route
 * `useWorkspaceApi` finds no company in the path, so every request goes out
 * unqualified and the page is the personal account's; see `WorkspaceDashboard`
 * for the whole of that mechanism.
 *
 * SUPER_ADMIN lands here too and gets a different page entirely — that branch is
 * taken inside the component, off the payload it has already fetched, so it
 * costs no extra request.
 */
import WorkspaceDashboard from '@/app/components/WorkspaceDashboard';

export default function DashboardPage() {
  return <WorkspaceDashboard />;
}
