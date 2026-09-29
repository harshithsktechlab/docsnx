/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   What a workspace is called before anybody has been asked               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `tenants.name` is NOT NULL and the row is created at registration, several
 * minutes before the onboarding wizard gets to ask what to call it. This is the
 * value that fills the gap — and the one the wizard prefills its input with, so
 * a wrong answer here is a wrong answer in two places.
 */
import { describe, it, expect } from 'vitest';
import { defaultWorkspaceName, workspaceNameCopy } from '@/lib/workspaceName';

describe('defaultWorkspaceName', () => {
  it('names the workspace after the person who opened it', () => {
    expect(defaultWorkspaceName('Amit Sharma')).toBe('Amit Sharma’s Workspace');
  });

  it('trims what the form sent', () => {
    expect(defaultWorkspaceName('  Asha Menon \n')).toBe('Asha Menon’s Workspace');
  });

  it('falls back to the string the dashboard already uses for a nameless tenant', () => {
    // Unreachable from the form — the name is required there — but this is a
    // public route, and a NOT NULL column will not take an empty string quietly.
    expect(defaultWorkspaceName('')).toBe('My Workspace');
    expect(defaultWorkspaceName('   ')).toBe('My Workspace');
    expect(defaultWorkspaceName(null)).toBe('My Workspace');
    expect(defaultWorkspaceName(undefined)).toBe('My Workspace');
  });

  it('never exceeds the column, whatever it is handed', () => {
    // varchar(255): one character over and the INSERT fails, taking a whole
    // registration with it.
    const long = 'Nnamdi '.repeat(60).trim(); // well past 255
    const derived = defaultWorkspaceName(long);
    expect(derived.length).toBeLessThanOrEqual(255);
    expect(derived.length).toBeGreaterThan(0);
  });

  it('keeps a name that only just fits once the suffix is added', () => {
    const name = 'A'.repeat(240);
    expect(defaultWorkspaceName(name)).toBe(`${name}’s Workspace`);
    expect(defaultWorkspaceName(name).length).toBeLessThanOrEqual(255);
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE WELCOME STEP ASKED EVERY ACCOUNT TYPE THE PERSONAL QUESTION        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * One box, three account types, and one household-shaped question over it —
 * asked a full step before the wizard mentions that companies exist and carry
 * their own names. A business admin who answered "Acme Trading" there had named
 * their ACCOUNT, and then met that name in the sidebar above every company page.
 *
 * The other half of this is a promise the old helper line made and the product
 * could not keep: no tenant-facing rename exists, only the SUPER_ADMIN route
 * PUT /api/admin/tenants/[id]. "Ask an administrator" was addressed to the
 * administrator.
 */
describe('workspaceNameCopy — one box, three questions', () => {
  it('asks a personal account about its workspace, with a household example', () => {
    const copy = workspaceNameCopy('personal');
    expect(copy.label).toMatch(/workspace/i);
    expect(copy.label).not.toMatch(/account/i);
    expect(copy.placeholder).toMatch(/household/i);
    expect(copy.noun).toBe('workspace');
  });

  it('never tells a personal account to go and name its companies', () => {
    // It has none, and the Companies step is not in PERSONAL_STEPS.
    expect(workspaceNameCopy('personal').helper).not.toMatch(/compan/i);
  });

  it('asks a business account about its ACCOUNT, not its workspace', () => {
    const copy = workspaceNameCopy('business');
    expect(copy.label).toMatch(/account/i);
    expect(copy.label).not.toMatch(/workspace/i);
    expect(copy.placeholder).not.toMatch(/household/i);
    expect(copy.noun).toBe('account');
  });

  it('tells a business account that companies are named next and named separately', () => {
    // The whole point: the name in this box is the umbrella, and the name a
    // person sees inside a company workspace is the company's own.
    const helper = workspaceNameCopy('business').helper;
    expect(helper).toMatch(/next step/i);
    expect(helper).toMatch(/compan/i);
  });

  it('tells a combo account the umbrella name covers its personal side too', () => {
    const helper = workspaceNameCopy('both').helper;
    expect(helper).toMatch(/personal side/i);
    expect(helper).toMatch(/compan/i);
    expect(workspaceNameCopy('both').noun).toBe('account');
  });

  it('treats an unrecognised account type as a combo one', () => {
    // The safe superset: it names both halves, so a type this build does not
    // know cannot be told about a half it turns out not to have.
    const both = workspaceNameCopy('both');
    expect(workspaceNameCopy(undefined)).toEqual(both);
    expect(workspaceNameCopy(null)).toEqual(both);
    expect(workspaceNameCopy('')).toEqual(both);
    expect(workspaceNameCopy('enterprise')).toEqual(both);
  });

  it('never promises a rename the product cannot do', () => {
    // Only PUT /api/admin/tenants/[id] renames a tenant, and it is
    // SUPER_ADMIN-only — the reader of this line is the TENANT admin.
    for (const type of ['personal', 'business', 'both', null]) {
      const helper = workspaceNameCopy(type).helper;
      expect(helper).not.toMatch(/ask an administrator/i);
      expect(helper).toMatch(/support/i);
    }
  });

  it('says where the name will actually show up, in every variant', () => {
    // It is on screen on every page (the rail and the mobile top bar) and on
    // every invoice, so "you'll see it somewhere" is not enough to answer with.
    for (const type of ['personal', 'business', 'both']) {
      const helper = workspaceNameCopy(type).helper;
      expect(helper).toMatch(/sidebar/i);
      expect(helper).toMatch(/invoice/i);
    }
  });
});
