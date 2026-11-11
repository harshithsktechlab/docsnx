'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ONE DOCUMENT, EVERYTHING ABOUT IT, EDITABLE IN PLACE                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Opened by clicking a row on the Documents Manager. A right-hand panel (the
 * list stays visible behind it) with:
 *   · the scan itself, with the ORIGINAL uploaded file name under it;
 *   · where the document is filed and who it belongs to;
 *   · every field of its category — with a lock-and-reveal on sealed ones;
 *   · the file's own facts (type, size, pages, uploaded by / when).
 *
 * ── EDITING IS PER FIELD ───────────────────────────────────────────────────
 * Each block has a pencil. It turns into the same input the Edit form uses,
 * with Save / Cancel beside it, and saves on its own. Only one block is open at
 * a time, so "what is about to be saved" is never ambiguous.
 *
 * ── WHY A FIELD SAVE SENDS THE WHOLE BODY ──────────────────────────────────
 * PUT /api/documents/:id REPLACES a record's body rather than merging into it
 * (see updateVaultRecordBody). So a one-field save posts every field — and it
 * must post the REVEALED values from GET /api/documents/:id, never a list row,
 * whose identifier is masked ('••••1234') and whose sealed fields are absent.
 * Saving from the list row would write the mask back as the real number.
 *
 * Filing and holders are different: they are columns, not body, so those saves
 * send only themselves and leave the body alone.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  AlertCircle, Check, Download, Eye, EyeOff, FileText, Loader2, Lock, Maximize2,
  Pencil, Printer, Share2, Trash2, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/dateHelper';
import FilePreviewPane, { formatBytes } from '@/components/records/FilePreviewPane';
import CategorySelect from '@/app/components/CategorySelect';
import OthersLabelInput from '@/app/components/OthersLabelInput';
import HolderSelect, { holderValues } from '@/app/components/HolderSelect';
import CategoryFieldInputs, {
  CustomFieldRows, LinkedCardRows, TITLE_KEY, asInputValue,
} from '@/app/components/CategoryFieldInputs';
import useCategoryFields from '@/app/components/useCategoryFields';
import { holdersForWrite } from '@/lib/records/holderScope';
import { docCustomFields } from '@/lib/records/docFieldsClient';
import { parseMultiValue, describeFieldErrors } from '@/lib/records/fieldValidation';
import { parseLinkedCards, LINKED_CARDS_KEY, CARD_NETWORKS, CARD_TYPES } from '@/lib/records/linkedCards';
import { acceptsCustomLabel } from '@/lib/documentCategories';
import { categoryDisplayName } from '@/lib/records/customSubcategory';

/** The editable block that is open, or '' for none. */
const FILING = 'filing';
const HOLDERS = 'holders';
const CUSTOM = 'custom';
const CARDS = 'cards';
const fieldBlock = (key) => `field:${key}`;

/** A stored value as a person reads it — option labels, dates, yes/no. */
function readable(spec, raw) {
  const value = asInputValue(raw);
  if (!value) return '';
  const options = spec.options ?? [];
  const labelOf = (v) => options.find((o) => o.value === v)?.label ?? v;
  switch (spec.dataType) {
    case 'date': return formatDate(value) || value;
    case 'boolean': return value === 'true' ? 'Yes' : value === 'false' ? 'No' : value;
    case 'select': return labelOf(value);
    case 'multiselect': return (parseMultiValue(value) ?? [value]).map(labelOf).join(', ');
    case 'member': return value.startsWith('member:') ? '' : value;
    default: return value;
  }
}

/** '••••1234' — the tail only, so the value is recognisable but not readable. */
function maskTail(value) {
  const text = String(value);
  return text.length <= 4 ? '••••' : `••••${text.slice(-4)}`;
}

