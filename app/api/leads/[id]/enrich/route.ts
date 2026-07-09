import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { enqueueJob } from "@/lib/jobs";
import { processJob } from "@/lib/enrich";
import { createLogger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

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

  const [lead] = await db.select().from(leads).where(eq(leads.id, id)).limit(1);
  if (!lead) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Enqueue a high-priority job that jumps the queue.
  const job = await enqueueJob({
    leadId: id,
    kind,
    priority: lead.score ?? 0,
    highPriority: true,
    force: true,
  });

  // Contact runs inline (not LinkedIn-capped); other kinds are drained by the worker.
  if (kind === "contact") {
    try {
      const outcome = await processJob(job);
      return NextResponse.json({ ok: true, inline: true, jobId: job.id, outcome });
    } catch (err) {
      log.error("inline contact enrich failed", err);
      return NextResponse.json({ ok: false, jobId: job.id, error: "contact enrich failed" }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, inline: false, jobId: job.id, status: job.status });
}
