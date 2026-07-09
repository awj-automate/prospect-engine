import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Unauthenticated health check (allowed by middleware).
export async function GET() {
  return NextResponse.json({ ok: true, service: "prospect-engine", time: new Date().toISOString() });
}
