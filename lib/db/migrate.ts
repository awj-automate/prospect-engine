import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Runtime migrator, invoked by `npm run migrate` before `next start` on the web
 * service. Applies everything in ./drizzle. Uses a dedicated single-connection
 * pool with `max: 1` so migration DDL runs serially, then exits.
 *
 * Reads DATABASE_URL straight from process.env (Railway injects it) rather than
 * through lib/env's full validation, so migrations can run even if an unrelated
 * app var is briefly missing.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[migrate] DATABASE_URL is not set");
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  const dbm = drizzle(sql);

  try {
    console.log("[migrate] applying migrations from ./drizzle …");
    await migrate(dbm, { migrationsFolder: "./drizzle" });
    console.log("[migrate] done.");
  } catch (err) {
    console.error("[migrate] failed:", err);
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(1);
  }

  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(0);
}

main();
