/**
 * READ-ONLY: validate every registered FCM token with a DRY-RUN send.
 * dryRun=true makes FCM validate the message + token without delivering it,
 * so no device receives anything and no rows are changed.
 *
 *   node scripts/check_push_dryrun.mjs
 */
import { config } from 'dotenv';
import pg from 'pg';
import { initializeApp, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

config({ path: '.env' + '.local' });
config();

initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows } = await client.query(
  `SELECT d.fcm_token, d.created_at, u.email
     FROM user_devices d JOIN users u ON u.id = d.user_id ORDER BY d.created_at`,
);
await client.end();

const res = await getMessaging().sendEach(
  rows.map((r) => ({ token: r.fcm_token, notification: { title: 't', body: 'b' } })),
  true,
);
res.responses.forEach((r, i) => {
  const e = rows[i].email.replace(/^(.).*(@.*)$/, '$1***$2');
  console.log(e, rows[i].created_at.toISOString(), r.success ? 'OK' : `${r.error.code}: ${r.error.message}`);
});
