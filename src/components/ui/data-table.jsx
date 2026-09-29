'use client';

import React, { useState, useEffect } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { RecordCard } from '@/components/ui/record-card';
import { Search, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Collapse a flat option list into consecutive runs sharing the same optional
 * `group` label, so a long filter (e.g. 83 document categories) can render
 * under module headings. Options without a `group` pass through ungrouped.
 */
function groupOptions(options = []) {
  const chunks = [];
  for (const opt of options) {
    const group = opt.group || null;
    const last = chunks[chunks.length - 1];
    if (last && last.group === group) last.items.push(opt);
    else chunks.push({ group, items: [opt] });
  }
  return chunks;
}

/**
 * A filter's values, read off the URL. One comma-separated param rather than a
 * repeated key: several list routes parse their filters with a `forEach` over
 * `searchParams`, which folds `?a=1&a=2` down to the last value — see
 * `splitFilterValues` in src/lib/listFilters.ts, the server half of this.
 */
export function parseFilterValues(raw) {
  if (!raw) return [];
  const seen = new Set();
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

/**
 * A filter that takes SEVERAL values, for `filterDefinitions` entries marked
 * `multiple`. Everything else still renders the single-choice Radix <Select>
 * below, so the four other pages using this table are untouched.
 *
 * Hand-rolled rather than a library control: Radix's <Select> has no multiple
 * mode and the app carries no popover/dropdown-menu package. The open panel is
 * the same shape as every other menu in the app — a full-screen click-catcher
 * under an absolutely positioned list — so a click outside closes it without a
 * document-level listener.
 */
function MultiSelectFilter({ label, allLabel, options, values, disabled, align = 'start', onChange }) {
  const [open, setOpen] = useState(false);
  const selected = new Set(values);

  const toggle = (value) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    // Deliberately keeps the panel open: picking several values is the whole
    // point, and closing after each one would make it a slower single-select.
    onChange([...next]);
  };

  // The one chosen option's own label reads better than "Category · 1", and is
  // what a member who picked a single value expects to see.
  const triggerLabel = selected.size === 0
    ? label
    : selected.size === 1
      ? (options.find((o) => selected.has(o.value))?.label ?? `${label} · 1`)
      : `${label} · ${selected.size}`;

  return (
    <div className="relative w-full sm:w-auto">
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          'h-10 w-full sm:w-[150px] justify-between gap-2 rounded-md border-input bg-card px-3 text-sm font-normal',
          selected.size === 0 && 'text-muted-foreground',
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
        /* The trigger is a 150px button and cannot hold 'Aadhaar Card (all
           members)', so it still truncates — but the whole pick is one hover
           (or long-press) away rather than lost. */
        title={triggerLabel}
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div
            role="listbox"
            aria-multiselectable="true"
            className={cn(
              'absolute z-50 mt-1 max-h-[320px] overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
              /* NOT `w-full`. Below `sm` the filters are a two-column grid, so
                 the container is ~150px of a 375px phone and a panel matching it
                 showed 83 sub-categories as clipped fragments. `100vw - 2rem` is
                 the page gutter on either side (GUTTER in e2e/mobile-layout),
                 so the panel is as wide as the screen allows and still cannot
                 push the document sideways. */
              'w-[min(20rem,calc(100vw-2rem))] sm:w-[280px]',
              /* A right-column filter has to grow LEFTWARDS or it opens off the
                 edge of the screen. Above `sm` the filters are a flex strip and
                 every panel anchors left again. */
              align === 'end' ? 'right-0 sm:left-0 sm:right-auto' : 'left-0',
            )}
          >
            <button
              type="button"
              onClick={() => onChange([])}
              className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            >
              {allLabel || `All ${label}`}
            </button>
            {groupOptions(options).map((chunk, i) => (
              <div key={`${label}-${chunk.group || 'ungrouped'}-${i}`}>
                {chunk.group && (
                  <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                    {chunk.group}
                  </div>
                )}
                {chunk.items.map((opt) => (
                  <label
                    key={opt.value}
                    /* `items-start`, not `items-center`: a wrapped label would
                       otherwise drag the box down to its middle. */
                    className="flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                  >
                    <Checkbox
                      checked={selected.has(opt.value)}
                      onCheckedChange={() => toggle(opt.value)}
                      aria-label={opt.label}
                      className="mt-0.5 shrink-0"
                    />
                    {/* Wraps rather than truncates. Choosing between 'Motor
                        Insurance Policy' and 'Motor Insurance Claim' is
                        impossible when both read 'Motor Insu…'. */}
                    <span className="whitespace-normal break-words leading-snug">{opt.label}</span>
                  </label>
                ))}
              </div>
            ))}
            {options.length === 0 && (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">Nothing to filter by</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function DataTable({
  data,
  columns,
  renderCard,
  /**
   * `[{ key, label, options, ... }]`, each one a dropdown bound to a URL param.
   *
   * Optional per filter:
   *  - `multiple`  — several values at once, sent as one comma-separated param.
   *  - `allLabel`  — overrides the default "All {label}" reset row.
   *  - `disabled`  — rendered but not usable.
   *  - `resets`    — sibling params nulled whenever this filter changes.
   *  - `derive(value, searchParams)` — extra `{ key: value|null }` updates
   *    applied in the same URL write; see `handleFilterChange`.
   */
  filterDefinitions = [],
  pagination,
  loading = false,
  emptyMessage = "No results found.",
  /**
   * ── SELECTION (opt-in) ──────────────────────────────────────────────────
   * Off unless `selectable` is passed, so every existing caller renders
   * exactly as before.
   *
   * The selection itself is the CALLER's state, not the table's: a bulk action
   * has to survive the refetch it triggers, and the toolbar needs the ids to
   * decide what to enable. `getRowId` exists because not every list is keyed
   * on `id`.
   */
  selectable = false,
  selectedIds = [],
  onSelectionChange,
  getRowId = (row) => row.id,
  /** `[{ key, label, icon, onClick(ids), variant, destructive }]`. */
  bulkActions = [],
  /**
   * How many rows the CURRENT FILTERS match in total, not just on this page.
   * Drives the "select all N matching" affordance — without it the table
   * cannot tell a 12-row result from page one of 400.
   */
  totalMatching = 0,
  /**
   * Called when the user asks for everything the filters match. The table has
   * only the current page, so the caller fetches the full id set.
   */
  onSelectAllMatching,
  /**
   * Tapping a mobile record card. Exists because the card CHROME belongs to the
   * table now (see <RecordCard>) — a caller whose whole row is a link no longer
   * has an element of its own to hang the handler on.
   */
  onCardClick,
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Local state for search to avoid lagging the input field
  const [searchTerm, setSearchTerm] = useState(searchParams.get('search') || '');

  // Debounce search update to URL
  useEffect(() => {
    const timer = setTimeout(() => {
      const currentUrlSearch = searchParams.get('search') || '';
      if (searchTerm !== currentUrlSearch) {
        updateURL({ search: searchTerm, page: 1 });
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [searchTerm, searchParams]);

  // Sync external URL changes to local search state
  useEffect(() => {
    setSearchTerm(searchParams.get('search') || '');
  }, [searchParams]);

  const updateURL = (updates) => {
    const params = new URLSearchParams(searchParams.toString());
    
    Object.keys(updates).forEach((key) => {
      if (updates[key] === null || updates[key] === '' || updates[key] === undefined) {
        params.delete(key);
      } else {
        params.set(key, updates[key]);
      }
    });

    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const handleSort = (key) => {
    const currentSort = searchParams.get('sortBy');
    const currentOrder = searchParams.get('sortOrder');
    
    if (currentSort === key) {
      updateURL({ sortOrder: currentOrder === 'asc' ? 'desc' : 'asc' });
    } else {
      updateURL({ sortBy: key, sortOrder: 'asc' });
    }
  };

  /**
   * `filter.resets` names the keys a CHILD filter owns — a cascaded filter whose
   * options depend on this one. They are nulled in the same `updateURL` call, so
   * switching Module never leaves the previous module's sub-category in the URL
   * ANDed against the new one (a filter pair that matches nothing).
   */
  const handleFilterChange = (filter, value) => {
    const updates = { [filter.key]: value === 'all' ? null : value, page: 1 };
    for (const key of filter.resets || []) updates[key] = null;
    // `derive` is the softer alternative to `resets`: instead of nulling a
    // sibling filter outright, the caller computes what that filter should
    // become given this one's new value — the Document Manager uses it to drop
    // only the sub-categories that fall outside the newly chosen categories,
    // rather than clearing the whole sub-category selection.
    Object.assign(updates, filter.derive?.(value, searchParams) || {});
    updateURL(updates);
  };

  /** Same, for a `multiple` filter: the values are joined into one param. */
  const handleMultiFilterChange = (filter, values) => {
    handleFilterChange(filter, values.length > 0 ? values.join(',') : null);
  };

  /**
   * Every key any filter owns — its own, plus the children it resets. A child
   * filter can be `disabled` rather than absent, but a caller may still drop one
   * entirely, so the reset keys are collected too.
   */
  const filterKeys = React.useMemo(() => {
    const keys = new Set();
    for (const filter of filterDefinitions) {
      keys.add(filter.key);
      for (const key of filter.resets || []) keys.add(key);
    }
    return [...keys];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterDefinitions.map((f) => `${f.key}:${(f.resets || []).join(',')}`).join('|')]);

  const activeFilterCount = filterKeys.filter((key) => searchParams.get(key)).length
    + (searchParams.get('search') ? 1 : 0);

  // Deliberately leaves `sortBy`/`sortOrder` alone: a column sort is not a
  // filter — it changes the order of the results, not which ones there are.
  const handleClearFilters = () => {
    const updates = { search: null, page: 1 };
    for (const key of filterKeys) updates[key] = null;
    setSearchTerm('');
    updateURL(updates);
  };

  const handlePageChange = (newPage) => {
    updateURL({ page: newPage });
  };

  const currentSortBy = searchParams.get('sortBy');
  const currentSortOrder = searchParams.get('sortOrder') || 'asc';
  
  const totalPages = pagination?.totalPages || 1;
  const currentPage = pagination?.page || 1;

  // ── Selection ─────────────────────────────────────────────────────────────
  const selected = React.useMemo(() => new Set(selectedIds), [selectedIds]);
  const pageIds = React.useMemo(
    () => (data || []).map(getRowId).filter(Boolean),
    [data, getRowId],
  );
  const selectedOnPage = pageIds.filter((id) => selected.has(id));
  const allPageSelected = pageIds.length > 0 && selectedOnPage.length === pageIds.length;
  const somePageSelected = selectedOnPage.length > 0 && !allPageSelected;
  const selectionCount = selectedIds.length;

  // The filters define the working set, so a change to them invalidates the
  // selection. Without this a user could filter to Medical, select everything,
  // filter to Vehicles, and delete the medical records they can no longer see.
  const filterSignature = searchParams.toString();
  React.useEffect(() => {
    if (selectable && selectedIds.length > 0) onSelectionChange?.([]);
    // Deliberately keyed on the URL alone: including selectedIds would clear
    // the selection the moment it was made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterSignature]);

  const toggleRow = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectionChange?.([...next]);
  };

  const togglePage = () => {
    const next = new Set(selected);
    if (allPageSelected) pageIds.forEach((id) => next.delete(id));
    else pageIds.forEach((id) => next.add(id));
    onSelectionChange?.([...next]);
  };

  // Shown only when the filters match more than this page holds — otherwise
  // the header checkbox already selected everything and the offer is a lie.
  const canSelectAllMatching = Boolean(onSelectAllMatching)
    && allPageSelected
    && totalMatching > pageIds.length
    && selectionCount < totalMatching;

  const columnCount = columns.length + (selectable ? 1 : 0);

  const selectionBar = selectable && selectionCount > 0 ? (
    <div className="flex flex-col gap-3 rounded-md border border-primary/30 bg-primary/5 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold">
          {selectionCount} selected
        </span>
        {canSelectAllMatching && (
          <button
            type="button"
            onClick={onSelectAllMatching}
            className="text-sm font-medium text-primary underline underline-offset-2 hover:opacity-80"
          >
            Select all {totalMatching} matching filters
          </button>
        )}
        <button
          type="button"
          onClick={() => onSelectionChange?.([])}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          Clear
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {bulkActions.map((action) => (
          <Button
            key={action.key}
            size="sm"
            variant={action.variant || 'outline'}
            disabled={action.disabled || loading}
            onClick={() => action.onClick(selectedIds)}
            className="gap-1.5"
          >
            {action.icon}
            {action.label}
          </Button>
        ))}
      </div>
    </div>
  ) : null;

  return (
    <div className="w-full space-y-4">
      {/* Search and Filters Toolbar */}
      <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
        <div className="relative w-full sm:max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search..."
            /* Not `bg-background` — that token is the tinted CANVAS now, and a
               control filled with it reads as a hole rather than a field. <Input>
               already paints itself `bg-field`. */
            className="pl-9 w-full"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          {searchTerm && (
            <button 
              onClick={() => setSearchTerm('')}
              className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        
        {/* Two controls per row on a phone rather than one. Each trigger is
            `w-full` below `sm`, so a list with four of them (the Document
            Manager has Module, Sub-category, Members and Clear) stacked
            into four full-width rows and pushed the results off the screen.
            `sm` and up is unchanged. */}
        {filterDefinitions.length > 0 && (
          <div className="grid grid-cols-2 gap-2 w-full sm:flex sm:flex-wrap sm:w-auto">
            {filterDefinitions.map((filter, index) => {
              if (filter.multiple) {
                return (
                  <MultiSelectFilter
                    key={filter.key}
                    label={filter.label}
                    allLabel={filter.allLabel}
                    options={filter.options}
                    values={parseFilterValues(searchParams.get(filter.key))}
                    disabled={filter.disabled}
                    /* Which half of the mobile `grid-cols-2` this one sits in —
                       the panel is wider than its cell and needs to know which
                       way to open. Ignored above `sm`. */
                    align={index % 2 === 1 ? 'end' : 'start'}
                    onChange={(values) => handleMultiFilterChange(filter, values)}
                  />
                );
              }
              const currentValue = searchParams.get(filter.key) || 'all';
              return (
                <Select
                  key={filter.key}
                  value={currentValue}
                  disabled={filter.disabled}
                  onValueChange={(val) => handleFilterChange(filter, val)}
                >
                  <SelectTrigger className="w-full sm:w-[150px] bg-card">
                    <SelectValue placeholder={filter.label} />
                  </SelectTrigger>
                  <SelectContent className="max-h-[320px]">
                    <SelectItem value="all">{filter.allLabel || `All ${filter.label}`}</SelectItem>
                    {/* Options may carry an optional `group` label; consecutive
                        options sharing one are rendered under a heading. */}
                    {groupOptions(filter.options).map((chunk, i) =>
                      chunk.group ? (
                        <SelectGroup key={`${filter.key}-${chunk.group}-${i}`}>
                          <SelectLabel>{chunk.group}</SelectLabel>
                          {chunk.items.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ) : (
                        chunk.items.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))
                      )
                    )}
                  </SelectContent>
                </Select>
              );
            })}
            {/* Only once something is actually set: a permanently visible
                "Clear" on an unfiltered list is a control that does nothing.
                Takes a grid cell like a dropdown on a phone, so it never
                orphans itself on a row of its own. */}
            {activeFilterCount > 0 && (
              <Button
                variant="ghost"
                onClick={handleClearFilters}
                className="h-10 w-full sm:w-auto gap-1.5 px-3 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
                <span>Clear filters</span>
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Bulk-action bar. Sits under the filters rather than replacing them, so
          the user can see WHICH filters produced the set they are about to act
          on — that context is the whole point of a filtered bulk action. */}
      {selectionBar}

      {/* Desktop Table View */}
      <div className="hidden md:block rounded-xl border border-border bg-card text-card-foreground shadow-glass overflow-hidden">
        <Table>
          {/* No `bg-muted/50` here any more — <TableHeader> owns its own fill,
              so every table in the app gets the same header instead of only the
              ones whose caller remembered to pass one. */}
          <TableHeader>
            <TableRow>
              {selectable && (
                <TableHead className="w-[44px]">
                  <Checkbox
                    checked={allPageSelected ? true : somePageSelected ? 'indeterminate' : false}
                    onCheckedChange={togglePage}
                    disabled={loading || pageIds.length === 0}
                    aria-label="Select all rows on this page"
                  />
                </TableHead>
              )}
              {columns.map((col) => (
                <TableHead 
                  key={col.key || col.header} 
                  className={col.sortable ? "cursor-pointer select-none" : ""}
                  onClick={() => col.sortable && handleSort(col.key)}
                >
                  <div className="flex items-center gap-1">
                    {col.header}
                    {col.sortable && currentSortBy === col.key && (
                      currentSortOrder === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
                    )}
                  </div>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={columnCount} className="h-24 text-center">
                  Loading...
                </TableCell>
              </TableRow>
            ) : data && data.length > 0 ? (
              data.map((item, rowIndex) => {
                const rowId = getRowId(item);
                return (
                <TableRow key={rowId || rowIndex} data-state={selectable && selected.has(rowId) ? 'selected' : undefined}>
                  {selectable && (
                    <TableCell className="w-[44px]">
                      <Checkbox
                        checked={selected.has(rowId)}
                        onCheckedChange={() => toggleRow(rowId)}
                        aria-label={`Select ${item.title || 'row'}`}
                      />
                    </TableCell>
                  )}
                  {columns.map((col) => (
                    <TableCell key={col.key || col.header} className={col.className}>
                      {col.render ? col.render(item) : item[col.key]}
                    </TableCell>
                  ))}
                </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell colSpan={columnCount} className="h-24 text-center text-muted-foreground">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Mobile Card View */}
      <div className="block md:hidden space-y-4">
        {loading ? (
          <div className="text-center py-8 text-muted-foreground">Loading...</div>
        ) : data && data.length > 0 ? (
          data.map((item, i) => {
            const rowId = getRowId(item);
            /* HANDED TO THE CARD, not wrapped around it.
               This used to sit OUTSIDE the card in a `flex items-start gap-3`
               row, which pushed every card ~28px right of the search box, the
               filter grid, the bulk bar, the empty state and the pager — all of
               which are flush with the container. One list, two left edges.
               So the card gets the checkbox as a node and decides where it goes;
               a caller that ignores it simply renders without one. */
            const checkbox = selectable ? (
              <Checkbox
                checked={selected.has(rowId)}
                onCheckedChange={() => toggleRow(rowId)}
                className="shrink-0"
                aria-label={`Select ${item.title || 'row'}`}
              />
            ) : null;
            return (
            /* THE CARD IS THE TABLE'S, THE CONTENT IS THE CALLER'S.
               `renderCard` used to have to draw its own border/fill/shadow, and
               the vault module list simply didn't — on a phone its records were
               unseparated stacked text. <RecordCard> is that chrome in one
               place, and it carries the selected state with the same tint and
               rail a selected desktop row gets. */
            <RecordCard
              key={rowId || i}
              selected={selectable && selected.has(rowId)}
              interactive={Boolean(onCardClick)}
              onClick={onCardClick ? () => onCardClick(item) : undefined}
            >
              {renderCard ? renderCard(item, { checkbox }) : (
                /* Fallback if renderCard is not provided */
                <div className="space-y-2 text-card-foreground">
                  {checkbox && (
                    <div className="flex justify-end pb-1">{checkbox}</div>
                  )}
                  {columns.map(col => (
                    <div key={col.key || col.header} className="flex justify-between gap-3">
                      <span className="font-semibold text-sm">{col.header}:</span>
                      <span className="text-sm min-w-0 text-right">{col.render ? col.render(item) : item[col.key]}</span>
                    </div>
                  ))}
                </div>
              )}
            </RecordCard>
            );
          })
        ) : (
          <RecordCard className="py-8 text-center text-muted-foreground">
            {emptyMessage}
          </RecordCard>
        )}
      </div>

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-4">
          <div className="text-sm text-muted-foreground">
            Page {currentPage} of {totalPages}
          </div>
          <div className="flex items-center space-x-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handlePageChange(currentPage - 1)}
              disabled={currentPage <= 1 || loading}
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handlePageChange(currentPage + 1)}
              disabled={currentPage >= totalPages || loading}
            >
              Next
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
