import { db } from './src/lib/db.js';

async function test() {
  try {
    const email = 'tenant@hsk.com';
    const user = await db.query.users.findFirst({
      where: (users, { eq }) => eq(users.email, email.trim().toLowerCase()),
    });
    console.log('User found:', user ? 'Yes' : 'No');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}
test();
