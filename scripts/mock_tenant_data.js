const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding mock tenant data...");

  // 1. Clean up existing mock data to ensure clean state
  const existingTenant = await prisma.tenant.findUnique({
    where: { slug: 'mock-family' }
  });
  if (existingTenant) {
    console.log("Deleting existing mock tenant data...");
    await prisma.tenant.delete({
      where: { id: existingTenant.id }
    });
  }

  // 2. Create Tenant
  const tenant = await prisma.tenant.create({
    data: {
      name: "Mock Family",
      slug: "mock-family",
      subscriptionPlan: "FREE",
      isActive: true,
    }
  });

  // 3. Hash Password
  const passwordHash = await bcrypt.hash("dev_secure_2026", 10);

  // 4. Create User (TENANT_ADMIN)
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      name: "John Doe",
      email: "john@example.com",
      passwordHash: passwordHash,
      role: "TENANT_ADMIN",
      requiresPasswordChange: false,
    }
  });

  // 5. Create LIC Policy (policyType = "lic", sumAssured = 10000, companyName = "LIC of India")
  // Note: policyType = "mediclaim" is intentionally omitted to simulate a health insurance gap.
  const licPolicy = await prisma.licMediclaim.create({
    data: {
      tenantId: tenant.id,
      userId: user.id,
      policyType: "lic",
      companyName: "LIC of India",
      policyName: "Jeevan Anand",
      policyNumber: "LIC987654321",
      insuredPerson: "John Doe",
      sumAssured: 10000.00,
      premiumAmount: 1200.00,
      premiumDueDate: new Date("2026-12-01T00:00:00Z"),
      expiryDate: new Date("2036-12-01T00:00:00Z"),
    }
  });

  // 6. Create Investment with high losses: category = "shares", purchaseValue = 100000, currentValue = 15000
  const badInvestment = await prisma.investment.create({
    data: {
      tenantId: tenant.id,
      userId: user.id,
      category: "shares",
      title: "Speculative Tech Stock",
      purchaseDate: new Date("2024-01-15T00:00:00Z"),
      purchaseValue: 100000.00,
      currentValue: 15000.00,
    }
  });

  // 7. Create Investment in mutual funds: category = "mutual_funds", purchaseValue = 50000, currentValue = 50000
  const stagnantInvestment = await prisma.investment.create({
    data: {
      tenantId: tenant.id,
      userId: user.id,
      category: "mutual_funds",
      title: "Stagnant Sector Fund",
      purchaseDate: new Date("2023-05-10T00:00:00Z"),
      purchaseValue: 50000.00,
      currentValue: 50000.00,
    }
  });

  // 8. Create Expired Vehicle Record
  // insuranceExpiry and pucExpiry are expired relative to current date (2026-07-04).
  // fitnessExpiry is not expired.
  const expiredVehicle = await prisma.vehicle.create({
    data: {
      tenantId: tenant.id,
      userId: user.id,
      vehicleName: "Honda Civic",
      vehicleNumber: "MH12AB1234",
      ownerName: "John Doe",
      registrationDate: new Date("2018-04-10T00:00:00Z"),
      insuranceExpiry: new Date("2025-06-01T00:00:00Z"),
      pucExpiry: new Date("2025-12-01T00:00:00Z"),
      fitnessExpiry: new Date("2033-04-10T00:00:00Z"),
    }
  });

  // 9. Write Audit Log
  const auditLog = await prisma.auditLog.create({
    data: {
      tenantId: tenant.id,
      userId: user.id,
      action: "SEED_MOCK_DATA",
      details: "Seeded mock family portfolio data for AI analysis testing",
    }
  });

  console.log("Mock tenant data seeded successfully!");
  console.log("=================================");
  console.log("Seeded Tenant:");
  console.log(`- ID: ${tenant.id}`);
  console.log(`- Slug: ${tenant.slug}`);
  console.log(`- Plan: ${tenant.subscriptionPlan}`);
  console.log("Seeded User:");
  console.log(`- ID: ${user.id}`);
  console.log(`- Name: ${user.name}`);
  console.log(`- Email: ${user.email}`);
  console.log(`- Role: ${user.role}`);
  console.log("Seeded Records:");
  console.log(`- LIC Policy: ID=${licPolicy.id}, Sum Assured=${licPolicy.sumAssured}`);
  console.log(`- High Loss Investment: ID=${badInvestment.id}, Purchase=${badInvestment.purchaseValue}, Current=${badInvestment.currentValue}`);
  console.log(`- Stagnant MF Investment: ID=${stagnantInvestment.id}, Purchase=${stagnantInvestment.purchaseValue}, Current=${stagnantInvestment.currentValue}`);
  console.log(`- Expired Vehicle: ID=${expiredVehicle.id}, Name=${expiredVehicle.vehicleName}, Insurance Expiry=${expiredVehicle.insuranceExpiry.toISOString()}, PUC Expiry=${expiredVehicle.pucExpiry.toISOString()}, Fitness Expiry=${expiredVehicle.fitnessExpiry.toISOString()}`);
  console.log(`- Audit Log Created: ID=${auditLog.id}`);
}

main()
  .catch((e) => {
    console.error("Error seeding data:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
