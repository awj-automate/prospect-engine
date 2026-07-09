import {
  pgTable,
  pgEnum,
  uuid,
  text,
  real,
  integer,
  boolean,
  jsonb,
  timestamp,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  IcpAnalysis,
  LeadEngagement,
  SignalBreakdown,
  TopSignal,
  ScoreBreakdown,
  PersonEnrichmentData,
  CompanyEnrichmentData,
  ResearchCitation,
  ResearchStructured,
} from "@/lib/types";

/* ─────────────────────────── enums ─────────────────────────── */

export const jobKindEnum = pgEnum("job_kind", [
  "person",
  "company_resolve",
  "company",
  "contact",
]);

export const jobStatusEnum = pgEnum("job_status", [
  "pending",
  "processing",
  "done",
  "failed",
]);

export const briefStatusEnum = pgEnum("brief_status", [
  "generating",
  "done",
  "failed",
]);

export const syncStatusEnum = pgEnum("sync_status", [
  "running",
  "done",
  "failed",
]);

/* ─────────────────────────── leads ─────────────────────────── */

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadsharkId: text("leadshark_id").notNull().unique(),

    // Raw LeadShark identity
    name: text("name"),
    firstName: text("first_name"),
    title: text("title"),
    linkedinUrl: text("linkedin_url"),
    linkedinUsername: text("linkedin_username"),
    commenterId: text("commenter_id"),
    source: text("source"),
    leadType: text("lead_type"),
    postId: text("post_id"),

    // ICP (from LeadShark)
    icpScore: real("icp_score"), // 0..1
    icpFit: text("icp_fit"), // "fit" | "maybe" | "not" | null
    icpAnalysis: jsonb("icp_analysis").$type<IcpAnalysis | null>(),
    engagements: jsonb("engagements").$type<LeadEngagement[]>().default([]),
    archived: boolean("archived").notNull().default(false),

    lsCreatedAt: timestamp("ls_created_at", { withTimezone: true }),
    lsUpdatedAt: timestamp("ls_updated_at", { withTimezone: true }),

    // Signals (Apex only; joined on commenter_id == actor_linkedin_id)
    heatScore: real("heat_score"), // ~0..100
    signalCount: integer("signal_count"),
    signalBreakdown: jsonb("signal_breakdown").$type<SignalBreakdown | null>(),
    topSignals: jsonb("top_signals").$type<TopSignal[]>().default([]),
    connectionStatus: text("connection_status"),

    // Computed
    score: real("score"), // 0..100
    scoreBreakdown: jsonb("score_breakdown").$type<ScoreBreakdown | null>(),
    lastEngagementAt: timestamp("last_engagement_at", { withTimezone: true }),

    // Enrichment
    personEnriched: jsonb("person_enriched").$type<PersonEnrichmentData | null>(),
    personEnrichedAt: timestamp("person_enriched_at", { withTimezone: true }),
    companySlug: text("company_slug"),
    companyEnriched: jsonb("company_enriched").$type<CompanyEnrichmentData | null>(),
    companyEnrichedAt: timestamp("company_enriched_at", { withTimezone: true }),

    // Contact
    email: text("email"),
    phone: text("phone"),
    contactEnrichedAt: timestamp("contact_enriched_at", { withTimezone: true }),
    contactSource: text("contact_source"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    commenterIdx: index("leads_commenter_id_idx").on(t.commenterId),
    scoreIdx: index("leads_score_idx").on(t.score),
    icpFitIdx: index("leads_icp_fit_idx").on(t.icpFit),
  })
);

/* ──────────────────────── enrichment_jobs ──────────────────────── */

export const enrichmentJobs = pgTable(
  "enrichment_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    kind: jobKindEnum("kind").notNull(),
    status: jobStatusEnum("status").notNull().default("pending"),
    priority: real("priority").notNull().default(0), // = lead score
    attempts: integer("attempts").notNull().default(0),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true })
      .notNull()
      .defaultNow(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => ({
    // A lead is never double-queued for the same step.
    leadKindUnq: uniqueIndex("enrichment_jobs_lead_kind_unq").on(
      t.leadId,
      t.kind
    ),
    statusPriorityIdx: index("enrichment_jobs_status_priority_idx").on(
      t.status,
      t.priority
    ),
  })
);

/* ──────────────────────────── daily_usage ──────────────────────────── */

export const dailyUsage = pgTable(
  "daily_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Stored as a calendar date in the configured TZ.
    date: date("date").notNull(),
    kind: text("kind").notNull(), // "person" | "company"
    count: integer("count").notNull().default(0),
  },
  (t) => ({
    dateKindUnq: uniqueIndex("daily_usage_date_kind_unq").on(t.date, t.kind),
  })
);

/* ─────────────────────────── research_briefs ─────────────────────────── */

export const researchBriefs = pgTable("research_briefs", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  status: briefStatusEnum("status").notNull().default("generating"),
  content: text("content"), // markdown
  structured: jsonb("structured").$type<ResearchStructured | null>(),
  citations: jsonb("citations").$type<ResearchCitation[]>().default([]),
  model: text("model"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

/* ─────────────────────────────── sync_runs ─────────────────────────────── */

export const syncRuns = pgTable("sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  leadsUpserted: integer("leads_upserted").notNull().default(0),
  signalsUpdated: integer("signals_updated").notNull().default(0),
  status: syncStatusEnum("status").notNull().default("running"),
  error: text("error"),
});

/* ─────────────────────────────── inferred types ─────────────────────────── */

export type LeadRow = typeof leads.$inferSelect;
export type NewLeadRow = typeof leads.$inferInsert;
export type EnrichmentJobRow = typeof enrichmentJobs.$inferSelect;
export type NewEnrichmentJobRow = typeof enrichmentJobs.$inferInsert;
export type DailyUsageRow = typeof dailyUsage.$inferSelect;
export type ResearchBriefRow = typeof researchBriefs.$inferSelect;
export type NewResearchBriefRow = typeof researchBriefs.$inferInsert;
export type SyncRunRow = typeof syncRuns.$inferSelect;
export type JobKind = (typeof jobKindEnum.enumValues)[number];
export type JobStatus = (typeof jobStatusEnum.enumValues)[number];
