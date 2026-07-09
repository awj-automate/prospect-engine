import { NextResponse } from "next/server";
import { and, asc, desc, eq, gte, ilike, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SORTABLE = {
  score: leads.score,
  heat: leads.heatScore,
  last_engagement: leads.lastEngagementAt,
  name: leads.name,
  created: leads.createdAt,
  icp: leads.icpScore,
} as const;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams;

  const minScore = q.get("minScore");
  const icpFit = q.get("icp_fit"); // fit | maybe | not
  const enriched = q.get("enriched"); // y | n
  const hasEmail = q.get("has_email"); // y | n
  const connectionStatus = q.get("connection_status");
  const search = q.get("search")?.trim();

  const sortKey = (q.get("sort") ?? "score") as keyof typeof SORTABLE;
  const dir = q.get("dir") === "asc" ? "asc" : "desc";
  const page = Math.max(1, Number(q.get("page") ?? "1") || 1);
  const pageSize = Math.min(200, Math.max(1, Number(q.get("pageSize") ?? "50") || 50));

  const conditions: SQL[] = [];

  if (minScore != null && minScore !== "") {
    const n = Number(minScore);
    if (Number.isFinite(n)) conditions.push(gte(leads.score, n));
  }
  if (icpFit && ["fit", "maybe", "not"].includes(icpFit)) {
    conditions.push(eq(leads.icpFit, icpFit));
  }
  if (enriched === "y") conditions.push(isNotNull(leads.personEnrichedAt));
  if (enriched === "n") conditions.push(isNull(leads.personEnrichedAt));
  if (hasEmail === "y") conditions.push(isNotNull(leads.email));
  if (hasEmail === "n") conditions.push(isNull(leads.email));
  if (connectionStatus) conditions.push(eq(leads.connectionStatus, connectionStatus));

  if (search) {
    const like = `%${search}%`;
    const searchCond = or(
      ilike(leads.name, like),
      ilike(leads.title, like),
      ilike(leads.linkedinUsername, like),
      sql`${leads.companyEnriched}->>'name' ILIKE ${like}`,
      sql`${leads.personEnriched}->'experience'->0->>'company' ILIKE ${like}`
    );
    if (searchCond) conditions.push(searchCond);
  }

  const whereClause = conditions.length ? and(...conditions) : undefined;
  const sortCol = SORTABLE[sortKey] ?? leads.score;
  const orderBy = dir === "asc" ? asc(sortCol) : desc(sortCol);

  const [rows, countRows] = await Promise.all([
    db
      .select()
      .from(leads)
      .where(whereClause)
      .orderBy(orderBy, desc(leads.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ count: sql<number>`count(*)::int` }).from(leads).where(whereClause),
  ]);

  const total = countRows[0]?.count ?? 0;

  return NextResponse.json({
    data: rows,
    pagination: {
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  });
}
