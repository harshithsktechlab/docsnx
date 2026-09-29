import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runLocal = (command) => {
  return new Promise((resolve, reject) => {
    console.log(`Running: ${command}`);
    try {
      execSync(command, { cwd: __dirname, stdio: 'inherit' });
      resolve();
    } catch (error) {
      console.error(`Error executing command`);
      reject(error);
    }
  });
};

const REMOTE_USER = 'azureuser';
const REMOTE_IP = '20.244.47.54';
const PEM_KEY = 'D:\\\\VM\\\\hsk-testing_key.pem';
const REMOTE_DIR = '/opt/apps/docsnx';
const TMP_ZIP = 'docsnx-native.tar.gz';

async function deploy() {
  try {
    console.log('1. Zipping local source code...');
    await runLocal(`tar.exe -czf ${TMP_ZIP} src public drizzle drizzle.config.ts scripts reset-db.ts package.json package-lock.json next.config.mjs tsconfig.json tailwind.config.js postcss.config.js eslint.config.mjs jsconfig.json AGENTS.md AI_CONTEXT.md CLAUDE.md`);

    console.log('2. Creating remote directory...');
    await runLocal(`ssh -i "${PEM_KEY}" -o StrictHostKeyChecking=no ${REMOTE_USER}@${REMOTE_IP} "sudo mkdir -p ${REMOTE_DIR} && sudo chown ${REMOTE_USER}:${REMOTE_USER} ${REMOTE_DIR}"`);

    console.log('3. Copying archive to VM...');
    await runLocal(`scp -i "${PEM_KEY}" -o StrictHostKeyChecking=no ${TMP_ZIP} ${REMOTE_USER}@${REMOTE_IP}:${REMOTE_DIR}/`);

    console.log('4. Extracting and building on VM...');
    await runLocal(`ssh -i "${PEM_KEY}" -o StrictHostKeyChecking=no ${REMOTE_USER}@${REMOTE_IP} "cd ${REMOTE_DIR} && sudo tar -xzf ${TMP_ZIP} && sudo chmod -R 777 . && sudo chown -R ${REMOTE_USER}:${REMOTE_USER} . && npm install && npm run build"`);

    console.log('5. Cleaning up local archive...');
    await runLocal(`powershell -Command "Remove-Item -Force ${TMP_ZIP}"`);

    console.log('\\nNative Build complete! Next: start with PM2.');
  } catch (err) {
    console.error('Deployment failed:', err);
  }
}

deploy();
