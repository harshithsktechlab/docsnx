import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

test.describe('Document Vault', () => {
  // Use the global authenticated state for these tests
  test.use({ storageState: 'playwright/.auth/user.json' });

  let testFilePath: string;
  let textFilePath: string;

  /** What the text document says, asserted verbatim in the preview. */
  const TEXT_BODY = 'Policy number: LIC-778899\nHolder: Playwright Tester\n';

  test.beforeAll(() => {
    // Create a dummy test file
    testFilePath = path.join(__dirname, 'dummy.pdf');
    fs.writeFileSync(testFilePath, 'dummy content for e2e testing');
    // A format the browser has no viewer for and the vault has always accepted.
    textFilePath = path.join(__dirname, 'dummy-notes.txt');
    fs.writeFileSync(textFilePath, TEXT_BODY);
  });

  test.afterAll(() => {
    for (const f of [testFilePath, textFilePath]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  /** The mocked AI scan every upload here relies on, so no Gemini call is made. */
  const mockScan = async (page: any, title: string) => {
    await page.route('**/api/ai/scan', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          proposedRecords: [{
            title,
            extractedData: {
              name: title,
              category: 'legal',
              metadata: {
                documentNumber: 'Z1234567',
                idHolderName: 'Playwright Tester',
                dob: '1990-01-01T00:00:00.000Z',
              },
            },
          }],
        }),
      });
    });
  };

  test('should successfully mock AI scan and upload a document', async ({ page }) => {
    await mockScan(page, 'Mocked Passport');

    await page.goto('/documents');

    // Open Add Document Form
    await page.click('button:has-text("Upload Document")');

    // One document at a time: several files are Power Scan's job, so this
    // control must not offer a multi-select. Asserted because the difference is
    // invisible until a user picks four files and three vanish.
    await expect(page.locator('input[type="file"]')).not.toHaveAttribute('multiple', /.*/);

    // Upload dummy file
    await page.setInputFiles('input[type="file"]', testFilePath);

    // Trigger AI Scan
    await page.click('button:has-text("Auto-fill with AI")');

    // Wait for the mocked AI to fill the fields
    await expect(page.locator('#docName')).toHaveValue('Mocked Passport');
    await expect(page.locator('#documentNumber')).toHaveValue('Z1234567');
    await expect(page.locator('#idHolderName')).toHaveValue('Playwright Tester');

    // Save Document
    await page.click('button:has-text("Save Document")');

    // Assert document appears in the list (wait for modal to close and list to update)
    // The documents list groups them, so we just look for the text
    await expect(page.getByText('Mocked Passport').first()).toBeVisible();
    await expect(page.getByText('Playwright Tester').first()).toBeVisible();
  });

  /**
   * ── EVERY FORMAT IS VIEWABLE, NOT JUST THE TWO A BROWSER DRAWS ───────────
   *
   * A .txt is the cheapest case that proves the whole chain: the vault stores
   * it, the browser has no viewer for it, and before `?render=1` the preview
   * said "No preview available — Download File" — a dead end for a view-only
   * member, whose download button is gated on `share`.
   *
   * The office-document branch is exercised in tests/previewRender.test.ts,
   * which builds a real .docx with LibreOffice rather than carrying a binary
   * fixture that can rot.
   */
  test('previews a text document in-app rather than only offering a download', async ({ page }) => {
    await mockScan(page, 'Mocked Policy Notes');

    await page.goto('/documents');
    await page.click('button:has-text("Upload Document")');
    await page.setInputFiles('input[type="file"]', textFilePath);
    await page.click('button:has-text("Auto-fill with AI")');
    await expect(page.locator('#docName')).toHaveValue('Mocked Policy Notes');
    await page.click('button:has-text("Save Document")');

    await expect(page.getByText('Mocked Policy Notes').first()).toBeVisible();

    // View is a button on the row itself, not an entry in the ⋮ — see the
    // Actions column. The ⋮ now holds Print, Download, Edit and Delete.
    await page.getByRole('button', { name: 'View' }).first().click();

    await expect(page.getByText(/Preview: Mocked Policy Notes/)).toBeVisible();
    // The bytes themselves, rendered as text — not a "no preview" card.
    await expect(page.getByText(/LIC-778899/)).toBeVisible();
    await expect(page.getByText('No preview available for Mocked Policy Notes')).toHaveCount(0);
  });
});
