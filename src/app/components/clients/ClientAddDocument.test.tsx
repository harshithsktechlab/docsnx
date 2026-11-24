/** "Add document": asks which TYPE (ticked ones + Others), then opens that type's add form. */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import ClientAddDocument from '@/app/components/clients/ClientAddDocument';

const groups = [
  { moduleKey: 'identity', moduleName: 'Identity', items: [
    { documentKey: 'identity-pan_card', documentName: 'PAN Card', enabled: true },
    { documentKey: 'identity-passport', documentName: 'Passport', enabled: false },
  ] },
];
const mount = (props: Record<string, unknown> = {}) =>
  render(<ClientAddDocument clientId="cl-1" companyId="co-1" groups={groups} canAdd {...props} />);

beforeEach(() => push.mockClear());

describe('ClientAddDocument', () => {
  it('lists only the ticked types, plus Others', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /add document/i }));
    expect(screen.getByRole('button', { name: 'PAN Card' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Passport' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Others' })).toBeTruthy();
  });

  it('opens that type\'s add form for this client', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /add document/i }));
    fireEvent.click(screen.getByRole('button', { name: 'PAN Card' }));
    expect(push).toHaveBeenCalledWith('/business/co-1/clients/cl-1/identity-pan_card?add=1');
  });

  it('is disabled, with the reason, while nothing is configured', () => {
    mount({ blockedMessage: 'Configure first' });
    const b = screen.getByRole('button', { name: /add document/i }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.title).toBe('Configure first');
  });

  it('is absent for a member who cannot add', () => {
    mount({ canAdd: false });
    expect(screen.queryByRole('button', { name: /add document/i })).toBeNull();
  });
});
