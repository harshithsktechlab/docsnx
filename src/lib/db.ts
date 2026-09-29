import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../db/schema";
import { sql } from "drizzle-orm";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  max: process.env.DB_MAX_CONNECTIONS ? parseInt(process.env.DB_MAX_CONNECTIONS) : 20,
});

export const db = drizzle(pool, { schema });

/**
 * Wrapper for tenant-scoped database transactions.
 * Enforces Row-Level Security (RLS) by setting the 'app.tenant_id' session variable
 * at the start of the transaction.
 * 
 * @param tenantId The UUID of the tenant
 * @param callback The callback containing the database operations to run within the transaction
 * @returns The result of the callback
 */
export async function withTenant<T>(
  tenantId: string | undefined | null,
  callback: (tx: typeof db) => Promise<T>
): Promise<T> {
  if (!tenantId) {
    throw new Error("Tenant ID is required for tenant-scoped queries.");
  }
  
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    // Pass the transaction client to the callback so all queries run within it
    return await callback(tx as any);
  });
}

// Re-export the schema so that other files can easily import models like `users`
export * from "../db/schema";
