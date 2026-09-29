/**
 * Loads /privacy in a real browser as a SIGNED-OUT visitor (auth stubbed to
 * fail, so nothing touches the database) and proves: no redirect to /login,
 * all 23 sections render, the document's links are live anchors, and the
 * Privacy Policy link on /register actually lands here.
 *
 * Usage: node scripts/verify_privacy_render.mjs [baseURL]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:3010';
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures.push(msg); };

const browser = await chromium.launch();
for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/api/auth/me', (r) => r.fulfill({ status: 401, json: { success: false } }));

  await page.goto(`${BASE}/privacy`, { waitUntil: 'load' });
  await page.locator('h1').first().waitFor({ timeout: 20000 });
  const tag = `[${viewport.width}px]`;
  check(new URL(page.url()).pathname === '/privacy', `${tag} stays on /privacy when signed out (got ${new URL(page.url()).pathname})`);
  check((await page.locator('h1').first().textContent()) === 'Privacy Policy', `${tag} h1 is Privacy Policy`);
  check((await page.locator('article section[id]').count()) === 23, `${tag} 23 sections rendered`);
  check((await page.locator('nav[aria-label="Contents"] a').count()) === 23, `${tag} 23 TOC links`);
  for (const href of [
    'mailto:info@hsktechlab.com',
    'https://docsnx.com',
    'https://hsktechlab.com',
    'https://developers.google.com/terms/api-services-user-data-policy',
    'https://policies.google.com/privacy',
    'https://myaccount.google.com/permissions',
    'https://razorpay.com/privacy/',
    '/terms',
  ]) {
    check((await page.locator(`a[href="${href}"]`).count()) > 0, `${tag} link present: ${href}`);
  }
  check((await page.locator('a[target="_blank"]:not([rel~="noopener"])').count()) === 0, `${tag} every _blank link carries rel=noopener`);
  check((await page.getByText('Last Updated:').count()) === 1 && (await page.getByText('September 2026').count()) === 1, `${tag} static Last Updated`);
  check(!(await page.content()).includes('legal@docsnx.com'), `${tag} no legal@docsnx.com left`);
  check(await page.getByText('Settings → Account').count() === 1, `${tag} erasure paragraph present`);
  check(await page.getByText('Google Gemini or OpenAI').count() === 1, `${tag} AI-processing paragraph present`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `${tag} no horizontal scroll (overflow ${overflow}px)`);

  // Anchor from the TOC must clear the fixed nav.
  // The page scrolls smoothly, so wait for scrollY to stop moving before
  // measuring — the heading must sit just below the 80px fixed nav.
  await page.locator('nav[aria-label="Contents"] a[href="#s16"]').click();
  let prev = -1;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    const y = await page.evaluate(() => window.scrollY);
    if (y === prev) break;
    prev = y;
  }
  const top = await page.locator('#s16 h2').evaluate((el) => el.getBoundingClientRect().top);
  check(top >= 80 && top <= 160, `${tag} #s16 heading sits just under the fixed nav (top=${Math.round(top)}px)`);

  check(errors.length === 0, `${tag} no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
  await page.screenshot({ path: `${process.env.SHOT_DIR || '.'}/privacy-${viewport.width}.png`, fullPage: false });
  await page.close();
}

// The consent link on /register must land on the policy, not on /login.
{
  const page = await browser.newPage();
  await page.route('**/api/auth/me', (r) => r.fulfill({ status: 401, json: { success: false } }));
  await page.goto(`${BASE}/register`, { waitUntil: 'load' });
  const href = await page.locator('a[href="/privacy"]').first().getAttribute('href');
  check(href === '/privacy', 'register page links to /privacy');
  await page.goto(`${BASE}${href}`, { waitUntil: 'load' });
  await page.locator('h1').first().waitFor({ timeout: 20000 });
  check(new URL(page.url()).pathname === '/privacy', `following the register link lands on /privacy (got ${new URL(page.url()).pathname})`);
  await page.close();
}

await browser.close();
if (failures.length) { console.log(`\n${failures.length} failure(s)`); process.exit(1); }
console.log('\nall checks passed');
