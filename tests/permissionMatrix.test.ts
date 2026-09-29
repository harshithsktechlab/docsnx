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
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import PermissionMatrix from '../src/app/users/PermissionMatrix';
import {
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
    expect(screen.getByText('This member gets')).toBeInTheDocument();
    expect(
      screen.getByText(`${PERMISSION_MODULE_KEYS.length} Full access`),
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
});
