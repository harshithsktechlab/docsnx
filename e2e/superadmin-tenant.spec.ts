import { test, expect } from '@playwright/test';

test.describe('Superadmin Tenant Creation', () => {
  // Use unauthenticated context to ensure clean login
  test.use({ storageState: { cookies: [], origins: [] } });

  test('should login as superadmin, create tenant with lifetime plan, and login as new tenant', async ({ browser }) => {
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    adminPage.on('response', async res => {
      if (res.url().includes('/api/')) {
        console.log('API Response:', res.url(), res.status());
        if (!res.ok()) {
           console.log('API Error Body:', await res.text().catch(()=>''));
        }
      }
    });

    // 1. Login as Super Admin
    await adminPage.goto('/login');
    await adminPage.getByLabel('Email Address').fill('sunil@hsk.com');
    await adminPage.getByLabel('Password').fill('123456');
    await adminPage.getByRole('button', { name: 'Sign In' }).click();

    // Verify successful login
    await expect(adminPage).toHaveURL(/\/dashboard|admin/);

    // 2. Navigate to Tenants Page
    await adminPage.goto('/admin/tenants');
    
    // 3. Create New Tenant
    await adminPage.getByRole('button', { name: 'Create Tenant' }).click();
    
    const timestamp = Date.now();
    const tenantName = `Test Tenant ${timestamp}`;
    const tenantSlug = `test-tenant-${timestamp}`;
    const adminEmail = `admin_${timestamp}@example.com`;
    
    await adminPage.getByPlaceholder('e.g. Sharma Household or Acme Corp').fill(tenantName);
    

    await adminPage.getByRole('checkbox', { name: 'Initialize with Tenant Administrator account' }).check();
    
    await adminPage.getByPlaceholder('e.g. Sunil Gadhiya').fill('E2E Admin');
    await adminPage.getByPlaceholder('admin@domain.com').fill(adminEmail);
    await adminPage.getByPlaceholder('Secure password').fill('password123');
    
    // Submit form
    await adminPage.getByRole('button', { name: 'Create Tenant', exact: true }).click();
    
    // Verify success toast or existence in list
    await expect(adminPage.getByText('Tenant created successfully')).toBeVisible();
    
    // 4. Close super admin context
    await adminContext.close();
    
    // 5. Login as the new tenant
    const tenantContext = await browser.newContext();
    const tenantPage = await tenantContext.newPage();
    
    await tenantPage.goto('/login');
    await tenantPage.getByLabel('Email Address').fill(adminEmail);
    await tenantPage.getByLabel('Password').fill('password123');
    await tenantPage.getByRole('button', { name: 'Sign In' }).click();
    
    // Verify successful login
    await expect(tenantPage).toHaveURL(/\/dashboard/);
    
    await tenantContext.close();
  });
});
