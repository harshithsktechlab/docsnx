const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/app/api/payments/verify/route.ts');
let code = fs.readFileSync(filePath, 'utf8');

// 1. Add imports
code = code.replace(
  /import { payments, tenants, auditLogs } from '@\/db\/schema';/,
  `import { payments, tenants, auditLogs, tenantAddons, subscriptionPlans, addons } from '@/db/schema';`
);

if (!code.includes('generateAndUploadInvoice')) {
  code = code.replace(
    /import { eq, and } from 'drizzle-orm';/,
    `import { eq, and } from 'drizzle-orm';\nimport { generateAndUploadInvoice } from '@/lib/invoiceGenerator';`
  );
}

// 2. Load payment with addon as well
code = code.replace(
  /with: { plan: true },/,
  `with: { plan: true, addon: true },`
);

// 3. Fix the transaction block to handle addons vs plans correctly
const oldTxBlock = `    await db.transaction(async (tx) => {
      await tx.update(payments)
        .set({
          razorpayPaymentId: razorpay_payment_id,
          razorpaySignature: razorpay_signature,
          status: 'captured',
        })
        .where(eq(payments.id, payment.id));

      await tx.update(tenants)
        .set({
          subscriptionPlan: payment.plan?.code || 'PRO',
          subscriptionExpiry,
          aiCreditsBalance: currentBalance + creditsToAdd,
        })
        .where(eq(tenants.id, payment.tenantId));

      await tx.insert(auditLogs).values({
        tenantId: payment.tenantId,
        userId: user.id,
        action: 'PAYMENT_VERIFIED',
        details: \`Payment verified for plan '\${payment.plan?.name || 'Unknown'}'. Order: \${razorpay_order_id}, Amount: ₹\${Number(payment.amount)}.\`,
      });
    });`;

const newTxBlock = `    await db.transaction(async (tx) => {
      await tx.update(payments)
        .set({
          razorpayPaymentId: razorpay_payment_id,
          razorpaySignature: razorpay_signature,
          status: 'captured',
        })
        .where(eq(payments.id, payment.id));

      if (payment.planId && payment.plan) {
        await tx.update(tenants)
          .set({
            subscriptionPlan: payment.plan.code,
            subscriptionExpiry,
            aiCreditsBalance: currentBalance + creditsToAdd,
          })
          .where(eq(tenants.id, payment.tenantId));

        await tx.insert(auditLogs).values({
          tenantId: payment.tenantId,
          userId: user.id,
          action: 'PAYMENT_VERIFIED',
          details: \`Payment verified for plan '\${payment.plan.name}'. Order: \${razorpay_order_id}, Amount: ₹\${Number(payment.amount)}.\`,
        });
      } else if (payment.addonId && payment.addon) {
        await tx.insert(tenantAddons).values({
          tenantId: payment.tenantId,
          addonId: payment.addonId,
          assignedBy: user.id
        });

        await tx.insert(auditLogs).values({
          tenantId: payment.tenantId,
          userId: user.id,
          action: 'PAYMENT_VERIFIED',
          details: \`Payment verified for addon '\${payment.addon.name}'. Order: \${razorpay_order_id}, Amount: ₹\${Number(payment.amount)}.\`,
        });
      }
    });

    // Generate Invoice
    try {
      const invoiceUrl = await generateAndUploadInvoice(payment.id);
      if (invoiceUrl) {
        await db.update(payments).set({ invoiceUrl }).where(eq(payments.id, payment.id));
      }
    } catch (invErr) {
      console.error('Invoice generation failed:', invErr);
    }`;

code = code.replace(oldTxBlock, newTxBlock);

fs.writeFileSync(filePath, code);
console.log("Updated verify/route.ts");
