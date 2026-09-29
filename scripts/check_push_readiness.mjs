/**
 * READ-ONLY diagnostic: why are push notifications not arriving?
 *
 * Reports (names/booleans only, never secret values):
 *   - which Firebase env vars are present
 *   - RLS state of user_devices, and whether the APP role would see rows
 *   - how many devices are registered, per platform, and how recently
 *
 *   node scripts/check_push_readiness.mjs
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env' + '.local' });
config();

const names = [
  'FIREBASE_SERVICE_ACCOUNT',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'NEXT_PUBLIC_FIREBASE_API_KEY',
  'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  'NEXT_PUBLIC_FIREBASE_APP_ID',
  'NEXT_PUBLIC_NOTIFICATION_API_URL',
];
console.log('== env (present?)');
for (const n of names) console.log(`  ${n}: ${process.env[n] ? 'SET' : 'missing'}`);
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log(`  service account project_id: ${sa.project_id}`);
  } catch {
    console.log('  FIREBASE_SERVICE_ACCOUNT is NOT valid JSON');
  }
}
console.log(`  client project_id: ${process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? '(none)'}`);

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const who = await client.query(
  `SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`,
);
console.log('== connection role', who.rows[0]);

const rls = await client.query(
  `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'user_devices'`,
);
console.log('== user_devices RLS', rls.rows[0]);
const pol = await client.query(
  `SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE tablename = 'user_devices'`,
);
console.log('== policies', pol.rows);

const counts = await client.query(
  `SELECT platform, count(*)::int AS n, max(last_active_at) AS last_active, max(created_at) AS newest
     FROM user_devices GROUP BY platform`,
);
console.log('== devices (as this role)', counts.rows);

await client.end();
