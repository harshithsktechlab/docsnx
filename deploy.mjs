import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const VM_IP = '80.225.252.161';
const VM_USER = 'ubuntu';
const KEY_PATH = 'C:\\Users\\Admin\\.ssh\\ssh-key-2026-06-11.key';
const REMOTE_PATH = '/home/ubuntu/docsnx';

function runLocal(cmd) {
  console.log(`[LOCAL] Running: ${cmd}`);
  return execSync(cmd, { stdio: 'inherit' });
}

function runRemote(cmd) {
  console.log(`[REMOTE] Running: ${cmd}`);
  const sshCmd = `ssh -i "${KEY_PATH}" -o StrictHostKeyChecking=no ${VM_USER}@${VM_IP} "${cmd.replace(/"/g, '\\"')}"`;
  return execSync(sshCmd, { stdio: 'inherit' });
}

async function deploy() {
  const zipName = 'docsnx.zip';
  try {
    console.log('=== Starting Deployment to VM (Docker Compose) ===');

    // 1. Create a zip archive of the project locally using PowerShell
    console.log('Creating ZIP archive...');
    if (fs.existsSync(zipName)) {
      fs.unlinkSync(zipName);
    }
    // Zip only required files and directories, avoiding node_modules and .next
    runLocal(`powershell -Command "Compress-Archive -Path src, public, drizzle, drizzle.config.ts, scripts, .env, .gitignore, AGENTS.md, AI_CONTEXT.md, CLAUDE.md, Dockerfile, README.md, deploy.mjs, docker-compose.yml, eslint.config.mjs, jsconfig.json, next.config.mjs, package.json, package-lock.json, postcss.config.js, tailwind.config.js, tsconfig.json -DestinationPath ${zipName} -Force"`);

    // 2. SCP the zip file to VM
    console.log('Uploading ZIP archive...');
    runLocal(`scp -i "${KEY_PATH}" -o StrictHostKeyChecking=no ${zipName} ${VM_USER}@${VM_IP}:/tmp/${zipName}`);

    // 3. Extract and rebuild on the VM
    console.log('Extracting and rebuilding containers on VM...');
    
    const remoteCmds = [
      `mkdir -p ${REMOTE_PATH}`,
      `sudo chmod -R 775 ${REMOTE_PATH} || true`,
      `sudo find ${REMOTE_PATH} -type d -exec chmod 775 {} \\; || true`,
      `rm -rf ${REMOTE_PATH}/src`,
      `unzip -o /tmp/${zipName} -d ${REMOTE_PATH}`,
      `rm -f /tmp/${zipName}`,
      `sudo chmod -R 775 ${REMOTE_PATH} || true`,
      `cd ${REMOTE_PATH}`,
      `docker run --rm --network standalone-apps-network -v $(pwd):/app -w /app -e DATABASE_URL=postgresql://admin:dev_secure_2026@shared-postgres:5432/docsnx_db?schema=public node:22-slim bash -c 'npm install drizzle-kit drizzle-orm pg dotenv && node scripts/manual-migration.js && npx drizzle-kit push --force'`,
      // Rebuild and restart the containers in background
      `docker compose up --build -d`
    ].join(' ; ');

    runRemote(remoteCmds);

    console.log('=== Deployment completed successfully! ===');
    console.log(`Access the application at: http://${VM_IP}:3005`);
  } catch (error) {
    console.error('Deployment failed:', error);
  } finally {
    // Clean up local ZIP
    if (fs.existsSync(zipName)) {
      fs.unlinkSync(zipName);
      console.log('Cleaned up local ZIP.');
    }
  }
}

deploy();
