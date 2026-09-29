import { config } from 'dotenv'; 
config(); 
import { db } from './src/lib/db'; 
import { subscriptionPlans } from './src/db/schema'; 
async function run() { 
  const p = await db.select().from(subscriptionPlans); 
  console.log(JSON.stringify(p, null, 2)); 
  process.exit(0); 
} 
run();
