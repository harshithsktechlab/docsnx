import db from '../src/lib/db.js';

async function checkDb() {
  try {
    const docs = await db.document.findMany();
    console.log('--- DOCUMENTS IN DB ---');
    console.log(JSON.stringify(docs, null, 2));
    
    const logs = await db.auditLog.findMany();
    console.log('--- AUDIT LOGS IN DB ---');
    console.log(JSON.stringify(logs, null, 2));
  } catch (error) {
    console.error('Error querying DB:', error);
  } finally {
    await db.$disconnect();
  }
}

checkDb();
