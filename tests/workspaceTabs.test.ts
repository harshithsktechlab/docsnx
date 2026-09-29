/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE TAB STRIP MUST NOT APPEAR WHERE THERE IS NOTHING TO CHOOSE         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `workspaceTabsFor` decides which tabs Billing, AI Credits and Audit Logs draw.
 * Most tenants are personal-only and must see exactly the pages they saw before
 * this feature existed — a strip offering "Summary" and "Personal" over one
 * identical list is furniture that teaches people the control does nothing.
 *
 * Tested through the `.jsx` component's named export rather than a `.ts` sibling
 * because the function is pure and the component around it is not imported here
 * — vitest can load the module, it just must not render it.
 */
import { describe, it, expect } from 'vitest';
import { workspaceTabsFor, PERSONAL_PARAM } from '@/app/components/WorkspaceTabs';

const ADMIN = { role: 'TENANT_ADMIN' };
const ACME = { id: '3f4e0b2a-0000-4000-8000-0000000000ac', name: 'Acme' };
const BETA = { id: '3f4e0b2a-0000-4000-8000-0000000000be', name: 'Beta' };

describe('workspaceTabsFor', () => {
  it('draws nothing for a personal-only tenant', () => {
    expect(workspaceTabsFor({
      accountType: 'personal', companies: [], viewer: ADMIN, includeSummary: true,
    })).toEqual([]);
  });

  // The companies list arrives empty from /api/auth/me for a personal account,
  // but a stale or hand-made payload must not resurrect the strip either.
  it('draws nothing when the account has no companies', () => {
    expect(workspaceTabsFor({
      accountType: 'both', companies: [], viewer: ADMIN, includeSummary: true,
    })).toEqual([]);
  });

  it('draws Summary, Personal and each company for a both-account admin', () => {
    const tabs = workspaceTabsFor({
      accountType: 'both', companies: [ACME, BETA], viewer: ADMIN, includeSummary: true,
    });
    expect(tabs.map((t) => t.key)).toEqual([null, PERSONAL_PARAM, ACME.id, BETA.id]);
    expect(tabs.map((t) => t.name)).toEqual(['Summary', 'Personal', 'Acme', 'Beta']);
  });

  it('omits Summary where the page does not want one', () => {
    const tabs = workspaceTabsFor({
      accountType: 'both', companies: [ACME], viewer: ADMIN, includeSummary: false,
    });
    expect(tabs.map((t) => t.key)).toEqual([PERSONAL_PARAM, ACME.id]);
  });

  /**
   * A business-only tenant has no household. Offering it a Personal tab would be
   * a filter matching nothing — an empty table that reads as lost data.
   */
  it('offers no Personal tab to a business-only tenant', () => {
    const tabs = workspaceTabsFor({
      accountType: 'business', companies: [ACME, BETA], viewer: ADMIN, includeSummary: true,
    });
    expect(tabs.map((t) => t.key)).toEqual([null, ACME.id, BETA.id]);
  });

  /**
   * The strip can never offer a company the workspace switcher does not: both
   * are built from `workspaceMenu`, which filters to what the viewer may reach.
   */
  it('offers a member only their own workspace', () => {
    const tabs = workspaceTabsFor({
      accountType: 'both',
      companies: [ACME],
      viewer: { role: 'STANDARD', accountScope: 'business' },
      includeSummary: true,
    });
    expect(tabs.some((t) => t.key === PERSONAL_PARAM)).toBe(false);
  });
});
