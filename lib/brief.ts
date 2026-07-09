import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { leads, researchBriefs } from "@/lib/db/schema";
import type { LeadRow, ResearchBriefRow } from "@/lib/db/schema";
import { anthropic, BRIEF_MODEL } from "@/lib/anthropic";
import { createLogger } from "@/lib/logger";
import { getWebResearcher } from "@/lib/research";
import { handleContact, ensurePersonInline, ensureCompanyInline } from "@/lib/enrich";
import type {
  ResearchCitation,
  ResearchStructured,
  WebResearchResult,
} from "@/lib/types";

const log = createLogger("brief");

/** Progress event pushed to the SSE stream. */
export interface BriefProgress {
  step: string;
  message: string;
  done?: boolean;
  error?: string;
  briefId?: string;
}

type Emit = (p: BriefProgress) => void | Promise<void>;

async function reload(leadId: string): Promise<LeadRow | null> {
  const [row] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  return row ?? null;
}

/* ── web research query builder ── */

function buildQueries(lead: LeadRow): string[] {
  const name = lead.name ?? "";
  const company =
    lead.companyEnriched?.name ??
    lead.personEnriched?.experience?.[0]?.company ??
    "";
  const role = lead.title ?? lead.personEnriched?.basic?.headline ?? "";
  const location = lead.personEnriched?.basic?.location ?? "";

  const queries: string[] = [];
  if (name && company) queries.push(`Who is ${name}${role ? `, ${role}` : ""} at ${company}? Background and current focus.`);
  if (company) queries.push(`Recent news, funding, growth, or hiring signals for ${company}.`);
  if (company) queries.push(`What products or services does ${company} offer and who are its customers?`);
  if (name && company) queries.push(`Any recent public activity, posts, talks, or press from ${name} at ${company}${location ? ` (${location})` : ""}.`);
  if (role && company) queries.push(`Challenges or priorities a ${role} at a company like ${company} typically faces this year.`);
  return queries.filter(Boolean).slice(0, 5);
}

/* ── Claude synthesis ── */

const SYSTEM_PROMPT = `You are a senior B2B sales researcher writing a concise, high-signal outreach brief for a solo consultant who sells business-growth / advisory services to service businesses and marketing agencies.

You will receive structured LinkedIn data, company data, contact data, and web research about a single prospect. Synthesize it into a sharp, skimmable Markdown brief. Be specific and grounded ONLY in the supplied data — never invent facts, numbers, or quotes. If a section lacks data, say so briefly rather than padding.

Output EXACTLY these Markdown sections, each as a level-2 heading (##), in this order:

## Snapshot
2–4 bullet points: who they are, role, company, seniority, the single most important reason they're worth contacting.

## Company Overview
What the company does, size, industry, and any notable context.

## Signals & Recent Triggers
The engagement/intent signals and any recent public triggers (news, posts, activity) that make now a good time to reach out. Call out the strongest buying signal.

## Fit for a business-growth / advisory offer
Honest assessment of how well this prospect fits an advisory/growth offer, and the angle most likely to resonate.

## Personalized Outreach Angle
The specific hook to lead with — tied to a real detail from the data.

## Suggested Opener
A 2–3 line opening message (LinkedIn DM or email) that is warm, specific, and non-salesy. No greeting fluff, no "I hope this finds you well".

Keep the whole brief tight — a busy operator should read it in under 60 seconds.`;

function buildUserBundle(lead: LeadRow, research: WebResearchResult): string {
  const bundle = {
    lead: {
      name: lead.name,
      title: lead.title,
      linkedin_url: lead.linkedinUrl,
      icp_fit: lead.icpFit,
      icp_score: lead.icpScore,
      score: lead.score,
      score_breakdown: lead.scoreBreakdown,
      heat_score: lead.heatScore,
      signal_breakdown: lead.signalBreakdown,
      top_signals: lead.topSignals,
      engagements: lead.engagements,
      last_engagement_at: lead.lastEngagementAt,
      email: lead.email,
      phone: lead.phone,
    },
    person: lead.personEnriched,
    company: lead.companyEnriched,
    web_research: {
      summary: research.summary,
      sources: research.citations,
    },
  };
  return [
    "Here is everything known about the prospect. Write the brief.",
    "",
    "```json",
    JSON.stringify(bundle, null, 2),
    "```",
  ].join("\n");
}

/** Split the markdown into the structured section map. */
function toStructured(markdown: string): ResearchStructured {
  const sections: Record<string, string> = {};
  const parts = markdown.split(/^##\s+/m).map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim().toLowerCase();
    const body = (nl === -1 ? "" : part.slice(nl + 1)).trim();
    if (heading.startsWith("snapshot")) sections.snapshot = body;
    else if (heading.startsWith("company")) sections.company_overview = body;
    else if (heading.startsWith("signals")) sections.signals_and_triggers = body;
    else if (heading.startsWith("fit")) sections.fit = body;
    else if (heading.startsWith("personalized")) sections.outreach_angle = body;
    else if (heading.startsWith("suggested")) sections.suggested_opener = body;
  }
  return sections;
}

/**
 * Full brief pipeline. Creates a 'generating' brief row, runs enrichment →
 * research → synthesis inline (Railway has no serverless timeout), persists the
 * result, and reports progress via `emit`. Returns the final brief row.
 */
export async function generateBrief(leadId: string, emit: Emit): Promise<ResearchBriefRow> {
  const [brief] = await db
    .insert(researchBriefs)
    .values({ leadId, status: "generating", model: BRIEF_MODEL })
    .returning();

  await emit({ step: "start", message: "Starting research brief…", briefId: brief.id });

  try {
    let lead = await reload(leadId);
    if (!lead) throw new Error("lead not found");

    // (a) ensure person + company enrichment
    await emit({ step: "person", message: "Enriching person profile…" });
    lead = await ensurePersonInline(lead);
    await emit({ step: "company", message: "Enriching company…" });
    lead = await ensureCompanyInline(lead);

    // (b) optionally contact
    if (!lead.email) {
      await emit({ step: "contact", message: "Looking up contact details…" });
      try {
        await handleContact(lead);
        lead = (await reload(leadId)) ?? lead;
      } catch (err) {
        log.warn("brief: contact lookup failed", err);
      }
    }

    // (c) web research
    await emit({ step: "research", message: "Running web research…" });
    const queries = buildQueries(lead);
    const researcher = getWebResearcher();
    const research = queries.length
      ? await researcher.research(queries)
      : { summary: "", citations: [] as ResearchCitation[] };

    // (d) synthesis
    await emit({ step: "synthesis", message: "Writing the brief with Claude…" });
    const message = await anthropic().messages.create({
      model: BRIEF_MODEL,
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserBundle(lead, research) }],
    });

    const markdown = message.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    const structured = toStructured(markdown);

    const [done] = await db
      .update(researchBriefs)
      .set({
        status: "done",
        content: markdown,
        structured,
        citations: research.citations,
        completedAt: new Date(),
      })
      .where(eq(researchBriefs.id, brief.id))
      .returning();

    await emit({ step: "done", message: "Brief ready.", done: true, briefId: brief.id });
    log.info("brief generated", { leadId, briefId: brief.id });
    return done;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(researchBriefs)
      .set({ status: "failed", error: msg, completedAt: new Date() })
      .where(eq(researchBriefs.id, brief.id));
    await emit({ step: "error", message: "Brief generation failed.", error: msg, done: true, briefId: brief.id });
    log.error("brief failed", err);
    const [failed] = await db.select().from(researchBriefs).where(eq(researchBriefs.id, brief.id)).limit(1);
    return failed;
  }
}
