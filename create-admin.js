
const { Client } = require('pg');
const crypto = require('crypto');

const client = new Client({
  connectionString: 'postgresql://admin:dev_secure_2026@localhost:5432/docsnx_db?schema=public' // wait, on VM, it's connected via docker. I can run it inside the docsnx-app container.
});
