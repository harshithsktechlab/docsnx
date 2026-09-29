'use client';

import React, { useMemo, useState } from 'react';
import { Search, RotateCcw, SlidersHorizontal, Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { ALL_NAV_MODULES, UTILITY_MODULES, PERMISSION_MODULE_KEYS } from '@/lib/moduleRegistry';
import {
  LEVELS,
  PRESETS,
  CUSTOM_LEVEL,
  levelToFlags,
  flagsToLevel,
  levelLabel,
  levelDescription,
  permissionsForLevel,
  summarizePermissions,
  matchingPreset,
} from '@/lib/permissionLevels';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  PERMISSION MATRIX — shared by "Add member" and "Edit permissions"       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * There used to be two of these: a flat 20-module checkbox grid in the Add
 * dialog and a two-grain accordion on the Edit screen. They disagreed, so a
 * member could not be given sub-category access at the moment of creation —
 * only afterwards, on a different screen, in a different shape.
 *
 * One component now serves both. `value` is the flat permission array the API
 * already speaks: one MODULE DEFAULT row per key (`documentKey: null`) plus a
 * row for each sub-category OVERRIDE. Untouched sub-categories have no row and
 * inherit, which is what lets a category added to the taxonomy later reach
 * existing members instead of being invisible to them.
 *
 * ── WHY ONE SELECT AND NOT FIVE CHECKBOXES ──────────────────────────────────
 * 20 modules and 83 sub-categories at five checkboxes each is 515 controls.
 * Each row instead offers the access ladder from permissionLevels.ts, with the
 * raw flags still reachable per row for combinations the ladder cannot express.
 * See that file for why this is lossy on purpose and why it never rewrites a
 * row the admin did not touch.
 *
 * ── SAYING WHAT IT MEANS ────────────────────────────────────────────────────
 * A rung's name is not a permission: "Manager" and "Contributor" tell an admin
 * nothing on their own. Every row, and every option inside every select, now
 * carries the rung's description in plain words, and the bar pinned to the foot
 * of the list totals up what the member ends up with. The list is ALWAYS
 * rendered — picking a role used to hide it, so the last thing an admin saw
 * before pressing "Create Member" was a five-word card.
 *
 * ── DISCLOSURE ──────────────────────────────────────────────────────────────
 *   presets      → three cards; a one-click starting point, not a mode
 *   module rows  → one line each, 20 of them, always visible
 *   sub-category → one line each, inside the module's accordion
 */

/** The five raw flags, for the per-row advanced expander. */
const PERMISSION_FLAGS = [
  { key: 'canView', label: 'View', accent: 'accent-primary' },
  { key: 'canAdd', label: 'Add', accent: 'accent-emerald-500' },
  { key: 'canEdit', label: 'Edit', accent: 'accent-amber-500' },
  { key: 'canDelete', label: 'Delete', accent: 'accent-destructive' },
  { key: 'canShare', label: 'Share', accent: 'accent-blue-500' },
];

const MODULE_LABELS = {
  ...Object.fromEntries(ALL_NAV_MODULES.map((m) => [m.key, m.name])),
  ...Object.fromEntries(UTILITY_MODULES.filter((m) => m.key).map((m) => [m.key, m.name])),
  other: 'Others (unfiled scans)',
  audit_logs: 'Audit Logs',
  invoices: 'Invoices',
};

/**
 * Module keys with no sub-categories — they render as one flat row each.
 *
 * Measured against ALL_NAV_MODULES, both taxonomies. Against the personal half
 * alone the fourteen business modules fell through to here and rendered as flat
 * rows, so their sub-categories could not be granted at all.
 */
const FLAT_MODULE_KEYS = PERMISSION_MODULE_KEYS.filter(
  (k) => !ALL_NAV_MODULES.some((m) => m.key === k),
);

/** How each rung reads in the summary bar. Deliberately three tones, not five. */
const LEVEL_BADGE = {
  none: 'muted',
  view: 'secondary',
  contribute: 'info',
  manage: 'info',
  full: 'success',
  [CUSTOM_LEVEL]: 'warning',
};

/**
 * The canView implication, in one place: you cannot add to what you cannot see,
 * and taking view away takes everything with it.
 */
function applyFlag(row, field) {
  const nextVal = !row[field];
  if (field === 'canView' && !nextVal) {
    return { ...row, canView: false, canAdd: false, canEdit: false, canDelete: false, canShare: false };
  }
  if (field !== 'canView' && nextVal) {
    return { ...row, [field]: true, canView: true };
  }
  return { ...row, [field]: nextVal };
}

const emptyFlags = { canView: false, canAdd: false, canEdit: false, canDelete: false, canShare: false };

/** A section title with the sentence that explains what the section is for. */
function SectionHeading({ step, title, subtitle, aside }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border/50 pb-2">
      <div className="flex flex-wrap items-center gap-2">
        <h5 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          {step ? `${step}. ${title}` : title}
        </h5>
        {aside}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{subtitle}</p>
    </div>
  );
}

