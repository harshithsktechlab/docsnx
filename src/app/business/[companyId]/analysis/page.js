'use client';

/**
 * `/business/<companyId>/analysis` — AI analysis of one company's records.
 *
 * The SAME component as `/analysis`. Its tabs become that company's permitted
 * business modules, and `useWorkspaceApi` puts the company on every request, so
 * `/api/analysis` builds a company context and hands the model that company's
 * records rather than an empty personal set.
 *
 * The cached answer is keyed by company as well as by member and module (see
 * migration 0054) — without that, two companies analysing the same module would
 * read and overwrite one another's summary.
 */
import AnalysisPage from '@/app/analysis/page';

export default function BusinessAnalysisPage() {
  return <AnalysisPage />;
}
