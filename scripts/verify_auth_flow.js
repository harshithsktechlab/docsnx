const { PrismaClient } = require('@prisma/client');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();
const TEST_PORT = '3009';
const TEST_URL = `http://localhost:${TEST_PORT}`;

async function main() {
  console.log('--- STARTING AUTH FLOW VERIFICATION ---');

  // 1. Get an existing tenant to assign our test user
  const tenant = await prisma.tenant.findFirst();
  if (!tenant) {
    throw new Error('No tenant found in the database. Run seed first.');
  }
  console.log(`Using tenant: ${tenant.name} (${tenant.id})`);

  // 2. Create a clean test user
  const testEmail = 'test_user_reset@example.com';
  const initialPassword = 'InitialPassword123!';
  const initialHash = await bcrypt.hash(initialPassword, 10);

  // Clean up any existing test user first
  await prisma.user.deleteMany({
    where: { email: testEmail }
  });

  const testUser = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: testEmail,
      name: 'Reset Test User',
      passwordHash: initialHash,
      role: 'STANDARD',
      requiresPasswordChange: false,
    }
  });
  console.log(`Created test user: ${testUser.email} (${testUser.id})`);

  // 3. Start Next.js development server on test port
  console.log(`Starting Next.js server on port ${TEST_PORT}...`);
  const serverProcess = spawn('npx', ['next', 'dev', '-p', TEST_PORT], {
    shell: true,
    env: { ...process.env, PORT: TEST_PORT }
  });

  // Handle server process exit/error
  serverProcess.on('error', (err) => {
    console.error('Failed to start Next.js server process:', err);
  });

  // Helper to stop the server
  const stopServer = () => {
    console.log('Stopping Next.js server...');
    serverProcess.kill('SIGINT');
  };

  // Wait for the server to be ready
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${TEST_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nonexistent@example.com', password: 'pwd' })
      });
      if (res.status === 401 || res.status === 200 || res.status === 400) {
        ready = true;
        console.log('Server is ready and responding.');
        break;
      }
    } catch (err) {
      // Server not ready yet, wait
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  if (!ready) {
    stopServer();
    throw new Error('Next.js server failed to become ready in 30 seconds.');
  }

  // Ensure public/reset_link_debug.log is removed/clean before starting
  const debugLogPath = path.join(process.cwd(), 'public', 'reset_link_debug.log');
  if (fs.existsSync(debugLogPath)) {
    fs.unlinkSync(debugLogPath);
  }

  try {
    // 4. Hit the Forgot Password API
    console.log('Sending forgot-password request...');
    const forgotResponse = await fetch(`${TEST_URL}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail })
    });

    const forgotResult = await forgotResponse.json();
    console.log('Forgot password response:', forgotResult);

    if (!forgotResponse.ok || !forgotResult.success) {
      throw new Error(`Forgot password API failed: ${JSON.stringify(forgotResult)}`);
    }

    // 5. Read the reset token from the database
    const updatedUser = await prisma.user.findUnique({
      where: { id: testUser.id }
    });

    if (!updatedUser.resetToken || !updatedUser.resetTokenExpiry) {
      throw new Error('Reset token or expiry was not saved to the database.');
    }
    console.log(`Found reset token in DB: ${updatedUser.resetToken}`);
    console.log(`Reset token expiry: ${updatedUser.resetTokenExpiry}`);

    // 6. Verify debug log was written
    if (!fs.existsSync(debugLogPath)) {
      throw new Error('Debug log public/reset_link_debug.log was not created.');
    }
    const logContent = fs.readFileSync(debugLogPath, 'utf8');
    console.log(`Debug log file content: ${logContent}`);
    if (!logContent.includes(updatedUser.resetToken)) {
      throw new Error('Debug log does not contain the correct reset token.');
    }
    console.log('Debug log file verification passed!');

    // 7. Hit the Reset Password API
    console.log('Sending reset-password request...');
    const newPassword = 'NewSecurePassword2026!';
    const resetResponse = await fetch(`${TEST_URL}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: updatedUser.resetToken,
        newPassword
      })
    });

    const resetResult = await resetResponse.json();
    console.log('Reset password response:', resetResult);

    if (!resetResponse.ok || !resetResult.success) {
      throw new Error(`Reset password API failed: ${JSON.stringify(resetResult)}`);
    }

    // 8. Verify database state is updated (token cleared, password changed)
    const finalUser = await prisma.user.findUnique({
      where: { id: testUser.id }
    });

    if (finalUser.resetToken || finalUser.resetTokenExpiry) {
      throw new Error('Reset token and expiry were not cleared from the database.');
    }

    const isOldPasswordMatch = await bcrypt.compare(initialPassword, finalUser.passwordHash);
    const isNewPasswordMatch = await bcrypt.compare(newPassword, finalUser.passwordHash);

    if (isOldPasswordMatch) {
      throw new Error('Password hash was not updated (still matches initial password).');
    }
    if (!isNewPasswordMatch) {
      throw new Error('Password hash does not match the new password.');
    }
    console.log('Database verification passed! Password hash updated successfully.');

    // 9. Try logging in with the new password
    console.log('Attempting to login with new password...');
    const loginResponse = await fetch(`${TEST_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: newPassword
      })
    });

    const loginResult = await loginResponse.json();
    console.log('Login response:', loginResult);

    if (!loginResponse.ok || !loginResult.success) {
      throw new Error(`Login with new password failed: ${JSON.stringify(loginResult)}`);
    }
    console.log('Login verification passed! Successfully authenticated with new password.');

  } finally {
    // 10. Clean up
    stopServer();
    console.log('Cleaning up test user...');
    await prisma.user.delete({
      where: { id: testUser.id }
    });
  }

  console.log('--- AUTH FLOW VERIFICATION PASSED SUCCESSFULLY ---');
}

main()
  .catch(err => {
    console.error('Verification failed with error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
