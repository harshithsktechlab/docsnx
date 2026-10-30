/**
 * The super-admin tenant list is one compact row per tenant. The row needs
 * fields the list route did not used to send; this pins that the route sends
 * them, and that it does so without a whole-row read of a sensitive table.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.join(__dirname, '..');
const route = fs.readFileSync(path.join(root, 'src/app/api/admin/tenants/route.ts'), 'utf8');
const row = fs.readFileSync(path.join(root, 'src/app/admin/tenants/TenantRow.jsx'), 'utf8');

describe('admin tenants list route payload', () => {
  it.each([
    'businessPlanId',
    'businessPlanExpiry',
    'businessPlanName',
    'latestPayment',
    'couponCode',
    'members',
    'quantity',
  ])('sends %s', (field) => {
    expect(route).toContain(field);
  });

  it('only counts captured payments as the latest payment', () => {
    expect(route).toMatch(/eq\(payments\.status, 'captured'\)/);
  });

  it('qualifies payments.id inside the coupon subqueries', () => {
    // Interpolating the column renders a bare "id" in a one-table select, which
    // Postgres rejects as ambiguous against discount_usages.id.
    expect(route).not.toMatch(/du\.payment_id = \$\{payments\.id\}/);
    expect(route).toMatch(/du\.payment_id = payments\.id/);
  });

  it('never selects contact details or hashes for the roster', () => {
    const roster = route.slice(route.indexOf('        accountScope: users.accountScope'), route.indexOf('db.select({\n        userId: companyAccess.userId'));
    expect(roster).not.toMatch(/passwordHash|email|phoneNumber/);
  });

  it('has no whole-row select()', () => {
    expect(route).not.toMatch(/\.select\(\s*\)/);
  });
});

describe('TenantRow', () => {
  it('keeps the action buttons out of the toggle button', () => {
    const toggle = row.slice(row.indexOf('onClick={onToggle}'), row.indexOf('</button>', row.indexOf('onClick={onToggle}')));
    expect(toggle).not.toMatch(/<Button\b/);
    expect(toggle).toContain('aria-expanded');
  });
});
