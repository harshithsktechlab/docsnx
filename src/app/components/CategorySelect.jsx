'use client';

/**
 * "Category → Sub-category" — the one document-category picker.
 *
 * ── WHY ONE COMPONENT ──────────────────────────────────────────────────────
 * Three places picked a category (the upload form, the edit modal, the
 * bulk-scan review grid) and each inlined its own control over its own
 * `/api/document-categories` fetch — two as a Radix <Select>, one as a bare
 * <select>. Parity between the single-upload and bulk-scan forms is exactly
 * what this change is about, so the picker is a component now: they cannot
 * present the taxonomy differently if there is only one of them.
 *
 * ── TWO CONTROLS, ONE VALUE ────────────────────────────────────────────────
 * The taxonomy's key is the PAIR (module_key, document_key), and 83 flat
 * options in one dropdown buried that structure. So: the first select picks the
 * MODULE (Documents, Medical, Vehicles…), the second lists only that module's
 * document types.
 *
 * What it EMITS is still a single `categoryId`, because that is what
 * `resolveCategory` — the mandated server-side choke point — takes. A
 * half-finished choice (module picked, sub-category not) emits '' rather than a
 * partial pair, so nothing downstream ever sees half a key.
 *
 * ── VALUE IS THE ID, NOT THE PAIR ──────────────────────────────────────────
 * `value` is a category id and both selects are DERIVED from it, so seeding the
 * control from a stored record — or from the category the AI proposed — is a
 * single prop and needs no back-resolution at the call site.
 *
 * ── IT OFFERS WHAT YOU CAN WRITE TO, NOT WHAT YOU CAN SEE ──────────────────
 * `action` says which permission the list is for. It used to be `view` always,
 * which is the wrong question for a picker: an upload form built from the view
 * list offered a member with View only on Identity every Identity sub-category,
 * and the upload then 403'd on a choice the form itself had put in front of
 * them. Callers pass `add` for an upload form and `edit` for an edit modal.
 *
 * Because all three pickers in the app are this one component, that fix lands
 * in all three at once and they cannot drift apart again.
 */
import { useEffect, useMemo, useState } from 'react';
import { Label } from '@/components/ui/label';
import { apiCall } from '@/lib/net/apiRequest';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useWorkspaceCompanyId } from '@/lib/net/useWorkspaceApi';
import { belongsToWorkspace } from '@/lib/documentCategories';

/** `<Select>` cannot hold an empty value, so "nothing picked" needs a sentinel. */
const NONE = '__none__';

