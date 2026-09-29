import { test, expect } from '@playwright/test';

// Use a unique email to avoid colliding with the global setup tenant
const randomId = Math.floor(Math.random() * 100000);
const email = `auth-test-${randomId}@example.com`;
const password = 'secure_password_123';

test.describe.serial('Authentication and Onboarding Flows', () => {
  // Use a completely unauthenticated context for this suite
  test.use({ storageState: { cookies: [], origins: [] } });

  test('should successfully register a new tenant', async ({ page }) => {
    await page.goto('/register');
    
    // Fill the registration form
    await page.fill('#tenantName', 'UI Test Tenant');
    await page.fill('#name', 'UI Tester');
    await page.fill('#email', email);
    await page.fill('#phoneNumber', '9999999999');
    await page.fill('#password', password);
    
    await page.check('#consentData');
    await page.check('#consentAi');
    
    // Wait for plans to load from API before submitting
    await expect(page.getByText(/Trial|Enterprise|Yearly/i).first()).toBeVisible({ timeout: 15000 });
    
    // Submit the form
    await page.getByRole('button', { name: 'Initialize Workspace' }).click();

    // Wait for redirect to billing
    await page.waitForURL(/.*\/billing/);
    await expect(page).toHaveURL(/.*\/billing/);
    await expect(page.getByText('Billing', { exact: false }).first()).toBeVisible();
  });

  test('should successfully login to an existing tenant', async ({ page }) => {
    // This test relies on the user created in the previous test.
    // In a fully isolated setup, you'd create a user via API first, but since this suite runs sequentially by default within the file, it works.
    await page.goto('/login');
    
    await page.fill('#email', email);
    await page.fill('#password', password);
    
    await page.click('button[type="submit"]');

    await page.waitForURL('**/dashboard');
    await expect(page).toHaveURL(/.*\/dashboard/);
  });
  
  test('should show error on invalid login', async ({ page }) => {
    await page.goto('/login');
    
    await page.fill('#email', 'wrong@email.com');
    await page.fill('#password', 'wrong_password');
    
    await page.click('button[type="submit"]');

    await expect(page.getByText('Invalid credentials')).toBeVisible();
  });
});
