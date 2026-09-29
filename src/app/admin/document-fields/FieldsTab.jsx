'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  FIELD CONFIGURATION — what each sub-category collects, and how          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── WHY A GRID AND NOT A CARD PER FIELD ────────────────────────────────────
 * This is a MATRIX — fields down, settings across — and the first version drew
 * it as a stack of cards, which is the one shape that hides a matrix. A credit
 * card statement's 16 fields became ~3,000px of scroll, and "what does this
 * category encrypt?" needed sixteen scroll-stops instead of one glance down a
 * column. One aligned row per field is the whole redesign; everything below
 * follows from it.
 *
 * Four checkboxes per row, not the access ladder its sibling
 * src/app/users/PermissionMatrix.jsx uses: that screen collapses five flags
 * into a rung because 20 modules × 83 categories × 5 is 515 controls, and its
 * flags are ORDERED (view < edit < delete). These four are orthogonal —
 * encrypted, required, scan-read and identity have no ladder between them — so
 * a rung would invent an order that does not exist. 16 rows × 4 is 64 controls,
 * which a grid carries comfortably.
 *
 * ── DISCLOSURE ─────────────────────────────────────────────────────────────
 *   help panel   → what the four settings mean, once, collapsed by default
 *   field rows   → the four settings, always visible, one line each
 *   expanded row → label, type, validation, order, and why a lock is locked
 *
 * ── WHAT THE SCREEN OWES THE OPERATOR ──────────────────────────────────────
 *  1. A locked control must LOOK locked. A disabled checkbox reads as an
 *     unchecked one, which is the opposite of the truth for `cvv`, so locks
 *     render as a padlock instead.
 *  2. A changed row must say what it changed FROM, or Reset is a leap of faith.
 *  3. The two settings that can cost something — unsealing, and marking an
 *     identifier — are confirmed by typing, never by a stray click.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Loader2, Save, Search, RotateCcw, Lock, ShieldAlert, Eye, EyeOff,
  ArrowUp, ArrowDown, ChevronRight, X, HelpCircle, Plus, Trash2, Sparkles, Fingerprint,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogBody,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import CategoryFieldInputs from '@/app/components/CategoryFieldInputs';
import { FORM_HIDDEN_KEYS } from '@/lib/records/fieldValidation';
import { apiCall } from '@/lib/net/apiRequest';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE TYPE MENU IS NOT THE DATA TYPE LIST                                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * "Dropdown", "Radio buttons" and "Checkboxes" read like three types to an
 * operator and are two questions to the code: `select` ("which one") and
 * `multiselect` ("which of these"), drawn differently. So each entry here is a
 * (dataType, display) PAIR, and `id` is what the menu is keyed on.
 *
 * Splitting them into four data types would mean writing the validation rule,
 * the AI coercion and the OCR prompt line twice each, and then watching the
 * copies drift — see FieldDataType in src/lib/documentCategoryFields.ts. The
 * operator never sees the distinction; this table is where it is hidden.
 */
const DATA_TYPES = [
  { id: 'text', value: 'text', label: 'Text' },
  { id: 'longtext', value: 'longtext', label: 'Long text' },
  { id: 'number', value: 'number', label: 'Number' },
  { id: 'currency', value: 'currency', label: 'Amount' },
  { id: 'date', value: 'date', label: 'Date' },
  { id: 'time', value: 'time', label: 'Time' },
  { id: 'boolean', value: 'boolean', label: 'Yes / No' },
  { id: 'select:dropdown', value: 'select', display: 'dropdown', label: 'Dropdown (choose one)' },
  { id: 'select:radio', value: 'select', display: 'radio', label: 'Radio buttons (choose one)' },
  { id: 'multiselect:checkbox', value: 'multiselect', display: 'checkbox', label: 'Checkboxes (choose many)' },
  { id: 'multiselect:chips', value: 'multiselect', display: 'chips', label: 'Tags (choose many)' },
  { id: 'email', value: 'email', label: 'Email address' },
  { id: 'phone', value: 'phone', label: 'Phone number' },
  { id: 'url', value: 'url', label: 'Web address' },
];

/** The menu entry a stored (dataType, display) pair corresponds to. */
function typeId(dataType, display) {
  const exact = DATA_TYPES.find((t) => t.value === dataType && t.display === display);
  if (exact) return exact.id;
  // A choice field whose display was never set, or holds something unknown:
  // fall back to the first entry for that data type rather than to nothing,
  // which would leave the Select rendering an empty trigger.
  return DATA_TYPES.find((t) => t.value === dataType)?.id ?? 'text';
}

const typeById = (id) => DATA_TYPES.find((t) => t.id === id) ?? DATA_TYPES[0];

/** Does this type ask the operator for a list of answers? */
const isChoiceType = (dataType) => dataType === 'select' || dataType === 'multiselect';

/**
 * The four settings, in the order they appear across a row.
 *
 * `help` is what the panel says; `hint` is the header's `title` — the repo has
 * no tooltip primitive, and adding a popover package for one screen is not
 * worth it. `danger` marks the two that are confirmed before they take effect.
 */
const SETTINGS = [
  {
    key: 'isPii', label: 'Encrypted', short: 'Enc',
    accent: 'accent-emerald-600',
    hint: 'Stored scrambled; reading it needs an audited unlock',
    help: 'Stored scrambled. Reading the value needs an audited unlock, and it never appears in ordinary lists. Use it for anything private.',
    danger: 'off',
  },
  {
    key: 'isRequired', label: 'Mandatory', short: 'Must',
    accent: 'accent-sky-600',
    hint: 'The form will not save without it',
    help: 'The add form refuses to save until this is filled in.',
  },
  {
    key: 'isPrinted', label: 'Scan reads', short: 'Scan',
    accent: 'accent-violet-600',
    hint: 'An uploaded document fills this in automatically',
    help: 'When someone uploads the document, this field is filled in from what is printed on it. Turn it off for anything a document does not state.',
  },
  {
    key: 'isIdentifier', label: 'Identifier', short: 'ID',
    accent: 'accent-amber-600',
    hint: 'The number this document is known by — searchable, and once confirmed here, what makes two records the same record',
    help: 'The number the document is known by. It is indexed for search and shown in the Number column. Ticked HERE, it also decides duplicates: a new record with the same value is refused as a copy of the existing one. Only ever use a value that is unique per document, never per person: a PAN or a UAN is the same for life, so making one decide duplicates would collapse every monthly payslip into a single record.',
    danger: 'on',
  },
];

/**
 * Does this field decide duplicates, and who says so?
 *
 * The server answers for the SAVED state (`effective.identifiesRecord`). This
 * answers for the state on screen, edits included, from the same rule the
 * server applies (`dedupeIdentifierFields`, documentCategoryFields.ts):
 *
 *   · an explicit Identifier tick or untick — an override that is true or
 *     false, saved or not — is the whole answer;
 *   · otherwise the shipped rule: an identifier decides when it is Mandatory
 *     and not one of the recurring-subject exclusions (a consumer number, a
 *     UAN). Mandatory can be edited here, so it is read live; the exclusion
 *     cannot, so it is read from what the server said about the shipped field.
 *
 * `whyNot` is the rule's reason when it says no, in the server's vocabulary,
 * and null when the answer is yes or came from the operator.
 */
