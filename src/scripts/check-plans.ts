import { config } from 'dotenv';
config({ path: '.env' });
import { db } from '../db';
import { tenants, subscriptionPlans } from '../db/schema';
import { eq } from 'drizzle-orm';

async function main() {
  const allTenants = await db.select({ id: tenants.id, name: tenants.name, subscriptionPlanId: tenants.subscriptionPlanId }).from(tenants);
  console.log("Tenants:", allTenants);
  
  const allPlans = await db.select().from(subscriptionPlans);
  console.log("Plans:", allPlans);
}

main().catch(console.error).then(() => process.exit(0));