export default function CategorySelect({
  value,
  /** `(categoryId, category | null)` — the second argument is the chosen row. */
  onChange,
  disabled = false,
  id = 'categoryId',
  label = 'Category',
  subLabel = 'Sub-category',
  /** Rendered in the sub-category slot before a module is chosen. */
  placeholder = 'Select a category first',
  className = '',
  /** Compact styling for the bulk-scan review grid's dense rows. */
  compact = false,
  /**
   * Which permission the offered list is filtered for: 'view' | 'add' | 'edit'.
   * See the header — a picker wants the action it is about to take, not `view`.
   */
  action = 'view',
}) {
  const [categories, setCategories] = useState([]);
  /**
   * Whether the list above has come back yet — NOT `categories.length > 0`.
   * A member with no writable categories legitimately gets an empty list, and
   * the two states have to be told apart or the orphan lookup below fires on
   * every mount against a list it has not seen.
   */
  const [categoriesLoaded, setCategoriesLoaded] = useState(false);
  // Tracked separately from `value` so choosing a module can show its
  // sub-categories BEFORE one has been picked — at which point there is no id
  // to derive the module from.
  const [moduleKey, setModuleKey] = useState('');

  /**
   * ── THE PICKER OFFERS ONE WORKSPACE'S TAXONOMY ─────────────────────────
   *
   * `/api/document-categories` answers with BOTH halves of the account, because
   * a member with default permissions holds all of them. Rendered unfiltered,
   * a company's upload form would offer Identity and Medical — categories whose
   * records cannot carry a company — and the household's would offer the
   * fourteen `biz_*` modules, whose records cannot exist without one. Either
   * choice is refused by the write gate, after the member has filled the form
   * in.
   *
   * Read from the URL here rather than taken as a prop, deliberately. This one
   * component is the picker on the Document Manager's upload form, its edit
   * modal AND every row of the bulk-scan review grid; a prop would be four call
   * sites to remember and a fifth, added later, to forget. The workspace is in
   * the path, so the component can simply ask.
   */
  const companyId = useWorkspaceCompanyId();

  useEffect(() => {
    let cancelled = false;
    setCategoriesLoaded(false);
    (async () => {
      try {
        const { res, json } = await apiCall(`/api/document-categories?action=${action}`);
        if (!res.ok) return;
        if (!cancelled && json.success) {
          setCategories((json.categories || []).filter(
            (c) => belongsToWorkspace(c.moduleKey, companyId),
          ));
          setCategoriesLoaded(true);
        }
      } catch {
        // A failed fetch leaves both selects empty rather than blocking the
        // form it sits in; the server still rejects a missing category.
      }
    })();
    return () => { cancelled = true; };
  }, [action, companyId]);

  /**
   * The row currently selected, even when the filtered list does not contain it.
   *
   * An edit modal opened on a record whose category the member may not ADD to
   * still has to show that category — it is what the record IS. Without this the
   * two selects would render blank and an unrelated save would silently look
   * like a category change. Fetched by id, unfiltered, and used only for
   * display: it is never added to `modules`, so it cannot be re-picked once
   * navigated away from.
   */
  const [orphanValue, setOrphanValue] = useState(null);
  /**
   * The orphan lookup above has run for the CURRENT value and come back.
   *
   * Needed to tell "we have not looked yet" from "we looked and it is not
   * there" — only the second may be reported to the user, and reporting the
   * first would flash a warning on every ordinary selection.
   */
  const [orphanChecked, setOrphanChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Nothing to reconcile until the filtered list has actually arrived.
    if (!categoriesLoaded) return;
    if (!value || categories.some((c) => c.id === value)) {
      setOrphanValue(null);
      setOrphanChecked(true);
      return;
    }
    setOrphanChecked(false);
    (async () => {
      try {
        // The unfiltered list is `view`, which any record the member can see is
        // in. A category outside even that is unresolvable and stays blank.
        const { res, json } = await apiCall('/api/document-categories');
        if (!res.ok) return;
        if (cancelled || !json.success) return;
        setOrphanValue((json.categories || []).find((c) => c.id === value) || null);
      } catch {
        // Same as above: blank rather than blocking.
      } finally {
        if (!cancelled) setOrphanChecked(true);
      }
    })();
    return () => { cancelled = true; };
  }, [value, categories, categoriesLoaded]);

  // The offered list, plus the current value when the filter excluded it (see
  // `orphanValue`). Concatenated HERE rather than into `categories` so a later
  // refetch cannot promote a display-only row into a selectable one.
  const offered = useMemo(
    () => (orphanValue ? [...categories, orphanValue] : categories),
    [categories, orphanValue],
  );

  const modules = useMemo(() => {
    const groups = new Map();
    for (const c of offered) {
      if (!groups.has(c.moduleKey)) {
        groups.set(c.moduleKey, { moduleKey: c.moduleKey, moduleName: c.moduleName, items: [] });
      }
      groups.get(c.moduleKey).items.push(c);
    }
    return Array.from(groups.values());
  }, [offered]);

  // The module the current value belongs to. Derived rather than stored, so a
  // `value` set from outside (an edit modal opening, the AI's proposal landing)
  // selects the right module with no extra wiring.
  const valueModuleKey = useMemo(
    () => offered.find((c) => c.id === value)?.moduleKey || '',
    [offered, value],
  );

  useEffect(() => {
    if (valueModuleKey) setModuleKey(valueModuleKey);
  }, [valueModuleKey]);

  /**
   * The VALUE decides which module is shown whenever there is one.
   *
   * This used to be `moduleKey || valueModuleKey` — the remembered module
   * winning over the module of the actual selection — so a `value` set from
   * outside into a DIFFERENT module (the AI's proposal landing on a form where
   * someone had already opened a module by hand) rendered that stale module's
   * sub-category list, which does not contain the selection. Radix shows a
   * value it has no item for as an EMPTY trigger, not as its placeholder, so
   * the sub-category simply went blank.
   *
   * The `value === ''` case still falls back to the remembered module, which is
   * the whole point of holding `moduleKey` separately (19d782f) — picking a
   * module clears the sub-category and must not blank the module with it.
   */
  const activeModule = valueModuleKey || moduleKey;
  const subCategories = useMemo(
    () => modules.find((m) => m.moduleKey === activeModule)?.items ?? [],
    [modules, activeModule],
  );

  /**
   * A `value` that has survived both lookups and still has no option.
   *
   * Rendered as a disabled item rather than left blank: an empty trigger under
   * a filled-in "Category" reads as "nothing is selected" when something very
   * much is, and the form would then refuse to save for a reason nothing on
   * screen explains. Disabled, so it cannot be re-picked once navigated away
   * from — the same rule `orphanValue` follows.
   */
  const unrenderableValue = Boolean(
    value && categoriesLoaded && orphanChecked
      && !offered.some((c) => c.id === value),
  );

  const triggerClass = compact ? 'h-9 text-xs' : '';

  return (
    <div className={`grid grid-cols-1 sm:grid-cols-2 gap-3 ${className}`}>
      <div className="flex flex-col gap-1.5">
        {label ? <Label htmlFor={`${id}-module`}>{label}</Label> : null}
        <Select
          value={activeModule || NONE}
          onValueChange={(val) => {
            // No item carries '' — only Radix's hidden native <select> emits it,
            // when the value lands before that select's <option>s are registered
            // (the categories list arriving under an edit modal already seeded
            // with an id). Honouring it wiped the seeded sub-category, and the
            // save then posted `categoryId: ''`. Re-picking the shown module is
            // not a change either.
            if (!val || val === activeModule) return;
            const next = val === NONE ? '' : val;
            setModuleKey(next);
            // Changing module invalidates the sub-category, and emitting '' is
            // what stops a stale id from a different module being submitted.
            onChange('', null);
          }}
          disabled={disabled}
        >
          <SelectTrigger id={`${id}-module`} className={triggerClass}>
            <SelectValue placeholder="Select category" />
          </SelectTrigger>
          <SelectContent className="max-h-[320px]">
            {modules.map((m) => (
              <SelectItem key={m.moduleKey} value={m.moduleKey}>{m.moduleName}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        {subLabel ? <Label htmlFor={`${id}-document`}>{subLabel}</Label> : null}
        <Select
          value={value || NONE}
          // The chosen row, not just its id. A caller that needs the taxonomy
          // pair — to ask what this category calls its identifier, say — would
          // otherwise have to fetch and re-index the whole master list to turn
          // the id back into the object this component already has in hand.
          // '' is the same native-select artefact as above, never a user's pick.
          onValueChange={(val) => val && onChange(
            val === NONE ? '' : val,
            val === NONE ? null : subCategories.find((c) => c.id === val) ?? null,
          )}
          disabled={disabled || !activeModule}
        >
          <SelectTrigger id={`${id}-document`} className={triggerClass}>
            <SelectValue placeholder={activeModule ? 'Select sub-category' : placeholder} />
          </SelectTrigger>
          <SelectContent className="max-h-[320px]">
            {unrenderableValue && (
              <SelectItem value={value} disabled>Not available to you</SelectItem>
            )}
            {subCategories.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.documentName}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
