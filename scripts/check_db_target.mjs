/**
 * READ-ONLY: which database does this deployment actually talk to?
 *
 * Prints the host/port/database/user from DATABASE_URL and, if the connection
 * succeeds, what the server says about itself. The password is NEVER printed —
 * only whether one is present.
 *
 *   node scripts/check_db_target.mjs
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env' + '.local' });
config();

const raw = process.env.DATABASE_URL;
if (!raw) {
  console.log('DATABASE_URL is NOT set');
  process.exit(1);
}

const u = new URL(raw);
console.log('--- DATABASE_URL target (password withheld) ---');
console.log('protocol :', u.protocol);
console.log('host     :', u.hostname);
console.log('port     :', u.port || '(default 5432)');
console.log('database :', u.pathname.replace(/^\//, ''));
console.log('user     :', u.username);
console.log('password :', u.password ? '(present, not shown)' : '(none)');

const client = new pg.Client({ connectionString: raw, connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  const { rows } = await client.query(
    `SELECT current_database() AS db,
            inet_server_addr()::text AS server_addr,
            current_user AS usr,
            version() AS ver`,
  );
  console.log('--- connected ---');
  console.log(rows[0]);
  await client.end();
} catch (err) {
  console.log('--- connection FAILED ---');
  console.log(err.message);
  process.exit(2);
}
