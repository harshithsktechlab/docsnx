import { test, expect, Page } from '@playwright/test';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   MOBILE LAYOUT AUDIT — one gutter, one left edge, no sideways scroll    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Runs ONLY in the `mobile` project (Pixel 5). Every other project here is
 * Desktop Chrome, which is exactly why a dozen pages drifted to their own
 * gutter without anyone noticing.
 *
 * Three assertions per page, each aimed at a failure that actually happened:
 *
 *  1. NO HORIZONTAL OVERFLOW. `body { overflow-x: hidden }` hides this, so it
 *     is invisible by eye — the page just looks shifted. Catches a wide child
 *     stretching the shell's content column.
 *  2. THE CONTAINER SITS AT THE GUTTER. `<main>` owns the 16px inset; a page
 *     that re-declares `p-6` lands at 40px instead. One number, one check.
 *  3. NOTHING ESCAPES THE CONTAINER. In-flow blocks stay inside it.
 *
 * ── RUNNING IT ─────────────────────────────────────────────────────────────
 *   npm run dev -- -p 3010
 *   PLAYWRIGHT_BASE_URL=http://localhost:3010 npx playwright test --project=mobile
 *
 * ⚠ NEVER point PLAYWRIGHT_BASE_URL at port 3005. That is the live production
 * server on this box, and e2e/global.setup.ts REGISTERS a tenant against
 * whatever base URL it is given. The config default (3002) is safe.
 */

/** `<main>`'s mobile inset — .page-gutter in globals.css. */
const GUTTER = 16;
/** Sub-pixel slack: layout maths rarely lands on a whole number. */
const EPS = 1.5;

const ROUTES = [
  '/dashboard',
  '/documents',
  '/medical',
  '/passwords',
  '/vehicles',
  '/bank-info',
  '/investments',
  '/todos',
  '/warranty',
  '/rentals',
  '/important-contacts',
  '/lic-mediclaim',
  '/trading',
  // The six that used to add their own `p-6` on top of the gutter.
  '/loans-debt',
  '/tax-compliance',
  '/utility-bills',
  '/wills-estate',
  '/corporate-compliance',
  '/employment-payroll',
  // Utility surfaces.
  '/more',
  '/settings',
  '/profile',
  '/users',
  '/follow-up',
  '/audit-logs',
  '/invoices',
  '/backup',
  '/analysis',
  '/billing',
];

async function settle(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle').catch(() => {});
  // Skeleton roots use the same container, so there is nothing to wait for
  // beyond the container existing at all.
  await page.locator('[data-page-container]').first().waitFor({ timeout: 15000 });
}

test.describe('Mobile layout', () => {
  for (const path of ROUTES) {
    test(`${path} — gutter, alignment and overflow`, async ({ page }) => {
      await settle(page, path);

      // ── 1. no horizontal overflow ──────────────────────────────────────
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(
        overflow.scrollWidth,
        `${path} scrolls sideways: ${overflow.scrollWidth}px of content in a ${overflow.innerWidth}px viewport`
      ).toBeLessThanOrEqual(overflow.innerWidth + EPS);

      // ── 2. the container sits exactly on the gutter ────────────────────
      const container = page.locator('[data-page-container]').first();
      const box = (await container.boundingBox())!;
      expect(box, `${path} has no page container`).not.toBeNull();
      expect(
        box.x,
        `${path} left edge is ${box.x}px, not the ${GUTTER}px gutter — the page is adding padding of its own`
      ).toBeLessThanOrEqual(GUTTER + EPS);
      expect(box.x).toBeGreaterThanOrEqual(GUTTER - EPS);

      // ── 3. nothing in flow escapes the viewport ────────────────────────
      const escapees = await container.evaluate((root, eps: number) => {
        const bad: string[] = [];
        const vw = window.innerWidth;
        for (const el of Array.from(root.children) as HTMLElement[]) {
          const cs = getComputedStyle(el);
          if (cs.position === 'fixed' || cs.position === 'absolute') continue;
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          if (r.left < -eps || r.right > vw + eps) {
            bad.push(`${el.tagName.toLowerCase()}.${el.className.toString().slice(0, 60)} @ ${Math.round(r.left)}..${Math.round(r.right)}`);
          }
        }
        return bad;
      }, EPS);
      expect(escapees, `${path} has blocks outside the viewport`).toEqual([]);
    });
  }
});

