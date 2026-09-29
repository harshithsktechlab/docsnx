/**
 * Drives the business Document Manager's "Belongs to" in a real browser with
 * every API stubbed — nothing is written to any database. Proves the inline
 * company rename: pencil for admins only, save updates the field AND the
 * sidebar, and a 409 shows inline.
 *
 * Usage: node scripts/verify_company_rename.mjs [baseURL]   (a dev server, not :3005)
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:3010';
const CID = 'c0ffee00-0000-4000-8000-000000000001';

async function run(label, { role = 'TENANT_ADMIN', putStatus = 200 }) {
  let name = 'Acme';
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  let putBody = null;
  const memberUrls = [];

  // Fallback first: Playwright tries the most recently registered route first.
  await page.route('**/api/**', (r) => r.fulfill({ json: { success: true, data: [], documents: [], items: [] } }));
  await page.route('**/api/auth/me', (r) => r.fulfill({
    json: {
      success: true,
      user: {
        id: 'u1', role, name: 'Test Admin', email: 'a@b.c', tenantId: 't1',
        permissions: [], tenant: { id: 't1', name: 'Acme Tenant', accountType: 'business', hasCompletedOnboarding: true },
      },
      companies: [{ id: CID, name }],
      planStatus: { accountType: 'business', axes: { business: { hasPlan: true, expired: false, daysLeft: 300 } } },
    },
  }));
  await page.route('**/api/document-categories**', (r) => r.fulfill({
    json: { success: true, categories: [{ moduleKey: 'biz_legal', documentKey: 'pan_card', moduleName: 'Legal', name: 'PAN Card' }] },
  }));
  await page.route('**/api/companies', (r) => r.fulfill({ json: { success: true, companies: [{ id: CID, name }], quota: null } }));
  await page.route('**/api/members**', (r) => {
    memberUrls.push(r.request().url());
    // The company's own member only when the request names the company.
    const scoped = r.request().url().includes(`companyId=${CID}`);
    return r.fulfill({
      json: {
        success: true,
        members: scoped ? [{ id: 'm-dir', name: 'Ravi Director' }] : [{ id: 'm-home', name: 'Household Aunt' }],
        canAddMembers: role === 'TENANT_ADMIN',
      },
    });
  });
  await page.route(`**/api/companies/${CID}`, async (r) => {
    putBody = r.request().postDataJSON();
    if (putStatus !== 200) return r.fulfill({ status: putStatus, json: { error: 'That company already exists.' } });
    name = putBody.name;
    return r.fulfill({ json: { success: true, company: { id: CID, name } } });
  });

  await page.goto(`${BASE}/business/${CID}/documents`, { waitUntil: 'networkidle' });
  await page.getByText('Upload Document').first().click().catch(() => {});
  await page.waitForTimeout(1500);

  const pencil = page.getByRole('button', { name: 'Rename company' });
  const hasPencil = await pencil.count() > 0;
  const out = { hasPencil, errors };

  // The dropdown: the company first, then THIS company's members only.
  const trigger = page.locator('#holderId');
  out.triggerBefore = (await trigger.innerText()).trim();
  await trigger.click();
  out.options = (await page.getByRole('option').allInnerTexts()).map((t) => t.trim());
  await page.keyboard.press('Escape');
  // Radix hides the rest of the page from the a11y tree while the list is open.
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  out.membersScoped = memberUrls.length > 0 && memberUrls.every((u) => u.includes(`companyId=${CID}`));

  const plus = page.getByRole('button', { name: 'Add a member' });
  out.hasPlus = await plus.count() > 0;
  if (out.hasPlus) {
    const [popup] = await Promise.all([page.waitForEvent('popup'), plus.click()]);
    out.plusOpens = new URL(popup.url()).pathname + new URL(popup.url()).search;
    await popup.close();
  }

  if (hasPencil) {
    await pencil.click();
    await page.getByRole('textbox', { name: 'Company name', exact: true }).fill('Acme Pvt Ltd');
    await page.getByRole('button', { name: 'Save company name' }).click();
    await page.waitForTimeout(1500);
    const body = await page.locator('body').innerText();
    out.putBody = putBody;
    out.inlineError = /That company already exists/.test(body);
    out.renamedCount = (body.match(/Acme Pvt Ltd/g) || []).length;
    out.editorStillOpen = await page.getByRole('textbox', { name: 'Company name', exact: true }).count() > 0;
    if (!out.editorStillOpen) out.triggerAfter = (await trigger.innerText()).trim();
  }

  console.log(`\n── ${label} ──\n${JSON.stringify(out, null, 2)}`);
  await page.screenshot({ path: `/tmp/claude-1000/-opt-docsnx/ada943ee-75af-4aee-b5dc-03a710abd2a7/scratchpad/rename-${label.replace(/\W+/g, '_')}.png` });
  await browser.close();
  return out;
}

/** Where "+" lands: the company's Members screen, add dialog open, name filled. */
async function addMemberLanding() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/api/**', (r) => r.fulfill({ json: { success: true, users: [], data: [], items: [] } }));
  await page.route('**/api/auth/me', (r) => r.fulfill({
    json: {
      success: true,
      user: {
        id: 'u1', role: 'TENANT_ADMIN', name: 'Test Admin', email: 'a@b.c', tenantId: 't1',
        permissions: [], tenant: { id: 't1', name: 'Acme Tenant', accountType: 'business', hasCompletedOnboarding: true },
      },
      companies: [{ id: CID, name: 'Acme' }],
      planStatus: { accountType: 'business', axes: { business: { hasPlan: true, expired: false, daysLeft: 300 } } },
    },
  }));
  await page.route('**/api/companies', (r) => r.fulfill({ json: { success: true, companies: [{ id: CID, name: 'Acme' }], quota: null } }));
  await page.goto(`${BASE}/business/${CID}/users?add=1&close=1&name=Ravi%20Director`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  // The Members screen's own modal, not a Radix dialog — so find it by its title.
  const values = await page.locator('input').evaluateAll((els) => els.map((e) => e.value));
  const out = {
    dialogOpen: await page.getByText('Add Member', { exact: true }).count() > 0,
    prefilled: values.includes('Ravi Director'),
    errors,
  };
  console.log(`\n── + lands on the company's add-member dialog ──\n${JSON.stringify(out, null, 2)}`);
  await browser.close();
  return out;
}

const landing = await addMemberLanding();
const admin = await run('admin renames', {});
const clash = await run('admin 409', { putStatus: 409 });
const member = await run('standard member', { role: 'STANDARD' });

const ok = landing.dialogOpen && landing.prefilled && landing.errors.length === 0
  && admin.hasPencil && admin.putBody?.name === 'Acme Pvt Ltd' && admin.renamedCount >= 2 && !admin.editorStillOpen
  && admin.triggerBefore === 'Acme' && admin.triggerAfter === 'Acme Pvt Ltd'
  && JSON.stringify(admin.options) === JSON.stringify(['Acme', 'Ravi Director']) && admin.membersScoped
  && admin.plusOpens?.startsWith(`/business/${CID}/users?add=1&close=1`)
  && clash.inlineError && clash.editorStillOpen
  && !member.hasPencil && !member.hasPlus
  && [admin, clash, member].every((r) => r.errors.length === 0);
console.log(`\n${ok ? 'ALL CLEAR' : 'FAILURES'}`);
process.exit(ok ? 0 : 1);