/** 'HDFC Regalia · Visa Credit · ends 1234' — the card as one line. */
function cardLine(card, index) {
  const network = CARD_NETWORKS.find((n) => n.value === card.cardNetwork)?.label ?? '';
  const type = CARD_TYPES.find((t) => t.value === card.cardType)?.label ?? '';
  const digits = String(card.cardNumber ?? '').replace(/\D/g, '');
  const parts = [card.cardName, [network, type].filter(Boolean).join(' '), digits.length >= 4 ? `ends ${digits.slice(-4)}` : '']
    .filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : `Card ${index + 1}`;
}

/** Label above a read-only value. */
function Row({ label, children, className }) {
  return (
    <div className={cn('flex flex-col gap-0.5 min-w-0', className)}>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="text-sm text-foreground break-words">{children}</div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="flex flex-col gap-3 border-t border-border/60 pt-5">
      <h3 className="text-xs font-bold uppercase tracking-wider text-primary">{title}</h3>
      {children}
    </section>
  );
}

/**
 * A block that is either read-only with a pencil, or an editor with Save/Cancel.
 * `children` is the read view; `editor` the edit view.
 */
function EditableBlock({ block, open, canEdit, busy, onEdit, onSave, onCancel, editor, children, className }) {
  const editing = open === block;
  return (
    <div className={cn('group relative rounded-lg', editing && 'bg-muted/30 ring-1 ring-primary/30 p-3 -m-3', className)}>
      {editing ? (
        <div className="flex flex-col gap-3">
          {editor}
          <div className="flex items-center gap-2 justify-end">
            <Button type="button" size="sm" variant="secondary" onClick={onCancel} disabled={busy}>
              <X size={14} className="mr-1" /> Cancel
            </Button>
            <Button type="button" size="sm" onClick={onSave} disabled={busy}>
              {busy ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Check size={14} className="mr-1" />}
              Save
            </Button>
          </div>
        </div>
      ) : (
        <>
          {children}
          {canEdit && (
            <button
              type="button"
              onClick={() => onEdit(block)}
              disabled={busy}
              aria-label="Edit"
              title="Edit"
              className="absolute -right-1 -top-1 rounded-md p-1.5 text-muted-foreground opacity-60 hover:opacity-100 hover:bg-muted hover:text-foreground focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring group-hover:opacity-100"
            >
              <Pencil size={13} />
            </button>
          )}
        </>
      )}
    </div>
  );
}

