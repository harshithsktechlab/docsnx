/**
 * Environment preload for standalone scripts. Import this FIRST, before any
 * module that reads process.env at load time (src/lib/db.ts builds its pg Pool
 * eagerly; encryption.ts and fieldCrypto.ts throw outright without their keys).
 *
 *   import './loadEnv';
 *   import { db } from '../src/lib/db';
 *
 * Why a module rather than a bare `config({ path: '.env.local' })` statement at
 * the top of the script: ES module imports are HOISTED, so every `import` in
 * the file is evaluated before the first statement runs. A plain call would fire
 * after `src/lib/db` had already constructed a Pool with an undefined
 * DATABASE_URL — which surfaces as the baffling
 * `SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string`.
 * Side effects of an *imported* module run in import order, so this works.
 *
 * `.env.local` is this project's env file; plain `dotenv/config` reads only
 * `.env`, which does not exist here.
 *
 * On the production host there is no `.env.local` at all: secrets are TPM-sealed
 * systemd credentials (see docsnx.service and scripts/seal-credentials.sh) and
 * arrive as one file per secret under $CREDENTIALS_DIRECTORY. Run such a script
 * through systemd so it does the decrypting, e.g.
 *
 *   sudo systemd-run --pty --same-dir --wait --uid=azureuser \
 *     --property=LoadCredentialEncrypted=DATABASE_URL:/etc/docsnx/credentials/DATABASE_URL.cred \
 *     --property=LoadCredentialEncrypted=ENCRYPTION_SECRET:/etc/docsnx/credentials/ENCRYPTION_SECRET.cred \
 *     npx tsx scripts/plan-expiry-cron.ts --dry-run
 *
 * `host+tpm2` sealing needs root, so the script cannot decrypt these itself.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';

// Credentials first, and only where absent: an explicitly exported shell value
// still wins, and dotenv below fills whatever neither supplied.
const credentialsDir = process.env.CREDENTIALS_DIRECTORY;
if (credentialsDir) {
  for (const name of readdirSync(credentialsDir)) {
    process.env[name] ??= readFileSync(join(credentialsDir, name), 'utf8');
  }
}

config({ path: '.env.local' });
config({ path: '.env.production' });
config();
