import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { AUTH_COOKIE, sessionToken, safeEqual } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({ password: z.string().min(1) });

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "password required" }, { status: 400 });
  }

  const expected = await sessionToken(env.APP_PASSWORD);
  const provided = await sessionToken(parsed.data.password);
  if (!safeEqual(provided, expected)) {
    return NextResponse.json({ error: "invalid password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, expected, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}
