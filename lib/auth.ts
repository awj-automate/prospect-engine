/**
 * Edge-safe auth helpers. Uses Web Crypto only (no Node APIs, no env import) so
 * this module can be imported from both middleware (edge runtime) and route
 * handlers (node runtime).
 *
 * The session cookie holds SHA-256(APP_PASSWORD) — proving knowledge of the
 * password without storing it in plaintext. Constant per deploy.
 */

export const AUTH_COOKIE = "pe_session";

export async function sessionToken(password: string): Promise<string> {
  const data = new TextEncoder().encode(`prospect-engine::${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return hex(digest);
}

function hex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/** Timing-safe-ish comparison for two hex strings of equal length. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