function dedupeState(row) {
  const explicit = row.override?.isIdentifier;
  if (explicit === true || explicit === false) {
    return { decides: explicit, source: 'admin', whyNot: null };
  }
  const d = row.default;
  if (!d.isIdentifier) return { decides: false, source: 'rule', whyNot: null };
  if (d.dedupeWhyNot === 'recurringSubject') {
    return { decides: false, source: 'rule', whyNot: 'recurringSubject' };
  }
  // The catch-all is identified by every identifier regardless of Mandatory —
  // the server says so by answering yes for a field it does not require.
  if (d.identifiesRecord && !d.isRequired) return { decides: true, source: 'rule', whyNot: null };
  return effective(row, 'isRequired')
    ? { decides: true, source: 'rule', whyNot: null }
    : { decides: false, source: 'rule', whyNot: 'optional' };
}

const WHY_NOT = {
  optional: 'it is optional here, so the shipped rule reads it as quoting another record\u2019s number',
  recurringSubject: 'it names a meter, an account or a person that produces many documents, so the shipped rule keeps every one of them',
};

/** The three-state rule: null means "follow the shipped default". */
function effective(row, key) {
  const o = row.override?.[key];
  return o === null || o === undefined ? row.default[key] : o;
}

const OVERRIDE_KEYS = [
  'fieldLabel', 'dataType', 'isPii', 'isRequired', 'isPrinted',
  'isIdentifier', 'isHidden', 'sortOrder', 'validation',
  'description', 'display', 'options', 'isReminder', 'alertDaysBefore',
];

function isOverridden(row) {
  const o = row.override;
  return !!o && OVERRIDE_KEYS.some((k) => o[k] !== null && o[k] !== undefined);
}

/** What an operator changed on this row, in words, for the expanded panel. */
function changeSummary(row) {
  const out = [];
  for (const s of SETTINGS) {
    const o = row.override?.[s.key];
    if (o === null || o === undefined) continue;
    if (o === row.default[s.key]) continue;
    out.push(`${s.label}: ${row.default[s.key] ? 'on' : 'off'} → ${o ? 'on' : 'off'}`);
  }
  if (
    row.override?.alertDaysBefore !== null
    && row.override?.alertDaysBefore !== undefined
    && row.override.alertDaysBefore !== row.default.alertDaysBefore
  ) {
    out.push(`Alert: ${row.default.alertDaysBefore} → ${row.override.alertDaysBefore} days before`);
  }
  // An Identifier override that EQUALS the shipped flag is skipped above, yet it
  // can still change what the field does: the flag is per key, the duplicate
  // decision is per record, and confirming one on an optional field is the
  // whole point of the override. Reported on its own terms.
  const dedupe = dedupeState(row);
  if (dedupe.source === 'admin' && dedupe.decides !== !!row.default.identifiesRecord) {
    out.push(`Duplicates: ${row.default.identifiesRecord ? 'decided' : 'not decided'} by this field → ${dedupe.decides ? 'decided' : 'not decided'}`);
  }
  if (row.override?.fieldLabel) out.push(`Label: “${row.default.fieldLabel}” → “${row.override.fieldLabel}”`);
  if (row.override?.dataType) out.push(`Type: ${row.default.dataType} → ${row.override.dataType}`);
  if (row.override?.isHidden === true) out.push('Hidden from the form');
  return out;
}

/** Grid template shared by the header and every row, so columns line up. */
const GRID = 'grid grid-cols-[1fr_repeat(4,3.25rem)_2rem] sm:grid-cols-[1fr_7rem_repeat(4,4.5rem)_2.25rem] lg:grid-cols-[1fr_7rem_repeat(4,5.5rem)_2.25rem] items-center gap-x-2';

/**
 * @param {object}   props
 * @param {object=}  props.jumpTo    A category the Categories tab sent us to,
 *                                   `{moduleKey, documentKey}`. Selected once it
 *                                   arrives, so "Configure fields" lands on the
 *                                   right row rather than on the first one.
 * @param {number=}  props.reloadKey Bumped by the shell when the taxonomy
 *                                   changed, so a category created next door
 *                                   appears here without a page refresh.
 */
