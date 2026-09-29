import { test, expect } from '@playwright/test';

test.describe('DAST Tests', () => {
  test('should have security headers', async ({ page, request }) => {
    const response = await request.get('/');
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    expect(response.headers()['x-frame-options']).toBe('DENY');
    expect(response.headers()['x-xss-protection']).toBe('1; mode=block');
    expect(response.headers()['strict-transport-security']).toContain('max-age=31536000');
  });

  test('should prevent basic XSS via query parameters', async ({ page }) => {
    const res = await page.goto('/?q=<script>alert("XSS")</script>');
    const content = await page.content();
    // Assuming framework handles it safely
    expect(content).not.toContain('<script>alert("XSS")</script>');
  });
});
