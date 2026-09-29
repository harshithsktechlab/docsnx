import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const result = await prisma.$queryRaw`
    SELECT relname, relrowsecurity 
    FROM pg_class 
    WHERE relnamespace = 'public'::regnamespace AND relkind = 'r';
  `;
  console.log("RLS Status for tables:");
  console.table(result);
  await prisma.$disconnect();
}

run().catch(console.error);
