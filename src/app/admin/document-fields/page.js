'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE TAXONOMY ADMIN SCREEN — two tabs over one subject                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A shell, deliberately thin. It owns the three things both tabs share and
 * nothing either of them does alone:
 *
 *   the role check   asked once, here, so the two tabs cannot disagree about
 *                    the answer or spend two round trips getting it;
 *   the tab          in the URL (`?tab=`), so a tab is linkable and survives a
 *                    refresh — `fields` stays the default, which is what every
 *                    existing link to this page expects;
 *   the hand-off     Categories → Fields carries the category that was clicked,
 *                    and a taxonomy change on one tab reloads the other.
 *
 * ── WHY TWO TABS AND NOT TWO PAGES ─────────────────────────────────────────
 * They are two halves of one question — which document types exist, and what
 * each one collects — and the operator moves between them constantly: adding a
 * document type is immediately followed by giving it fields. Two URLs would put
 * a page load in the middle of one task, and would need the second page to
 * re-explain which category it is about.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { clientGetMe } from '@/lib/clientAuth';
import { cn } from '@/lib/utils';
import PageContainer from '@/app/components/PageContainer';
import FieldsTab from './FieldsTab';
import CategoriesTab from './CategoriesTab';
import FileSizeTab from './FileSizeTab';

const TABS = [
  {
    id: 'fields',
    label: 'Personal Fields Config',
    blurb: 'Choose what each PERSONAL document type collects, what is encrypted, and what a scan fills in.',
  },
  {
    // A second tab over the same editor, filtered to the business taxonomy.
    // Not a second component: the two taxonomies differ in which rows they
    // list and in nothing else, and a copy of a 1,500-line editor would drift
    // the first time either one gained a field type.
    id: 'business-fields',
    label: 'Business Fields Config',
    blurb: 'The same, for the fourteen BUSINESS modules a company files under.',
  },
  {
    id: 'categories',
    label: 'Categories',
    blurb: 'Which modules and document types exist. Shared by every tenant on the platform.',
  },
  {
    id: 'filesize',
    label: 'File Size',
    blurb: 'Set the maximum file size for document uploads across the platform.',
  },
];

export default function DocumentTaxonomyPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [allowed, setAllowed] = useState(false);
  const [checking, setChecking] = useState(true);

  // `fields` for anything unrecognised, so an old link or a hand-typed value
  // lands on the tab this page has always been rather than on an empty state.
  const requested = searchParams.get('tab');
  const tab = TABS.some((t) => t.id === requested) ? requested : 'fields';

  /** The category Categories sent to Fields, as `{moduleKey, documentKey}`. */
  const [jumpTo, setJumpTo] = useState(null);
  /**
   * Bumped whenever the taxonomy changed, so the OTHER tab reloads when it is
   * next shown. Both tabs read the category list; a document type added on one
   * would otherwise be missing on the other until a manual refresh.
   */
  const [taxonomyVersion, setTaxonomyVersion] = useState(0);

  useEffect(() => {
    (async () => {
      const me = await clientGetMe();
      if (!me.success || me.user.role !== 'SUPER_ADMIN') { router.push('/dashboard'); return; }
      setAllowed(true);
      setChecking(false);
    })();
  }, [router]);

  const show = useCallback((id) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', id);
    // `replace`, not `push`: the tabs are one screen, and Back should leave the
    // page rather than walk through however many tab switches were made.
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [router, searchParams]);

  const configureFields = useCallback((category) => {
    setJumpTo({ moduleKey: category.moduleKey, documentKey: category.documentKey });
    // To the tab that actually LISTS this category. Always jumping to 'fields'
    // would land a business category on the personal tab, which filters it out
    // — the operator would arrive at a screen showing anything but the row they
    // just clicked.
    show(String(category.moduleKey).startsWith('biz_') ? 'business-fields' : 'fields');
  }, [show]);

  if (checking || !allowed) {
    return (
      <PageContainer>
        <div className="flex items-center justify-center gap-2 py-24 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" /> Loading…
        </div>
      </PageContainer>
    );
  }

  const active = TABS.find((t) => t.id === tab);

  return (
    <PageContainer className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Document Types</h1>
        <p className="mt-1 text-sm text-muted-foreground">{active.blurb}</p>
      </div>

      <div className="flex gap-1 border-b" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === tab}
            onClick={() => show(t.id)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              t.id === tab
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/*
        All mounted, one shown, rather than swapped. The Fields tab holds
        unsaved edits — its own beforeunload guard says so — and unmounting it on
        a tab click would discard them silently, which is the one thing that
        screen is careful never to do.
      */}
      <div className={tab === 'fields' ? '' : 'hidden'}>
        <FieldsTab jumpTo={jumpTo} reloadKey={taxonomyVersion} taxonomy="personal" />
      </div>
      <div className={tab === 'business-fields' ? '' : 'hidden'}>
        <FieldsTab jumpTo={jumpTo} reloadKey={taxonomyVersion} taxonomy="business" />
      </div>
      <div className={tab === 'categories' ? '' : 'hidden'}>
        <CategoriesTab
          onConfigureFields={configureFields}
          onTaxonomyChanged={() => setTaxonomyVersion((n) => n + 1)}
        />
      </div>
      <div className={tab === 'filesize' ? '' : 'hidden'}>
        <FileSizeTab />
      </div>
    </PageContainer>
  );
}
