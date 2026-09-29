import { db } from "../src/lib/db";
import { subscriptionPlans, addons } from "../src/db/schema";

async function main() {
  console.log("Seeding base plans...");
  try {
    await db.insert(subscriptionPlans).values([
      { name: "Yearly Plan", code: "YEARLY_BASE", price: "2500.00", durationDays: 365 },
      { name: "Lifetime Plan", code: "LIFETIME_BASE", price: "11000.00", durationDays: 36500 },
    ]).onConflictDoNothing({ target: subscriptionPlans.code });
    console.log("Base plans seeded successfully.");
  } catch (err) {
    console.log("Could not seed plans (might already exist):", err.message);
  }

  console.log("Seeding AI Add-on...");
  try {
    await db.insert(addons).values([
      { name: "AI Features", code: "AI_ADDON", price: "6000.00", billingCycle: "YEARLY", description: "Unlock Gemini/OpenAI powered analysis and smart search." }
    ]).onConflictDoNothing({ target: addons.code });
    console.log("AI Add-on seeded successfully.");
  } catch (err) {
    console.log("Could not seed addons (might already exist):", err.message);
  }

  process.exit(0);
}

main().catch(console.error);
