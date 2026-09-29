/** Walks a `both` account to the Members step and picks a destination —
 *  the exact state `chosenDestination` is computed for. Stubbed, no DB writes. */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:3010';
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

const companies = [{ id: 'c1', name: 'Acme Trading' }, { id: 'c2', name: 'Beta Foods' }];
await page.route('**/api/auth/me', (r) => r.fulfill({ json: {
  success: true,
  user: { id: 'u1', role: 'TENANT_ADMIN', name: 'A', email: 'a@b.c',
    tenant: { id: 't1', name: 'Sharma Household', accountType: 'both', hasCompletedOnboarding: false } },
  companies,
  planStatus: { accountType: 'both', axes: { personal: { hasPlan: true, expired: false }, business: { hasPlan: true, expired: false } } },
} }));
await page.route('**/api/companies', (r) => r.fulfill({ json: { success: true, companies, quota: { used: 2, limit: 3 } } }));
await page.route('**/api/tenants/integrations/google', (r) => r.fulfill({ json: { success: true, integration: { connected: true, enabled: true, scopeOk: true } } }));

await page.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
console.log('landed on   :', (await page.locator('body').innerText()).includes('Your Companies') ? 'Companies' : '???');

await page.getByRole('button', { name: /Continue/ }).click();
await page.waitForTimeout(600);

const radios = await page.getByRole('radio').allInnerTexts();
console.log('destinations:', radios.map((t) => t.split('\n')[0]).join(' | '));
console.log('blurb       :', (await page.locator('body').innerText()).split('\n').find((l) => l.includes('Adding to')) || '(none)');

// Pick the second one — this is what writes `destinationId`, the variable that crashed.
await page.getByRole('radio').nth(1).click();
await page.waitForTimeout(400);
console.log('after pick  :', (await page.locator('body').innerText()).split('\n').find((l) => l.includes('Adding to')) || '(none)');
console.log('button says :', (await page.getByRole('button', { name: /Add Member/ }).innerText()).trim());
console.log(errors.length ? `PAGEERRORS: ${errors.join(' | ')}` : 'no page errors');

await browser.close();
process.exit(errors.length ? 1 : 0);
