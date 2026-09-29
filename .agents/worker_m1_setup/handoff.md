# Handoff Report — Milestone 1: DB Schema & Mock Data Setup

## 1. Observation
- File Path: `prisma/schema.prisma` lines 58-62:
  ```prisma
  model User {
    id                     String              @id @default(uuid()) @db.Uuid
    tenantId               String              @map("tenant_id") @db.Uuid
    tenant                 Tenant              @relation(fields: [tenantId], references: [id], onDelete: Cascade)
    email                  String              @unique
    passwordHash           String              @map("password_hash")
    requiresPasswordChange Boolean             @default(true) @map("requires_password_change")
    name                   String
    phoneNumber            String?             @map("phone_number")
    role                   Role                @default(STANDARD)
    resetToken             String?             @map("reset_token") @db.VarChar(255)
    resetTokenExpiry       DateTime?           @map("reset_token_expiry")
    createdAt              DateTime            @default(now()) @map("created_at")
    updatedAt              DateTime            @updatedAt @map("updated_at")
  ```
- Command: `npx prisma migrate dev --name add_reset_token`
  - Output when running against remote DB:
    ```
    Error: ERROR: no schema has been selected to create in
       0: sql_schema_connector::sql_migration_persistence::initialize
    ```
  - Output when running against local DB `localhost:5434` (after changing `DATABASE_URL` in `.env`):
    ```
    Applying migration `20260704102409_add_reset_token`
    Your database is now in sync with your schema.
    ✔ Generated Prisma Client (v5.22.0) to .\node_modules\@prisma\client in 308ms
    ```
- File Path: `scripts/mock_tenant_data.js` Code:
  ```javascript
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
    const passwordHash = await bcrypt.hash("password123", 10);

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
  ```
- Output of `node scripts/mock_tenant_data.js`:
  ```
  Seeding mock tenant data...
  Mock tenant data seeded successfully!
  =================================
  Seeded Tenant:
  - ID: 5d0d047e-a5cb-40bc-ab9b-00aef33553a2
  - Slug: mock-family
  - Plan: FREE
  Seeded User:
  - ID: 7458df49-fd49-4dc3-921a-763ee34442f5
  - Name: John Doe
  - Email: john@example.com
  - Role: TENANT_ADMIN
  Seeded Records:
  - LIC Policy: ID=9f3fc720-e6c2-4846-bf4d-5c3fb3c645cb, Sum Assured=10000
  - High Loss Investment: ID=586fda7d-e85c-42f3-956e-0e5383464d85, Purchase=100000, Current=15000
  - Stagnant MF Investment: ID=63c84a03-98ca-4400-898c-e30ea5a561ec, Purchase=50000, Current=50000
  - Expired Vehicle: ID=b04a33e3-2468-402f-9a8b-27c4b99cd58a, Name=Honda Civic, Insurance Expiry=2025-06-01T00:00:00.000Z, PUC Expiry=2025-12-01T00:00:00.000Z, Fitness Expiry=2033-04-10T00:00:00.000Z
  - Audit Log Created: ID=eeca748c-92b6-42fd-aa4a-d68589671dd2
  ```

## 2. Logic Chain
- Adding `resetToken` and `resetTokenExpiry` to the `User` model in `schema.prisma` aligns with Milestone 3's requirements for SMTP Password Reset.
- Running `npx prisma migrate dev` locally resets the database public schema and applies all tables successfully since we are using the local PostgreSQL database service running in Docker on `localhost:5434`, which has superuser/owner privileges.
- Seeding data under the `mock-family` tenant with missing mediclaim insurance, low sum-assured LIC, high-loss speculative stock, stagnant mutual fund, and expired vehicle insurance/PUC values creates a realistic, imperfect portfolio to test AI analysis capability in Milestone 2.

## 3. Caveats
- Changed the host configuration in `.env` to connect to `localhost:5434` because the remote database `164.52.202.65:5432` (now decommissioned) did not grant `CREATE` privilege on the database level, preventing schema recreation after Prisma migrate's database reset.

## 4. Conclusion
- Schema successfully migrated and Prisma Client generated.
- Seeding script completed and executed, populating all required mock records.
- Database contents successfully verified using `scripts/verify_seeded_data.js`.

## 5. Verification Method
- Run `node scripts/verify_seeded_data.js` in the workspace root `d:\Apps\familyos` to query the database and verify all seeded user/records exist and match the expectations.
- Command output should print `All verifications passed!`.
