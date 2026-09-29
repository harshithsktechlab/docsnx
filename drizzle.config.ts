import { config } from 'dotenv';
// Load .env.local first (this project's actual env file), then fall back to .env.
config({ path: '.env.local' });
config();
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
