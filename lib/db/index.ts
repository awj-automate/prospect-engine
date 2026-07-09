import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * Lazily-created postgres-js pool + drizzle instance, shared by the web server
 * and the worker. Against Neon's POOLED connection string, so we keep our own
 * pool small (PgBouncer sits in front). `prepare: false` is required for pooled
 * (transaction-mode) PgBouncer.
 *
 * Construction is deferred until first access so `next build` (which imports
 * route modules without env vars present) doesn't touch the connection string.
 */

declare global {
  // eslint-disable-next-line no-var
  var __pe_pg__: ReturnType<typeof postgres> | undefined;
}

let _client: ReturnType<typeof postgres> | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function getClient(): ReturnType<typeof postgres> {
  if (_client) return _client;
  _client =
    global.__pe_pg__ ??
    postgres(env.DATABASE_URL, {
      max: 5,
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 30,
    });
  if (process.env.NODE_ENV !== "production") global.__pe_pg__ = _client;
  return _client;
}

function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (!_db) _db = drizzle(getClient(), { schema });
  return _db;
}

// Proxies forward to the lazily-built instances, binding methods so `this`
// remains the real client/drizzle object.
function lazyProxy<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      const inst = resolve() as Record<string | symbol, unknown>;
      const value = inst[prop];
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(inst) : value;
    },
  });
}

export const db = lazyProxy(getDb);
export const pg = lazyProxy(getClient);
export { schema };
