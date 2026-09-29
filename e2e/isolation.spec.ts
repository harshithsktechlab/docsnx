import { test, expect } from '@playwright/test';

test.describe.serial('Tenant Data Isolation Checks', () => {
  let tenantAUser;
  let tenantBUser;

  test.beforeAll(async ({ request }) => {
    const randomSuffix = Math.floor(Math.random() * 100000);
    const emailA = `adminA-${randomSuffix}@example.com`;
    const emailB = `adminB-${randomSuffix}@example.com`;
    const password = 'secure_password_123';

    // Create Tenant A
    const resA = await request.post(`${process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3005'}/api/auth/register`, {
      data: {
        tenantName: 'Tenant A',
        name: 'Admin A',
        email: emailA,
        password,
        phoneNumber: '1111111111',
        consentDataProcessing: true,
        consentAiProcessing: true
      }
    });
    if (!resA.ok()) {
      console.log('resA failed:', await resA.text());
    }
    expect(resA.ok()).toBeTruthy();

    // Create Tenant B
    const resB = await request.post(`${process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3005'}/api/auth/register`, {
      data: {
        tenantName: 'Tenant B',
        name: 'Admin B',
        email: emailB,
        password,
        phoneNumber: '2222222222',
        consentDataProcessing: true,
        consentAiProcessing: true
      }
    });
    if (!resB.ok()) {
      console.log('resB failed:', await resB.text());
    }
    expect(resB.ok()).toBeTruthy();
    
    // Login to grab User B's details (like ID)
    const loginBRes = await request.post(`${process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3005'}/api/auth/login`, {
      data: { email: emailB, password }
    });
    const bodyB = await loginBRes.json();
    tenantBUser = bodyB.user;
  });

  test('Tenant A SHOULD NOT be able to modify Tenant B user profile via PUT /api/profiles', async ({ request }) => {
    // Login to grab User A's details and populate the test's request context with the auth cookie
    const randomSuffix = tenantBUser.email.split('-')[1].split('@')[0]; // Extract the suffix used in beforeAll
    const emailA = `adminA-${randomSuffix}@example.com`;
    const password = 'secure_password_123';
    
    const loginARes = await request.post(`${process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3005'}/api/auth/login`, {
      data: { email: emailA, password }
    });
    const bodyA = await loginARes.json();
    tenantAUser = bodyA.user;

    // request context has the cookies from the LAST login (which was Tenant A)
    // Attempt to update Tenant B's profile
    const putRes = await request.put(`${process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3005'}/api/profiles`, {
      data: {
        userId: tenantBUser.id,
        personalDetails: {
          hacked: true,
          dob: '1990-01-01'
        }
      }
    });

    const status = putRes.status();
    const text = await putRes.text();
    console.log('PUT Status:', status, 'Response:', text);

    // It should be forbidden (403) or not found (404)
    expect([403, 404]).toContain(status);
  });
});
