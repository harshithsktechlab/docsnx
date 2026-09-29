const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/app/api/payments/create-order/route.ts');
let code = fs.readFileSync(filePath, 'utf8');

// 1. Add import
if (!code.includes('generateAndUploadInvoice')) {
  code = code.replace(
    /import { eq } from 'drizzle-orm';/,
    `import { eq } from 'drizzle-orm';\nimport { generateAndUploadInvoice } from '@/lib/invoiceGenerator';\nimport { tenantAddons } from '@/db/schema';`
  );
}

// 2. Destructure isManualPayment
code = code.replace(
  /let { planId, addonId, tenantId, discountCode } = await req\.json\(\);/,
  `let { planId, addonId, tenantId, discountCode, isManualPayment } = await req.json();`
);

// 3. Prevent non-super-admins from using manual payment
code = code.replace(
  /if \(user\.role === 'TENANT_ADMIN' && user\.tenantId !== tenantId\) {/,
  `if (isManualPayment && user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Only Super Admins can manually record payments.' }, { status: 403 });
    }

    if (user.role === 'TENANT_ADMIN' && user.tenantId !== tenantId) {`
);

// 4. Handle amount <= 0 AND manual payments
// We need to replace the `if (amountInPaise <= 0)` block completely up to `const receipt`
const oldBlock = `    if (amountInPaise <= 0) {
      // Bypass payment for $0 plans
      if (planId) {
        const planResult = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, planId)).limit(1);
        const plan = planResult[0];
        
        // Add credits
        const currentTenantResult = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
        const currentBalance = currentTenantResult[0]?.aiCreditsBalance || 0;

        await db.update(tenants).set({
          subscriptionPlan: plan.code,
          subscriptionExpiry: plan.durationDays ? new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000) : null,
          aiCreditsBalance: currentBalance + (plan.aiCredits || 0)
        }).where(eq(tenants.id, tenantId));
        
        await db.insert(payments).values({
          tenantId,
          planId: planId,
          razorpayOrderId: \`free_\${Date.now()}\`,
          amount: '0',
          currency: 'INR',
          status: 'captured',
          initiatedBy: user.role,
        });

        return NextResponse.json({ success: true, bypassPayment: true });
      } else {
        return NextResponse.json({ error: 'Invalid order amount.' }, { status: 400 });
      }
    }`;

const newBlock = `    if (amountInPaise <= 0 || isManualPayment) {
      const orderIdPrefix = isManualPayment ? 'manual' : 'free';
      const pId = \`\${orderIdPrefix}_\${Date.now()}\`;

      // 1. Insert payment record first
      const paymentRet = await db.insert(payments).values({
        tenantId,
        planId: planId || null,
        addonId: addonId || null,
        razorpayOrderId: pId,
        amount: String(finalPrice),
        currency: 'INR',
        status: 'captured',
        initiatedBy: user.role,
      }).returning({ id: payments.id });

      const paymentId = paymentRet[0].id;

      // 2. Fulfill order
      if (planId) {
        const planResult = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, planId)).limit(1);
        const plan = planResult[0];
        
        const currentTenantResult = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
        const currentBalance = currentTenantResult[0]?.aiCreditsBalance || 0;

        await db.update(tenants).set({
          subscriptionPlan: plan.code,
          subscriptionExpiry: plan.durationDays ? new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000) : null,
          aiCreditsBalance: currentBalance + (plan.aiCredits || 0)
        }).where(eq(tenants.id, tenantId));
      } else if (addonId) {
        await db.insert(tenantAddons).values({
          tenantId,
          addonId,
          assignedBy: user.id
        });
      }

      // 3. Generate Invoice
      const invoiceUrl = await generateAndUploadInvoice(paymentId);
      if (invoiceUrl) {
        await db.update(payments).set({ invoiceUrl }).where(eq(payments.id, paymentId));
      }

      return NextResponse.json({ success: true, bypassPayment: true });
    }`;

code = code.replace(oldBlock, newBlock);

fs.writeFileSync(filePath, code);
console.log("Updated create-order/route.ts");
