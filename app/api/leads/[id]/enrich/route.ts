import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import type { JobKind } from "@/lib/db/schema";
import { enqueueJob } from "@/lib/jobs";
import { processJob, ensurePersonInline, ensureCompanyInline } from "@/lib/enrich";
import { createLogger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 180;

const log = createLogger("api:enrich");

const bodySchema = z.object({
  kind: z.enum(["person", "company_resolve", "company", "contact"]),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "kind must be person|company_resolve|company|contact" }, { status: 400 });
  }
  const { kind } = parsed.data;

  let lead = (await db.select().from(leads).where(eq(leads.id, id)).limit(1))[0];
  if (!lead) return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    // Contact: not LinkedIn-capped — always inline (own 30/hr safety cap).
    if (kind === "contact") {
      const job = await enqueueJob({ leadId: id, kind, priority: lead.score ?? 0, highPriority: true, force: true });
      const outcome = await processJob(job);
      return NextResponse.json({ ok: true, inline: true, kind, jobId: job.id, outcome });
    }

    // Person / company: run inline so the lead you're viewing becomes usable
    // immediately. Each is one real LinkedIn profile view, gated by the daily
    // cap. If capped, fall back to a high-priority queued job for the worker.
    lead = await ensurePersonInline(lead);

    if (kind === "person") {
      if (lead.personEnriched) {
        return NextResponse.json({ ok: true, inline: true, kind, enriched: true });
      }
      const job = await enqueueJob({ leadId: id, kind: "person", priority: lead.score ?? 0, highPriority: true });
      return NextResponse.json({ ok: true, inline: false, kind, queued: true, jobId: job.id });
    }

    // company / company_resolve → drive the full person→resolve→company chain.
    lead = await ensureCompanyInline(lead);
    if (lead.companyEnriched) {
      return NextResponse.json({ ok: true, inline: true, kind: "company", enriched: true });
    }

    // Couldn't finish inline (a cap was hit) — queue the earliest missing step;
    // the worker chains the rest.
    const queueKind: JobKind = !lead.personEnriched
      ? "person"
      : !lead.companySlug
        ? "company_resolve"
        : "company";
    const job = await enqueueJob({ leadId: id, kind: queueKind, priority: lead.score ?? 0, highPriority: true });
    return NextResponse.json({ ok: true, inline: false, kind: queueKind, queued: true, jobId: job.id });
  } catch (err) {
    log.error("enrich failed", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "enrich failed" },
      { status: 500 }
    );
  }
}
