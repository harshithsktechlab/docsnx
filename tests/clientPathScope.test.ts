import { describe, it, expect, afterEach } from 'vitest';
import { clientIdFromPath, withCompany } from '@/lib/net/useWorkspaceApi';

const CID = '123e4567-e89b-42d3-a456-426614174000';
const COMPANY = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

describe('clientIdFromPath', () => {
  it('reads the client off a client page and its sub-pages', () => {
    expect(clientIdFromPath(`/business/${COMPANY}/clients/${CID}`)).toBe(CID);
    expect(clientIdFromPath(`/business/${COMPANY}/clients/${CID}/identity-pan_card`)).toBe(CID);
    expect(clientIdFromPath(`/business/${COMPANY}/clients/${CID.toUpperCase()}/x`)).toBe(CID);
  });

  it('is null everywhere that is not one client\'s own page', () => {
    for (const p of [
      '', '/', '/documents', `/business/${COMPANY}/dashboard`, `/business/${COMPANY}/clients`,
      `/business/${COMPANY}/clients/configure`, `/business/${COMPANY}/clients/not-a-uuid`,
      `/business/${COMPANY}/modules/biz_tax/${CID}`,
    ]) expect(clientIdFromPath(p), p).toBeNull();
  });
});

describe('withCompany', () => {
  afterEach(() => { window.history.pushState({}, '', '/'); });

  it('adds only the company outside a client page', () => {
    window.history.pushState({}, '', `/business/${COMPANY}/documents`);
    expect(withCompany('/api/x', COMPANY)).toBe(`/api/x?companyId=${COMPANY}`);
  });

  it('adds the client too on a client page, once, and never without a company', () => {
    window.history.pushState({}, '', `/business/${COMPANY}/clients/${CID}/identity-pan_card`);
    expect(withCompany('/api/x?a=1', COMPANY)).toBe(`/api/x?a=1&companyId=${COMPANY}&clientId=${CID}`);
    expect(withCompany(`/api/x?clientId=${CID}`, COMPANY)).toBe(`/api/x?clientId=${CID}&companyId=${COMPANY}`);
    expect(withCompany('/api/x', null)).toBe('/api/x');
  });
});
