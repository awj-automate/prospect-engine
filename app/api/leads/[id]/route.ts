import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { leads, researchBriefs } from "@/lib/db/schema";
import { jobsForLead } from "@/lib/jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const [lead] = await db.select().from(leads).where(eq(leads.id, id)).limit(1);
  if (!lead) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const [briefs, jobs] = await Promise.all([
    db
      .select()
      .from(researchBriefs)
      .where(eq(researchBriefs.leadId, id))
      .orderBy(desc(researchBriefs.createdAt))
      .limit(10),
    jobsForLead(id),
  ]);

  return NextResponse.json({
    lead,
    latestBrief: briefs[0] ?? null,
    briefs,
    jobs,
  });
}
