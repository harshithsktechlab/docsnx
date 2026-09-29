const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/db/schema.ts');
let code = fs.readFileSync(filePath, 'utf8');

// 1. Update systemConfigs
code = code.replace(
  /export const systemConfigs = pgTable\("system_configs", {/,
  `export const systemConfigs = pgTable("system_configs", {
  platformName: varchar("platform_name", { length: 255 }),
  platformGstin: varchar("platform_gstin", { length: 50 }),
  platformAddress: text("platform_address"),`
);

// 2. Update tenants
code = code.replace(
  /export const tenants = pgTable\("tenants", {/,
  `export const tenants = pgTable("tenants", {
  billingName: varchar("billing_name", { length: 255 }),
  billingGst: varchar("billing_gst", { length: 50 }),
  billingAddress: text("billing_address"),`
);

// 3. Update payments
code = code.replace(
  /planId: uuid\("plan_id"\)\.references\(\(\) => subscriptionPlans\.id, { onDelete: 'set null' }\),/,
  `planId: uuid("plan_id").references(() => subscriptionPlans.id, { onDelete: 'set null' }),
  addonId: uuid("addon_id").references(() => addons.id, { onDelete: 'set null' }),
  invoiceUrl: text("invoice_url"),`
);

// 4. Update paymentsRelations to include addon
code = code.replace(
  /export const paymentsRelations = relations\(payments, \(\{ one \}\) => \(\{\n  plan: one\(subscriptionPlans, \{ fields: \[payments\.planId\], references: \[subscriptionPlans\.id\] \}\),\n\}\)\);/,
  `export const paymentsRelations = relations(payments, ({ one }) => ({
  plan: one(subscriptionPlans, { fields: [payments.planId], references: [subscriptionPlans.id] }),
  addon: one(addons, { fields: [payments.addonId], references: [addons.id] }),
}));`
);


fs.writeFileSync(filePath, code);
console.log("Updated schema.ts");
