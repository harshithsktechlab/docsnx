'use client';

/**
 * The bank-locker additions to the generic sub-category page (0069, moved
 * under Bank & Investments by 0070).
 *
 * <SubCategoryWorkspace> knows nothing about lockers and stays that way: it
 * renders what this file hands it — an inventory panel on the locker
 * agreement's summary, and a few extra columns on either list. Every other
 * category gets nothing and is untouched.
 *
 * Everything here reads the same permission-checked list endpoints the pages
 * use, so a member who may not view locker items is told so rather than shown
 * an empty locker.
 */
import { useEffect, useMemo, useState } from 'react';
import { Gem, Lock, Plus, Scale } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useWorkspaceApi } from '@/lib/net/useWorkspaceApi';
import { scopeForCategory } from '@/lib/records/registry';
import {
  GROSS_WEIGHT_KEY, LOCKER_REF_KEY, NET_WEIGHT_KEY, gramsOf, summariseInventory,
} from '@/lib/records/lockerInventory';
import { AttachmentThumb } from './RecordPhotos';
import { linkedRecordLabel, useLinkedRecords } from './useLinkedRecords';

export const LOCKERS = { moduleKey: 'bank_investments', documentKey: 'bank_locker_agreement' };
export const LOCKER_ITEMS = { moduleKey: 'bank_investments', documentKey: 'locker_items' };

const ITEMS_SCOPE = scopeForCategory(LOCKER_ITEMS);

const is = (key, moduleKey, documentKey) => key.moduleKey === moduleKey && key.documentKey === documentKey;

/** "1,234.5 g" */
export function formatGrams(n) {
  return `${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 3 })} g`;
}

/** A choice field's stored value as its label, from the category's own spec. */
function optionLabel(spec, key, value) {
  if (!value) return '';
  const field = spec?.find((f) => f.fieldKey === key);
  return field?.options?.find((o) => o.value === value)?.label ?? String(value);
}

/**
 * The item category's field spec — for choice labels, and for whether an
 * operator has sealed the weights (in which case no total is possible).
 */
function useItemSpec(enabled = true) {
  const { api, companyId } = useWorkspaceApi();
  const [spec, setSpec] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    (async () => {
      const { res, json } = await api(`/api/modules/${LOCKER_ITEMS.moduleKey}/${LOCKER_ITEMS.documentKey}/fields`);
      if (!cancelled && res.ok && json?.success) setSpec(json.fields || []);
    })();
    return () => { cancelled = true; };
  }, [companyId, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return spec;
}

function weightIsSealed(spec) {
  return Boolean(spec?.some((f) => (f.fieldKey === GROSS_WEIGHT_KEY || f.fieldKey === NET_WEIGHT_KEY) && f.isPii));
}

/** First photo of an item, as a thumbnail — or a gem placeholder. */
function ItemThumb({ item, onClick }) {
  const photo = item.attachments?.[0];
  if (!photo) {
    return (
      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted text-muted-foreground">
        <Gem size={14} />
      </span>
    );
  }
  return <AttachmentThumb scope={ITEMS_SCOPE} recordId={item.id} attachment={photo} onClick={onClick} />;
}

/** How an item came to be in the family, in a few words. */
function acquisitionLine(item, spec) {
  const f = item.fields || {};
  const how = optionLabel(spec, 'acquisition_type', f.acquisition_type);
  if (f.acquisition_type === 'purchased' && f.purchased_from) return `${how} · ${f.purchased_from}`;
  if (f.acquisition_type === 'gifted' && f.occasion) return `${how} · ${f.occasion}`;
  return how;
}

/**
 * The Bank lockers summary: one card per locker, what is in it, and its weight.
 */