export default function DocumentDetailPanel({
  doc,
  api,
  companyId,
  /** (action) => boolean, already bound to this row. */
  may,
  taxonomyLabel,
  /** Refetch the list after a save. */
  onChanged,
  onClose,
  onDownload,
  onShare,
  onPrint,
  onDelete,
  /** Open the full Edit form (replace the file, AI "fill blanks"). */
  onEditAll,
  /** Open the large preview dialog. */
  onExpandPreview,
  onRotate,
  categoryOptions = [],
}) {
  // The category the record's BODY is sealed under. Re-filing moves only the
  // row's FK (the PUT leaves categoryModuleKey/DocumentKey alone), so the spec
  // must keep following the original pair or the fields would stop matching
  // what the server validates against.
  const [specRef] = useState(doc.categoryRef ?? null);
  const fields = useCategoryFields(specRef);

  const [full, setFull] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [open, setOpen] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [revealed, setRevealed] = useState(() => new Set());

  const [categoryId, setCategoryId] = useState(doc.categoryId || '');
  const [label, setLabel] = useState(doc.customSubcategory || '');
  const [holderIds, setHolderIds] = useState(() => holderValues(doc));

  const canEdit = may('edit');
  const baseline = useRef(null);

  const seedFrom = useCallback((record) => {
    const stored = {
      ...(record?.metadata?.open ?? {}),
      [TITLE_KEY]: record?.metadata?.open?.[TITLE_KEY] ?? doc.title ?? '',
    };
    fields.seed(stored, docCustomFields(record));
    baseline.current = { open: stored, custom: docCustomFields(record) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields.seed, doc.title]);

  // Load the REVEALED record once per document.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    (async () => {
      try {
        const { json } = await api(`/api/documents/${doc.id}`);
        if (cancelled) return;
        if (!json?.success) {
          setLoadError(json?.error || 'Could not load this document’s details.');
          return;
        }
        setFull(json.document);
        seedFrom(json.document);
      } catch {
        if (!cancelled) setLoadError('Could not load this document’s details.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id]);

  const specFields = fields.fields;
  const titleSpec = useMemo(() => specFields.find((f) => f.fieldKey === TITLE_KEY), [specFields]);
  const detailFields = useMemo(() => specFields.filter((f) => f.fieldKey !== TITLE_KEY), [specFields]);

  const takesLabel = useMemo(
    () => acceptsCustomLabel(categoryOptions.find((c) => c.id === categoryId)),
    [categoryOptions, categoryId],
  );

  /** Put every editor back to what is stored. */
  const discard = useCallback(() => {
    if (baseline.current) fields.seed(baseline.current.open, baseline.current.custom);
    setCategoryId(doc.categoryId || '');
    setLabel(doc.customSubcategory || '');
    setHolderIds(holderValues(doc));
    setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields.seed, doc]);

  const startEdit = (block) => {
    if (open && open !== block) discard();
    setError('');
    setOpen(block);
  };
  const cancelEdit = () => { discard(); setOpen(''); };

  /** PUT, then re-read so what is shown is what the server stored. */
  const put = async (body, success = 'Saved') => {
    setSaving(true);
    setError('');
    try {
      const { json } = await api(`/api/documents/${doc.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!json?.success) {
        if (json?.fieldErrors) fields.showErrors(json.fieldErrors);
        setError(json?.error || 'Could not save');
        return false;
      }
      toast.success(success);
      const { json: fresh } = await api(`/api/documents/${doc.id}`);
      if (fresh?.success) {
        setFull(fresh.document);
        seedFrom(fresh.document);
      }
      setOpen('');
      onChanged?.();
      return true;
    } catch (err) {
      console.error('[documents] detail save threw', err);
      setError('Something went wrong saving. Please try again.');
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** Fields, custom rows and cards — everything that lives in the body. */
  const saveBody = async () => {
    const record = fields.payload();
    const title = String(record[TITLE_KEY] ?? '').trim();
    const fieldErrors = fields.validate(record);
    if (!title) fieldErrors[TITLE_KEY] = fieldErrors[TITLE_KEY] ?? 'Give this document a name';
    if (Object.keys(fieldErrors).length > 0) {
      fields.showErrors(fieldErrors);
      setError(describeFieldErrors(fields.fields, fieldErrors));
      return;
    }
    await put({ title, metadata: record, taxonomyFields: true });
  };

  const saveFiling = async () => {
    if (!categoryId) { setError('Pick a sub-category before saving.'); return; }
    await put({ categoryId, customSubcategory: takesLabel ? label : null }, 'Filing updated');
  };

  const saveHolders = async () => {
    const h = holdersForWrite(companyId, holderIds);
    await put({
      holderId: h.holderId === undefined ? undefined : (h.holderId || null),
      holderIds: h.holderIds,
    }, 'Holders updated');
  };

  const toggleReveal = (key) => setRevealed((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const title = String(fields.values[TITLE_KEY] ?? '').trim() || doc.title;
  const storedTitle = String(baseline.current?.open?.[TITLE_KEY] ?? doc.title ?? '');
  const customRows = baseline.current?.custom ?? [];
  const cards = useMemo(
    () => parseLinkedCards(full?.metadata?.open?.[LINKED_CARDS_KEY]).cards ?? [],
    [full],
  );
  const holderNames = (full?.holders?.length ? full.holders.map((h) => h.name).filter(Boolean).join(', ') : '')
    || doc.display?.holderName || 'All members';
  const filedUnder = taxonomyLabel
    || [doc.categoryRef?.moduleName, categoryDisplayName(doc.categoryRef, doc.customSubcategory)].filter(Boolean).join(' - ');

  const busy = saving || loading;
  const fileMeta = [
    doc.mimeType,
    doc.fileSize ? formatBytes(doc.fileSize) : '',
    doc.pageCount > 1 ? `${doc.pageCount} pages` : '',
  ].filter(Boolean).join(' · ');

  return (
    <DialogPrimitive.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed right-0 top-0 z-50 flex h-full w-full flex-col border-l border-border bg-popover shadow-[0_0_80px_rgba(0,0,0,0.4)] sm:max-w-[600px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right duration-200 focus:outline-none"
        >
          {/* ── Header ───────────────────────────────────────────────── */}
          <header className="flex items-start gap-3 border-b border-border px-5 py-4 pr-12">
            <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <FileText size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
              {open === fieldBlock(TITLE_KEY) && titleSpec ? (
                <EditableBlock
                  block={fieldBlock(TITLE_KEY)} open={open} canEdit={false} busy={saving}
                  onSave={saveBody} onCancel={cancelEdit}
                  editor={(
                    <CategoryFieldInputs
                      fields={[titleSpec]}
                      values={fields.values}
                      errors={fields.errors}
                      touched={fields.touched}
                      disabled={saving}
                      onChange={fields.setValue}
                      onBlur={fields.onBlur}
                      registerRef={fields.registerRef}
                      className="sm:grid-cols-1"
                    />
                  )}
                />
              ) : (
                <div className="flex items-start gap-1.5">
                  <h2 className="text-lg font-bold leading-snug text-foreground break-words">{storedTitle || doc.title}</h2>
                  {canEdit && titleSpec && !loading && (
                    <button
                      type="button"
                      onClick={() => startEdit(fieldBlock(TITLE_KEY))}
                      aria-label="Rename document"
                      title="Rename"
                      className="mt-0.5 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                </div>
              )}
              <p className="mt-0.5 text-xs text-muted-foreground break-words">{filedUnder}</p>
            </div>
            <DialogPrimitive.Close
              aria-label="Close"
              className="absolute right-3 top-3 rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <X size={16} />
            </DialogPrimitive.Close>
          </header>

          {/* ── Actions ──────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-5 py-2.5">
            {may('share') && (
              <Button size="sm" variant="outline" onClick={onShare} className="gap-1.5"><Share2 size={13} />Share</Button>
            )}
            {may('share') && (
              <Button size="sm" variant="outline" onClick={onDownload} className="gap-1.5"><Download size={13} />Download</Button>
            )}
            <Button size="sm" variant="outline" onClick={onPrint} className="gap-1.5"><Printer size={13} />Print</Button>
            {canEdit && (
              <Button size="sm" variant="outline" onClick={onEditAll} className="gap-1.5" title="Replace the file or fill blanks from a new scan">
                <Pencil size={13} />Replace file…
              </Button>
            )}
            {may('delete') && (
              <Button size="sm" variant="outline" onClick={onDelete} className="ml-auto gap-1.5 text-destructive hover:text-destructive border-destructive/30">
                <Trash2 size={13} />Delete
              </Button>
            )}
          </div>

          {/* ── Body ─────────────────────────────────────────────────── */}
          <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
            {error && (
              <Alert variant="destructive">
                <AlertCircle size={16} />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {/* Preview, with the ORIGINAL file name under it. */}
            <div className="flex flex-col overflow-hidden rounded-xl border border-border/70 bg-background/40">
              {doc.filePath ? (
                <FilePreviewPane
                  className="h-[300px]"
                  source={{
                    kind: 'record', filePath: doc.filePath, mimeType: doc.mimeType,
                    name: doc.title, pageCount: doc.pageCount, fileSize: doc.fileSize,
                  }}
                  rotation={doc.rotation || 0}
                  onRotate={canEdit ? onRotate : null}
                  emptyMessage={`No preview available for ${doc.title}`}
                  fallbackAction={may('share') ? (
                    <Button className="mt-4 gap-1.5" onClick={onDownload}><Download size={16} />Download File</Button>
                  ) : null}
                />
              ) : (
                <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
                  No file is stored for this record.
                </div>
              )}
              <div className="flex items-center gap-2 border-t border-border/60 bg-muted/30 px-3 py-2">
                <FileText size={14} className="shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold text-foreground" title={doc.fileName || ''}>
                    {doc.fileName || 'No original file name'}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    Original file{fileMeta ? ` · ${fileMeta}` : ''}
                  </p>
                </div>
                {doc.filePath && (
                  <Button size="sm" variant="ghost" onClick={onExpandPreview} className="h-7 gap-1 px-2 text-xs">
                    <Maximize2 size={12} />Expand
                  </Button>
                )}
              </div>
            </div>

            {loadError && (
              <Alert variant="destructive">
                <AlertCircle size={16} />
                <AlertDescription>{loadError}</AlertDescription>
              </Alert>
            )}

            {/* Filing + holders — columns on the row, not part of the body. */}
            <Section title="Filing">
              <EditableBlock
                block={FILING} open={open} canEdit={canEdit && !loading} busy={saving}
                onEdit={startEdit} onSave={saveFiling} onCancel={cancelEdit}
                editor={(
                  <div className="grid grid-cols-1 gap-3">
                    <CategorySelect
                      id="detailCategory" label="Category" subLabel="Sub-category"
                      value={categoryId} onChange={setCategoryId} disabled={saving} action="edit"
                    />
                    {takesLabel && (
                      <OthersLabelInput id="detailLabel" value={label} onChange={setLabel} disabled={saving} />
                    )}
                  </div>
                )}
              >
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 pr-6">
                  <Row label="Category">{doc.categoryRef?.moduleName || '—'}</Row>
                  <Row label="Sub-category">
                    {categoryDisplayName(doc.categoryRef, doc.customSubcategory) || doc.category || '—'}
                  </Row>
                </div>
              </EditableBlock>

              <EditableBlock
                block={HOLDERS} open={open} canEdit={canEdit && !loading} busy={saving}
                onEdit={startEdit} onSave={saveHolders} onCancel={cancelEdit}
                editor={<HolderSelect multiple id="detailHolders" value={holderIds} onChange={setHolderIds} disabled={saving} />}
              >
                <Row label="Belongs to" className="pr-6">{holderNames}</Row>
              </EditableBlock>
            </Section>

            {/* The category's own fields. */}
            <Section title={`${fields.spec?.category?.documentName || 'Document'} details`}>
              {loading || fields.loadingSpec ? (
                <div className="flex items-center gap-2 py-3 text-muted-foreground">
                  <Loader2 size={16} className="animate-spin" />
                  <span className="text-xs">Decrypting this document’s details…</span>
                </div>
              ) : fields.specError ? (
                <Alert variant="destructive"><AlertCircle size={16} /><AlertDescription>{fields.specError}</AlertDescription></Alert>
              ) : detailFields.length === 0 ? (
                <p className="text-xs text-muted-foreground">This category has no extra fields.</p>
              ) : (
                <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2">
                  {detailFields.map((spec) => {
                    const stored = baseline.current?.open?.[spec.fieldKey];
                    const shown = readable(spec, stored);
                    const block = fieldBlock(spec.fieldKey);
                    const hide = spec.isPii && shown && !revealed.has(spec.fieldKey);
                    return (
                      <EditableBlock
                        key={spec.fieldKey}
                        block={block} open={open} canEdit={canEdit} busy={saving}
                        onEdit={startEdit} onSave={saveBody} onCancel={cancelEdit}
                        className={cn(spec.dataType === 'longtext' && 'sm:col-span-2', open === block && 'sm:col-span-2')}
                        editor={(
                          <CategoryFieldInputs
                            fields={[spec]}
                            values={fields.values}
                            errors={fields.errors}
                            touched={fields.touched}
                            disabled={saving}
                            onChange={fields.setValue}
                            onBlur={fields.onBlur}
                            registerRef={fields.registerRef}
                            className="sm:grid-cols-1"
                          />
                        )}
                      >
                        <Row
                          label={(
                            <span className="inline-flex items-center gap-1">
                              {spec.fieldLabel}
                              {spec.isPii && <Lock size={10} className="text-faint" aria-label="Encrypted" />}
                            </span>
                          )}
                          className="pr-6"
                        >
                          {shown ? (
                            <span className="inline-flex items-center gap-1.5">
                              <span className={cn(spec.dataType === 'longtext' && 'whitespace-pre-wrap')}>
                                {hide ? maskTail(shown) : shown}
                              </span>
                              {spec.isPii && (
                                <button
                                  type="button"
                                  onClick={() => toggleReveal(spec.fieldKey)}
                                  aria-label={hide ? `Show ${spec.fieldLabel}` : `Hide ${spec.fieldLabel}`}
                                  className="rounded p-0.5 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                                >
                                  {hide ? <Eye size={13} /> : <EyeOff size={13} />}
                                </button>
                              )}
                            </span>
                          ) : <span className="text-muted-foreground">—</span>}
                        </Row>
                      </EditableBlock>
                    );
                  })}
                </div>
              )}
            </Section>

            {/* User-defined extras. */}
            {!loading && !fields.specError && (
              <Section title="Additional details">
                <EditableBlock
                  block={CUSTOM} open={open} canEdit={canEdit} busy={saving}
                  onEdit={startEdit} onSave={saveBody} onCancel={cancelEdit}
                  editor={<CustomFieldRows rows={fields.customRows} onChange={fields.setCustomRows} disabled={saving} />}
                >
                  {customRows.length === 0 ? (
                    <p className="text-xs text-muted-foreground pr-6">Nothing added. Use the pencil to add your own label and value.</p>
                  ) : (
                    <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2 pr-6">
                      {customRows.map((row, i) => (
                        <Row key={`${row.label}-${i}`} label={row.label}>{row.value}</Row>
                      ))}
                    </div>
                  )}
                </EditableBlock>
              </Section>
            )}

            {!loading && fields.hasCards && (
              <Section title="Linked cards">
                <EditableBlock
                  block={CARDS} open={open} canEdit={canEdit} busy={saving}
                  onEdit={startEdit} onSave={saveBody} onCancel={cancelEdit}
                  editor={(
                    <LinkedCardRows
                      value={fields.cardsValue}
                      onChange={fields.setCardsValue}
                      disabled={saving}
                      error={fields.touched[LINKED_CARDS_KEY] ? fields.errors[LINKED_CARDS_KEY] : undefined}
                    />
                  )}
                >
                  {cards.length === 0 ? (
                    <p className="text-xs text-muted-foreground pr-6">No cards linked.</p>
                  ) : (
                    <ul className="flex flex-col gap-1 pr-6 text-sm">
                      {cards.map((c, i) => (
                        <li key={c.id || i}>{cardLine(c, i)}</li>
                      ))}
                    </ul>
                  )}
                </EditableBlock>
              </Section>
            )}

            {/* The file's own facts — read-only; they describe the upload. */}
            <Section title="File information">
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2">
                <Row label="Original file name" className="sm:col-span-2">{doc.fileName || '—'}</Row>
                <Row label="Type">{doc.mimeType || '—'}</Row>
                <Row label="Size">{doc.fileSize ? formatBytes(doc.fileSize) : '—'}</Row>
                <Row label="Pages">{doc.pageCount || 1}</Row>
                <Row label="Uploaded by">{doc.user?.name || '—'}</Row>
                <Row label="Uploaded on">{formatDate(doc.createdAt) || '—'}</Row>
                <Row label="Last updated">{formatDate(doc.updatedAt) || '—'}</Row>
              </div>
            </Section>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
