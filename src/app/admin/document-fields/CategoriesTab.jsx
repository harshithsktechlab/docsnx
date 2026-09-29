'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  CATEGORIES & SUB-CATEGORIES — the taxonomy itself                       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Its sibling tab configures what a document type COLLECTS. This one decides
 * which document types exist.
 *
 * ── WHAT THE SCREEN OWES THE OPERATOR ──────────────────────────────────────
 *  1. THE BLAST RADIUS, BEFORE THE CLICK. This taxonomy is global: a document
 *     type added here appears for every tenant on the platform. That sentence
 *     is on the screen and in the create dialog, not buried in a tooltip.
 *  2. THE KEY IS VISIBLE AND OBVIOUSLY NOT EDITABLE. It is shown in monospace
 *     next to the name it was derived from, so "why can't I fix this typo in
 *     the key" is answered before it is asked — the key names the Drive folder
 *     the records live in and cannot move.
 *  3. RETIRE IS NOT DELETE, AND SAYS SO. The record count is on the row, and
 *     retiring a category that holds records is confirmed by typing. Nothing
 *     here deletes anything, because nothing here can: the records are
 *     encrypted on tenant Drives and unreadable from this platform.
 *
 * ── WHY MODULES ARE NOT CREATABLE HERE ─────────────────────────────────────
 * A sub-category inherits its module's permissions, page, Drive folder, colour
 * and icon. A module has none of those and cannot derive them from a label —
 * see the POST handler in /api/admin/document-categories, which refuses it
 * explicitly rather than half-creating one. The screen says so where an
 * operator would look for the button.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Loader2, Plus, Search, Pencil, Check, X, EyeOff, Eye, Settings2, Lock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogBody,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { apiCall } from '@/lib/net/apiRequest';

/** Typed to retire a category that still holds records. See `RetireDialog`. */
const RETIRE_PHRASE = 'RETIRE';

/**
 * @param {object}    props
 * @param {Function}  props.onConfigureFields  Switch to the Fields tab, on this
 *                                             category.
 * @param {Function}  props.onTaxonomyChanged  Tell the shell the taxonomy moved,
 *                                             so the other tab reloads.
 */
