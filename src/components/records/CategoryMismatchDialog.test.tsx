/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE CATEGORY-MISMATCH PROMPT ASKS ONE QUESTION AND CANNOT BE DISMISSED ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 *   · it names BOTH categories, from the server's own names;
 *   · Yes / No call the right handler;
 *   · "Yes" is not offered for a category the member may not add to;
 *   · Esc does not close it — the form would be left on a category the AI has
 *     just said is wrong.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import CategoryMismatchDialog from './CategoryMismatchDialog';

const mismatch = (over: Record<string, unknown> = {}) => ({
  selected: { id: 's', moduleKey: 'insurance', documentKey: 'health_insurance', moduleName: 'Insurance', documentName: 'Health insurance' },
  detected: { id: 'd', moduleKey: 'identity', documentKey: 'pan_card', moduleName: 'Identity', documentName: 'PAN Card' },
  otherCategory: { id: 'o', moduleKey: 'insurance', documentKey: 'other', moduleName: 'Insurance', documentName: 'Other' },
  detectedPermitted: true,
  ...over,
});

const setup = (over: Record<string, unknown> = {}) => {
  const onYes = vi.fn();
  const onNo = vi.fn();
  render(<CategoryMismatchDialog open mismatch={mismatch(over) as any} onYes={onYes} onNo={onNo} />);
  return { onYes, onNo };
};

describe('CategoryMismatchDialog', () => {
  it('names the category the user picked and the one the AI found', () => {
    setup();

    expect(screen.getByText('Insurance › Health insurance')).toBeTruthy();
    expect(screen.getAllByText(/Identity › PAN Card/).length).toBeGreaterThan(0);
  });

  it('Yes switches, No files under the picked module\'s Other', () => {
    const { onYes, onNo } = setup();

    fireEvent.click(screen.getByRole('button', { name: /Yes, use PAN Card/ }));
    expect(onYes).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /No, file under Insurance › Other/ }));
    expect(onNo).toHaveBeenCalledTimes(1);
  });

  it('does not offer Yes for a category the member may not add to', () => {
    const { onNo } = setup({ detectedPermitted: false });

    expect(screen.queryByRole('button', { name: /^Yes/ })).toBeNull();
    expect(screen.getByText(/do not have permission/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /OK, file under Other/ }));
    expect(onNo).toHaveBeenCalledTimes(1);
  });

  it('cannot be dismissed with Escape', () => {
    const { onYes, onNo } = setup();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    expect(screen.getByText(/wrong category/i)).toBeTruthy();
    expect(onYes).not.toHaveBeenCalled();
    expect(onNo).not.toHaveBeenCalled();
  });

  it('renders nothing without a mismatch', () => {
    const { container } = render(<CategoryMismatchDialog open mismatch={null} onYes={vi.fn()} onNo={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});
