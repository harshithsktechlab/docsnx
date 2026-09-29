/**
 * Drives the onboarding wizard in a real browser with every API stubbed, so
 * nothing is written to any database. It exists to prove the client render path
 * — where the TDZ crash lived — actually paints.
 *
 * Usage: node scripts/verify_onboarding_render.mjs [baseURL]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:3010';

const me = (over = {}) => ({
  success: true,
  user: {
    id: 'u1', role: 'TENANT_ADMIN', name: 'Test Admin', email: 'a@b.c',
    tenant: { id: 't1', name: 'Sharma Household', accountType: 'personal', hasCompletedOnboarding: false },
    ...over,
  },
  companies: [],
  planStatus: {
    accountType: 'personal',
    axes: { personal: { hasPlan: true, expired: false, daysLeft: 300 } },
  },
});

const drive = (connected) => ({
  success: true,
  integration: { connected, enabled: connected, scopeOk: connected },
});

async function run(label, { accountType = 'personal', query = '', companies = [], quota = null, driveOk = false }) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.route('**/api/auth/me', (r) => r.fulfill({
    json: me({ tenant: { id: 't1', name: 'Sharma Household', accountType, hasCompletedOnboarding: false } }),
  }));
  await page.route('**/api/companies', (r) => r.fulfill({ json: { success: true, companies, quota } }));
  await page.route('**/api/tenants/integrations/google', (r) => r.fulfill({ json: drive(driveOk) }));
  await page.route('**/api/notifications/**', (r) => r.fulfill({ json: { success: true } }));

  await page.goto(`${BASE}/onboarding${query}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const body = await page.locator('body').innerText();
  const crashed = /Setup could not be loaded|Something went wrong|before initialization/.test(body);
  const heading = (await page.locator('h1, h2, [class*="CardTitle"], .text-3xl, .text-2xl').first().innerText().catch(() => '')).trim();

  console.log(`\n── ${label} ──`);
  console.log(`   crashed : ${crashed ? 'YES' : 'no'}`);
  console.log(`   heading : ${heading || '(none)'}`);
  if (errors.length) console.log(`   pageerror: ${errors.join(' | ')}`);
  const excerpt = body.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 14);
  console.log(`   screen  : ${excerpt.join(' / ')}`);

  await browser.close();
  return { crashed, errors, body };
}

const results = [];
results.push(['personal, fresh', await run('personal, fresh arrival', {})]);
results.push(['drive consent skipped', await run('returned from Google WITHOUT the Drive box ticked', { query: '?google=missing_drive_scope' })]);
results.push(['drive cancelled', await run('cancelled Google consent screen', { query: '?google=cancelled' })]);
results.push(['business, drive ok', await run('business account, Drive connected, no companies', { accountType: 'business', driveOk: true, quota: { used: 0, limit: 1 } })]);
results.push(['both, no allowance', await run('both account with NO business allowance', { accountType: 'both', driveOk: true, quota: { used: 0, limit: 0 } })]);

const bad = results.filter(([, r]) => r.crashed || r.errors.length);
console.log(`\n${bad.length === 0 ? 'ALL CLEAR' : 'FAILURES: ' + bad.map(([n]) => n).join(', ')}`);
process.exit(bad.length === 0 ? 0 : 1);
