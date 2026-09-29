import "dotenv/config";
import { db } from "./lib/db";
import { investments } from "./db/schema";

import { sql } from "drizzle-orm";

async function main() {
  const result = await db.execute(sql`SELECT * FROM investments`);
  console.log(JSON.stringify(result.rows, null, 2));
  process.exit(0);
}
main();