test.describe('Reachable on a phone', () => {
  /**
   * Three controls that existed only above a breakpoint:
   *   - the theme button was in `hidden md:flex` inside an `lg:hidden` header,
   *     so it rendered only in the 768–1023px tablet band;
   *   - the AI Credits / Storage meters lived in the `hidden lg:flex` sidebar;
   *   - nothing on a phone linked to /billing/credits at all.
   * Each is asserted at a real phone width, which is the only width that was
   * ever wrong.
   */
  test('the theme toggle is in the header', async ({ page }) => {
    await settle(page, '/dashboard');
    const toggle = page.getByRole('button', { name: /switch to (light|dark) mode/i });
    await expect(toggle).toBeVisible();
  });

  test('the theme toggle actually switches the theme', async ({ page }) => {
    await settle(page, '/dashboard');
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await page.getByRole('button', { name: /switch to (light|dark) mode/i }).click();
    const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(after).not.toBe(before);
  });

  test('/more carries the usage meters, the credits link and Appearance', async ({ page }) => {
    await settle(page, '/more');

    await expect(page.getByText('AI Credits', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /AI Credits & Usage/i })).toBeVisible();

    // Appearance: both controls, the text-size one being the reason this
    // section exists rather than everything living in the header.
    await expect(page.getByRole('radiogroup', { name: 'Theme' })).toBeVisible();
    await expect(page.getByTitle('Increase Font Size')).toBeVisible();
  });

  test('the AI credits link opens the ledger', async ({ page }) => {
    await settle(page, '/more');
    await page.getByRole('button', { name: /AI Credits & Usage/i }).click();
    await page.waitForURL('**/billing/credits');
  });
});

