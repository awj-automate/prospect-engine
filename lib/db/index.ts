import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * Single shared postgres-js pool + drizzle instance for both the web server and
 * the worker. Against Neon's POOLED connection string, so we keep our own pool
 * small (PgBouncer sits in front). `prepare: false` is required for pooled
 * (transaction-mode) PgBouncer.
 */

declare global {
  // eslint-disable-next-line no-var
  var __pe_pg__: ReturnType<typeof postgres> | undefined;
}

const client =
  global.__pe_pg__ ??
  postgres(env.DATABASE_URL, {
    max: 5,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 30,
  });

if (process.env.NODE_ENV !== "production") {
  global.__pe_pg__ = client;
}

export const db = drizzle(client, { schema });
export { schema };
export const pg = client;