export default function CategoriesTab({ onConfigureFields, onTaxonomyChanged }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  /** The module an operator is adding a document type to, or null. */
  const [adding, setAdding] = useState(null);
  const [addError, setAddError] = useState('');
  /** `${moduleKey}/${documentKey}` of the row being renamed inline. */
  const [editing, setEditing] = useState(null);
  const [editValue, setEditValue] = useState('');
  /** The row awaiting a typed confirmation before it is retired. */
  const [retiring, setRetiring] = useState(null);
  const [retireText, setRetireText] = useState('');

  const load = useCallback(async () => {
    try {
      const { json: data } = await apiCall('/api/admin/document-categories');
      if (data.success) setRows(data.categories || []);
      else setError(data.error || 'Could not load the taxonomy');
    } catch { setError('Could not load the taxonomy'); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  /**
   * Grouped by module, in the order the server sent them — (module_no,
   * sort_order), which is the master table's own order and therefore the
   * information architecture. Never re-sorted here.
   */
  const modules = useMemo(() => {
    const q = search.trim().toLowerCase();
    const byKey = new Map();
    for (const c of rows) {
      if (q && !c.documentName.toLowerCase().includes(q)
        && !c.moduleName.toLowerCase().includes(q)
        && !c.documentKey.includes(q)) continue;
      let mod = byKey.get(c.moduleKey);
      if (!mod) {
        mod = { moduleKey: c.moduleKey, moduleName: c.moduleName, items: [] };
        byKey.set(c.moduleKey, mod);
      }
      mod.items.push(c);
    }
    return [...byKey.values()];
  }, [rows, search]);

  const activeInModule = useCallback(
    (moduleKey) => rows.filter((r) => r.moduleKey === moduleKey && r.isActive).length,
    [rows],
  );

  const patch = async (row, body, note) => {
    setBusy(true); setError(''); setSuccess('');
    try {
      const { json: data } = await apiCall('/api/admin/document-categories', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
        moduleKey: row.moduleKey, documentKey: row.documentKey, ...body,
        }),
      });
      if (data.success) {
        setSuccess(note);
        await load();
        onTaxonomyChanged?.();
      } else setError(data.error || 'Could not save that change');
    } catch { setError('Could not save that change'); }
    setBusy(false);
  };

  const create = async (moduleKey, documentName) => {
    setBusy(true); setAddError('');
    try {
      const { json: data } = await apiCall('/api/admin/document-categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moduleKey, documentName }),
      });
      if (data.success) {
        setAdding(null);
        setSuccess(`Added "${documentName}". It now has the four standard fields — `
          + 'add the ones it needs on the Fields tab.');
        await load();
        onTaxonomyChanged?.();
      } else setAddError(data.error || 'Could not add that document type');
    } catch { setAddError('Could not add that document type'); }
    setBusy(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" /> Loading the taxonomy…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Alert>
        <AlertDescription>
          <strong>This list is global.</strong> Every document type here appears for
          every tenant on the platform — in their sidebar, their upload picker and
          the AI that classifies their scans. Names can be changed at any time;
          keys never can, and nothing here is ever deleted.
        </AlertDescription>
      </Alert>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {success && <Alert><AlertDescription>{success}</AlertDescription></Alert>}

      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="h-9 pl-8 text-sm"
          placeholder="Find a module or document type…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {modules.map((mod) => (
        <div key={mod.moduleKey} className="rounded-lg border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{mod.moduleName}</p>
              <p className="truncate font-mono text-xs text-faint">{mod.moduleKey}</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => { setAdding(mod); setAddError(''); }}
            >
              <Plus className="mr-1 size-3.5" /> Add document type
            </Button>
          </div>

          <div className="divide-y">
            {mod.items.map((c) => {
              const id = `${c.moduleKey}/${c.documentKey}`;
              const isEditing = editing === id;
              // The last active row of a module cannot be retired — doing so
              // would take the whole module out of every tenant's navigation.
              // Refused by the server too; disabled here so the operator is not
              // offered a button that only ever returns an error.
              const lastActive = c.isActive && activeInModule(c.moduleKey) <= 1;
              return (
                <div
                  key={id}
                  className={cn(
                    'flex flex-wrap items-center gap-2 px-3 py-2',
                    !c.isActive && 'bg-muted/40',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    {isEditing ? (
                      <div className="flex items-center gap-1">
                        <Input
                          autoFocus
                          className="h-8 text-sm"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setEditing(null);
                            if (e.key === 'Enter' && editValue.trim()) {
                              setEditing(null);
                              patch(c, { documentName: editValue.trim() }, 'Name updated.');
                            }
                          }}
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-8"
                          disabled={!editValue.trim() || busy}
                          onClick={() => {
                            setEditing(null);
                            patch(c, { documentName: editValue.trim() }, 'Name updated.');
                          }}
                        >
                          <Check className="size-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-8"
                          onClick={() => setEditing(null)}
                        >
                          <X className="size-4" />
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-1.5">
                          <span className={cn('truncate text-sm', !c.isActive && 'text-muted-foreground line-through')}>
                            {c.documentName}
                          </span>
                          <button
                            type="button"
                            title="Rename"
                            className="text-faint hover:text-foreground"
                            onClick={() => { setEditing(id); setEditValue(c.documentName); }}
                          >
                            <Pencil className="size-3" />
                          </button>
                        </div>
                        <p
                          className="flex items-center gap-1 truncate font-mono text-xs text-faint"
                          title="The key names the folder these records are stored in. It can never change."
                        >
                          <Lock className="size-2.5 shrink-0" />
                          {c.documentKey}
                        </p>
                      </>
                    )}
                  </div>

                  <Badge variant={c.isSystem ? 'secondary' : 'outline'} className="shrink-0">
                    {c.isSystem ? 'Built in' : 'Added here'}
                  </Badge>

                  <span className="shrink-0 text-xs text-muted-foreground">
                    {c.recordCount} record{c.recordCount === 1 ? '' : 's'}
                  </span>

                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0"
                    onClick={() => onConfigureFields?.(c)}
                  >
                    <Settings2 className="mr-1 size-3.5" />
                    Fields{c.overrides > 0 ? ` (${c.overrides})` : ''}
                  </Button>

                  {c.isActive ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="shrink-0 text-muted-foreground"
                      disabled={busy || lastActive}
                      title={lastActive
                        ? 'The last document type in a module cannot be retired — the '
                          + 'module would disappear from every tenant’s navigation.'
                        : 'Stop offering this document type. Records already filed under '
                          + 'it stay readable.'}
                      onClick={() => {
                        if (c.recordCount > 0) { setRetiring(c); setRetireText(''); return; }
                        patch(c, { isActive: false }, `"${c.documentName}" retired.`);
                      }}
                    >
                      <EyeOff className="mr-1 size-3.5" /> Retire
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="shrink-0"
                      disabled={busy}
                      onClick={() => patch(c, { isActive: true }, `"${c.documentName}" restored.`)}
                    >
                      <Eye className="mr-1 size-3.5" /> Restore
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {modules.length === 0 && (
        <p className="py-10 text-center text-sm text-muted-foreground">No match.</p>
      )}

      <p className="pt-1 text-xs text-muted-foreground">
        New modules are not created here. A document type inherits its module’s
        permissions, its records page, its Drive folder and its colour — a module
        has none of those to inherit, so adding one is a change to the
        application, not a setting.
      </p>

      <AddCategoryDialog
        module={adding}
        saving={busy}
        error={addError}
        onCancel={() => setAdding(null)}
        onCreate={(name) => create(adding.moduleKey, name)}
      />

      <RetireDialog
        row={retiring}
        text={retireText}
        setText={setRetireText}
        saving={busy}
        onCancel={() => setRetiring(null)}
        onConfirm={() => {
          const row = retiring;
          setRetiring(null);
          patch(row, { isActive: false }, `"${row.documentName}" retired.`);
        }}
      />
    </div>
  );
}

/**
 * Adding a document type.
 *
 * Asks for a NAME and nothing else. The key is derived on the server from the
 * name — see taxonomyKey.ts — so there is no key field to get wrong, and the
 * preview below shows what the name will become before the click.
 */
function AddCategoryDialog({ module: mod, saving, error, onCancel, onCreate }) {
  const [name, setName] = useState('');

  useEffect(() => { if (mod) setName(''); }, [mod]);

  /**
   * The same slug rule the server applies, shown so the operator sees the
   * permanent half of what they are creating.
   *
   * A PREVIEW, never the value sent: the server derives the real key and owns
   * uniquifying it against retired rows this screen cannot see.
   */
  const preview = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 57);

  if (!mod) return null;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a document type to {mod.moduleName}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="new-category-name">Name</Label>
            <Input
              id="new-category-name"
              autoFocus
              value={name}
              placeholder="e.g. Gift Deed"
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              What a member sees in the sidebar and the upload picker. Editable later.
            </p>
          </div>

          {preview && (
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
              <p className="text-muted-foreground">Its permanent key will be</p>
              <p className="mt-0.5 font-mono">{mod.moduleKey} / {preview}</p>
              <p className="mt-1 text-muted-foreground">
                This names the folder its records are stored in on every tenant’s
                Drive, and it can never be changed.
              </p>
            </div>
          )}

          <Alert>
            <AlertDescription className="text-xs">
              It appears for <strong>every tenant</strong> immediately, with the four
              standard fields (title, holder, issue date, notes). Add the fields it
              actually needs on the Fields tab.
            </AlertDescription>
          </Alert>

          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button onClick={() => onCreate(name.trim())} disabled={!name.trim() || saving}>
            {saving && <Loader2 className="mr-1 size-4 animate-spin" />}
            Add document type
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Retiring a category that holds records.
 *
 * Typed rather than clicked, and only when there are records — the cost is
 * proportional to what is filed under it, and a confirmation on an empty
 * category is friction that teaches people to click through the one that matters.
 *
 * The wording is deliberately exact about what does NOT happen. Records stay
 * where they are and stay readable; this platform could not delete them if it
 * wanted to, because they are encrypted on each tenant's own Drive.
 */
function RetireDialog({ row, text, setText, saving, onCancel, onConfirm }) {
  if (!row) return null;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Retire “{row.documentName}”?</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3 text-sm">
          <p>
            It stops being offered anywhere: no upload picker, no sidebar entry,
            and the AI will not classify a scan into it.
          </p>
          <p className="text-muted-foreground">
            The <strong>{row.recordCount} record{row.recordCount === 1 ? '' : 's'}</strong> already
            filed under it stay exactly where they are and stay readable. Nothing is
            deleted — and nothing could be: they are encrypted on each tenant’s own
            Drive. You can restore this document type at any time.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="retire-confirm">
              Type <span className="font-mono">{RETIRE_PHRASE}</span> to confirm
            </Label>
            <Input
              id="retire-confirm"
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={text !== RETIRE_PHRASE || saving}
            onClick={onConfirm}
          >
            {saving && <Loader2 className="mr-1 size-4 animate-spin" />}
            Retire it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
