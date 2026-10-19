import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Every `payments` insert names its payment_method.
 *
 * The column defaults to 'RAZORPAY', and /api/payments/create-order's ₹0 and
 * manual branches relied on that default — so a plan bought with a 100% coupon
 * (never sent to Razorpay) showed on the Payments page as a Razorpay payment.
 * 0079 corrected those rows; this keeps a new insert from repeating it.
 */
const SRC = path.resolve(__dirname, '../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

/** The text of each `.insert(payments).values({ … })` object literal. */
function paymentInserts(text: string): string[] {
  const found: string[] = [];
  const re = /\.insert\(payments\)\s*\.values\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
    }
    found.push(text.slice(m.index, i));
  }
  return found;
}

describe('payments inserts', () => {
  const sites = walk(SRC).flatMap((file) =>
    paymentInserts(fs.readFileSync(file, 'utf8')).map((body) => ({ file: path.relative(SRC, file), body })));

  it('finds the inserts at all', () => {
    expect(sites.length).toBeGreaterThanOrEqual(4);
  });

  it('never leaves payment_method to the RAZORPAY default', () => {
    const missing = sites.filter((s) => !/\bpaymentMethod\b/.test(s.body)).map((s) => s.file);
    expect(missing, 'these insert a payment without saying how it was paid').toEqual([]);
  });

  it('settles ₹0 checkouts as COUPON, FREE or MANUAL — never RAZORPAY', () => {
    const route = fs.readFileSync(path.join(SRC, 'app/api/payments/create-order/route.ts'), 'utf8');
    expect(route).toMatch(/isManualPayment\s*\?\s*'MANUAL'\s*:\s*appliedDiscountId && amountSaved > 0 \? 'COUPON' : 'FREE'/);
  });
});