export function LockerInventoryPanel({ canAddItems, onAddItem, onPreviewItem, refreshKey }) {
  const lockers = useLinkedRecords(LOCKERS);
  const items = useLinkedRecords(LOCKER_ITEMS);
  const spec = useItemSpec();
  useEffect(() => {
    if (refreshKey) { lockers.refresh(); items.refresh(); }
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = useMemo(
    () => summariseInventory(items.records, lockers.records, { weightSealed: weightIsSealed(spec) }),
    [items.records, lockers.records, spec],
  );

  if (!lockers.loaded || !items.loaded) return null;

  const weightCell = (grams) => (summary.weightSealed
    ? <span className="inline-flex items-center gap-1 text-muted-foreground"><Lock size={10} /> sealed</span>
    : formatGrams(grams));

  return (
    <Card className="border-border/50 bg-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-bold flex flex-wrap items-center gap-2">
          <Gem size={15} className="text-primary" />
          Locker inventory
          {!items.forbidden && (
            <span className="ml-auto flex items-center gap-3 text-xs font-semibold text-muted-foreground">
              <span className="inline-flex items-center gap-1"><Scale size={12} /> Gross {weightCell(summary.totalGrossGrams)}</span>
              <span>Net {weightCell(summary.totalNetGrams)}</span>
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {items.forbidden ? (
          <p className="text-xs text-muted-foreground">
            You don&apos;t have access to locker items. Ask a workspace admin to grant it under Members → Permissions.
          </p>
        ) : lockers.records.length === 0 ? (
          <p className="text-xs text-muted-foreground">Add a locker first, then record what is kept in it.</p>
        ) : (
          <>
            {lockers.records.map((locker) => {
              const t = summary.byLocker.get(locker.id);
              return (
                <LockerBlock
                  key={locker.id}
                  title={linkedRecordLabel(locker)}
                  subtitle={locker.fields?.branch_address}
                  totals={t}
                  spec={spec}
                  weightCell={weightCell}
                  onPreviewItem={onPreviewItem}
                  action={canAddItems && (
                    <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => onAddItem(locker.id)}>
                      <Plus size={11} /> Add item
                    </Button>
                  )}
                />
              );
            })}
            {summary.unassigned.count > 0 && (
              <LockerBlock
                title="Not in a locker"
                totals={summary.unassigned}
                spec={spec}
                weightCell={weightCell}
                onPreviewItem={onPreviewItem}
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function LockerBlock({ title, subtitle, totals, spec, weightCell, onPreviewItem, action }) {
  return (
    <div className="rounded-lg border border-border/40 bg-background/30">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 px-3 py-2">
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-xs font-bold text-foreground">{title}</span>
          {subtitle && <span className="truncate text-xs text-muted-foreground">{subtitle}</span>}
        </span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary" className="text-2xs">{totals.count} item{totals.count === 1 ? '' : 's'}</Badge>
          <span className="tabular-nums">{weightCell(totals.grossGrams)}</span>
          {action}
        </span>
      </div>
      {totals.count === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">Nothing recorded in this locker yet.</p>
      ) : (
        <div className="flex flex-col divide-y divide-border/30">
          {totals.items.map((item) => (
            <div key={item.id} className="flex items-center gap-3 px-3 py-2">
              <ItemThumb item={item} onClick={() => onPreviewItem(item)} />
              <button
                type="button"
                onClick={() => onPreviewItem(item)}
                className="flex min-w-0 flex-1 flex-col text-left hover:text-primary"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-xs font-semibold text-foreground">{item.title}</span>
                  {item.fields?.locker_movement === 'withdrawn' && (
                    <Badge variant="destructive" className="shrink-0 text-2xs">
                      Withdrawn{item.fields?.movement_date ? ` · ${item.fields.movement_date}` : ''}
                    </Badge>
                  )}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {[
                    optionLabel(spec, 'item_type', item.fields?.item_type),
                    optionLabel(spec, 'metal_purity', item.fields?.metal_purity),
                    item.display?.holderName,
                    acquisitionLine(item, spec),
                  ].filter(Boolean).join(' · ')}
                </span>
              </button>
              <span className="shrink-0 text-xs tabular-nums text-foreground/80">
                {gramsOf(item.fields?.[GROSS_WEIGHT_KEY]) !== null
                  ? weightCell(gramsOf(item.fields[GROSS_WEIGHT_KEY]))
                  : '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Extra list columns for either locker category, inserted after "Record".
 * Returns [] for every other category.
 */
export function useLockerColumns(categoryKey, { onPreview } = {}) {
  const isItems = is(categoryKey, LOCKER_ITEMS.moduleKey, LOCKER_ITEMS.documentKey);
  const isLockers = is(categoryKey, LOCKERS.moduleKey, LOCKERS.documentKey);
  // Hooks run unconditionally; the targets are null when not needed, which the
  // hook treats as "nothing to load".
  const lockers = useLinkedRecords(isItems ? LOCKERS : null);
  const items = useLinkedRecords(isLockers ? LOCKER_ITEMS : null);
  const spec = useItemSpec(isItems || isLockers);

  return useMemo(() => {
    if (isItems) {
      const titles = new Map(lockers.records.map((l) => [l.id, linkedRecordLabel(l)]));
      return [
        {
          header: 'Photo',
          key: 'photo',
          render: (r) => <ItemThumb item={r} onClick={onPreview ? () => onPreview(r) : undefined} />,
        },
        {
          header: 'Locker',
          key: 'locker',
          render: (r) => {
            const ref = r.fields?.[LOCKER_REF_KEY];
            return (
              <span className="text-xs text-muted-foreground">
                {!ref ? '—' : titles.get(ref) ?? (lockers.loaded ? 'Locker removed' : '…')}
              </span>
            );
          },
        },
        {
          header: 'Weight',
          key: 'weight',
          render: (r) => {
            const g = gramsOf(r.fields?.[GROSS_WEIGHT_KEY]);
            return <span className="text-xs tabular-nums">{g === null ? '—' : formatGrams(g)}</span>;
          },
        },
        {
          header: 'Acquired',
          key: 'acquired',
          render: (r) => <span className="text-xs text-muted-foreground">{acquisitionLine(r, spec) || '—'}</span>,
        },
      ];
    }
    if (isLockers) {
      const summary = summariseInventory(items.records, [], { weightSealed: weightIsSealed(spec) });
      const byLocker = new Map();
      for (const item of items.records) {
        const ref = item.fields?.[LOCKER_REF_KEY];
        if (!ref) continue;
        const t = byLocker.get(ref) ?? { count: 0, grams: 0 };
        t.count += 1;
        t.grams += gramsOf(item.fields?.[GROSS_WEIGHT_KEY]) ?? 0;
        byLocker.set(ref, t);
      }
      if (items.forbidden) return [];
      return [
        {
          header: 'Items',
          key: 'items',
          render: (r) => <span className="text-xs tabular-nums">{byLocker.get(r.id)?.count ?? 0}</span>,
        },
        {
          header: 'Weight',
          key: 'weight',
          render: (r) => (
            <span className="text-xs tabular-nums">
              {summary.weightSealed ? 'sealed' : formatGrams(byLocker.get(r.id)?.grams ?? 0)}
            </span>
          ),
        },
      ];
    }
    return [];
  }, [isItems, isLockers, lockers.records, lockers.loaded, items.records, items.forbidden, spec, onPreview]);
}

/** How many items point at a locker — for the delete warning. */
export function itemsInLocker(records, lockerId) {
  return records.filter((r) => r.fields?.[LOCKER_REF_KEY] === lockerId).length;
}
