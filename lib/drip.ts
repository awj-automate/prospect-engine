import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { enrichmentJobs } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";
import { enrichWindow } from "@/lib/time";
import {
  claimPendingJobs,
  requeueStuckProcessing,
} from "@/lib/jobs";
import { processJob } from "@/lib/enrich";
import { capFor, getRemainingToday, type CappedKind } from "@/lib/usage";
import { sleep } from "@/lib/utils";

const log = createLogger("drip");

/** Small random jitter between LinkedIn calls to look organic + spread load. */
function jitterMs(): number {
  return 500 + Math.floor(Math.random() * 2000); // 0.5–2.5s
}

/** Put claimed-but-unprocessed jobs back to pending. */
async function releaseJobs(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db
    .update(enrichmentJobs)
    .set({ status: "pending" })
    .where(inArray(enrichmentJobs.id, ids));
}

/**
 * Process pending jobs of a capped kind, paced so ~cap enrichments spread
 * EVENLY across [START_HOUR, END_HOUR]:
 *   expected_by_now = cap * elapsed_fraction_of_window
 * We process only enough highest-priority jobs to catch up to expected, never
 * exceeding the daily cap, never outside the window.
 */
async function processPacedKind(kind: CappedKind, elapsedFraction: number): Promise<number> {
  const cap = capFor(kind);
  const remaining = await getRemainingToday(kind);
  if (remaining <= 0) {
    log.info("paced kind at cap", { kind, cap });
    return 0;
  }
  const used = cap - remaining;
  const expected = cap * elapsedFraction;
  const toProcess = Math.min(remaining, Math.max(0, Math.ceil(expected - used)));
  if (toProcess <= 0) {
    log.info("paced kind on track; nothing to catch up", {
      kind,
      used,
      expected: Math.round(expected * 100) / 100,
    });
    return 0;
  }

  const jobs = await claimPendingJobs([kind], toProcess);
  if (jobs.length === 0) return 0;

  let processed = 0;
  for (let i = 0; i < jobs.length; i++) {
    // Re-check headroom in case manual jobs consumed quota concurrently.
    const headroom = await getRemainingToday(kind);
    if (headroom <= 0) {
      await releaseJobs(jobs.slice(i).map((j) => j.id));
      log.info("hit cap mid-tick; released remaining", { kind, released: jobs.length - i });
      break;
    }
    const outcome = await processJob(jobs[i]);
    if (outcome === "done") processed++;
    if (i < jobs.length - 1) await sleep(jitterMs());
  }

  log.info("paced kind processed", { kind, processed, attempted: jobs.length, used, expected: Math.round(expected) });
  return processed;
}

/** Process uncapped jobs (company_resolve) in a bounded batch. */
async function processUncapped(kind: "company_resolve", max: number): Promise<number> {
  const jobs = await claimPendingJobs([kind], max);
  let processed = 0;
  for (let i = 0; i < jobs.length; i++) {
    const outcome = await processJob(jobs[i]);
    if (outcome === "done") processed++;
    if (i < jobs.length - 1) await sleep(jitterMs());
  }
  if (jobs.length) log.info("uncapped processed", { kind, processed, attempted: jobs.length });
  return processed;
}

export interface DripResult {
  inWindow: boolean;
  companyResolve: number;
  person: number;
  company: number;
}

/**
 * One drip tick. Wrapped by the worker in try/catch; also self-guards each
 * stage so one failing stage never aborts the others.
 */
export async function dripTick(): Promise<DripResult> {
  const result: DripResult = { inWindow: false, companyResolve: 0, person: 0, company: 0 };

  try {
    await requeueStuckProcessing();
  } catch (err) {
    log.error("requeueStuckProcessing failed", err);
  }

  const win = enrichWindow();
  result.inWindow = win.inWindow;
  if (!win.inWindow) {
    log.info("outside enrichment window; idle", { hour: Math.round(win.hour * 100) / 100, start: win.start, end: win.end });
    return result;
  }

  // 1) advance the pipeline (name → slug); not rate-capped
  try {
    result.companyResolve = await processUncapped("company_resolve", 25);
  } catch (err) {
    log.error("company_resolve stage failed", err);
  }

  // 2) paced person enrichment
  try {
    result.person = await processPacedKind("person", win.elapsedFraction);
  } catch (err) {
    log.error("person stage failed", err);
  }

  // 3) paced company enrichment
  try {
    result.company = await processPacedKind("company", win.elapsedFraction);
  } catch (err) {
    log.error("company stage failed", err);
  }

  return result;
}

export { eq };
