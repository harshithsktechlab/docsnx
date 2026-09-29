import 'dotenv/config';
import { db } from '../src/lib/db';

async function check() {
  try {
    const userRes = await db.query.users.findFirst({
      where: (u, { eq }) => eq(u.email, 'archi@hsk.com'),
      with: { tenant: true }
    });
    console.log('USER & TENANT:', {
      email: userRes?.email,
      role: userRes?.role,
      tenantName: userRes?.tenant?.name,
      tenantId: userRes?.tenant?.id,
      aiCreditsBalance: userRes?.tenant?.aiCreditsBalance,
      subscriptionPlanId: userRes?.tenant?.subscriptionPlanId
    });

    const plans = await db.query.subscriptionPlans.findMany();
    console.log('PLANS:', plans.map(p => ({ id: p.id, name: p.name, price: p.price, aiCredits: p.aiCredits })));

    const addonsList = await db.query.addons.findMany();
    console.log('ADDONS:', addonsList.map(a => ({ id: a.id, name: a.name, price: a.price, aiCredits: a.aiCredits })));

    const keys = await db.query.apiKeys.findMany();
    console.log('API KEYS COUNT:', keys.length, keys.map(k => ({ provider: k.provider, isActive: k.isActive })));

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

check();