export default function FieldsTab({ jumpTo = null, reloadKey = 0, taxonomy = 'personal' }) {
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [rows, setRows] = useState([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [catSearch, setCatSearch] = useState('');
  const [search, setSearch] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [expanded, setExpanded] = useState(null);
  // Open on arrival. It carries the one sentence that stops someone making a
  // per-person value an identifier, and a collapsed panel does not get read.
  const [showHelp, setShowHelp] = useState(true);
  const [confirm, setConfirm] = useState(null);
  const [confirmText, setConfirmText] = useState('');
  const [preview, setPreview] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [busy, setBusy] = useState(false);
  /** The custom field awaiting a typed confirmation before it is removed. */
  const [deleting, setDeleting] = useState(null);
  const [deleteText, setDeleteText] = useState('');

  const dirtyCount = useMemo(() => rows.filter(isOverridden).length, [rows]);
  const [baseline, setBaseline] = useState('');
  const dirty = useMemo(
    () => JSON.stringify(rows.map((r) => r.override ?? null)) !== baseline,
    [rows, baseline],
  );

  // The role check lives in the page shell — this component is never rendered
  // for anyone else, and asking twice would mean two /api/auth/me round trips
  // and two chances to disagree about the answer.
  useEffect(() => {
    (async () => {
      try {
        const { json: data } = await apiCall('/api/admin/document-fields');
        if (data.success) {
          /**
           * One taxonomy per tab.
           *
           * The API answers with all 151 categories, and it should — it is one
           * global table and the split is a presentation choice, not a
           * permission. Mixing them in one picker would put "GST Returns" a few
           * rows from "Passport" and make the operator's mental model of the
           * two accounts the thing they have to hold in their head.
           */
          const list = (data.categories || []).filter(
            (c) => String(c.moduleKey).startsWith('biz_') === (taxonomy === 'business'),
          );
          setCategories(list);
          // `jumpTo` wins over "the first one" whenever the Categories tab named
          // a category. Matched on the PAIR: a documentKey is unique only inside
          // its module.
          const wanted = jumpTo
            ? list.find((c) => c.moduleKey === jumpTo.moduleKey
                && c.documentKey === jumpTo.documentKey)
            : null;
          setSelected((current) => wanted ?? current ?? list[0] ?? null);
        } else setError(data.error || 'Could not load categories');
      } catch { setError('Could not load categories'); }
      setLoading(false);
    })();
  }, [jumpTo, reloadKey, taxonomy]);

  const loadCategory = useCallback(async (cat) => {
    if (!cat) return;
    setLoadingRows(true); setError(''); setSuccess(''); setExpanded(null);
    try {
      const { json: data } = await apiCall(`/api/admin/document-fields?moduleKey=${cat.moduleKey}&documentKey=${cat.documentKey}`, {}
);
      if (data.success) {
        setDetail(data.category);
        setRows(data.fields || []);
        setBaseline(JSON.stringify((data.fields || []).map((r) => r.override ?? null)));
      } else setError(data.error || 'Could not load fields');
    } catch { setError('Could not load fields'); }
    setLoadingRows(false);
  }, []);

  useEffect(() => { loadCategory(selected); }, [selected, loadCategory]);

  // Losing a screenful of configuration to a stray tab-close is the kind of
  // thing an operator never forgives.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const setOverride = (fieldKey, patch) => {
    setRows((prev) => prev.map((r) => (r.fieldKey === fieldKey
      ? { ...r, override: { ...(r.override || {}), ...patch } }
      : r)));
  };

  const resetRow = (fieldKey) => setRows((prev) => prev.map((r) => (r.fieldKey === fieldKey
    ? { ...r, override: Object.fromEntries(OVERRIDE_KEYS.map((k) => [k, null])) }
    : r)));

  const move = (fieldKey, delta) => {
    const i = rows.findIndex((r) => r.fieldKey === fieldKey);
    const target = i + delta;
    if (i < 0 || target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[i], next[target]] = [next[target], next[i]];
    // Renumber everything, so the order stored matches the order shown.
    setRows(next.map((r, n) => ({ ...r, override: { ...(r.override || {}), sortOrder: (n + 1) * 10 } })));
  };

  const toggle = (row, setting, value) => {
    // The two that can cost something are confirmed, never toggled.
    if (setting.danger === 'off' && value === false) {
      setConfirm({ row, setting }); setConfirmText(''); return;
    }
    if (setting.danger === 'on' && value === true) {
      setConfirm({ row, setting }); setConfirmText(''); return;
    }
    setOverride(row.fieldKey, { [setting.key]: value });
  };

  const save = async () => {
    setSaving(true); setError(''); setSuccess('');
    try {
      const { json: data } = await apiCall('/api/admin/document-fields', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
        moduleKey: selected.moduleKey,
        documentKey: selected.documentKey,
        fields: rows.map((r) => ({ fieldKey: r.fieldKey, ...(r.override || {}) })),
        }),
      });
      if (data.success) {
        setSuccess('Saved.');
        await loadCategory(selected);
        setCategories((prev) => prev.map((c) => (c.moduleKey === selected.moduleKey
          && c.documentKey === selected.documentKey ? { ...c, overrides: dirtyCount } : c)));
      } else {
        // Edits are kept on failure — never silently dropped.
        setError(data.error || 'Could not save');
      }
    } catch { setError('Could not save'); }
    setSaving(false);
  };

  /**
   * Add a field, then reload.
   *
   * Reloaded rather than pushed onto `rows`: the server decides the key and the
   * sort order, and a locally-invented row would disagree with both the moment
   * anyone pressed Save. Unsaved edits elsewhere on the screen are the reason
   * the button is disabled while `dirty` — see the toolbar.
   */
  const createField = async (body) => {
    setBusy(true); setAddError('');
    try {
      const { json: data } = await apiCall('/api/admin/document-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
        moduleKey: selected.moduleKey, documentKey: selected.documentKey, ...body,
        }),
      });
      if (data.success) {
        setAdding(false);
        await loadCategory(selected);
        setSuccess(`Added “${body.fieldLabel}”.`);
      } else {
        setAddError(data.error || 'Could not add the field');
      }
    } catch { setAddError('Could not add the field'); }
    setBusy(false);
  };

  const deleteField = async () => {
    setBusy(true); setError('');
    try {
      const params = new URLSearchParams({
        moduleKey: selected.moduleKey,
        documentKey: selected.documentKey,
        fieldKey: deleting.fieldKey,
      });
      const { json: data } = await apiCall(`/api/admin/document-fields?${params}`, { method: 'DELETE' });
      if (data.success) {
        setDeleting(null); setDeleteText('');
        await loadCategory(selected);
        setSuccess('Field deleted.');
      } else {
        setError(data.error || 'Could not delete the field');
        setDeleting(null);
      }
    } catch {
      setError('Could not delete the field');
      setDeleting(null);
    }
    setBusy(false);
  };

  const visible = useMemo(() => rows.filter((r) => {
    if (onlyChanged && !isOverridden(r)) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return r.fieldKey.includes(q) || String(effective(r, 'fieldLabel')).toLowerCase().includes(q);
  }), [rows, search, onlyChanged]);

  const byModule = useMemo(() => {
    const q = catSearch.toLowerCase();
    const map = new Map();
    for (const c of categories) {
      if (q && !c.documentName.toLowerCase().includes(q) && !c.moduleName.toLowerCase().includes(q)) continue;
      if (!map.has(c.moduleKey)) map.set(c.moduleKey, { name: c.moduleName, items: [] });
      map.get(c.moduleKey).items.push(c);
    }
    return [...map.values()];
  }, [categories, catSearch]);

  const switchTo = (c) => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setSelected(c);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" /> Loading field configuration…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {success && !dirty && <Alert><AlertDescription>{success}</AlertDescription></Alert>}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[260px_1fr]">
        {/* ── Which document type ──────────────────────────────────────── */}
        <div className="rounded-lg border bg-card lg:sticky lg:top-4">
          <div className="border-b p-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-8 pl-8 text-sm"
                placeholder="Find a document type…"
                value={catSearch}
                onChange={(e) => setCatSearch(e.target.value)}
              />
            </div>
          </div>
          <div className="max-h-[60vh] space-y-3 overflow-y-auto p-2">
            {byModule.map((mod) => (
              <div key={mod.name}>
                <p className="mb-1 px-2 text-xs font-bold uppercase tracking-widest text-faint">
                  {mod.name}
                </p>
                {mod.items.map((c) => {
                  const active = selected?.moduleKey === c.moduleKey
                    && selected?.documentKey === c.documentKey;
                  return (
                    <button
                      key={`${c.moduleKey}/${c.documentKey}`}
                      onClick={() => switchTo(c)}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                        active ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted/60',
                      )}
                    >
                      <span className="truncate">{c.documentName}</span>
                      {c.overrides > 0 && (
                        <span className="size-1.5 shrink-0 rounded-full bg-primary" title={`${c.overrides} configured`} />
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
            {byModule.length === 0 && (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">No match.</p>
            )}
          </div>
        </div>

        {/* ── The fields ───────────────────────────────────────────────── */}
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">{selected?.documentName}</h2>
            {detail && (
              <span className="text-xs text-muted-foreground">
                {rows.length} fields · {detail.recordCount} record{detail.recordCount === 1 ? '' : 's'} filed
              </span>
            )}
          </div>

          {/* Explained once, collapsed, instead of a sentence on every row. */}
          <div className="rounded-lg border bg-muted/30">
            <button
              onClick={() => setShowHelp((v) => !v)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium"
            >
              <HelpCircle className="size-4 text-muted-foreground" />
              What do these settings mean?
              <ChevronRight className={cn('ml-auto size-4 transition-transform', showHelp && 'rotate-90')} />
            </button>
            {showHelp && (
              <dl className="space-y-2.5 border-t p-3 text-sm">
                {SETTINGS.map((s) => (
                  <div key={s.key} className="grid gap-0.5 sm:grid-cols-[7rem_1fr] sm:gap-3">
                    <dt className="font-semibold">{s.label}</dt>
                    <dd className="text-muted-foreground">{s.help}</dd>
                  </div>
                ))}
                <div className="grid gap-0.5 border-t pt-2.5 sm:grid-cols-[7rem_1fr] sm:gap-3">
                  <dt className="flex items-center gap-1.5 font-semibold">
                    <Lock className="size-3.5" /> Locked
                  </dt>
                  <dd className="text-muted-foreground">
                    Fixed in code and not changeable here. Open the row to see why.
                  </dd>
                </div>
              </dl>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[180px] flex-1">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-8 pl-8 text-sm"
                placeholder="Filter fields…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <input
                type="checkbox"
                checked={onlyChanged}
                onChange={(e) => setOnlyChanged(e.target.checked)}
                className="size-4 cursor-pointer rounded border-border bg-field"
              />
              Only changed
            </label>
            {/* Disabled while there are unsaved edits: adding reloads the
                category from the server, which would discard them silently. */}
            <Button
              variant="outline" size="sm" className="h-8 gap-1 text-xs"
              disabled={!selected || dirty}
              title={dirty ? 'Save or discard your changes first' : undefined}
              onClick={() => setAdding(true)}
            >
              <Plus className="size-3.5" /> Add field
            </Button>
          </div>

          {/* ── Header + rows ──────────────────────────────────────────── */}
          <div className="overflow-hidden rounded-lg border bg-card">
            <div className={cn(GRID, 'border-b bg-muted/40 px-3 py-2')}>
              <span className="text-2xs font-bold uppercase tracking-wide text-faint">
                Field
              </span>
              <span className="hidden text-2xs font-bold uppercase tracking-wide text-faint sm:block">
                Type
              </span>
              {SETTINGS.map((s) => (
                <span
                  key={s.key}
                  title={s.hint}
                  className="min-w-0 cursor-help truncate text-center text-2xs font-bold uppercase tracking-wide text-faint"
                >
                  {/* The long labels do not fit a 4.5rem column at any tracking,
                      so they wait for the wider lg columns; below that the row
                      shows the short form the mobile layout already used. */}
                  <span className="hidden lg:inline">{s.label}</span>
                  <span className="lg:hidden">{s.short}</span>
                </span>
              ))}
              <span />
            </div>

            {loadingRows && (
              <div className="space-y-2 p-3">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-9 animate-pulse rounded bg-muted/50" />
                ))}
              </div>
            )}

            {!loadingRows && visible.map((row) => (
              <FieldRow
                key={row.fieldKey}
                row={row}
                open={expanded === row.fieldKey}
                onOpen={() => setExpanded(expanded === row.fieldKey ? null : row.fieldKey)}
                onToggle={(setting, value) => toggle(row, setting, value)}
                onPatch={(patch) => setOverride(row.fieldKey, patch)}
                onReset={() => resetRow(row.fieldKey)}
                onMove={(d) => move(row.fieldKey, d)}
                onDelete={() => { setDeleting(row); setDeleteText(''); }}
                recordCount={detail?.recordCount ?? 0}
              />
            ))}

            {!loadingRows && visible.length === 0 && (
              <div className="space-y-2 p-8 text-center">
                <p className="text-sm text-muted-foreground">
                  {onlyChanged
                    ? 'Nothing has been changed on this document type.'
                    : `No fields match “${search}”.`}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setSearch(''); setOnlyChanged(false); }}
                >
                  <X className="mr-1.5 size-3.5" /> Clear filters
                </Button>
              </div>
            )}
          </div>

          <FormPreview rows={rows} open={preview} onToggle={() => setPreview((v) => !v)} />

          <p className="text-xs text-muted-foreground">
            Changes apply to records saved from now on. Records already saved keep the values
            they stored.
          </p>
        </div>
      </div>

      {/* ── Pinned so it cannot scroll away ──────────────────────────────── */}
      {dirty && (
        <div className="sticky bottom-0 z-20 -mx-1 flex flex-wrap items-center gap-3 border-t border-border/60 bg-popover/95 px-1 py-3 backdrop-blur">
          <span className="text-sm font-medium">
            {dirtyCount} field{dirtyCount === 1 ? '' : 's'} configured
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => loadCategory(selected)} disabled={saving}>
              Discard
            </Button>
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Save className="mr-1.5 size-4" />}
              Save changes
            </Button>
          </div>
        </div>
      )}

      <AddFieldDialog
        open={adding}
        category={detail || selected}
        saving={busy}
        error={addError}
        onCancel={() => { setAdding(false); setAddError(''); }}
        onCreate={createField}
      />

      <DeleteFieldDialog
        field={deleting}
        text={deleteText}
        setText={setDeleteText}
        saving={busy}
        onCancel={() => { setDeleting(null); setDeleteText(''); }}
        onConfirm={deleteField}
      />

      <ConfirmDialog
        confirm={confirm}
        text={confirmText}
        setText={setConfirmText}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setOverride(confirm.row.fieldKey, { [confirm.setting.key]: confirm.setting.danger === 'on' });
          setConfirm(null);
        }}
      />
    </div>
  );
}

