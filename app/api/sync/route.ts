import { NextResponse } from "next/server";
import { runSync } from "@/lib/sync";
import { createLogger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const log = createLogger("api:sync");

// Triggered by the "Sync now" button (cookie auth) or by cron (x-cron-secret).
// Middleware has already gated access.
export async function POST() {
  try {
    const result = await runSync();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    log.error("manual sync failed", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "sync failed" },
      { status: 500 }
    );
  }
}
