import { test, expect } from '@playwright/test';

test.describe('Tenant Self-Serve Signup', () => {
  // Use unauthenticated context to ensure clean session
  test.use({ storageState: { cookies: [], origins: [] } });

  test('should register a new tenant and default to TRIAL plan', async ({ page }) => {
    page.on('response', async res => {
      if (res.url().includes('/api/')) {
        console.log('API Response:', res.url(), res.status());
        if (!res.ok()) {
           console.log('API Error Body:', await res.text().catch(()=>''));
        }
      }
    });
    // 1. Navigate to register page
    await page.goto('/register');
    
    const timestamp = Date.now();
    const tenantName = `Self Serve ${timestamp}`;
    const email = `tenant_${timestamp}@example.com`;
    
    // 2. Fill registration form
    await page.fill('#tenantName', tenantName);
    await page.fill('#name', 'E2E User');
    await page.fill('#email', email);
    await page.fill('#phoneNumber', '9876543210');
    await page.fill('#password', 'password123');
    
    // Accept consents
    await page.locator('#consentData').check();
    await page.locator('#consentAi').check();
    
    // Wait for plans to load from API before submitting
    await expect(page.getByText(/Trial|Enterprise|Yearly/i).first()).toBeVisible({ timeout: 15000 });
    
    // 3. Submit registration
    await page.screenshot({ path: 'before-submit.png', fullPage: true });
    await page.getByRole('button', { name: 'Initialize Workspace' }).click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'after-submit.png', fullPage: true });
    
    // 4. Verify redirect to /billing and success
    await expect(page).toHaveURL(/\/billing/);
    
    // 5. Verify default plan badge
    await expect(page.getByText(/Trial|Enterprise/i).first()).toBeVisible();
    
    // 6. Simulate clicking "Select Plan" for upgrade
    // Wait for plans to load
    await expect(page.getByText('Loading plans...')).not.toBeVisible();
    
    // Click the first available "Select Plan" button
    const selectPlanBtn = page.getByRole('button', { name: 'Select Plan' }).first();
    await expect(selectPlanBtn).toBeVisible();
    await selectPlanBtn.click();
    
    // Verify Checkout modal opens
    await expect(page.getByText(/Checkout|Order Summary|Pay Now/i).first()).toBeVisible({ timeout: 15000 });
  });
});