/** One field: four settings across, everything else behind the chevron. */
function FieldRow({
  row, open, onOpen, onToggle, onPatch, onReset, onMove, onDelete, recordCount,
}) {
  const changed = isOverridden(row);
  // Not via effective(): the API reports isHidden at the ROW level, not inside
  // `default` — a hidden field is dropped from the effective spec, so its
  // hiddenness is a fact about the row rather than one of its settings.
  const hidden = row.override?.isHidden ?? row.isHidden ?? false;
  const locked = row.locks.length > 0;
  /**
   * Two keys the add form never renders as an input: `holder_name` is answered
   * by the "Belongs to" picker and `custom_fields` by the free-text rows.
   *
   * Mandatory and Identifier are meaningless for both, and Mandatory was worse
   * than meaningless — marking it made the whole sub-category unsavable, with
   * the error landing on a field that is nowhere on screen, so nothing could be
   * filed and the duplicate check never ran. The API refuses both settings for
   * these keys; the switches say so here rather than failing on Save.
   */
  const unrenderable = FORM_HIDDEN_KEYS.has(row.fieldKey);
  const unrenderableWhy = row.fieldKey === 'holder_name'
    ? 'Answered by the “Belongs to” picker, not by an input on the form.'
    : 'Filled in as free-text rows, not as a single input.';
  const changes = changeSummary(row);
  const dedupe = dedupeState(row);
  // Ticked, indexed, searchable — and not deciding duplicates. See dedupeState.
  const indexedOnly = !!effective(row, 'isIdentifier') && !dedupe.decides;
  const identifierSetting = SETTINGS.find((s) => s.key === 'isIdentifier');

  const dataType = effective(row, 'dataType');
  const display = effective(row, 'display');
  const options = effective(row, 'options');
  const choice = isChoiceType(dataType);
  const rule = { ...(row.default?.validation || {}), ...(row.override?.validation || {}) };

  /** Merge one key into `validation`, dropping it when the box is emptied. */
  const setRule = (key, value) => onPatch({
    validation: {
      ...(row.override?.validation || {}),
      ...(value === '' || value === null || value === undefined
        ? { [key]: undefined } : { [key]: value }),
    },
  });

  return (
    <div className={cn('border-b last:border-b-0', open && 'bg-muted/20')}>
      <div className={cn(GRID, 'px-3 py-1.5 hover:bg-muted/30')}>
        <button
          onClick={onOpen}
          className="flex min-w-0 items-center gap-1.5 py-1 text-left"
          aria-expanded={open}
        >
          <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          {changed && <span className="size-1.5 shrink-0 rounded-full bg-primary" title="Configured" />}
          <span className={cn('truncate text-sm', hidden && 'text-muted-foreground line-through')}>
            {effective(row, 'fieldLabel')}
          </span>
          {/* "Added here" and "configured here" are different facts and the dot
              above only says the second. Without this, a field an operator
              created is indistinguishable from one they merely relabelled —
              and only one of the two can be deleted. */}
          {row.isCustom && (
            <span
              title="Added on this screen — not part of the shipped document type"
              className="inline-flex shrink-0 items-center gap-0.5 rounded bg-primary/10 px-1 py-px text-2xs font-bold uppercase tracking-wider text-primary"
            >
              <Sparkles className="size-2.5" /> Added
            </span>
          )}
          {hidden && <EyeOff className="size-3 shrink-0 text-muted-foreground" />}
        </button>

        <span className="hidden truncate text-xs text-muted-foreground sm:block">
          {typeById(typeId(dataType, display)).label}
        </span>

        {SETTINGS.map((s) => {
          // A padlock, not a disabled checkbox: a disabled checkbox reads as an
          // unchecked one, which is the opposite of the truth here.
          const isLocked = locked && s.key === 'isPii';   // both lock directions live on isPii
          // Fixed in code for the same reason a lock is: the field has no input
          // to be mandatory on and no value that identifies a document.
          const isFixed = unrenderable
            && (s.key === 'isRequired' || s.key === 'isIdentifier');
          return (
            <div key={s.key} className="flex justify-center">
              {isLocked || isFixed ? (
                <Lock
                  className="size-3.5 text-muted-foreground"
                  title={isFixed ? unrenderableWhy : row.locks.join(' ')}
                />
              ) : (
                <input
                  type="checkbox"
                  aria-label={`${s.label} — ${effective(row, 'fieldLabel')}`}
                  checked={!!effective(row, s.key)}
                  disabled={hidden && s.key === 'isRequired'}
                  onChange={(e) => onToggle(s, e.target.checked)}
                  // A ticked Identifier that decides nothing is the one state
                  // this column can mislead about, so it is drawn differently
                  // and says why — the row below has the control to change it.
                  title={s.key === 'isIdentifier' && indexedOnly
                    ? `Indexed and searchable, but does not decide duplicates — ${WHY_NOT[dedupe.whyNot]}. Open the row to change.`
                    : undefined}
                  className={cn(
                    'size-4 cursor-pointer rounded border-border bg-field disabled:cursor-not-allowed disabled:opacity-30',
                    s.accent,
                    s.key === 'isIdentifier' && indexedOnly && 'ring-2 ring-amber-500/70 ring-offset-1 ring-offset-background',
                  )}
                />
              )}
            </div>
          );
        })}

        <div className="flex justify-end">
          {changed && (
            <Button
              variant="ghost" size="sm" onClick={onReset}
              title="Reset to default" aria-label="Reset to default"
              className="size-7 px-0 text-muted-foreground"
            >
              <RotateCcw className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {open && (
        <div className="space-y-3 border-t bg-background/40 p-3 pl-8">
          {/* ── DUPLICATES ──────────────────────────────────────────────
              The Identifier column answers "is this indexed?"; this answers
              "does it decide duplicates?", which is the question the operator
              actually came to ask and the one the column alone cannot. Shown
              for every indexed field, and for the unrenderable two it is not
              shown at all — they have no value to match on. */}
          {!unrenderable && !hidden && !!effective(row, 'isIdentifier') && (
            <div className={cn(
              'flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md p-2 text-xs',
              dedupe.decides ? 'bg-amber-500/10 text-amber-700 dark:text-amber-500' : 'bg-muted/60 text-muted-foreground',
            )}>
              <Fingerprint className="size-3.5 shrink-0" />
              {dedupe.decides ? (
                <>
                  <span>
                    <strong>Decides duplicates.</strong> A new record with the same value
                    is refused as a copy of the one on file
                    {dedupe.source === 'admin' ? ' — set here.' : ' — the shipped rule.'}
                  </span>
                  <Button
                    variant="outline" size="sm" className="h-7 text-xs"
                    onClick={() => onToggle(identifierSetting, false)}
                  >
                    Stop deciding duplicates
                  </Button>
                  <span className="basis-full text-muted-foreground">
                    Stopping also drops it from search and the Number column — the
                    two are one setting.
                  </span>
                </>
              ) : (
                <>
                  <span>
                    <strong>Indexed only.</strong> Searchable and shown in the Number
                    column, but a matching value does not refuse a new record
                    {dedupe.whyNot ? ` — ${WHY_NOT[dedupe.whyNot]}.` : '.'}
                  </span>
                  <Button
                    variant="outline" size="sm" className="h-7 text-xs"
                    onClick={() => onToggle(identifierSetting, true)}
                  >
                    Use for duplicate matching
                  </Button>
                </>
              )}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs">Label on the form</Label>
              <Input
                className="h-8 text-sm"
                value={effective(row, 'fieldLabel') ?? ''}
                onChange={(e) => onPatch({ fieldLabel: e.target.value })}
              />
            </div>
            <div>
              <Label className="text-xs">Type of value</Label>
              <Select
                value={typeId(dataType, display)}
                onValueChange={(id) => {
                  const t = typeById(id);
                  onPatch({
                    dataType: t.value,
                    // Always written, so switching a dropdown back to Text
                    // clears the display rather than leaving a stale one that
                    // would resurface if it were ever made a choice again.
                    display: t.display ?? null,
                    ...(isChoiceType(t.value) ? {} : { options: null }),
                  });
                }}
              >
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DATA_TYPES.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {row.override?.dataType && (
                <p className="mt-1 text-xs text-amber-600">
                  Values already saved are not converted.
                </p>
              )}
            </div>

            {/* Explaining the field to whoever fills it in. Not only for fields
                an operator added — "what does Assessment Year mean here" is
                asked about a shipped field far more often. */}
            <div className="sm:col-span-2">
              <Label className="text-xs">Description shown under the box</Label>
              <Textarea
                rows={2}
                className="text-sm"
                placeholder="Optional. Plain language, for whoever is filling this in."
                value={effective(row, 'description') ?? ''}
                onChange={(e) => onPatch({ description: e.target.value })}
              />
            </div>

            {choice && (
              <div className="sm:col-span-2">
                <OptionsEditor
                  options={options}
                  recordCount={recordCount}
                  onChange={(next) => onPatch({ options: next })}
                />
              </div>
            )}
            <div>
              <Label className="text-xs">Example shown under the box</Label>
              <Input
                className="h-8 text-sm"
                placeholder="e.g. ABCDE1234F"
                value={row.override?.validation?.example ?? ''}
                onChange={(e) => onPatch({
                  validation: { ...(row.override?.validation || {}), example: e.target.value },
                })}
              />
            </div>
            {/* ── The rest of the rule ────────────────────────────────
                `maxLength`, `minLength`, `min`, `max`, `notFuture` and
                `notPast` have been accepted by the API and enforced by
                `validateField` since this screen shipped — they were simply
                never rendered, so the only way to set one was a hand-written
                PUT. `pattern` and `message` stay out deliberately: an anchored
                regex is where one typo silently rejects every value a user
                types, and those live in code where tests hold them to account. */}
            {!choice && dataType !== 'boolean' && (
              <div className="sm:col-span-2 grid gap-3 sm:grid-cols-2">
                {(dataType === 'number' || dataType === 'currency') ? (
                  <>
                    <div>
                      <Label className="text-xs">Smallest allowed</Label>
                      <Input
                        type="number" className="h-8 text-sm" placeholder="No limit"
                        value={rule.min ?? ''}
                        onChange={(e) => setRule('min', e.target.value === '' ? '' : Number(e.target.value))}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Largest allowed</Label>
                      <Input
                        type="number" className="h-8 text-sm" placeholder="No limit"
                        value={rule.max ?? ''}
                        onChange={(e) => setRule('max', e.target.value === '' ? '' : Number(e.target.value))}
                      />
                    </div>
                  </>
                ) : dataType === 'date' ? (
                  <div className="flex flex-wrap gap-4 sm:col-span-2">
                    {[
                      ['notFuture', 'Cannot be in the future', 'A birth date, an issue date.'],
                      ['notPast', 'Cannot be in the past', 'A renewal date, an expiry being entered now.'],
                    ].map(([key, text, why]) => (
                      <label key={key} title={why} className="flex cursor-pointer items-center gap-1.5 text-xs font-semibold">
                        <input
                          type="checkbox"
                          checked={!!rule[key]}
                          onChange={(e) => setRule(key, e.target.checked || '')}
                          className="size-4 cursor-pointer rounded border-border bg-field"
                        />
                        {text}
                      </label>
                    ))}
                  </div>
                ) : (
                  <>
                    <div>
                      <Label className="text-xs">Shortest allowed</Label>
                      <Input
                        type="number" min="0" className="h-8 text-sm" placeholder="No limit"
                        value={rule.minLength ?? ''}
                        onChange={(e) => setRule('minLength', e.target.value === '' ? '' : Number(e.target.value))}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Longest allowed</Label>
                      <Input
                        type="number" min="1" className="h-8 text-sm" placeholder="No limit"
                        value={rule.maxLength ?? ''}
                        onChange={(e) => setRule('maxLength', e.target.value === '' ? '' : Number(e.target.value))}
                      />
                    </div>
                  </>
                )}
              </div>
            )}

            {/* REMINDER_FIELD_KEYS is a hardcoded set of twelve keys, so before
                this a date an operator ADDED could never raise a follow-up, and
                one that shipped could never be turned off. */}
            {dataType === 'date' && (
              <label className="flex cursor-pointer items-center gap-1.5 text-xs font-semibold sm:col-span-2">
                <input
                  type="checkbox"
                  checked={!!effective(row, 'isReminder')}
                  onChange={(e) => onPatch({ isReminder: e.target.checked })}
                  className="size-4 cursor-pointer rounded border-border bg-field"
                />
                Show this date in Follow-ups
                <span className="font-normal text-muted-foreground">
                  — for renewals and expiries, never for a date that merely records
                  when something happened.
                </span>
              </label>
            )}

            {/* ── HOW EARLY, not just whether ────────────────────────────
                Every reminder in the app used to surface at fifteen days, so a
                passport and an electricity bill got the same notice. Shown only
                once the date actually raises a follow-up: a lead time on a field
                that never alerts is a control that lies, and the API rejects it.

                Empty clears the override — the field goes back to the shipped
                default, which the placeholder names. `0` is a real answer and
                means "tell me on the day it expires", so it must not be treated
                as blank. */}
            {dataType === 'date' && effective(row, 'isReminder') && (
              <div className="sm:col-span-2">
                <Label className="text-xs">Alert this many days before</Label>
                <div className="flex items-center gap-2">
                  <Input
                    type="number" min="0" max="365"
                    className="h-8 w-28 text-sm"
                    placeholder={String(row.default.alertDaysBefore ?? 15)}
                    value={row.override?.alertDaysBefore ?? ''}
                    onChange={(e) => onPatch({
                      alertDaysBefore: e.target.value === ''
                        ? null
                        : Number(e.target.value),
                    })}
                  />
                  <span className="text-xs text-muted-foreground">
                    Shipped default: {row.default.alertDaysBefore ?? 15} days.
                    A member can ask for more notice on a single record.
                  </span>
                </div>
              </div>
            )}

            <div className="flex items-end gap-2">
              <Button variant="outline" size="sm" onClick={() => onMove(-1)}>
                <ArrowUp className="mr-1 size-3.5" /> Move up
              </Button>
              <Button variant="outline" size="sm" onClick={() => onMove(1)}>
                <ArrowDown className="mr-1 size-3.5" /> Move down
              </Button>
              <Button
                variant="outline" size="sm"
                onClick={() => onPatch({ isHidden: !hidden, ...(hidden ? {} : { isRequired: false }) })}
              >
                {hidden ? <Eye className="mr-1 size-3.5" /> : <EyeOff className="mr-1 size-3.5" />}
                {hidden ? 'Show' : 'Hide'}
              </Button>
              {/* ── DELETE IS OFFERED ON ADDED FIELDS ONLY ──────────────
                  A shipped field's key is what already-sealed ciphertext is
                  stored under in every tenant's vault, and the dictionary
                  re-declares it on the next spec load — so a Delete button on
                  one would appear to work and do nothing. Hide is the real
                  answer there, and it is the only one offered. */}
              {row.isCustom && (
                <Button
                  variant="outline" size="sm"
                  className="text-danger-action hover:bg-destructive/10"
                  onClick={onDelete}
                >
                  <Trash2 className="mr-1 size-3.5" /> Delete
                </Button>
              )}
            </div>
          </div>

          {/* Reset is a leap of faith unless the row says what it changed FROM. */}
          {changes.length > 0 && (
            <p className="text-xs text-muted-foreground">
              <span className="font-semibold">Changed from the default — </span>
              {changes.join(' · ')}
            </p>
          )}

          {locked && (
            <p className="flex items-start gap-1.5 rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
              <Lock className="mt-px size-3 shrink-0" />
              <span>{row.locks.join(' ')}</span>
            </p>
          )}

          {/* Who to ask about a setting nobody remembers choosing. Both
              columns have been on the table since it was created and nothing
              has ever shown them. */}
          {row.lastChange?.at && (
            <p className="text-xs text-muted-foreground">
              Changed by {row.lastChange.by || 'a deleted admin'} on{' '}
              {new Date(row.lastChange.at).toLocaleDateString(undefined, {
                day: 'numeric', month: 'short', year: 'numeric',
              })}
            </p>
          )}

          <p className="text-xs text-faint">
            Internal name <code className="rounded bg-muted px-1">{row.fieldKey}</code> — permanent,
            because saved values are stored under it.
          </p>
        </div>
      )}
    </div>
  );
}

/** Typing the field name is the speed bump; the text above it is the reason. */
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE FORM, AS THE PEOPLE FILLING IT IN WILL SEE IT                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A matrix of checkboxes is the right shape for CONFIGURING sixteen fields and
 * the wrong shape for judging the result. "Is this readable?", "does that order
 * make sense?", "is the description clear?" are questions about a form, and
 * until now the only way to ask them was to save, open a tenant, and start an
 * upload.
 *
 * ── IT RENDERS THE REAL COMPONENT ──────────────────────────────────────────
 * <CategoryFieldInputs> is the same component the sub-category add form, the
 * Documents Manager upload form and the Power Scan review grid render. A
 * mock-up drawn here would be a fourth thing that could disagree with the other
 * three — and disagree most convincingly, since it is the one the operator
 * checks their work against.
 *
 * Built from the UNSAVED rows, so it answers for what is on screen rather than
 * for what is in the database. Hidden fields are dropped, exactly as
 * `applyOverrides` drops them.
 */
function FormPreview({ rows, open, onToggle }) {
  const [values, setValues] = useState({});

  const fields = useMemo(() => rows
    .filter((r) => !(r.override?.isHidden ?? r.isHidden ?? false))
    .map((r) => ({
      fieldKey: r.fieldKey,
      fieldLabel: effective(r, 'fieldLabel'),
      dataType: effective(r, 'dataType'),
      isPii: effective(r, 'isPii'),
      isRequired: effective(r, 'isRequired'),
      description: effective(r, 'description') || undefined,
      display: effective(r, 'display') || undefined,
      options: effective(r, 'options') || undefined,
      validation: {
        ...(r.default?.validation || {}),
        ...(r.override?.validation || {}),
      },
      sortOrder: r.override?.sortOrder,
    })), [rows]);

  return (
    <div className="rounded-lg border bg-card">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium"
        aria-expanded={open}
      >
        <Eye className="size-4 text-muted-foreground" />
        Preview the form
        <span className="text-xs font-normal text-muted-foreground">
          — how this looks to whoever fills it in
        </span>
        <ChevronRight className={cn('ml-auto size-4 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="border-t p-3">
          <CategoryFieldInputs
            fields={fields}
            values={values}
            errors={{}}
            touched={{}}
            aiFilled={PREVIEW_NO_AI}
            onChange={(key, value) => setValues((prev) => ({ ...prev, [key]: value }))}
            onBlur={PREVIEW_NOOP}
            registerRef={PREVIEW_NOOP}
          />
          <p className="mt-3 text-xs text-faint">
            Nothing typed here is saved. “Additional details” is not shown — it is
            the same free-text block on every document type and is not configurable.
          </p>
        </div>
      )}
    </div>
  );
}

const PREVIEW_NO_AI = new Set();
const PREVIEW_NOOP = () => {};

/**
 * The permitted answers for a choice field, as editable rows.
 *
 * ── VALUE AND LABEL ARE NOT THE SAME THING ─────────────────────────────────
 * `value` is what is STORED in every record and what a scan must answer with;
 * `label` is what the form shows. They start identical and stay linked while
 * the value has not been touched, because the common case is that they are the
 * same word — but they are separable, because renaming a label must not rewrite
 * the value in every record already filed under it.
 *
 * That is why the value input carries a lock once records exist: an operator
 * who edits it is not renaming the choice, they are creating a new one and
 * orphaning the old.
 */
function OptionsEditor({ options, onChange, recordCount }) {
  const rows = Array.isArray(options) ? options : [];
  const update = (next) => onChange(next.length > 0 ? next : null);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs">Choices</Label>
        <Button
          variant="outline" size="sm" className="h-7 gap-1 text-xs"
          onClick={() => update([...rows, { value: '', label: '' }])}
        >
          <Plus className="size-3" /> Add choice
        </Button>
      </div>

      {rows.length === 0 && (
        <p className="text-xs text-muted-foreground">
          A list field needs at least two choices before it can be saved.
        </p>
      )}

      {rows.map((option, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            className="h-8 flex-1 text-sm"
            placeholder="Stored value"
            value={option.value ?? ''}
            onChange={(e) => update(rows.map((r, j) => (j === i
              ? { ...r, value: e.target.value, touchedValue: true }
              : r)))}
          />
          <Input
            className="h-8 flex-1 text-sm"
            placeholder="Shown to the user"
            value={option.label ?? ''}
            onChange={(e) => update(rows.map((r, j) => (j === i
              // Keeps value in step until someone edits it directly — the two
              // are the same word far more often than not.
              ? {
                ...r,
                label: e.target.value,
                ...(r.touchedValue ? {} : { value: e.target.value }),
              }
              : r)))}
          />
          <Button
            variant="ghost" size="icon"
            aria-label="Remove choice"
            className="size-8 shrink-0 text-muted-foreground hover:text-danger-action"
            onClick={() => update(rows.filter((_, j) => j !== i))}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ))}

      {rows.length > 0 && recordCount > 0 && (
        <p className="text-xs text-amber-600">
          {recordCount} record{recordCount === 1 ? '' : 's'} already filed here. Changing a
          stored value does not update them — they keep the old one and show it as
          “no longer offered”.
        </p>
      )}
    </div>
  );
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ADD A FIELD — a dialog, not a row that appears at the bottom           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Creating a field is not the same act as configuring one, and the screen says
 * so. A blank row in the grid would be saved by the same Save button as
 * everything else, which is exactly the habit that produces half-defined
 * fields; this asks for a name and a type, and only then does anything exist.
 *
 * The reach warning is not decoration. This taxonomy is global — a field added
 * here appears for EVERY tenant, on the add form, the Documents Manager upload
 * form and the bulk-scan review grid. An operator should read that before the
 * click, not discover it from a support ticket.
 */
function AddFieldDialog({ open, category, saving, error, onCancel, onCreate }) {
  const [label, setLabel] = useState('');
  const [typeKey, setTypeKey] = useState('text');
  const [description, setDescription] = useState('');
  const [options, setOptions] = useState(null);
  const [isPii, setIsPii] = useState(true);
  const [isRequired, setIsRequired] = useState(false);
  const [isPrinted, setIsPrinted] = useState(true);

  // Cleared on open, not on close: a dialog that failed to save must still hold
  // what the operator typed when they reopen it to fix the message.
  useEffect(() => {
    if (!open) return;
    setLabel(''); setTypeKey('text'); setDescription('');
    setOptions(null); setIsPii(true); setIsRequired(false); setIsPrinted(true);
  }, [open]);

  const type = typeById(typeKey);
  const choice = isChoiceType(type.value);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a field to {category?.documentName}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div>
            <Label className="text-xs">Label on the form</Label>
            <Input
              className="h-8 text-sm"
              placeholder="e.g. Regional Office Code"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          <div>
            <Label className="text-xs">Type of value</Label>
            <Select value={typeKey} onValueChange={setTypeKey}>
              <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {DATA_TYPES.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {choice && (
            <OptionsEditor options={options} onChange={setOptions} recordCount={0} />
          )}

          <div>
            <Label className="text-xs">Description (optional)</Label>
            <Textarea
              rows={2}
              className="text-sm"
              placeholder="Shown under the box, to whoever is filling this in."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="flex flex-wrap gap-4 rounded-md border p-2.5">
            {[
              ['Encrypted', isPii, setIsPii],
              ['Mandatory', isRequired, setIsRequired],
              ['Scan reads', isPrinted, setIsPrinted],
            ].map(([text, value, set]) => (
              <label key={text} className="flex cursor-pointer items-center gap-1.5 text-xs font-semibold">
                <input
                  type="checkbox"
                  checked={value}
                  onChange={(e) => set(e.target.checked)}
                  className="size-4 cursor-pointer rounded border-border bg-field"
                />
                {text}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Encrypted is on by default. A field nobody has thought about is safer
            sealed — reading it back needs an audited unlock, and it never appears
            in ordinary lists. <strong>Identifier</strong> is set afterwards, on the
            row, because it is the one setting that can merge records.
          </p>

          <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-500">
            <ShieldAlert className="mt-px size-3.5 shrink-0" />
            <span>
              This adds the field for <strong>every tenant</strong>, on the add form,
              the Documents Manager upload form and Power Scan. Its internal name is
              generated from the label and can never be changed afterwards.
            </span>
          </p>

          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button
            disabled={saving || !label.trim()}
            onClick={() => onCreate({
              fieldLabel: label.trim(),
              dataType: type.value,
              ...(type.display ? { display: type.display } : {}),
              ...(choice && options ? {
                options: options
                  .map((o) => ({ value: String(o.value ?? '').trim(), label: String(o.label ?? '').trim() }))
                  .filter((o) => o.value),
              } : {}),
              ...(description.trim() ? { description: description.trim() } : {}),
              isPii, isRequired, isPrinted,
            })}
          >
            {saving ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
            Add field
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Confirming the removal of a field an operator added.
 *
 * Separate from ConfirmDialog because the thing being confirmed is different in
 * kind: that one guards a SETTING that can cost something, this one guards the
 * disappearance of a field. The wording carries the limitation honestly —
 * record bodies are encrypted on each tenant's own Drive, so this platform
 * cannot read, count or erase what has already been written under the key.
 * Saying "deleted" without that would be the comfortable lie.
 */
function DeleteFieldDialog({ field, text, setText, saving, onCancel, onConfirm }) {
  const label = field?.effective?.fieldLabel ?? field?.default?.fieldLabel ?? '';
  return (
    <Dialog open={!!field} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-destructive" />
            Delete “{label}”?
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3 text-sm">
          <p>
            It stops being collected everywhere: the add form, the Documents Manager
            upload form and Power Scan, for every tenant.
          </p>
          <p className="text-muted-foreground">
            Values already saved under <code className="rounded bg-muted px-1">{field?.fieldKey}</code> are
            <strong> not erased</strong>. Records live encrypted on each tenant’s own
            Google Drive, so nothing here can read or rewrite them. Adding a field with
            this exact name again would show them once more.
          </p>
          {field?.effective?.isIdentifier && (
            <p className="rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-500">
              This field is the identifier for this document type. Deleting it means
              new records are no longer matched against existing ones by this value.
            </p>
          )}
          <div>
            <Label className="text-xs">Type the field’s name to confirm</Label>
            <Input
              className="h-8 text-sm"
              value={text}
              placeholder={label}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={saving || text.trim() !== label}
            onClick={onConfirm}
          >
            {saving ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
            Delete field
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmDialog({ confirm, text, setText, onCancel, onConfirm }) {
  const unseal = confirm?.setting.key === 'isPii';
  return (
    <Dialog open={!!confirm} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-destructive" />
            {unseal ? 'Stop encrypting this field?' : 'Use this to decide duplicates?'}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3 text-sm">
          {unseal ? (
            <>
              <p>
                <strong>{confirm?.row.default.fieldLabel}</strong> is encrypted today. Opening it
                means every record saved from now on stores the value in the readable tier — it
                shows in ordinary lists instead of needing an audited unlock.
              </p>
              <p className="text-muted-foreground">
                Records already saved keep their encrypted values and are unaffected.
              </p>
            </>
          ) : (
            <>
              <p>
                A new record with the same <strong>{confirm?.row.default.fieldLabel}</strong> as
                one already on file will be refused as a duplicate, and the person uploading it
                is asked to keep one or <strong>overwrite</strong> the other. This is your
                explicit answer: it applies whether or not the field is Mandatory, and it
                overrides the shipped rule for this document type.
              </p>
              <p className="text-amber-600">
                Only use a value that is unique per document, never per person. A PAN or a UAN is
                the same for life: making one decide duplicates would collapse every monthly
                payslip into a single record.
              </p>
              <p className="text-muted-foreground">
                Records already saved are not re-checked; the match applies to records saved from
                now on. Reset on the row returns the field to the shipped rule.
              </p>
            </>
          )}
          <div className="space-y-1.5">
            {/*
              Plain markup, NOT <Label>: that component applies CSS `uppercase`,
              which rewrote the key on screen while the comparison ran against
              the real lower-case one. Following the instruction exactly could
              not work. Never put a string that must be typed verbatim inside a
              component that transforms text.
            */}
            <p className="text-sm">
              Type <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm normal-case">
                {confirm?.row.fieldKey}
              </code> to confirm
            </p>
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder={confirm?.row.fieldKey}
              className="h-9 font-mono text-sm"
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          {/* Case- and whitespace-forgiving: the point is deliberate intent, not
              a typing test, and a phone that auto-capitalises should not lock
              someone out of their own setting. */}
          <Button
            variant="destructive"
            disabled={text.trim().toLowerCase() !== (confirm?.row.fieldKey ?? '').toLowerCase()}
            onClick={onConfirm}
          >
            {unseal ? 'Stop encrypting' : 'Use as identifier'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
