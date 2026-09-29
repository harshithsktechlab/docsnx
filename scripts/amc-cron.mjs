import 'dotenv/config';
import cron from 'node-cron';
import { db } from '../src/lib/db.js'; // Ensure this can run in node directly, might need a specific db instance for the script or tsx
import { tenants, subscriptionPlans, invoices } from '../src/db/schema.js';
import { eq, and, isNull, sql, lte } from 'drizzle-orm';
import { randomUUID } from 'crypto';

// We run this every day at 00:00 (Midnight)
cron.schedule('0 0 * * *', async () => {
  console.log('Running AMC Cron Job...', new Date().toISOString());
  try {
    // Find all active tenants on a Lifetime plan whose amcNextDueDate is within the next 14 days
    // In Drizzle, we can query tenants joined with subscriptionPlans
    const targetTenants = await db
      .select({
        tenant: tenants,
        plan: subscriptionPlans
      })
      .from(tenants)
      .innerJoin(subscriptionPlans, eq(tenants.subscriptionPlan, subscriptionPlans.code))
      .where(
        and(
          eq(tenants.isActive, true),
          eq(subscriptionPlans.isLifetime, true),
          // We look for amcNextDueDate <= NOW() + 14 days
          // Or if amcNextDueDate is somehow null, maybe they just got added? (Initialization should handle it, but just in case)
          lte(tenants.amcNextDueDate, sql`NOW() + INTERVAL '14 days'`)
        )
      );

    for (const { tenant, plan } from targetTenants) {
      if (Number(plan.amcAmount) <= 0) continue; // No AMC required

      // Check if an AMC invoice already exists for this tenant that is pending
      const existingPending = await db.query.invoices.findFirst({
        where: (inv, { eq, and }) => and(
          eq(inv.tenantId, tenant.id),
          eq(inv.invoiceType, 'amc'),
          eq(inv.status, 'pending')
        )
      });

      if (existingPending) {
        // Already invoiced for this cycle
        continue;
      }

      // Generate new invoice
      const invoiceNum = `AMC-${tenant.id.substring(0, 8).toUpperCase()}-${Date.now()}`;
      
      // Calculate due date (it should ideally be exactly the amcNextDueDate, but if it's already past, make it today + 14 days)
      const dueDate = new Date(tenant.amcNextDueDate);
      if (dueDate < new Date()) {
         dueDate.setDate(new Date().getDate() + 14); 
      }

      await db.insert(invoices).values({
        tenantId: tenant.id,
        invoiceNumber: invoiceNum,
        invoiceType: 'amc',
        clientName: tenant.billingName || tenant.name,
        amount: plan.amcAmount,
        currency: 'INR',
        status: 'pending',
        dueDate: dueDate,
        items: [{
          description: `Annual Maintenance Charge (AMC) for ${plan.name} Plan`,
          quantity: 1,
          price: plan.amcAmount
        }]
      });

      console.log(`Generated AMC Invoice ${invoiceNum} for Tenant ${tenant.name}`);
    }

    console.log('AMC Cron Job finished successfully.');
  } catch (err) {
    console.error('Error running AMC Cron Job:', err);
  }
});

console.log('AMC Cron Service started. Waiting for schedule...');