test.describe('Dialog alignment', () => {
  /**
   * The title and the fields it labels have to share a left edge. Nineteen
   * dialogs used to pass `p-6` on DialogContent while resetting DialogHeader
   * to `p-0`, so the title sat at 24px and the form body at 48px — the base
   * component already pads every child.
   */
  test('a record dialog puts its title and its first field on one edge', async ({ page }) => {
    await settle(page, '/medical');

    const opener = page.getByRole('button', { name: /add (health )?record|add new/i }).first();
    if (!(await opener.isVisible().catch(() => false))) {
      test.skip(true, 'no add-record affordance for this user');
    }
    await opener.click();

    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ timeout: 10000 });

    const title = (await dialog.locator('h2, [id$="-title"]').first().boundingBox())!;
    const field = (await dialog.locator('input:visible, [role="combobox"]').first().boundingBox())!;
    expect(title).not.toBeNull();
    expect(field).not.toBeNull();
    expect(
      Math.abs(title.x - field.x),
      `dialog title at ${title.x}px but first field at ${field.x}px — the content is double-padded`
    ).toBeLessThanOrEqual(EPS);
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   NOTHING OVERLAPS ON A PHONE                                            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The gutter tests above catch a page that is in the wrong PLACE. These catch a
 * page whose parts are on top of EACH OTHER, which is invisible to every check
 * that only measures the container. Two real bugs prompted them:
 *
 *  1. On a sub-category Summary the red "104d overdue" badge sat ON the holder
 *     name — a nested flex row keeps its min-content width unless told
 *     otherwise, so it spilled out of the column that was shrinking around it.
 *  2. On /documents the floating Add and Power Scan buttons sat ON the
 *     pagination's Next button: `position: fixed` is out of flow, so the page
 *     scrolled its last row straight underneath them.
 *
 * Hence one check for each failure mode, and only those two — a generic
 * "no two rects intersect" sweep flags every deliberate stack and teaches
 * everyone to ignore it.
 */

/** Overlap smaller than this is a border, a shadow or a rounding error. */
const OVERLAP_SLACK = 4;

/** The Summary tab is the surface (1) broke on, so it is measured explicitly. */
const OVERLAP_ROUTES = [
  ...ROUTES,
  '/modules/identity',
  '/modules/identity/pan_card',
];

test.describe('Nothing overlaps on a phone', () => {
  for (const path of OVERLAP_ROUTES) {
    test(`${path} — every control is tappable and no row sits on its neighbour`, async ({ page }) => {
      await settle(page, path);
      // Fixed chrome only covers content once the page is scrolled to its end,
      // which is exactly the state bug (2) needed.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(300);

      // ── 1. every visible control is the thing at its own centre ──────────
      // `elementFromPoint` answers the only question that matters for a tap:
      // who receives it. A control under fixed chrome fails here even though
      // its own box is perfectly correct.
      const covered = await page.evaluate((slack: number) => {
        const bad: string[] = [];
        const controls = document.querySelectorAll<HTMLElement>(
          'button, a[href], [role="button"], input:not([type="hidden"]), select'
        );
        for (const el of Array.from(controls)) {
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) continue;                 // icon-less/hidden
          if (r.bottom <= 0 || r.top >= window.innerHeight) continue; // off-screen
          if (r.right <= 0 || r.left >= window.innerWidth) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.opacity === '0' || cs.pointerEvents === 'none') continue;
          const x = Math.min(window.innerWidth - 1, Math.max(1, r.left + r.width / 2));
          const y = Math.min(window.innerHeight - 1, Math.max(1, r.top + r.height / 2));
          const hit = document.elementFromPoint(x, y);
          if (!hit) continue;
          if (el.contains(hit) || hit.contains(el)) continue;
          // A label/overlay of the control's own is not a collision.
          if (hit.closest('button, a[href], [role="button"], input, select') === el) continue;
          const cover = hit as HTMLElement;
          const cr = cover.getBoundingClientRect();
          const overlap =
            Math.max(0, Math.min(r.right, cr.right) - Math.max(r.left, cr.left)) *
            Math.max(0, Math.min(r.bottom, cr.bottom) - Math.max(r.top, cr.top));
          if (overlap <= slack * slack) continue;
          bad.push(
            `${el.tagName.toLowerCase()}[${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}]` +
            ` is covered by ${cover.tagName.toLowerCase()}.${cover.className.toString().slice(0, 50)}`
          );
        }
        return bad;
      }, OVERLAP_SLACK);
      expect(covered, `${path} has controls that cannot be tapped`).toEqual([]);

      // ── 2. no element sits on the sibling beside it in a row ─────────────
      // Bug (1) exactly: siblings in one flex row, laid out side by side, whose
      // boxes intersect because one of them could not shrink.
      const collisions = await page.evaluate((slack: number) => {
        const bad: string[] = [];
        const rows = document.querySelectorAll<HTMLElement>('*');
        for (const row of Array.from(rows)) {
          const cs = getComputedStyle(row);
          if (cs.display !== 'flex' && cs.display !== 'inline-flex') continue;
          if (cs.flexDirection.startsWith('column')) continue;   // stacked, not side by side
          if (cs.flexWrap !== 'nowrap' && cs.flexWrap !== 'wrap') continue;
          const kids = (Array.from(row.children) as HTMLElement[]).filter((k) => {
            const s = getComputedStyle(k);
            if (s.display === 'none' || s.visibility === 'hidden') return false;
            if (s.position === 'absolute' || s.position === 'fixed') return false;
            const r = k.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          for (let i = 0; i < kids.length - 1; i++) {
            const a = kids[i].getBoundingClientRect();
            const b = kids[i + 1].getBoundingClientRect();
            // Only a pair actually laid out side by side; a wrapped row puts
            // the next child on a new line, which is not a collision.
            const sameLine = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0;
            if (!sameLine) continue;
            const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            if (overlapX <= slack) continue;
            bad.push(
              `${kids[i].tagName.toLowerCase()}[${(kids[i].textContent || '').trim().slice(0, 24)}]` +
              ` overlaps ${kids[i + 1].tagName.toLowerCase()}[${(kids[i + 1].textContent || '').trim().slice(0, 24)}]` +
              ` by ${Math.round(overlapX)}px`
            );
          }
        }
        return bad;
      }, OVERLAP_SLACK);
      expect(collisions, `${path} has rows whose contents sit on each other`).toEqual([]);
    });
  }
});
