/**
 * The super admin's plan list puts every live plan ahead of every retired one.
 *
 * The screen is read top-down and an inactive plan is history — a draft price
 * list, a plan typed twice, last year's trial — so it must not sit between two
 * plans that are still being sold. The list arrives from the API ordered by
 * price, and that ordering has to survive inside each half.
 */
import { describe, it, expect } from 'vitest';
import { orderPlansForAdmin, matchesPlanQuery } from '@/lib/planListOrder';

const plans = [
  { name: 'Trial Plan', isActive: false },
  { name: 'Personal', isActive: true },
  { name: 'pro plan', isActive: false },
  { name: 'Business', isActive: true },
  { name: 'Personal + Business', isActive: true },
];

describe('orderPlansForAdmin', () => {
  it('puts active plans first and inactive ones after', () => {
    const names = orderPlansForAdmin(plans).map(p => p.name);
    expect(names).toEqual([
      'Personal', 'Business', 'Personal + Business',
      'Trial Plan', 'pro plan',
    ]);
  });

  it('keeps the incoming (price) order inside each half', () => {
    // A stable sort is the whole reason the API can keep ordering by price.
    const byPrice = [
      { name: 'cheap-off', isActive: false },
      { name: 'cheap-on', isActive: true },
      { name: 'dear-off', isActive: false },
      { name: 'dear-on', isActive: true },
    ];
    expect(orderPlansForAdmin(byPrice).map(p => p.name))
      .toEqual(['cheap-on', 'dear-on', 'cheap-off', 'dear-off']);
  });

  it('does not mutate the array it was given', () => {
    const input = [...plans];
    orderPlansForAdmin(input);
    expect(input.map(p => p.name)).toEqual(plans.map(p => p.name));
  });

  it('applies the search box before ordering', () => {
    expect(orderPlansForAdmin(plans, 'pro').map(p => p.name)).toEqual(['pro plan']);
    expect(orderPlansForAdmin(plans, 'plan').map(p => p.name))
      .toEqual(['Trial Plan', 'pro plan']);
  });

  it('treats a missing isActive as inactive rather than dropping the row', () => {
    const odd = [{ name: 'unknown' }, { name: 'live', isActive: true }];
    expect(orderPlansForAdmin(odd).map(p => p.name)).toEqual(['live', 'unknown']);
  });

  it('survives an empty list', () => {
    expect(orderPlansForAdmin([])).toEqual([]);
  });
});

describe('matchesPlanQuery', () => {
  it('matches case-insensitively on any part of the name', () => {
    expect(matchesPlanQuery({ name: 'Personal + Business' }, 'BUSI')).toBe(true);
  });

  it('matches everything on a blank or whitespace query', () => {
    expect(matchesPlanQuery({ name: 'Personal' }, '   ')).toBe(true);
  });

  it('does not throw on a nameless plan', () => {
    expect(matchesPlanQuery({ name: null }, 'x')).toBe(false);
  });
});
