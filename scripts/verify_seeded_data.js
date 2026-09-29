const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("Verifying seeded database data...");

  const tenant = await prisma.tenant.findUnique({
    where: { slug: 'mock-family' },
    include: {
      users: true,
      licMediclaims: true,
      investments: true,
      vehicles: true,
      auditLogs: true,
    }
  });

  if (!tenant) {
    console.error("Verification failed: Mock tenant not found!");
    process.exit(1);
  }

  console.log("Tenant found:", tenant.name, `(${tenant.id})`);
  console.log("Users count:", tenant.users.length);
  tenant.users.forEach(u => {
    console.log(`- User: ${u.name}, Email: ${u.email}, Role: ${u.role}, ResetToken: ${u.resetToken}, ResetTokenExpiry: ${u.resetTokenExpiry}`);
  });

  console.log("LIC/Mediclaim records count:", tenant.licMediclaims.length);
  tenant.licMediclaims.forEach(p => {
    console.log(`- Policy Type: ${p.policyType}, Company: ${p.companyName}, Sum Assured: ${p.sumAssured}`);
  });

  console.log("Investments count:", tenant.investments.length);
  tenant.investments.forEach(i => {
    console.log(`- Title: ${i.title}, Category: ${i.category}, Purchase Value: ${i.purchaseValue}, Current Value: ${i.currentValue}`);
  });

  console.log("Vehicles count:", tenant.vehicles.length);
  tenant.vehicles.forEach(v => {
    console.log(`- Name: ${v.vehicleName}, Number: ${v.vehicleNumber}, Insurance Expiry: ${v.insuranceExpiry.toISOString()}, PUC Expiry: ${v.pucExpiry.toISOString()}, Fitness Expiry: ${v.fitnessExpiry.toISOString()}`);
  });

  console.log("Audit Logs count:", tenant.auditLogs.length);
  tenant.auditLogs.forEach(log => {
    console.log(`- Action: ${log.action}, Details: ${log.details}`);
  });

  console.log("All verifications passed!");
}

main()
  .catch((e) => {
    console.error("Error verifying data:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
