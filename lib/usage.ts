import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dailyUsage } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { todayInTz } from "@/lib/time";

/**
 * Daily usage counters. Only "person" and "company" LinkedIn profile-views are
 * metered here (they count against the caps). Keyed by (date, kind) in the
 * configured TZ.
 */

export type CappedKind = "person" | "company";

export function capFor(kind: CappedKind): number {
  return kind === "person"
    ? env.DAILY_PERSON_ENRICH_CAP
    : env.DAILY_COMPANY_ENRICH_CAP;
}

export async function getUsedToday(kind: CappedKind, date = todayInTz()): Promise<number> {
  const [row] = await db
    .select({ count: dailyUsage.count })
    .from(dailyUsage)
    .where(and(eq(dailyUsage.date, date), eq(dailyUsage.kind, kind)))
    .limit(1);
  return row?.count ?? 0;
}

export async function getRemainingToday(kind: CappedKind): Promise<number> {
  const used = await getUsedToday(kind);
  return Math.max(0, capFor(kind) - used);
}

/**
 * Atomically increment today's counter and return the NEW value. Upserts the
 * (date, kind) row. Callers should have already checked headroom, but this is
 * the source of truth.
 */
export async function incrementUsage(kind: CappedKind, by = 1, date = todayInTz()): Promise<number> {
  const [row] = await db
    .insert(dailyUsage)
    .values({ date, kind, count: by })
    .onConflictDoUpdate({
      target: [dailyUsage.date, dailyUsage.kind],
      set: { count: sql`${dailyUsage.count} + ${by}` },
    })
    .returning({ count: dailyUsage.count });
  return row?.count ?? by;
}

export interface UsageSnapshot {
  date: string;
  person: { used: number; cap: number; remaining: number };
  company: { used: number; cap: number; remaining: number };
}

export async function usageSnapshot(): Promise<UsageSnapshot> {
  const date = todayInTz();
  const [personUsed, companyUsed] = await Promise.all([
    getUsedToday("person", date),
    getUsedToday("company", date),
  ]);
  const personCap = capFor("person");
  const companyCap = capFor("company");
  return {
    date,
    person: { used: personUsed, cap: personCap, remaining: Math.max(0, personCap - personUsed) },
    company: { used: companyUsed, cap: companyCap, remaining: Math.max(0, companyCap - companyUsed) },
  };
}
