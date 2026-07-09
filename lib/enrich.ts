import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import type { EnrichmentJobRow, LeadRow } from "@/lib/db/schema";
import { leadshark } from "@/lib/leadshark";
import { PERSON_ENRICH_SECTIONS } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { enqueueJob, markDone, markFailed } from "@/lib/jobs";
import { incrementUsage } from "@/lib/usage";
import { getContactEnricher } from "@/lib/contact";
import type { PersonEnrichmentData, CompanyEnrichmentData } from "@/lib/types";

const log = createLogger("enrich");

/* ── contact-only in-memory safety limiter: 30/hr ── */
const contactCalls: number[] = [];
function contactHeadroom(): boolean {
  const now = Date.now();
  while (contactCalls.length && now - contactCalls[0] > 3_600_000) contactCalls.shift();
  return contactCalls.length < 30;
}
function recordContactCall() {
  contactCalls.push(Date.now());
}

async function loadLead(leadId: string): Promise<LeadRow | null> {
  const [row] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  return row ?? null;
}

/* ───────────────────────────── person ───────────────────────────── */

export async function handlePerson(lead: LeadRow): Promise<void> {
  if (!lead.linkedinUsername) {
    throw new Error("person enrich: lead has no linkedin_username");
  }
  const res = await leadshark.enrichPerson(lead.linkedinUsername, PERSON_ENRICH_SECTIONS);
  await incrementUsage("person");

  const data: PersonEnrichmentData | null = res?.data ?? null;
  await db
    .update(leads)
    .set({ personEnriched: data, personEnrichedAt: new Date(), updatedAt: new Date() })
    .where(eq(leads.id, lead.id));

  // Two-hop: if we learned the current employer, resolve its slug next.
  const employer = data?.experience?.[0]?.company?.trim();
  if (employer) {
    await enqueueJob({
      leadId: lead.id,
      kind: "company_resolve",
      priority: lead.score ?? 0,
    });
    log.info("person enriched; queued company_resolve", { leadId: lead.id, employer });
  } else {
    log.info("person enriched; no employer to resolve", { leadId: lead.id });
  }
}

/* ────────────────────────── company_resolve ────────────────────────── */

export async function handleCompanyResolve(lead: LeadRow): Promise<void> {
  const employer = lead.personEnriched?.experience?.[0]?.company?.trim();
  if (!employer) {
    throw new Error("company_resolve: no employer name on person enrichment");
  }
  const res = await leadshark.searchLinkedin({ company: employer }, 5);
  const slug = res?.data?.results?.[0]?.linkedin_id;
  if (!slug) {
    throw new Error(`company_resolve: no slug found for "${employer}"`);
  }
  await db
    .update(leads)
    .set({ companySlug: slug, updatedAt: new Date() })
    .where(eq(leads.id, lead.id));

  await enqueueJob({ leadId: lead.id, kind: "company", priority: lead.score ?? 0 });
  log.info("company resolved; queued company enrich", { leadId: lead.id, employer, slug });
}

/* ───────────────────────────── company ───────────────────────────── */

export async function handleCompany(lead: LeadRow): Promise<void> {
  if (!lead.companySlug) {
    throw new Error("company enrich: lead has no company_slug");
  }
  const res = await leadshark.enrichCompany(lead.companySlug);
  await incrementUsage("company");

  const data: CompanyEnrichmentData | null = res?.data ?? null;
  await db
    .update(leads)
    .set({ companyEnriched: data, companyEnrichedAt: new Date(), updatedAt: new Date() })
    .where(eq(leads.id, lead.id));
  log.info("company enriched", { leadId: lead.id, slug: lead.companySlug });
}

/* ───────────────────────────── contact ───────────────────────────── */

export async function handleContact(lead: LeadRow): Promise<void> {
  if (lead.email) {
    log.info("contact: lead already has email, skipping", { leadId: lead.id });
    return; // already have it (e.g. Apex auto-enrich)
  }
  if (!contactHeadroom()) {
    throw new Error("contact: 30/hr safety cap reached");
  }

  const company =
    lead.companyEnriched?.name ??
    lead.personEnriched?.experience?.[0]?.company ??
    undefined;

  recordContactCall();
  const enricher = getContactEnricher();
  const result = await enricher.find({
    name: lead.name ?? undefined,
    linkedinUrl: lead.linkedinUrl ?? undefined,
    company: company ?? undefined,
  });

  await db
    .update(leads)
    .set({
      email: result.email ?? lead.email,
      phone: result.phone ?? lead.phone,
      contactSource: result.email || result.phone ? result.source : lead.contactSource,
      contactEnrichedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(leads.id, lead.id));

  log.info("contact enriched", {
    leadId: lead.id,
    foundEmail: Boolean(result.email),
    foundPhone: Boolean(result.phone),
  });
}

/* ───────────────────────────── dispatch ───────────────────────────── */

/**
 * Process one job end-to-end. Loads the lead, dispatches by kind, and marks the
 * job done/failed. Wrapped so a single job failure never escapes to the tick.
 */
export async function processJob(job: EnrichmentJobRow): Promise<"done" | "failed"> {
  try {
    const lead = await loadLead(job.leadId);
    if (!lead) throw new Error(`lead ${job.leadId} not found`);

    switch (job.kind) {
      case "person":
        await handlePerson(lead);
        break;
      case "company_resolve":
        await handleCompanyResolve(lead);
        break;
      case "company":
        await handleCompany(lead);
        break;
      case "contact":
        await handleContact(lead);
        break;
      default:
        throw new Error(`unknown job kind: ${job.kind as string}`);
    }

    await markDone(job.id);
    return "done";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markFailed(job, msg);
    return "failed";
  }
}

/** Run a single job inline (used by the manual enrich route for `contact`). */
export async function runJobInline(job: EnrichmentJobRow): Promise<"done" | "failed"> {
  return processJob(job);
}
