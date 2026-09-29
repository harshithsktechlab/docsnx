import { test, expect } from '@playwright/test';

test.describe('Accessibility and Visual Checks', () => {
  test('Dashboard Visual Regression', async ({ page }) => {
    await page.route('**/api/dashboard**', async route => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, stats: { totalUsers: 2, storageUsed: '100 MB', alertsCount: 0 }}) });
    });
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveScreenshot('dashboard.png', { fullPage: true, maxDiffPixelRatio: 0.1 });
  });

  test('Documents Visual Regression', async ({ page }) => {
    await page.route('**/api/documents**', async route => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, documents: [] }) });
    });
    await page.goto('/documents');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveScreenshot('documents.png', { fullPage: true, maxDiffPixelRatio: 0.1 });
  });
});
