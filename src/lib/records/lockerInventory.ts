/**
 * What is in each locker, and how much it weighs — from the two list
 * responses the browser already has (`bank_investments/bank_locker_agreement`
 * and `bank_investments/locker_items`). Pure, so it is tested without a page.
 *
 * Weights are read from the OPEN tier (`record.fields`). They ship open for
 * exactly this reason (0069/0070). If an operator later seals them on
 * /admin/document-fields, the list carries no value at all and a total of 0
 * would be a lie — so the caller says so (`weightSealed`, read off the item
 * category's spec) and the panel shows that instead of a number.
 *
 * A weight is per ITEM, as its label says ("Gross Weight (g)"), and is not
 * multiplied by `quantity`: a pair of earrings is weighed as the pair.
 */

export const LOCKER_REF_KEY = 'locker_ref';
export const GROSS_WEIGHT_KEY = 'gross_weight_grams';
export const NET_WEIGHT_KEY = 'net_weight_grams';

export interface InventoryRecord {
  id: string;
  title?: string;
  fields?: Record<string, unknown> | null;
}

export interface LockerTotals<T extends InventoryRecord = InventoryRecord> {
  items: T[];
  count: number;
  /** Sum of `quantity`, an item with none counting as one piece. */
  pieces: number;
  grossGrams: number;
  netGrams: number;
  /** Items here that carry no gross weight at all. */
  unweighed: number;
}

export interface InventorySummary<T extends InventoryRecord = InventoryRecord> {
  byLocker: Map<string, LockerTotals<T>>;
  /** Items with no locker, or a locker that no longer exists. */
  unassigned: LockerTotals<T>;
  /** The weight fields are sealed, so no total can be computed from a list. */
  weightSealed: boolean;
  totalGrossGrams: number;
  totalNetGrams: number;
}

/** "12.5", "12.5 g", "1,250" → a number; anything else → null. */
export function gramsOf(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[,\s]/g, '').replace(/g(ms?|rams?)?$/i, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function emptyTotals<T extends InventoryRecord>(): LockerTotals<T> {
  return { items: [], count: 0, pieces: 0, grossGrams: 0, netGrams: 0, unweighed: 0 };
}

function add<T extends InventoryRecord>(totals: LockerTotals<T>, item: T): void {
  const f = item.fields ?? {};
  totals.items.push(item);
  totals.count += 1;
  const qty = Number(f.quantity);
  totals.pieces += Number.isFinite(qty) && qty > 0 ? qty : 1;
  const gross = gramsOf(f[GROSS_WEIGHT_KEY]);
  const net = gramsOf(f[NET_WEIGHT_KEY]);
  if (gross === null) totals.unweighed += 1;
  totals.grossGrams += gross ?? 0;
  totals.netGrams += net ?? 0;
}

/** Rounded for display: weights are entered to the milligram at most. */
export function roundGrams(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function summariseInventory<T extends InventoryRecord>(
  items: readonly T[],
  lockers: readonly { id: string }[],
  options: { weightSealed?: boolean } = {},
): InventorySummary<T> {
  const byLocker = new Map<string, LockerTotals<T>>();
  for (const locker of lockers) byLocker.set(locker.id, emptyTotals<T>());
  const unassigned = emptyTotals<T>();
  const weightSealed = Boolean(options.weightSealed);

  for (const item of items) {
    const ref = item.fields?.[LOCKER_REF_KEY];
    const bucket = typeof ref === 'string' && byLocker.get(ref);
    add(bucket || unassigned, item);
  }

  let totalGrossGrams = 0;
  let totalNetGrams = 0;
  for (const t of [...byLocker.values(), unassigned]) {
    t.grossGrams = roundGrams(t.grossGrams);
    t.netGrams = roundGrams(t.netGrams);
    totalGrossGrams += t.grossGrams;
    totalNetGrams += t.netGrams;
  }

  return {
    byLocker,
    unassigned,
    weightSealed,
    totalGrossGrams: roundGrams(totalGrossGrams),
    totalNetGrams: roundGrams(totalNetGrams),
  };
}
