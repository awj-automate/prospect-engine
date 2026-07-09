import { NextResponse } from "next/server";
import { desc, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { leads, researchBriefs, syncRuns } from "@/lib/db/schema";
import { usageSnapshot } from "@/lib/usage";
import { queueDepth } from "@/lib/jobs";
import { enrichWindow } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const [
    totalRows,
    hotRows,
    briefRows,
    usage,
    depth,
    lastSyncRows,
  ] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(leads),
    db.select({ count: sql<number>`count(*)::int` }).from(leads).where(gte(leads.score, 70)),
    db.select({ count: sql<number>`count(*)::int` }).from(researchBriefs),
    usageSnapshot(),
    queueDepth(),
    db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(1),
  ]);

  const win = enrichWindow();

  return NextResponse.json({
    totals: {
      leads: totalRows[0]?.count ?? 0,
      hot: hotRows[0]?.count ?? 0,
      briefs: briefRows[0]?.count ?? 0,
    },
    usage,
    queue: depth,
    window: {
      inWindow: win.inWindow,
      hour: Math.round(win.hour * 100) / 100,
      start: win.start,
      end: win.end,
      elapsedFraction: Math.round(win.elapsedFraction * 1000) / 1000,
      expected: {
        person: Math.round(usage.person.cap * win.elapsedFraction),
        company: Math.round(usage.company.cap * win.elapsedFraction),
      },
    },
    lastSync: lastSyncRows[0] ?? null,
  });
}
