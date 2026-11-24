/** The Sub-categories page: every type kept for one client, with counts; a tile opens that type. */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useParams: () => ({ clientId: 'cl-1' }),
  useRouter: () => ({ push, replace: vi.fn() }),
}));
const api = vi.fn(async (url: string) => {
  if (url.endsWith('/counts')) return { json: { success: true, counts: { 'identity-pan_card': 1, 'identity-passport': 0, uncategorized: 2 } } };
  if (url.includes('/subcategories')) {
    return { json: { success: true, groups: [{ moduleKey: 'identity', moduleName: 'Identity', items: [
      { documentKey: 'identity-pan_card', documentName: 'PAN Card', enabled: true },
      { documentKey: 'identity-passport', documentName: 'Passport', enabled: false },
    ] }] } };
  }
  return { json: { success: true, client: { id: 'cl-1', clientType: 'individual', displayName: 'Ram Das', details: {} } } };
});
vi.mock('@/lib/net/useWorkspaceApi', () => ({ useWorkspaceApi: () => ({ api, companyId: 'co-1' }) }));

import ClientSubCategories from '@/app/components/clients/ClientSubCategories';

describe('ClientSubCategories', () => {
  it('shows ticked types and Others with counts, and hides an unticked empty one', async () => {
    render(<ClientSubCategories />);
    expect(await screen.findByText('PAN Card')).toBeTruthy();
    expect(screen.getByText('Others')).toBeTruthy();
    expect(screen.queryByText('Passport')).toBeNull();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('a tile opens that type for this client', async () => {
    render(<ClientSubCategories />);
    fireEvent.click(await screen.findByRole('button', { name: /PAN Card/ }));
    expect(push).toHaveBeenCalledWith('/business/co-1/clients/cl-1/identity-pan_card');
  });

  it('the back link returns to the client', async () => {
    render(<ClientSubCategories />);
    fireEvent.click(await screen.findByRole('button', { name: /Ram Das/ }));
    expect(push).toHaveBeenCalledWith('/business/co-1/clients/cl-1');
  });
});
