/**
 * Which database would a migration hit? Prints the host, port, database and
 * user — never the password. Read-only; connects to nothing.
 *
 *   node scripts/print_db_target.mjs
 */
import { config } from 'dotenv';

config({ path: '.env' + '.local' });
config();

const url = process.env.DATABASE_URL || '';
try {
  const parsed = new URL(url);
  console.log(
    `host=${parsed.hostname} port=${parsed.port || 5432} ` +
    `db=${parsed.pathname.slice(1)} user=${parsed.username}`,
  );
} catch {
  console.log('DATABASE_URL missing or unparseable');
}
