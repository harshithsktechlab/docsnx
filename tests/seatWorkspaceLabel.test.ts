/**
 * What an invitation calls the workspace it invites to: the company for a
 * business seat, the personal workspace for a personal one — never just the
 * account's umbrella name.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

import { seatWorkspaceLabel } from '@/lib/account/seatWorkspaceLabel';

const tenant = { name: 'HSK Group', personalWorkspaceName: 'Kishan Sanghani’s Workspace' };

describe('seatWorkspaceLabel', () => {
  it('names the company for a business seat', () => {
    expect(seatWorkspaceLabel(tenant, 'business', ['HSK TechLab'])).toBe('HSK TechLab');
  });

  it('lists several companies, de-duplicated and ordered', () => {
    expect(seatWorkspaceLabel(tenant, 'business', ['Zed', 'Acme', 'Acme'])).toBe('Acme, Zed');
  });

  it('falls back to the account name for a business seat with no grant', () => {
    expect(seatWorkspaceLabel(tenant, 'business', [])).toBe('HSK Group');
  });

  it('uses the personal workspace name for a personal seat, ignoring companies', () => {
    expect(seatWorkspaceLabel(tenant, 'personal', ['HSK TechLab'])).toBe('Kishan Sanghani’s Workspace');
  });

  it('personal seat on a tenant with no separate personal name uses the tenant name', () => {
    expect(seatWorkspaceLabel({ name: 'Sharma Household' }, 'personal')).toBe('Sharma Household');
  });
});
