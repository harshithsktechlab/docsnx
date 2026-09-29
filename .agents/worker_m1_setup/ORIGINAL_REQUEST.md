## 2026-07-04T15:49:18Z
Your task is to modify the database schema and write a setup script to seed mock data.

Please complete the following steps:
1. Open and inspect `prisma/schema.prisma`.
2. Add the following fields to the `User` model:
   - `resetToken String? @map("reset_token") @db.VarChar(255)`
   - `resetTokenExpiry DateTime? @map("reset_token_expiry")`
3. Run the database migration to apply this change to the database:
   `npx prisma migrate dev --name add_reset_token`
   (Make sure the migration executes successfully and generates the client).
4. Create a new Node.js script at `scripts/mock_tenant_data.js` using CommonJS (`require`). In this script, use Prisma Client to seed a mock tenant, a tenant admin user, and specific record data designed to test AI analysis gaps:
   - A tenant: name="Mock Family", slug="mock-family" (or similar), subscriptionPlan="FREE".
   - A user in the tenant: name="John Doe", email="john@example.com", password_hash="encrypted_hash_here", role="TENANT_ADMIN".
   - Under this tenant, create records with intentional portfolio gaps, bad investments, and expired policies:
     - DO NOT create any health insurance policies (LicMediclaim with policyType="mediclaim") to simulate a mediclaim gap. (Or create an expired one, but leaving it completely missing is ideal to verify gaps). You can create an LIC policy with low sum assured (e.g. policyType="lic", sumAssured=10000, companyName="LIC of India").
     - An investment with high losses: category="shares", title="Speculative Tech Stock", purchaseDate="2024-01-15T00:00:00Z", purchaseValue=100000.00, currentValue=15000.00.
     - An investment in mutual funds: category="mutual_funds", title="Stagnant Sector Fund", purchaseDate="2023-05-10T00:00:00Z", purchaseValue=50000.00, currentValue=50000.00.
     - An expired vehicle record: vehicleName="Honda Civic", vehicleNumber="MH12AB1234", ownerName="John Doe", registrationDate="2018-04-10T00:00:00Z", insuranceExpiry="2025-06-01T00:00:00Z" (expired relative to current date 2026-07-04), pucExpiry="2025-12-01T00:00:00Z" (expired), fitnessExpiry="2033-04-10T00:00:00Z" (not expired).
   - Ensure the script prints a success message with details of seeded tenant, user, and records.
5. Run the seeding script: `node scripts/mock_tenant_data.js` and verify it seeds successfully.
6. Verify the database tables and columns are as expected.
7. Write `handoff.md` in your working directory summarizing:
   - Modifications made to `schema.prisma`.
   - Migration command run and confirmation of success.
   - Code content of `scripts/mock_tenant_data.js`.
   - Output of running the mock seeding script.
   - Any database verification results.
8. Send a message to the orchestrator (conversation ID: c3816e33-ecf6-4d74-bfea-a81126a6bdb4) indicating you are done and providing the path to your handoff.md.
