import { test, expect } from '@playwright/test';

test.describe('User Management', () => {
  // Use the global authenticated state
  test.use({ storageState: 'playwright/.auth/user.json' });

  test('should successfully add a new member', async ({ page }) => {
    await page.on('response', async res => {
      if (res.url().includes('/api/') && !res.ok()) {
        console.log('API Error Body:', await res.text().catch(()=>''));
      }
    });
    
    await page.goto('/users');

    // Click "Add Member" button
    await page.click('button:has-text("Add Member")');

    // Wait for the modal to open
    await expect(page.getByText('Add Member')).toBeVisible();

    const randomStr = Math.random().toString(36).substring(7);
    const testEmail = `new-member-${randomStr}@example.com`;
    const testName = `New Member ${randomStr}`;

    // Fill basic details
    await page.fill('#addName', testName);
    await page.fill('#addEmail', testEmail);
    await page.fill('#addPhone', '9876543210');
    // password is auto-filled with temporary password, we can leave it
    
    // Select Role
    await page.click('#addRole'); // open select
    await page.click('div[role="option"]:has-text("Standard Member")');

    // Submit form. We find the submit button inside the dialog
    // We can just press Enter on an input or find the button by type
    await page.locator('button[type="submit"][form="addForm"]').click();

    // Verify success toast appears
    await expect(page.getByText('Successfully added user')).toBeVisible();

    // Verify the new user appears in the members list
    await expect(page.getByText(testName).first()).toBeVisible();
    await expect(page.getByText(testEmail).first()).toBeVisible();
  });
});
