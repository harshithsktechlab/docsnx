import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const VM_IP = '20.244.47.54';
const VM_USER = 'azureuser';
const KEY_PATH = 'D:\\VM\\hsk-testing_key.pem';
const REMOTE_PATH = '/home/azureuser/docsnx';

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
    console.log('=== Starting Deployment to Azure VM (Docker Compose) ===');

    console.log('Creating ZIP archive...');
    if (fs.existsSync(zipName)) {
      fs.unlinkSync(zipName);
    }
    
    // Using Compress-Archive from powershell
    runLocal(`powershell -Command "Compress-Archive -Path src, public, drizzle, drizzle.config.ts, scripts, .env, .gitignore, AGENTS.md, AI_CONTEXT.md, CLAUDE.md, Dockerfile, README.md, deploy.mjs, docker-compose.yml, eslint.config.mjs, jsconfig.json, next.config.mjs, package.json, package-lock.json, postcss.config.js, tailwind.config.js, tsconfig.json -DestinationPath ${zipName} -Force"`);

    console.log('Uploading ZIP archive...');
    runLocal(`scp -i "${KEY_PATH}" -o StrictHostKeyChecking=no ${zipName} ${VM_USER}@${VM_IP}:/tmp/${zipName}`);

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
      // Make sure the standalone-apps-network exists
      `sudo docker network create standalone-apps-network || true`,
      `sudo docker run --rm --network standalone-apps-network -v $(pwd):/app -w /app -e DATABASE_URL=postgresql://admin:dev_secure_2026@shared-postgres:5432/docsnx_db?schema=public node:22-slim bash -c 'npm install drizzle-kit drizzle-orm pg dotenv && node scripts/manual-migration.js && npx drizzle-kit push --force'`,
      `sudo docker compose up --build -d`
    ].join(' ; ');

    runRemote(remoteCmds);

    console.log('=== Deployment completed successfully! ===');
    console.log(`Access the application at: http://${VM_IP}:3005`);
  } catch (error) {
    console.error('Deployment failed:', error);
  } finally {
    if (fs.existsSync(zipName)) {
      fs.unlinkSync(zipName);
      console.log('Cleaned up local ZIP.');
    }
  }
}

deploy();
