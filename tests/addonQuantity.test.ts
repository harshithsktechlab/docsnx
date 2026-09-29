/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   HOW MANY OF AN ADD-ON — the number that is both money and access       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A quantity arrives in a request body, is multiplied into a PRICE, and is then
 * multiplied into an ENTITLEMENT. It is read by four separate server paths
 * (create-order, validate-discount, verify, the Razorpay webhook), which is
 * exactly the shape of thing that ends up parsed three different ways.
 *
 * So the rule lives in one module and is pinned here. The cases that matter are
 * not the happy ones: a negative quantity is a line that pays the customer, and
 * a huge one is either an absurd charge or — on an add-on nobody has priced yet
 * — an unbounded free entitlement.
 */
import { describe, it, expect } from 'vitest';
import { parseAddonQuantity, storedQuantity, MAX_ADDON_QUANTITY } from '@/lib/addonQuantity';

describe('parseAddonQuantity', () => {
  it('accepts a plain count', () => {
    expect(parseAddonQuantity(1)).toBe(1);
    expect(parseAddonQuantity(3)).toBe(3);
    expect(parseAddonQuantity(MAX_ADDON_QUANTITY)).toBe(MAX_ADDON_QUANTITY);
  });

  it('accepts the digits a form sends as a string', () => {
    // A <select> hands back strings, and an older client may not coerce.
    expect(parseAddonQuantity('3')).toBe(3);
    expect(parseAddonQuantity(' 3 ')).toBe(3);
  });

  it('treats an absent quantity as one', () => {
    // Every caller that predates this sends `{ id, duration }` and means one.
    // Refusing them would break an installed PWA holding an older bundle.
    expect(parseAddonQuantity(undefined)).toBe(1);
    expect(parseAddonQuantity(null)).toBe(1);
  });

  it('refuses a quantity that would pay the customer', () => {
    expect(parseAddonQuantity(-1)).toBeNull();
    expect(parseAddonQuantity(-20)).toBeNull();
  });

  it('refuses zero — a line that should not exist', () => {
    // The dropdown's "None" deletes the line client-side; a zero reaching the
    // server is a bug, and billing someone for nothing is not the recovery.
    expect(parseAddonQuantity(0)).toBeNull();
    expect(parseAddonQuantity('0')).toBeNull();
  });

  it('refuses more than the dropdown offers', () => {
    expect(parseAddonQuantity(MAX_ADDON_QUANTITY + 1)).toBeNull();
    expect(parseAddonQuantity(1e9)).toBeNull();
    expect(parseAddonQuantity(Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it('refuses a fraction rather than rounding it', () => {
    // Flooring 2.9 would charge for two while the client showed three.
    expect(parseAddonQuantity(2.9)).toBeNull();
    expect(parseAddonQuantity(0.5)).toBeNull();
  });

  it('refuses anything that is not a number', () => {
    expect(parseAddonQuantity('abc')).toBeNull();
    expect(parseAddonQuantity('')).toBeNull();
    expect(parseAddonQuantity('   ')).toBeNull();
    expect(parseAddonQuantity({})).toBeNull();
    expect(parseAddonQuantity([])).toBeNull();
    expect(parseAddonQuantity(NaN)).toBeNull();
    expect(parseAddonQuantity(Infinity)).toBeNull();
    expect(parseAddonQuantity(true)).toBeNull();
  });
});

describe('storedQuantity', () => {
  it('reads a row written before 0061 as one unit', () => {
    // Those rows carry no quantity and each mean a single unit. Reading them as
    // zero would silently revoke an entitlement somebody paid for.
    expect(storedQuantity(null)).toBe(1);
    expect(storedQuantity(undefined)).toBe(1);
  });

  it('returns what was stored', () => {
    expect(storedQuantity(1)).toBe(1);
    expect(storedQuantity(5)).toBe(5);
  });

  it('never reads as less than one', () => {
    expect(storedQuantity(0)).toBe(1);
    expect(storedQuantity(-4)).toBe(1);
    expect(storedQuantity(2.5)).toBe(1);
  });
});

/**
 * The arithmetic itself, stated once: a line is the unit price times the
 * quantity, and that product is what a discount applies against. Both
 * create-order and validate-discount compute it, and if they ever disagree the
 * customer is quoted one saving and charged another.
 */
describe('what a line costs', () => {
  const line = (unit: number, raw: unknown) => {
    const quantity = parseAddonQuantity(raw);
    return quantity === null ? null : unit * quantity;
  };

  it('is the unit price times the quantity', () => {
    expect(line(499, 3)).toBe(1497);
    expect(line(499, 1)).toBe(499);
    expect(line(499, undefined)).toBe(499);
  });

  it('applies a percentage to the whole line, not to one unit', () => {
    const total = line(499, 3) as number;
    expect(total * 0.2).toBeCloseTo(299.4, 5);
    // The bug this guards: 20% of ONE seat quoted as the saving on three.
    expect(total * 0.2).not.toBeCloseTo(499 * 0.2, 5);
  });

  it('has no price at all when the quantity is refused', () => {
    expect(line(499, -3)).toBeNull();
    expect(line(499, 1e9)).toBeNull();
  });
});
