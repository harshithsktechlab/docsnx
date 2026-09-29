import { request, FullConfig } from '@playwright/test';
import { STORAGE_STATE } from '../playwright.config';
import fs from 'fs';
import path from 'path';

export default async function globalSetup(config: FullConfig) {
  const authDir = path.dirname(STORAGE_STATE);
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  const requestContext = await request.newContext({
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3002',
  });

  const email = 'sunil@gadhiya.biz';
  const password = 'dev_secure_2026';
  
  console.log('Global Setup: Creating E2E Test Tenant and User...');

  // Attempt to register
  const res = await requestContext.post('/api/auth/register', {
    data: {
      tenantName: 'E2E Test Tenant',
      name: 'E2E Admin',
      email,
      password,
      phoneNumber: '1234567890',
      consentDataProcessing: true,
      consentAiProcessing: true
    }
  });

  if (!res.ok()) {
    const body = await res.json().catch(() => ({}));
    if (res.status() === 400 && body.error === 'Email already registered') {
      console.log('Global Setup: User exists, logging in instead...');
      const loginRes = await requestContext.post('/api/auth/login', {
        data: { email, password }
      });
      if (!loginRes.ok()) {
        throw new Error(`Failed to login during setup: ${await loginRes.text()}`);
      }
    } else {
      throw new Error(`Failed to register during setup: ${await res.text()}`);
    }
  }

  // Save the state with the auth_token cookie
  await requestContext.storageState({ path: STORAGE_STATE });
  console.log('Global Setup: Auth state saved.');
}