/**
 * The access control itself: a level select, a drawer of raw flags for the
 * combinations the ladder cannot express, and an optional reset-to-inherit.
 * Used bare in a module header and inside AccessRow everywhere else.
 */
function LevelControl({ level, options, onLevelChange, flags, onFlagToggle, onReset, canReset }) {
  const [showFlags, setShowFlags] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 sm:justify-end">
        <Select value={level} onValueChange={onLevelChange}>
          {/* The trigger shows the label only — the description lives in the
              list, where it is read at the moment of deciding. */}
          <SelectTrigger className="h-9 w-full text-xs sm:w-[172px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((opt) => (
              <SelectItem
                key={opt.key}
                value={opt.key}
                description={opt.description}
                className="text-xs"
              >
                {opt.label}
              </SelectItem>
            ))}
            {/* Offered only as a readback of an odd row, never as a choice. */}
            {level === CUSTOM_LEVEL && (
              <SelectItem
                value={CUSTOM_LEVEL}
                description={levelDescription(CUSTOM_LEVEL)}
                className="text-xs"
              >
                Custom
              </SelectItem>
            )}
          </SelectContent>
        </Select>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          title="Set individual permissions"
          aria-label="Set individual permissions"
          aria-pressed={showFlags}
          onClick={() => setShowFlags((v) => !v)}
          className={`h-9 w-9 shrink-0 px-0 ${showFlags ? 'text-primary' : 'text-muted-foreground'}`}
        >
          <SlidersHorizontal size={14} />
        </Button>

        {onReset && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            title="Follow the module again"
            aria-label="Follow the module again"
            disabled={!canReset}
            onClick={onReset}
            className="h-9 w-9 shrink-0 px-0 text-muted-foreground disabled:opacity-30"
          >
            <RotateCcw size={13} />
          </Button>
        )}
      </div>

      {/* Two columns on a phone rather than five labels wrapping mid-word. */}
      {showFlags && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md bg-muted/30 p-2.5 sm:grid-cols-5">
          {PERMISSION_FLAGS.map((flag) => (
            <label
              key={flag.key}
              className="flex cursor-pointer select-none items-center gap-1.5 text-xs font-semibold text-muted-foreground"
            >
              <input
                type="checkbox"
                checked={!!flags[flag.key]}
                onChange={() => onFlagToggle(flag.key)}
                className={`h-4 w-4 rounded border-border bg-field ${flag.accent} cursor-pointer`}
              />
              {flag.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** A labelled row: name and what it grants on the left, the control on the right. */
function AccessRow({ label, subtitle, badge, indent = false, labelClass, ...control }) {
  return (
    <div
      className={`flex flex-col gap-2 py-2.5 ${
        indent
          ? 'rounded-lg border border-border/40 bg-background/20 px-3'
          : 'border-b border-border/40 last:border-b-0'
      } sm:flex-row sm:items-start sm:justify-between sm:gap-3`}
    >
      {/* Stacks under 640px so a long category name never squeezes the select. */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:pt-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className={`break-words ${labelClass || 'text-sm font-semibold text-foreground'}`}>
            {label}
          </span>
          {badge}
        </div>
        {subtitle && (
          <span className="text-xs leading-snug text-muted-foreground">{subtitle}</span>
        )}
      </div>
      <div className="shrink-0">
        <LevelControl {...control} />
      </div>
    </div>
  );
}

export default function PermissionMatrix({ value, onChange, showPresets = false }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  /** Reveals the modules of the account this member does NOT belong to. */
  const [showOtherAccount, setShowOtherAccount] = useState(false);

  const findPerm = (module, documentKey = null) =>
    value.find((p) => p.module === module && (p.documentKey ?? null) === documentKey);

  /** What a sub-category actually obeys: its override, else the module default. */
  const effectivePerm = (module, documentKey) =>
    findPerm(module, documentKey) || findPerm(module) || emptyFlags;

  const overrideCounts = useMemo(() => {
    const counts = {};
    for (const p of value) if (p.documentKey) counts[p.module] = (counts[p.module] || 0) + 1;
    return counts;
  }, [value]);

  const summary = useMemo(() => summarizePermissions(value), [value]);

  /**
   * Derived, never remembered: a preset card is lit only while the permissions
   * still match it, so changing one module after clicking "Viewer" drops the
   * highlight instead of leaving the card claiming something untrue.
   */
  const activePreset = useMemo(() => matchingPreset(value), [value]);

  /**
   * Module-default writes create the row when it is missing. A member is seeded
   * with their own account's modules only, so a module shown through "show the
   * other account" has no row yet — mapping over `value` alone made it ungrantable.
   */
  const updateModuleRow = (module, update) => {
    const existing = findPerm(module);
    onChange(existing
      ? value.map((p) => (p === existing ? update(p) : p))
      : [...value, update({ module, documentKey: null, ...emptyFlags })]);
  };

  const setModuleFlags = (module, flags) => updateModuleRow(module, (p) => ({ ...p, ...flags }));

  const setModuleLevel = (module, level) => setModuleFlags(module, levelToFlags(level));

  const toggleModuleFlag = (module, field) => updateModuleRow(module, (p) => applyFlag(p, field));

  /**
   * Setting a sub-category writes an override; "follow the module" DELETES the
   * row rather than storing a copy of the default, so a later change to the
   * module default keeps reaching it.
   */
  const setSubLevel = (module, documentKey, level) => {
    if (level === 'inherit') {
      onChange(value.filter((p) => !(p.module === module && p.documentKey === documentKey)));
      return;
    }
    const flags = levelToFlags(level);
    const existing = findPerm(module, documentKey);
    if (existing) {
      onChange(value.map((p) => (p === existing ? { ...p, ...flags } : p)));
      return;
    }
    onChange([...value, { module, documentKey, ...flags }]);
  };

  /** Toggling a raw flag on an inheriting sub-category creates the override. */
  const toggleSubFlag = (module, documentKey, field) => {
    const existing = findPerm(module, documentKey);
    if (existing) {
      onChange(value.map((p) => (p === existing ? applyFlag(p, field) : p)));
      return;
    }
    const base = findPerm(module) || emptyFlags;
    onChange([
      ...value,
      applyFlag(
        {
          module,
          documentKey,
          canView: !!base.canView,
          canAdd: !!base.canAdd,
          canEdit: !!base.canEdit,
          canDelete: !!base.canDelete,
          canShare: !!base.canShare,
        },
        field,
      ),
    ]);
  };

  /**
   * A preset resets to module defaults only and drops every override — it is a
   * fresh start, and silently keeping overrides from a previous choice would
   * make the resulting access impossible to predict from the card you clicked.
   */
  const applyPreset = (key) => {
    const chosen = PRESETS.find((p) => p.key === key);
    if (!chosen?.level) return;
    // The modules already on the form, i.e. this member's account. Expanding to
    // PERMISSION_MODULE_KEYS handed a company member the household's modules too
    // (and put them back at the top of the list) the moment a card was clicked.
    const heldKeys = [...new Set(value.filter((p) => !p.documentKey).map((p) => p.module))];
    onChange(permissionsForLevel(heldKeys.length ? heldKeys : PERMISSION_MODULE_KEYS, chosen.level));
  };

  const setAllModules = (level) => {
    const flags = levelToFlags(level);
    onChange(value.filter((p) => !p.documentKey).map((p) => ({ ...p, ...flags })));
  };

  const moduleLevel = (key) => flagsToLevel(findPerm(key) || emptyFlags);

  const q = query.trim().toLowerCase();
  const matches = (name) => !q || name.toLowerCase().includes(q);

  const filterChips = [
    { key: 'all', label: 'All', count: summary.total },
    { key: 'granted', label: 'With access', count: summary.total - summary.hidden },
    { key: 'hidden', label: 'Hidden', count: summary.hidden },
    { key: 'overrides', label: 'Overridden', count: summary.overrides },
  ];

  /**
   * A chip whose count has just fallen to zero — the last override cleared, the
   * last module un-hidden — falls back to All rather than leaving the admin
   * staring at an empty list they did not ask for.
   */
  const activeChip = filterChips.find((c) => c.key === filter);
  const effectiveFilter = activeChip && activeChip.count > 0 ? filter : 'all';

  /** The chips and the search box narrow the same list, ANDed together. */
  const passesFilter = (key) => {
    if (effectiveFilter === 'all') return true;
    if (effectiveFilter === 'overrides') return (overrideCounts[key] || 0) > 0;
    if (effectiveFilter === 'hidden') return moduleLevel(key) === 'none';
    return moduleLevel(key) !== 'none';
  };

  /**
   * ── THE MATRIX SHOWS THE MEMBER'S OWN ACCOUNT ────────────────────────────
   *
   * A member belongs to one account, and is seeded with only that account's
   * modules. So the rows they HOLD are the rows worth showing: a personal
   * member's screen lists thirteen household modules, not those plus fourteen
   * company ones they were deliberately not given.
   *
   * Derived from `value` rather than from a prop, so it follows the member
   * without a second source of truth to keep in step. `held` is empty only for
   * an admin (who holds no rows and bypasses the grid anyway) — everything is
   * shown then, which is the right answer for the one case with no account.
   */
  const held = new Set(value.map((p) => p.module));
  const inAccount = (key) => held.size === 0 || held.has(key) || showOtherAccount;

  const visibleModules = ALL_NAV_MODULES.filter(
    (m) => inAccount(m.key) && passesFilter(m.key)
      && (matches(m.name) || m.subCategories.some((s) => matches(s.name))),
  );
  const visibleFlat = FLAT_MODULE_KEYS.filter(
    (k) => inAccount(k) && passesFilter(k) && matches(MODULE_LABELS[k] || k),
  );

  /**
   * How many modules the OTHER account holds, for the disclosure below.
   *
   * Granting across accounts stays possible — the chosen model is defaults, not
   * prohibition — it just is not the thing an admin trips over.
   */
  const otherAccountCount = held.size === 0 ? 0
    : PERMISSION_MODULE_KEYS.filter((k) => !held.has(k)).length;

  /** Strongest rung first — the grant is what an admin is checking for. */
  const summarySegments = [...LEVELS]
    .reverse()
    .concat([{ key: CUSTOM_LEVEL, label: 'Custom' }])
    .filter((l) => summary.byLevel[l.key])
    .map((l) => ({ ...l, count: summary.byLevel[l.key] }));

  const levelOptions = LEVELS.map((l) => ({
    key: l.key,
    label: l.label,
    description: l.description,
  }));
  const subLevelOptions = (module) => {
    const parent = moduleLevel(module);
    return [
      {
        key: 'inherit',
        label: 'Follow the module',
        description: `Currently ${levelLabel(parent)} — ${levelDescription(parent)}`,
      },
      ...levelOptions,
    ];
  };

  return (
    <div className="flex flex-col gap-4">
      {/* ── Tier 0: presets. A starting point, not a mode. ──────────────── */}
      {showPresets && (
        <div className="flex flex-col gap-2">
          <SectionHeading
            step={1}
            title="Start from a role"
            subtitle="Sets every module at once, and clears any category you set on its own. Adjust individual modules below."
            aside={
              activePreset === 'custom' ? (
                <Badge variant="warning" className="text-2xs">
                  Custom
                </Badge>
              ) : null
            }
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {PRESETS.filter((p) => p.level).map((p) => {
              const active = activePreset === p.key;
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => applyPreset(p.key)}
                  aria-pressed={active}
                  className={`flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors ${
                    active
                      ? 'border-primary/60 bg-primary/10'
                      : 'border-border/50 bg-card hover:border-border hover:bg-card/70'
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-xs font-bold text-foreground">
                    {active && <Check size={12} className="shrink-0 text-primary" />}
                    {p.label}
                    {/* What a new member gets if the admin changes nothing. */}
                    {p.level === 'contribute' && (
                      <Badge variant="secondary" className="text-2xs">
                        Default
                      </Badge>
                    )}
                  </span>
                  <span className="text-xs leading-snug text-muted-foreground">
                    {p.description}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Tier 1 + 2: modules, each expanding to its sub-categories ───── */}
      <div className="flex flex-col gap-3">
        <SectionHeading
          step={showPresets ? 2 : null}
          title="Fine-tune by module"
          subtitle="Open a module to allow or deny one of its categories on its own. A category with no setting of its own follows the module, including any category added later."
        />

        {/* ── Toolbar: 20 modules and 83 sub-categories need a way in. ── */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="relative flex-1 sm:max-w-[260px]">
              <Search
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search modules or categories…"
                className="h-9 pl-8 text-xs"
              />
            </div>
            {/* Clears every sub-category override as well as setting the module
                defaults. It has to: an override BEATS the default it sits under
                (see hasPermission in lib/auth.ts), so leaving them behind would
                make "set everything to No access" not actually mean that. The
                consequence is stated below the control, not hidden in a title. */}
            <div className="flex flex-col items-start gap-1 sm:items-end">
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-xs font-semibold text-muted-foreground">
                  Apply to all modules
                </span>
                <Select value="" onValueChange={setAllModules}>
                  <SelectTrigger className="h-9 w-[150px] text-xs">
                    <SelectValue placeholder="Choose…" />
                  </SelectTrigger>
                  <SelectContent>
                    {levelOptions.map((opt) => (
                      <SelectItem
                        key={opt.key}
                        value={opt.key}
                        description={opt.description}
                        className="text-xs"
                      >
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {summary.overrides > 0 && (
                <span className="text-xs text-warning-text">
                  Also clears {summary.overrides} category override
                  {summary.overrides === 1 ? '' : 's'}.
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {filterChips.map((chip) => {
              const active = effectiveFilter === chip.key;
              return (
                <button
                  key={chip.key}
                  type="button"
                  aria-pressed={active}
                  disabled={chip.count === 0 && chip.key !== 'all'}
                  onClick={() => setFilter(chip.key)}
                  className={`rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    active
                      ? 'border-primary/60 bg-primary/10 text-foreground'
                      : 'border-border/50 text-muted-foreground hover:border-border hover:text-foreground'
                  }`}
                >
                  {chip.label} <span className="opacity-60">{chip.count}</span>
                </button>
              );
            })}
          </div>
        </div>

        <Accordion type="multiple" className="w-full">
          {visibleModules.map((mod) => {
            const perm = findPerm(mod.key) || emptyFlags;
            const level = flagsToLevel(perm);
            const overrides = overrideCounts[mod.key] || 0;
            const subs = mod.subCategories.filter((s) => matches(s.name) || matches(mod.name));
            return (
              <AccordionItem key={mod.key} value={mod.key}>
                <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                  {/* The width lives on this wrapper, never on the trigger:
                      AccordionTrigger renders inside a shrink-to-fit <Header>,
                      so a percentage max-width there resolves against a width
                      that depends on the trigger itself and collapses the
                      module name to two characters. */}
                  <div className="min-w-0 flex-1">
                    {/* justify-start keeps the chevron beside the module name
                        instead of stranding it halfway across the row, where it
                        read as part of the access control next to it. */}
                    <AccordionTrigger className="w-full items-start justify-start gap-2">
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="break-words">{mod.name}</span>
                          <span className="shrink-0 text-xs font-medium text-faint">
                            {mod.subCategories.length} items
                          </span>
                          {overrides > 0 && (
                            <Badge variant="warning" className="shrink-0 text-2xs font-bold">
                              {overrides} override{overrides === 1 ? '' : 's'}
                            </Badge>
                          )}
                        </span>
                        <span className="text-xs font-normal leading-snug text-muted-foreground">
                          {levelDescription(level)}
                        </span>
                      </span>
                    </AccordionTrigger>
                  </div>
                  <div className="shrink-0 pb-2 sm:pb-0 sm:pt-1">
                    <LevelControl
                      level={level}
                      options={levelOptions}
                      onLevelChange={(lvl) => setModuleLevel(mod.key, lvl)}
                      flags={perm}
                      onFlagToggle={(f) => toggleModuleFlag(mod.key, f)}
                    />
                  </div>
                </div>

                <AccordionContent className="pb-3">
                  <div className="flex flex-col gap-2 border-l-2 border-border/60 pl-3 sm:pl-4">
                    {subs.map((sub) => {
                      const override = findPerm(mod.key, sub.documentKey);
                      const eff = effectivePerm(mod.key, sub.documentKey);
                      const effLevel = flagsToLevel(eff);
                      return (
                        <AccessRow
                          key={sub.documentKey}
                          indent
                          label={sub.name}
                          labelClass="text-xs font-medium text-foreground/90"
                          subtitle={
                            override
                              ? `Only here — ${levelDescription(effLevel)}`
                              : `Follows the module — ${levelLabel(effLevel)}`
                          }
                          badge={
                            override ? (
                              <Badge variant="warning" className="shrink-0 text-2xs font-bold">
                                Override
                              </Badge>
                            ) : null
                          }
                          level={override ? flagsToLevel(override) : 'inherit'}
                          options={subLevelOptions(mod.key)}
                          onLevelChange={(lvl) => setSubLevel(mod.key, sub.documentKey, lvl)}
                          flags={eff}
                          onFlagToggle={(f) => toggleSubFlag(mod.key, sub.documentKey, f)}
                          onReset={() => setSubLevel(mod.key, sub.documentKey, 'inherit')}
                          canReset={!!override}
                        />
                      );
                    })}
                  </div>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>

        {/* ── Everything without sub-categories: one grain, one row. ──── */}
        {visibleFlat.length > 0 && (
          <div className="flex flex-col border-t border-border/60 pt-3">
            <span className="text-xs font-bold uppercase tracking-widest text-faint">
              Tools &amp; system areas
            </span>
            <span className="pb-1 text-xs text-muted-foreground">
              These have no categories — one setting each.
            </span>
            {visibleFlat.map((key) => {
              const perm = findPerm(key) || emptyFlags;
              return (
                <AccessRow
                  key={key}
                  label={MODULE_LABELS[key] || key}
                  subtitle={levelDescription(flagsToLevel(perm))}
                  level={flagsToLevel(perm)}
                  options={levelOptions}
                  onLevelChange={(lvl) => setModuleLevel(key, lvl)}
                  flags={perm}
                  onFlagToggle={(f) => toggleModuleFlag(key, f)}
                />
              );
            })}
          </div>
        )}

        {/*
            ── THE OTHER ACCOUNT ──────────────────────────────────────────────
            A member belongs to one account, so the rows above are their own.
            Granting across accounts is still allowed — the model is defaults,
            not prohibition — but it has to be asked for, because handing a
            company member the household's modules is exactly the mistake the
            split exists to stop being the default.
        */}
        {otherAccountCount > 0 && !q && filter === 'all' && (
          <div className="border-t border-border/40 pt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground"
              onClick={() => setShowOtherAccount((v) => !v)}
            >
              {showOtherAccount
                ? 'Hide the other account\u2019s modules'
                : `Show the other account\u2019s ${otherAccountCount} modules`}
            </Button>
            {showOtherAccount && (
              <p className="px-3 pb-1 text-2xs text-muted-foreground">
                Granting these makes this member part of both accounts.
              </p>
            )}
          </div>
        )}

        {visibleModules.length === 0 && visibleFlat.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-6">
            <p className="text-center text-xs text-muted-foreground">
              {q ? `Nothing matches “${query}”.` : 'Nothing matches this filter.'}
            </p>
            {(q || filter !== 'all') && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setQuery('');
                  setFilter('all');
                }}
              >
                Clear search and filters
              </Button>
            )}
          </div>
        )}

        {/* ── The total, pinned to the foot of the list: what the member ends
               up with, in the same words as the rows above. ───────────── */}
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/60 bg-popover/95 py-2 backdrop-blur">
          <span className="text-xs font-bold uppercase tracking-widest text-faint">
            This member gets
          </span>
          {summarySegments.map((seg) => (
            <Badge key={seg.key} variant={LEVEL_BADGE[seg.key] || 'muted'} className="text-2xs">
              {seg.count} {seg.label}
            </Badge>
          ))}
          {summary.overrides > 0 && (
            <button
              type="button"
              onClick={() => setFilter('overrides')}
              className="text-xs font-semibold text-warning-text underline-offset-2 hover:underline"
            >
              {summary.overrides} category override{summary.overrides === 1 ? '' : 's'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
