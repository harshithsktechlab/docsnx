'use client';

/**
 * The global search box — typed into where it sits, no modal.
 *
 * It used to be a button that opened a full-screen Spotlight dialog with Quick
 * Actions and tips the user had to get past before typing. Now the sidebar box
 * IS the input: click, type, and the results drop down under it.
 *
 * The dropdown is portalled to <body> and placed from the input's own rect, so
 * it can be wider than the 256px sidebar and is never clipped by the sidebar's
 * `overflow-y-auto`.
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Loader2, Search, X } from 'lucide-react';
import { apiCall, apiRequest } from '@/lib/net/apiRequest';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface SearchResult {
  id: string;
  title: string;
  subtitle?: string;
  link: string;
  module: string;
  /** The `documents` row behind the hit, for the search log. Absent on passwords. */
  documentId?: string;
  /** An exact lookup of a sealed identifier — never logged. */
  exact?: boolean;
  /** Which kind of field the best word matched in. */
  matchedIn?: string | null;
}

export interface GlobalSearchHandle {
  focus: () => void;
}

interface GlobalSearchProps {
  /** `sidebar` shows the ⌘K hint; `mobile` fills its row. */
  variant?: 'sidebar' | 'mobile';
  autoFocus?: boolean;
  /** Called after a result is opened or the box is dismissed with Esc. */
  onDone?: () => void;
  className?: string;
}

const MIN_QUERY = 2;
const DROPDOWN_WIDTH = 440;

const GlobalSearch = forwardRef<GlobalSearchHandle, GlobalSearchProps>(function GlobalSearch(
  { variant = 'sidebar', autoFocus = false, onDone, className },
  ref,
) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const requestSeq = useRef(0);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  const trimmed = query.trim();
  const showDropdown = open && trimmed.length >= MIN_QUERY;

  // The search log. Written when a search ENDS — a result is opened, or the box
  // is closed on a query that found nothing — never per keystroke. Fire and
  // forget: a failed log write must never be seen by the person searching.
  const settled = useRef({ query: '', searching: false, count: 0, lastNoResult: '' });
  settled.current.query = trimmed;
  settled.current.searching = searching;
  settled.current.count = results.length;
  const track = useCallback((body: Record<string, unknown>) => {
    apiRequest('/api/search/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  }, []);
  const trackNoResult = useCallback(() => {
    const s = settled.current;
    if (s.query.length < MIN_QUERY || s.searching || s.count > 0 || s.lastNoResult === s.query) return;
    s.lastNoResult = s.query;
    track({ query: s.query, outcome: 'no_result', resultCount: 0 });
  }, [track]);

  // Debounced fetch. A sequence number drops a slow response that lands after
  // a newer query's, so the list never shows results for text no longer typed.
  useEffect(() => {
    if (trimmed.length < MIN_QUERY) { setResults([]); setSearching(false); return; }
    const seq = ++requestSeq.current;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const { json } = await apiCall(`/api/search?q=${encodeURIComponent(trimmed)}`);
        if (seq !== requestSeq.current) return;
        if (json?.success) { setResults(json.results || []); setActiveIndex(0); }
      } catch (err) {
        console.error('Search failed:', err);
      } finally {
        if (seq === requestSeq.current) setSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [trimmed]);

  // Keep the dropdown pinned under the input while it is open.
  const place = useCallback(() => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect) return;
    const gutter = 16;
    const width = variant === 'mobile'
      ? rect.width
      : Math.max(rect.width, Math.min(DROPDOWN_WIDTH, window.innerWidth - rect.left - gutter));
    setPos({ top: rect.bottom + 6, left: rect.left, width });
  }, [variant]);

  useEffect(() => {
    if (!showDropdown) return;
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [showDropdown, place]);

  // A click anywhere outside the box and its dropdown closes the list but keeps
  // the text, so clicking back in shows the same results.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (boxRef.current?.contains(t) || dropdownRef.current?.contains(t)) return;
      trackNoResult();
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open, trackNoResult]);

  const reset = () => {
    trackNoResult();
    setQuery('');
    setResults([]);
    setOpen(false);
  };

  const go = (res: SearchResult) => {
    if (res.documentId) {
      track({
        query: trimmed,
        outcome: 'clicked',
        documentId: res.documentId,
        resultCount: results.length,
        matchedIn: res.matchedIn ?? undefined,
        exact: res.exact === true,
      });
    }
    router.push(res.link);
    reset();
    inputRef.current?.blur();
    onDone?.();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      reset();
      inputRef.current?.blur();
      onDone?.();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      const res = results[activeIndex];
      if (res) { e.preventDefault(); go(res); }
    }
  };

  const dropdown = showDropdown && pos && createPortal(
    <div
      ref={dropdownRef}
      role="listbox"
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}
      className="z-[99999] bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
    >
      <div className="max-h-[60vh] overflow-y-auto py-1">
        {searching && results.length === 0 ? (
          <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin text-primary" />
            Searching your vault...
          </div>
        ) : results.length === 0 ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">
            No matches for &quot;{trimmed}&quot;
          </div>
        ) : (
          results.map((res, index) => {
            const isSelected = index === activeIndex;
            return (
              <button
                key={res.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => go(res)}
                className={cn(
                  'w-full text-left flex items-center justify-between gap-3 px-4 py-2.5 transition-colors border-l-2',
                  isSelected ? 'bg-primary/10 border-l-primary' : 'border-l-transparent hover:bg-muted/40',
                )}
              >
                <div className="flex flex-col min-w-0">
                  <span className={cn('text-sm font-semibold truncate', isSelected ? 'text-primary' : 'text-foreground')}>
                    {res.title}
                  </span>
                  {res.subtitle && (
                    <span className="text-xs text-muted-foreground truncate">{res.subtitle}</span>
                  )}
                </div>
                <Badge variant={isSelected ? 'default' : 'secondary'} className="text-2xs font-bold uppercase shrink-0 py-0 h-5 px-2">
                  {res.module}
                </Badge>
              </button>
            );
          })
        )}
      </div>
      {results.length > 0 && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-border/60 text-2xs text-muted-foreground bg-muted/20">
          <span>{results.length} result{results.length !== 1 ? 's' : ''}{searching ? ' · updating…' : ''}</span>
          <span className="hidden sm:inline">↑↓ to move · Enter to open · Esc to clear</span>
        </div>
      )}
    </div>,
    document.body,
  );

  return (
    <div
      ref={boxRef}
      className={cn(
        'flex items-center gap-2 px-3 h-9 w-full rounded-lg border border-border/85 bg-background/30 text-xs',
        'focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/20 transition-all',
        className,
      )}
    >
      <Search size={13} className="text-muted-foreground shrink-0" />
      <input
        ref={inputRef}
        type="search"
        value={query}
        autoFocus={autoFocus}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Search records..."
        aria-label="Search records"
        aria-expanded={showDropdown}
        autoComplete="off"
        spellCheck={false}
        className="flex-1 min-w-0 bg-transparent border-none outline-none text-foreground placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
      />
      {query ? (
        <button
          type="button"
          onClick={() => { reset(); inputRef.current?.focus(); }}
          aria-label="Clear search"
          className="text-muted-foreground hover:text-foreground shrink-0"
        >
          <X size={13} />
        </button>
      ) : variant === 'sidebar' && (
        <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-0.5 rounded border border-border bg-muted px-1.5 font-mono text-2xs font-medium text-muted-foreground shrink-0">
          <span className="text-xs">⌘</span>K
        </kbd>
      )}
      {dropdown}
    </div>
  );
});

export default GlobalSearch;
