import cron from "node-cron";
import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { runSync } from "@/lib/sync";
import { dripTick } from "@/lib/drip";
import { requeueStuckProcessing } from "@/lib/jobs";
import { pg } from "@/lib/db";

const log = createLogger("worker");

let syncing = false;
let dripping = false;

async function safeSync(trigger: string) {
  if (syncing) {
    log.warn("sync already running; skipping", { trigger });
    return;
  }
  syncing = true;
  try {
    log.info("sync tick start", { trigger });
    const res = await runSync();
    log.info("sync tick done", { trigger, ...res });
  } catch (err) {
    log.error("sync tick failed", err);
  } finally {
    syncing = false;
  }
}

async function safeDrip() {
  if (dripping) {
    log.warn("drip already running; skipping");
    return;
  }
  dripping = true;
  try {
    const res = await dripTick();
    log.info("drip tick done", res);
  } catch (err) {
    log.error("drip tick failed", err);
  } finally {
    dripping = false;
  }
}

async function main() {
  log.info("worker starting", {
    tz: env.TZ,
    personCap: env.DAILY_PERSON_ENRICH_CAP,
    companyCap: env.DAILY_COMPANY_ENRICH_CAP,
    window: [env.ENRICH_WINDOW_START_HOUR, env.ENRICH_WINDOW_END_HOUR],
  });

  // Clean up any jobs left mid-flight by a previous crash.
  try {
    await requeueStuckProcessing(0);
  } catch (err) {
    log.error("startup requeue failed", err);
  }

  // Sync every 6 hours.
  cron.schedule("0 */6 * * *", () => void safeSync("cron-6h"), { timezone: env.TZ });

  // Drip enricher every 15 minutes.
  cron.schedule("*/15 * * * *", () => void safeDrip(), { timezone: env.TZ });

  // Kick an initial sync shortly after boot so the first deploy has data,
  // then a drip tick once it's done.
  setTimeout(() => {
    void (async () => {
      await safeSync("startup");
      await safeDrip();
    })();
  }, 5_000);

  log.info("worker scheduled: sync every 6h, drip every 15m");
}

// Keep the process alive and shut down cleanly.
process.on("SIGTERM", async () => {
  log.info("SIGTERM received; shutting down");
  await pg.end({ timeout: 5 }).catch(() => {});
  process.exit(0);
});
process.on("SIGINT", async () => {
  log.info("SIGINT received; shutting down");
  await pg.end({ timeout: 5 }).catch(() => {});
  process.exit(0);
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection", reason instanceof Error ? reason : { reason });
});
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", err);
});

main().catch((err) => {
  log.error("worker main crashed", err);
  process.exit(1);
});
