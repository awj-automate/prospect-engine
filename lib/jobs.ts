import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { enrichmentJobs, leads } from "@/lib/db/schema";
import type { JobKind, EnrichmentJobRow } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";

const log = createLogger("jobs");

const MAX_ATTEMPTS = 4;

/**
 * Enqueue a job for (lead, kind). UNIQUE(lead_id, kind) guarantees a lead is
 * never double-queued for the same step. If a row already exists:
 *  - a 'done' row is left alone (idempotent) unless `force` re-queues it,
 *  - a 'failed'/'pending'/'processing' row is reset to pending and re-prioritized.
 */
export async function enqueueJob(opts: {
  leadId: string;
  kind: JobKind;
  priority: number;
  highPriority?: boolean;
  force?: boolean;
}): Promise<EnrichmentJobRow> {
  const { leadId, kind, priority, highPriority = false, force = false } = opts;
  // High-priority (manual) jobs jump the queue with a large priority boost.
  const effPriority = highPriority ? priority + 1000 : priority;

  const [row] = await db
    .insert(enrichmentJobs)
    .values({
      leadId,
      kind,
      status: "pending",
      priority: effPriority,
      attempts: 0,
      scheduledFor: new Date(),
    })
    .onConflictDoUpdate({
      target: [enrichmentJobs.leadId, enrichmentJobs.kind],
      set: force
        ? {
            status: "pending",
            priority: effPriority,
            attempts: 0,
            error: null,
            scheduledFor: new Date(),
            processedAt: null,
          }
        : {
            // Only revive non-done jobs; bump priority for done→(unchanged).
            status: sql`CASE WHEN ${enrichmentJobs.status} = 'done' THEN ${enrichmentJobs.status} ELSE 'pending' END`,
            priority: sql`GREATEST(${enrichmentJobs.priority}, ${effPriority})`,
            scheduledFor: sql`CASE WHEN ${enrichmentJobs.status} = 'done' THEN ${enrichmentJobs.scheduledFor} ELSE ${new Date()} END`,
          },
    })
    .returning();
  return row;
}

/** Claim up to `limit` highest-priority pending jobs of the given kinds. */
export async function claimPendingJobs(kinds: JobKind[], limit: number): Promise<EnrichmentJobRow[]> {
  if (limit <= 0) return [];
  const now = new Date();

  // Select candidates, then mark them processing. Not a hard row-lock (single
  // worker process), but we bump status immediately to avoid re-claiming.
  const candidates = await db
    .select()
    .from(enrichmentJobs)
    .where(
      and(
        eq(enrichmentJobs.status, "pending"),
        inArray(enrichmentJobs.kind, kinds),
        lte(enrichmentJobs.scheduledFor, now)
      )
    )
    .orderBy(desc(enrichmentJobs.priority), asc(enrichmentJobs.scheduledFor))
    .limit(limit);

  if (candidates.length === 0) return [];

  const ids = candidates.map((c) => c.id);
  await db
    .update(enrichmentJobs)
    .set({ status: "processing" })
    .where(inArray(enrichmentJobs.id, ids));

  return candidates.map((c) => ({ ...c, status: "processing" as const }));
}

export async function markDone(jobId: string): Promise<void> {
  await db
    .update(enrichmentJobs)
    .set({ status: "done", processedAt: new Date(), error: null })
    .where(eq(enrichmentJobs.id, jobId));
}

/**
 * Mark a job failed. If it still has retry budget, re-queue it as pending with
 * a short backoff instead of terminal failure.
 */
export async function markFailed(job: EnrichmentJobRow, error: string): Promise<void> {
  const attempts = (job.attempts ?? 0) + 1;
  if (attempts < MAX_ATTEMPTS) {
    const backoffMs = Math.min(2 ** attempts * 60_000, 30 * 60_000);
    await db
      .update(enrichmentJobs)
      .set({
        status: "pending",
        attempts,
        error,
        scheduledFor: new Date(Date.now() + backoffMs),
      })
      .where(eq(enrichmentJobs.id, job.id));
    log.warn("job re-queued after failure", { jobId: job.id, kind: job.kind, attempts, error });
  } else {
    await db
      .update(enrichmentJobs)
      .set({ status: "failed", attempts, error, processedAt: new Date() })
      .where(eq(enrichmentJobs.id, job.id));
    log.error("job permanently failed", { jobId: job.id, kind: job.kind, attempts, error });
  }
}

export interface QueueDepth {
  pending: number;
  processing: number;
  failed: number;
  byKind: Record<string, number>;
}

export async function queueDepth(): Promise<QueueDepth> {
  const rows = await db
    .select({
      kind: enrichmentJobs.kind,
      status: enrichmentJobs.status,
      count: sql<number>`count(*)::int`,
    })
    .from(enrichmentJobs)
    .groupBy(enrichmentJobs.kind, enrichmentJobs.status);

  const depth: QueueDepth = { pending: 0, processing: 0, failed: 0, byKind: {} };
  for (const r of rows) {
    if (r.status === "pending") depth.pending += r.count;
    if (r.status === "processing") depth.processing += r.count;
    if (r.status === "failed") depth.failed += r.count;
    if (r.status === "pending") {
      depth.byKind[r.kind] = (depth.byKind[r.kind] ?? 0) + r.count;
    }
  }
  return depth;
}

/** Job statuses for a single lead (for the detail view). */
export async function jobsForLead(leadId: string): Promise<EnrichmentJobRow[]> {
  return db
    .select()
    .from(enrichmentJobs)
    .where(eq(enrichmentJobs.leadId, leadId))
    .orderBy(asc(enrichmentJobs.kind));
}

/** Reset any 'processing' jobs left dangling by a crashed tick back to pending. */
export async function requeueStuckProcessing(olderThanMs = 10 * 60_000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const res = await db
    .update(enrichmentJobs)
    .set({ status: "pending" })
    .where(
      and(
        eq(enrichmentJobs.status, "processing"),
        lte(enrichmentJobs.scheduledFor, cutoff)
      )
    )
    .returning({ id: enrichmentJobs.id });
  if (res.length) log.warn("requeued stuck processing jobs", { count: res.length });
  return res.length;
}

export { leads, MAX_ATTEMPTS };
