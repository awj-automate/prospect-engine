import { and, eq, inArray, isNull, isNotNull, desc, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { leads, enrichmentJobs, syncRuns } from "@/lib/db/schema";
import type { NewLeadRow, LeadRow } from "@/lib/db/schema";
import { leadshark } from "@/lib/leadshark";
import { createLogger } from "@/lib/logger";
import {
  score,
  heatBounds,
  deriveLastEngagementAt,
  type ScoringLead,
} from "@/lib/scoring";
import { enqueueJob } from "@/lib/jobs";
import type {
  Lead,
  Signal,
  IcpFit,
  PersonEnrichmentData,
} from "@/lib/types";

const log = createLogger("sync");

/** How many top-scored leads to auto-enqueue for person enrichment per sync. */
const AUTO_ENQUEUE_LIMIT = 500;
const UPSERT_CHUNK = 200;

let loggedRawSample = false;
function logRawSampleOnce(lead: Lead | undefined, signal: Signal | undefined, apex: boolean) {
  if (loggedRawSample) return;
  loggedRawSample = true;
  log.info("RAW SAMPLE [leads] — first lead object as returned by LeadShark", {
    apexSignalsAvailable: apex,
    icpAnalysisPresent: lead?.icp_analysis != null,
    engagementCount: lead?.engagements?.length ?? 0,
    firstLead: lead ?? null,
  });
  if (apex) {
    log.info("RAW SAMPLE [signals] — first signal object as returned by LeadShark", {
      firstSignal: signal ?? null,
    });
  }
}

function toDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Map a raw LeadShark Lead (+ optional joined Signal) to a DB upsert row. */
function mapLead(lead: Lead, signal: Signal | undefined): NewLeadRow {
  // Apex auto-enrich may already have populated the profile/email.
  const apexEnriched = lead.enriched_profile as PersonEnrichmentData | null;
  const apexEnrichedAt = toDate(lead.enriched_at);

  const row: NewLeadRow = {
    leadsharkId: lead.id,
    name: lead.name,
    firstName: lead.first_name,
    title: lead.title,
    linkedinUrl: lead.linkedin_url,
    linkedinUsername: lead.linkedin_username,
    commenterId: lead.commenter_id,
    source: lead.source,
    leadType: lead.lead_type,
    postId: lead.post_id,

    icpScore: lead.icp_score,
    icpFit: (lead.icp_fit as IcpFit | null) ?? null,
    icpAnalysis: lead.icp_analysis,
    engagements: lead.engagements ?? [],
    archived: lead.archived ?? false,

    lsCreatedAt: toDate(lead.created_at),
    lsUpdatedAt: toDate(lead.updated_at),

    // Signals (only if we matched one)
    heatScore: signal?.heat_score ?? null,
    signalCount: signal?.signal_count ?? null,
    signalBreakdown: signal?.signal_breakdown ?? null,
    topSignals: signal?.top_signals ?? [],
    connectionStatus: signal?.connection_status ?? null,

    // Apex auto-enrichment carried forward
    personEnriched: apexEnriched ?? undefined,
    personEnrichedAt: apexEnrichedAt ?? undefined,
    email: lead.email ?? undefined,
    contactSource: lead.email ? "apex" : undefined,
    contactEnrichedAt: lead.email ? apexEnrichedAt ?? new Date() : undefined,

    updatedAt: new Date(),
  };
  return row;
}

export interface SyncResult {
  syncRunId: string;
  leadsUpserted: number;
  signalsUpdated: number;
  enqueuedPersonJobs: number;
  apexSignals: boolean;
}

/**
 * Full sync: paginate all leads and (if Apex) all signals, join on
 * commenter_id == actor_linkedin_id, upsert, recompute ALL scores (two-pass),
 * then auto-enqueue person jobs for the top-scored eligible leads.
 */
export async function runSync(): Promise<SyncResult> {
  const [run] = await db
    .insert(syncRuns)
    .values({ status: "running", startedAt: new Date() })
    .returning();

  try {
    // 1) Pull data
    const [allLeads, allSignals] = await Promise.all([
      leadshark.listAllLeads(),
      leadshark.listAllSignals({ sort: "heat_score" }),
    ]);
    const apexSignals = allSignals !== null;

    // One-time raw-sample log so we can eyeball exactly which free fields
    // LeadShark populates for this account (esp. icp_analysis) before deciding
    // how to weight scoring. Guarded so it logs once per process.
    logRawSampleOnce(allLeads[0], allSignals?.[0], apexSignals);

    const signalsByActor = new Map<string, Signal>();
    for (const s of allSignals ?? []) {
      if (s.actor_linkedin_id) signalsByActor.set(s.actor_linkedin_id, s);
    }

    // 2) Upsert leads (chunked)
    let signalsUpdated = 0;
    const rows = allLeads.map((lead) => {
      const sig = lead.commenter_id ? signalsByActor.get(lead.commenter_id) : undefined;
      if (sig) signalsUpdated++;
      return mapLead(lead, sig);
    });

    for (const part of chunk(rows, UPSERT_CHUNK)) {
      await db
        .insert(leads)
        .values(part)
        .onConflictDoUpdate({
          target: leads.leadsharkId,
          set: upsertSet(),
        });
    }

    log.info("leads upserted", { count: rows.length, signalsUpdated, apexSignals });

    // 3) Recompute ALL scores — two-pass over the full table.
    const enqueued = await recomputeScoresAndEnqueue();

    await db
      .update(syncRuns)
      .set({
        status: "done",
        finishedAt: new Date(),
        leadsUpserted: rows.length,
        signalsUpdated,
      })
      .where(eq(syncRuns.id, run.id));

    return {
      syncRunId: run.id,
      leadsUpserted: rows.length,
      signalsUpdated,
      enqueuedPersonJobs: enqueued,
      apexSignals,
    };
  } catch (err) {
    log.error("sync failed", err);
    await db
      .update(syncRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        error: err instanceof Error ? err.message : String(err),
      })
      .where(eq(syncRuns.id, run.id));
    throw err;
  }
}

