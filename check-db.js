const { Client } = require('pg');
const client = new Client({ connectionString: 'postgresql://admin:dev_secure_2026@127.0.0.1:5432/docsnx_db?schema=public' });
client.connect().then(() => {
  return client.query(`
    SELECT conname, contype 
    FROM pg_constraint 
    WHERE conrelid = 'subscription_plans'::regclass;
  `);
}).then(res => {
  console.log("Constraints:", res.rows);
  client.end();
}).catch(e => {
  console.log('ERROR:', e);
  client.end();
});
