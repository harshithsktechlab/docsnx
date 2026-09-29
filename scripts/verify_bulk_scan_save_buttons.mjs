/**
 * Drives the bulk-scan review with every API stubbed (no DB writes) and checks
 * that the "Confirm & Save All" button appears above AND below the record list,
 * with matching alignment at phone, tablet and desktop widths.
 *
 * Usage: node scripts/verify_bulk_scan_save_buttons.mjs [baseURL] [shotDir]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:3010';
const SHOTS = process.argv[3] || null;

const me = {
  success: true,
  user: {
    id: 'u1', role: 'TENANT_ADMIN', name: 'Test Admin', email: 'a@b.c',
    tenant: { id: 't1', name: 'Sharma Household', accountType: 'personal', hasCompletedOnboarding: true },
  },
  companies: [],
  planStatus: { accountType: 'personal', axes: { personal: { hasPlan: true, expired: false, daysLeft: 300 } } },
};

const records = Array.from({ length: 14 }, (_, i) => ({
  title: `Scanned record ${i + 1}`,
  holderId: 'u1',
  fileIndices: [0],
  extractedData: { moduleKey: 'identity', documentKey: 'pan_card', fields: { name: 'Test' } },
}));

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

const browser = await chromium.launch();
let failed = false;

for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // Catch-all first; later routes take precedence.
  await page.route('**/api/**', (r) => r.fulfill({ json: { success: true } }));
  await page.route('**/api/auth/me', (r) => r.fulfill({ json: me }));
  await page.route('**/api/ai/scan', (r) => r.fulfill({
    json: { success: true, files: [{ name: 'a.png' }], proposedRecords: records, fieldSpecs: null },
  }));

  await page.goto(`${BASE}/documents/bulk-scan`, { waitUntil: 'networkidle' });
  await page.locator('input[type="file"]').setInputFiles({
    name: 'a.png', mimeType: 'image/png', buffer: Buffer.from('89504e47', 'hex'),
  });
  await page.getByRole('button', { name: /Start AI Group & Scan/ }).click();
  await page.getByText('AI Scan Finished!').waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);

  const buttons = page.getByRole('button', { name: /Confirm & Save All|need attention/ });
  const count = await buttons.count();
  const rects = await buttons.evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), top: Math.round(r.top + window.scrollY), text: e.innerText.trim(), sw: e.scrollWidth, cw: e.clientWidth };
  }));
  const hScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

  const [top, bottom] = rects;
  const sameEdges = count === 2 && top.left === bottom.left && top.right === bottom.right;
  const clipped = rects.some((r) => r.sw > r.cw + 1);
  const ok = count === 2 && sameEdges && !hScroll && !clipped && top.text === bottom.text && bottom.top > top.top;
  if (!ok) failed = true;

  console.log(`\n── ${vp.name} (${vp.width}px) ── ${ok ? 'OK' : 'FAIL'}`);
  console.log(`   buttons : ${count}`);
  rects.forEach((r, i) => console.log(`   [${i ? 'bottom' : 'top   '}] left=${r.left} right=${r.right} width=${r.width} y=${r.top} "${r.text}"`));
  console.log(`   same edges: ${sameEdges}  h-scroll: ${hScroll}  clipped: ${clipped}`);
  if (errors.length) console.log(`   pageerror: ${errors.join(' | ')}`);

  if (SHOTS) {
    await buttons.first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/${vp.name}-top.png` });
    await buttons.last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/${vp.name}-bottom.png` });
  }
  await page.close();
}

await browser.close();
process.exit(failed ? 1 : 0);