/**
 * Columns to overwrite on conflict. We deliberately DO NOT clobber worker-owned
 * enrichment columns (company_slug, company_enriched, contact_*) except person
 * fields, which we only set from Apex when present (COALESCE keeps existing).
 */
function upsertSet() {
  return {
    name: sql`excluded.name`,
    firstName: sql`excluded.first_name`,
    title: sql`excluded.title`,
    linkedinUrl: sql`excluded.linkedin_url`,
    linkedinUsername: sql`excluded.linkedin_username`,
    commenterId: sql`excluded.commenter_id`,
    source: sql`excluded.source`,
    leadType: sql`excluded.lead_type`,
    postId: sql`excluded.post_id`,
    icpScore: sql`excluded.icp_score`,
    icpFit: sql`excluded.icp_fit`,
    icpAnalysis: sql`excluded.icp_analysis`,
    engagements: sql`excluded.engagements`,
    archived: sql`excluded.archived`,
    lsCreatedAt: sql`excluded.ls_created_at`,
    lsUpdatedAt: sql`excluded.ls_updated_at`,
    heatScore: sql`excluded.heat_score`,
    signalCount: sql`excluded.signal_count`,
    signalBreakdown: sql`excluded.signal_breakdown`,
    topSignals: sql`excluded.top_signals`,
    connectionStatus: sql`excluded.connection_status`,
    // Keep existing enrichment if we already have it; adopt Apex's if newer.
    personEnriched: sql`COALESCE(${leads.personEnriched}, excluded.person_enriched)`,
    personEnrichedAt: sql`COALESCE(${leads.personEnrichedAt}, excluded.person_enriched_at)`,
    email: sql`COALESCE(${leads.email}, excluded.email)`,
    contactSource: sql`COALESCE(${leads.contactSource}, excluded.contact_source)`,
    contactEnrichedAt: sql`COALESCE(${leads.contactEnrichedAt}, excluded.contact_enriched_at)`,
    updatedAt: sql`now()`,
  };
}

/**
 * Two-pass rescore of every lead, then enqueue person jobs for the top eligible
 * leads. Returns the number of person jobs enqueued.
 */
export async function recomputeScoresAndEnqueue(): Promise<number> {
  // Pass 1: gather heat min/max across the dataset.
  const all = await db
    .select({
      id: leads.id,
      icpScore: leads.icpScore,
      icpFit: leads.icpFit,
      heatScore: leads.heatScore,
      signalCount: leads.signalCount,
      signalBreakdown: leads.signalBreakdown,
      topSignals: leads.topSignals,
      engagements: leads.engagements,
    })
    .from(leads);

  const bounds = heatBounds(all.map((l) => ({ heatScore: l.heatScore })));
  const now = new Date();

  // Pass 2: score + persist (chunked updates).
  for (const part of chunk(all, UPSERT_CHUNK)) {
    await db.transaction(async (tx) => {
      for (const l of part) {
        const sl: ScoringLead = {
          icpScore: l.icpScore,
          icpFit: l.icpFit,
          heatScore: l.heatScore,
          signalCount: l.signalCount,
          signalBreakdown: l.signalBreakdown ?? null,
          topSignals: l.topSignals ?? null,
          engagements: l.engagements ?? null,
        };
        const result = score(sl, { ...bounds, now });
        const lastEng = deriveLastEngagementAt({
          engagements: l.engagements ?? null,
          topSignals: l.topSignals ?? null,
        });
        await tx
          .update(leads)
          .set({
            score: result.score,
            scoreBreakdown: result.breakdown,
            lastEngagementAt: lastEng,
          })
          .where(eq(leads.id, l.id));
      }
    });
  }

  log.info("scores recomputed", { count: all.length, heatBounds: bounds });

  return autoEnqueuePersonJobs();
}

/**
 * Enqueue person jobs for the highest-scored leads that have a
 * linkedin_username, are not archived, and are not already person-enriched or
 * already queued for person enrichment.
 */
async function autoEnqueuePersonJobs(): Promise<number> {
  // lead_ids that already have a person job (any status) — exclude them.
  const existing = await db
    .select({ leadId: enrichmentJobs.leadId })
    .from(enrichmentJobs)
    .where(eq(enrichmentJobs.kind, "person"));
  const excluded = new Set(existing.map((e) => e.leadId));

  const candidates = await db
    .select({
      id: leads.id,
      score: leads.score,
      username: leads.linkedinUsername,
    })
    .from(leads)
    .where(
      and(
        eq(leads.archived, false),
        isNotNull(leads.linkedinUsername),
        isNull(leads.personEnrichedAt)
      )
    )
    .orderBy(desc(leads.score))
    .limit(AUTO_ENQUEUE_LIMIT + excluded.size);

  let enqueued = 0;
  for (const c of candidates) {
    if (enqueued >= AUTO_ENQUEUE_LIMIT) break;
    if (excluded.has(c.id)) continue;
    if (!c.username) continue;
    await enqueueJob({ leadId: c.id, kind: "person", priority: c.score ?? 0 });
    enqueued++;
  }
  log.info("auto-enqueued person jobs", { enqueued });
  return enqueued;
}

/** Convenience used by the /api/leads/:id detail view. */
export async function getLeadById(id: string): Promise<LeadRow | null> {
  const [row] = await db.select().from(leads).where(eq(leads.id, id)).limit(1);
  return row ?? null;
}

export { inArray };
