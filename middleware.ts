import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, sessionToken, safeEqual } from "@/lib/auth";

/**
 * Cookie-based single-password gate. Everything except /login and /api/health
 * requires a valid session cookie. Cron/internal API routes additionally check
 * CRON_SECRET inside the route (not here) since browsers can't send it.
 *
 * Reads process.env directly (not lib/env) to stay lean in the edge runtime.
 */

const PUBLIC_PATHS = ["/login", "/api/health", "/api/auth/login", "/api/auth/logout"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  // Cron/internal callers authenticate with the shared secret header.
  const cronSecret = process.env.CRON_SECRET;
  const providedSecret = req.headers.get("x-cron-secret");
  if (cronSecret && providedSecret && safeEqual(providedSecret, cronSecret)) {
    return NextResponse.next();
  }

  const password = process.env.APP_PASSWORD;
  const cookie = req.cookies.get(AUTH_COOKIE)?.value;

  let authed = false;
  if (password && cookie) {
    try {
      authed = safeEqual(cookie, await sessionToken(password));
    } catch {
      authed = false;
    }
  }

  if (authed) return NextResponse.next();

  // API routes get a 401; page routes redirect to /login.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Run on everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
