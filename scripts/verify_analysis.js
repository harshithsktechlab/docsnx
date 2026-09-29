const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("Locating mock tenant...");
  const tenant = await prisma.tenant.findUnique({
    where: { slug: 'mock-family' }
  });

  if (!tenant) {
    console.error("Mock tenant not found! Please run node scripts/mock_tenant_data.js first.");
    process.exit(1);
  }

  console.log(`Found tenant: ${tenant.name} (${tenant.id})`);

  // Dynamically import the generatePortfolioAnalysis ES module helper
  const { generatePortfolioAnalysis } = await import('../src/lib/ai.js');

  console.log("Querying database records...");
  const [
    medicalRecords,
    investments,
    licMediclaims,
    documents,
    vehicles,
    warrantyAmcs,
    contractAgreements
  ] = await Promise.all([
    prisma.medicalRecord.findMany({ where: { tenantId: tenant.id } }),
    prisma.investment.findMany({ where: { tenantId: tenant.id } }),
    prisma.licMediclaim.findMany({ where: { tenantId: tenant.id } }),
    prisma.document.findMany({ where: { tenantId: tenant.id } }),
    prisma.vehicle.findMany({ where: { tenantId: tenant.id } }),
    prisma.warrantyAmc.findMany({ where: { tenantId: tenant.id } }),
    prisma.contractAgreement.findMany({ where: { tenantId: tenant.id } }),
  ]);

  const portfolioData = {
    medicalRecords,
    investments,
    licMediclaims,
    documents,
    vehicles,
    warrantyAmcs,
    contractAgreements,
  };

  console.log("Executing generatePortfolioAnalysis...");
  const result = await generatePortfolioAnalysis(portfolioData, tenant.id);

  console.log("\n--- ANALYSIS RESULT ---");
  console.log(JSON.stringify(result, null, 2));
  console.log("------------------------\n");

  // Assertions
  let errors = [];

  // Check health insurance gap
  const healthInsuranceGap = result.gaps.find(g => g.title.includes("Health Insurance"));
  if (healthInsuranceGap) {
    console.log("✅ Missing Health Insurance Gap detected.");
  } else {
    errors.push("❌ Missing Health Insurance Gap NOT detected.");
  }

  // Check low life insurance sum assured gap
  const lowLifeGap = result.gaps.find(g => g.title.includes("Low Life Insurance"));
  if (lowLifeGap) {
    console.log("✅ Low Life Insurance Coverage Gap detected.");
  } else {
    errors.push("❌ Low Life Insurance Coverage Gap NOT detected.");
  }

  // Check missing core documents gap
  const missingDocsGap = result.gaps.find(g => g.title.includes("Core Identity Documents"));
  if (missingDocsGap) {
    console.log("✅ Missing Core Identity Documents Gap detected.");
  } else {
    errors.push("❌ Missing Core Identity Documents Gap NOT detected.");
  }

  // Check bad shares investment (Speculative Tech Stock)
  const speculativeStock = result.investments.find(i => i.title.includes("Speculative Tech Stock"));
  if (speculativeStock && speculativeStock.issue.includes("Erosion") && speculativeStock.impact.includes("85%")) {
    console.log("✅ Bad investment (Speculative Tech Stock) correctly flagged with 85% capital erosion.");
  } else {
    errors.push("❌ Speculative Tech Stock issue/impact incorrect or missing.");
  }

  // Check stagnant mutual fund
  const stagnantMF = result.investments.find(i => i.title.includes("Stagnant Sector Fund"));
  if (stagnantMF && stagnantMF.issue.includes("Stagnant")) {
    console.log("✅ Stagnant investment (Stagnant Sector Fund) correctly flagged.");
  } else {
    errors.push("❌ Stagnant Sector Fund issue incorrect or missing.");
  }

  // Check vehicle insurance and PUC expiry
  const civicInsurance = result.expiry.find(e => e.item.includes("Honda Civic") && e.item.includes("Insurance"));
  if (civicInsurance && civicInsurance.actionRequired.includes("Expired")) {
    console.log("✅ Expired Honda Civic Insurance correctly flagged.");
  } else {
    errors.push("❌ Expired Honda Civic Insurance missing or incorrect.");
  }

  const civicPUC = result.expiry.find(e => e.item.includes("Honda Civic") && e.item.includes("PUC"));
  if (civicPUC && civicPUC.actionRequired.includes("Expired")) {
    console.log("✅ Expired Honda Civic PUC correctly flagged.");
  } else {
    errors.push("❌ Expired Honda Civic PUC missing or incorrect.");
  }

  if (errors.length > 0) {
    console.error("\n❌ Verification Failed!");
    errors.forEach(e => console.error(e));
    process.exit(1);
  } else {
    console.log("\n🎉 Verification Succeeded! All checks passed successfully.");
  }
}

main()
  .catch(err => {
    console.error("Verification error:", err);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
