/**
 * The Sub-category filter names the whole taxonomy — 83 options, with labels
 * like 'Aadhaar Card (all members)'. On a phone the filter row is a two-column
 * grid, so each dropdown's container is ~150px of a 375px screen; the panel used
 * to inherit that width and truncate every label, which left a list of clipped
 * fragments you could not choose between. These are that bug: the panel is wider
 * than its cell, it opens the right way round, and the labels wrap.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const searchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/documents',
  useSearchParams: () => searchParams,
}));

// eslint-disable-next-line import/first
import { DataTable } from './data-table';

/** The two multi-select filters the Documents Manager renders, in its order. */
const FILTERS = [
  {
    key: 'moduleKey',
    label: 'Category',
    allLabel: 'All categories',
    multiple: true,
    options: [{ value: 'identity', label: 'Identity & Personal' }],
  },
  {
    key: 'categoryId',
    label: 'Sub-category',
    allLabel: 'All sub-categories',
    multiple: true,
    options: [
      { value: 'c1', label: 'Aadhaar Card (all members)', group: 'Identity & Personal' },
    ],
  },
];

/** The panel is only in the DOM while open, so every check opens one first. */
const toggle = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}$`) }));

const openPanel = (name: string) => {
  toggle(name);
  return screen.getByRole('listbox');
};

describe('DataTable multi-select filters', () => {
  beforeEach(() => {
    render(
      <DataTable data={[]} columns={[{ header: 'Name', key: 'name' }]} filterDefinitions={FILTERS} />
    );
  });

  it('opens a panel wider than its half-width mobile grid cell', () => {
    const panel = openPanel('Category');
    expect(panel.className).toContain('w-[min(20rem,calc(100vw-2rem))]');
    expect(panel.className).not.toContain('w-full');
  });

  it('renders an option label in full rather than truncating it', () => {
    const panel = openPanel('Sub-category');
    const label = screen.getByText('Aadhaar Card (all members)');
    expect(panel).toContainElement(label);
    expect(label.className).not.toContain('truncate');
    expect(label.className).toContain('break-words');
  });

  it('opens the second (right-hand) filter leftwards so it stays on screen', () => {
    // index 0 is the left column of the mobile `grid-cols-2` and anchors left;
    // index 1 is the right column, which has to grow the other way.
    expect(openPanel('Category').className).toContain('left-0');
    toggle('Category');
    expect(openPanel('Sub-category').className).toContain('right-0');
  });
});
