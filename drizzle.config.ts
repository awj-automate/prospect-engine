import { defineConfig } from "drizzle-kit";

// drizzle-kit reads DATABASE_URL directly (used for `db:generate` / `db:push`).
// The runtime migrator (lib/db/migrate.ts) does not depend on this file.
export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  strict: true,
  verbose: true,
});
