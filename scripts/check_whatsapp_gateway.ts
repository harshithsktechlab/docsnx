/**
 * READ-ONLY: why is the /admin/whatsapp "Sending Instance" dropdown empty?
 *
 * The picker calls fetchInstances (src/lib/whatsapp.ts), which deliberately
 * swallows every failure and returns [] — a dead engine must empty the dropdown,
 * not 500 the settings page. The cost of that is that four very different
 * problems look identical from the browser: nothing configured, a key this
 * server cannot decrypt, a key the engine rejects, and a URL that reaches
 * nothing. This script separates them.
 *
 *   npx tsx scripts/check_whatsapp_gateway.ts [instance-name]
 *
 * On the production host the secrets are TPM-sealed systemd credentials, so it
 * has to be run through systemd to get DATABASE_URL and ENCRYPTION_SECRET —
 * see scripts/loadEnv.ts for the incantation:
 *
 *   sudo systemd-run --pty --same-dir --wait --uid=azureuser \
 *     --property=LoadCredentialEncrypted=DATABASE_URL:/etc/docsnx/credentials/DATABASE_URL.cred \
 *     --property=LoadCredentialEncrypted=ENCRYPTION_SECRET:/etc/docsnx/credentials/ENCRYPTION_SECRET.cred \
 *     npx tsx scripts/check_whatsapp_gateway.ts
 *
 * Prints the stored URL (not a secret, and already returned by GET
 * /api/admin/whatsapp) and the key's LENGTH and first four characters — enough
 * to tell two keys apart, never enough to use one.
 */
import './loadEnv';
import { db } from '../src/lib/db';
import { systemConfigs } from '../src/db/schema';
import { decrypt } from '../src/lib/encryption';
import { fetchInstancesDetailed } from '../src/lib/whatsapp';

/** The instance the dropdown is expected to offer. */
const WANTED = process.argv[2] || 'instance_918668654995';

/** Same 10s ceiling the real helper dials with. */
const TIMEOUT_MS = 10_000;

function fingerprint(key: string): string {
  return `${key.length} chars, starts "${key.slice(0, 4)}"`;
}

async function main() {
  // Everything reads this table with an UNORDERED findFirst — the route, the
  // helpers and this script alike. One row is the assumption; more than one and
  // "which config is live" stops being a question anyone can answer.
  const all = await db.select({ id: systemConfigs.id }).from(systemConfigs);
  if (all.length > 1) {
    console.log(`WARNING: ${all.length} rows in system_configs. findFirst picks one arbitrarily.`);
  }

  const config = await db.query.systemConfigs.findFirst();

  if (!config) {
    console.log('system_configs: NO ROW AT ALL.');
    console.log('  -> The gateway has never been saved. Save SMTP settings first, then WhatsApp.');
    process.exit(0);
  }

  console.log('system_configs:');
  console.log(`  whatsappEnabled  = ${config.whatsappEnabled}`);
  console.log(`  whatsappApiUrl   = ${config.whatsappApiUrl || '(empty)'}`);
  console.log(`  whatsappInstance = ${config.whatsappInstance || '(none selected)'}`);
  console.log(`  whatsappApiKey   = ${config.whatsappApiKey ? 'present (ciphertext stored)' : 'ABSENT'}`);

  // The verdict the admin route will actually give, from the same helper it
  // calls — so this script and the page can never disagree about the cause.
  const verdict = await fetchInstancesDetailed();
  console.log(
    `\n/api/admin/whatsapp/instances would answer: reason="${verdict.reason}"` +
      `${verdict.status ? ` (HTTP ${verdict.status})` : ''}, ${verdict.instances.length} instance(s)`,
  );

  if (!config.whatsappApiUrl) {
    console.log('\n-> No API URL stored. getEvolutionConnection() returns null and the route');
    console.log('   reports configured:false. Fill in the Evolution API URL and save.');
    process.exit(0);
  }
  if (!config.whatsappApiKey) {
    console.log('\n-> No API key stored. Paste the global Evolution API key and save.');
    process.exit(0);
  }

  // The exact branch readApiKey() takes in src/lib/whatsapp.ts.
  const key = decrypt(config.whatsappApiKey);
  if (!key) {
    console.log('\ndecrypt: empty');
    console.log('-> Stored value decrypts to nothing. Paste the key again and save.');
    process.exit(0);
  }
  if (key === '[Decryption Failed]') {
    console.log('\ndecrypt: DECRYPTION_FAILED');
    console.log('-> A key IS stored, but this server\'s ENCRYPTION_SECRET cannot read it. The');
    console.log('   admin form still shows "Stored — leave blank to keep it", which is why this');
    console.log('   looks like a working config. Paste the Evolution API key again and save.');
    process.exit(0);
  }
  console.log(`\ndecrypt: ok (${fingerprint(key)})`);

  // Same normalisation the helper applies, so we probe the URL it would probe.
  const apiUrl = config.whatsappApiUrl.replace(/\/+$/, '');
  const target = `${apiUrl}/instance/fetchInstances`;
  console.log(`\nGET ${target}`);

  let response: Response;
  try {
    response = await fetch(target, {
      headers: { 'Content-Type': 'application/json', apikey: key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error: unknown) {
    console.log(`  UNREACHABLE: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`\n-> Nothing answered at ${apiUrl}. Check the scheme (http vs https), the host,`);
    console.log('   and that the stored URL carries no extra path segment.');
    process.exit(0);
  }

  console.log(`  status ${response.status}`);

  if (response.status === 401 || response.status === 403) {
    console.log('\n-> The engine rejected the key. fetchInstances answers the GLOBAL');
    console.log('   AUTHENTICATION_API_KEY with every instance; an instance-scoped token gets');
    console.log('   only its own instance, and a token matching none at all gets this 401.');
    console.log('   Paste the global Evolution API key and save.');
    process.exit(0);
  }
  if (!response.ok) {
    console.log(`\n-> HTTP ${response.status} from the engine, so fetchInstances returns [] and the`);
    console.log('   dropdown empties. Check the engine logs and the stored URL.');
    process.exit(0);
  }

  const body = await response.json();
  if (!Array.isArray(body)) {
    console.log(`  body is ${typeof body}, not an array: ${JSON.stringify(body).slice(0, 200)}`);
    console.log('\n-> fetchInstances requires an array and returns [] otherwise.');
    process.exit(0);
  }

  console.log(`  ${body.length} instance(s) returned\n`);
  for (const raw of body as any[]) {
    const name = String(raw?.name ?? raw?.instanceName ?? '');
    const status = String(raw?.connectionStatus ?? raw?.status ?? 'unknown');
    const number = raw?.number ? String(raw.number) : '-';
    const mark = name === WANTED ? '  <-- the one you are looking for' : '';
    console.log(`  ${name || '(UNNAMED — dropped by the name filter)'}  [${status}]  ${number}${mark}`);
  }

  const found = (body as any[]).some((raw) => String(raw?.name ?? raw?.instanceName ?? '') === WANTED);
  console.log(
    found
      ? `\n-> "${WANTED}" IS in the engine's reply for this key. If the dropdown is still empty,`
        + '\n   the browser is not reaching this route — check /api/admin/whatsapp/instances directly.'
      : `\n-> "${WANTED}" is NOT in the engine's reply for this key, though the call succeeded.`
        + '\n   That means this key is instance-scoped (it lists only its own instances) or the'
        + "\n   instance was created under a different DATABASE_CONNECTION_CLIENT_NAME.",
  );

  process.exit(0);
}

main();
