/**
 * The Access step, rendered.
 *
 * These pin the three things that made the dialog ambiguous, each of which is a
 * rendering decision no unit test of permissionLevels.ts can see:
 *   1. the module list is on screen before anything is clicked,
 *   2. every row says in words what it grants,
 *   3. the lit preset card follows the data rather than the last click.
 *
 * React.createElement rather than JSX because vitest.config.ts only collects
 * `tests/**\/*.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import PermissionMatrix from '../src/app/users/PermissionMatrix';
import {
  BUSINESS_PERMISSION_KEYS,
  DEFAULT_PERSONAL_PERMISSIONS,
  PERMISSION_MODULE_KEYS,
} from '../src/lib/moduleRegistry';
import { permissionsForLevel, levelToFlags } from '../src/lib/permissionLevels';

const matrix = (props: Record<string, unknown>) =>
  createElement(PermissionMatrix as never, { onChange: () => {}, ...props });

describe('<PermissionMatrix> — the Access step', () => {
  it('shows the module list without waiting for a "Custom" click', () => {
    render(matrix({ value: DEFAULT_PERSONAL_PERMISSIONS, showPresets: true }));
    expect(screen.getByText('1. Start from a role')).toBeInTheDocument();
    expect(screen.getByText('2. Fine-tune by module')).toBeInTheDocument();
    // A rung's description, printed under a row, not just its name.
    expect(screen.getAllByText('Can read and add new records').length).toBeGreaterThan(0);
    cleanup();
  });

  it('lights the card the permissions actually match, and drops it when one module differs', () => {
    const { rerender } = render(
      matrix({ value: permissionsForLevel(PERMISSION_MODULE_KEYS, 'view'), showPresets: true }),
    );
    expect(screen.getByRole('button', { name: /Viewer/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Custom')).not.toBeInTheDocument();

    const drifted = permissionsForLevel(PERMISSION_MODULE_KEYS, 'view').map((row, i) =>
      i === 0 ? { ...row, ...levelToFlags('full') } : row,
    );
    rerender(matrix({ value: drifted, showPresets: true }));
    expect(screen.getByRole('button', { name: /Viewer/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Custom')).toBeInTheDocument();
    cleanup();
  });

  it('totals the grant in the summary bar and offers the override filter', () => {
    render(
      matrix({
        value: [
          ...permissionsForLevel(PERMISSION_MODULE_KEYS, 'full'),
          { module: PERMISSION_MODULE_KEYS[0], documentKey: 'pan', ...levelToFlags('none') },
        ],
        showPresets: true,
      }),
    );
    expect(screen.getByText('This user gets')).toBeInTheDocument();
    expect(
      // Client Documents is one row for the admin, though it is stored as two.
      screen.getByText(`${PERMISSION_MODULE_KEYS.length - 1} Full access`),
    ).toBeInTheDocument();
    expect(screen.getByText('1 category override')).toBeInTheDocument();
    expect(screen.getByText(/Also clears 1 category override/)).toBeInTheDocument();
    cleanup();
  });

  it('applies a preset as module defaults only, dropping every override', () => {
    const onChange = vi.fn();
    render(
      matrix({
        value: [
          ...permissionsForLevel(PERMISSION_MODULE_KEYS, 'view'),
          { module: PERMISSION_MODULE_KEYS[0], documentKey: 'pan', ...levelToFlags('full') },
        ],
        showPresets: true,
        onChange,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Full access/ }));
    const next = onChange.mock.calls[0][0];
    expect(next).toHaveLength(PERMISSION_MODULE_KEYS.length);
    expect(next.every((r: { documentKey: string | null }) => r.documentKey === null)).toBe(true);
    cleanup();
  });

  it('lists Client Documents for a business member who holds no client rows yet', () => {
    const held = permissionsForLevel(
      BUSINESS_PERMISSION_KEYS.filter((k) => !k.startsWith('biz_client_')), 'contribute',
    );
    render(matrix({ value: held }));
    // ONE row for both client types, not two.
    expect(screen.getAllByText('Client Documents')).toHaveLength(1);
    expect(screen.queryByText(/Company clients/)).toBeNull();
    cleanup();
  });

  it('keeps Client Documents out of a personal member\'s list', () => {
    render(matrix({ value: DEFAULT_PERSONAL_PERMISSIONS }));
    expect(screen.queryByText('Client Documents')).toBeNull();
    cleanup();
  });

  it('writes both client-type rows with the same flags from the one control', () => {
    const held = permissionsForLevel(
      BUSINESS_PERMISSION_KEYS.filter((k) => !k.startsWith('biz_client_')), 'contribute',
    );
    const onChange = vi.fn();
    render(matrix({ value: held, onChange }));
    let row: HTMLElement | null = screen.getByText('Client Documents');
    while (row && !row.querySelector('[aria-label="Set individual permissions"]')) row = row.parentElement;
    fireEvent.click(row!.querySelector('[aria-label="Set individual permissions"]')!);
    fireEvent.click(within(row!).getByLabelText('Delete'));
    const next = onChange.mock.calls.at(-1)![0] as Array<Record<string, unknown>>;
    const client = next.filter((p) => String(p.module).startsWith('biz_client_'));
    expect(client.map((p) => p.module).sort()).toEqual(['biz_client_company', 'biz_client_individual']);
    for (const p of client) expect(p).toMatchObject({ canView: true, canDelete: true });
    cleanup();
  });
});
