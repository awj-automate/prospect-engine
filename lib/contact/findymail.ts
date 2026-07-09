import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import type { ContactEnricher, ContactQuery, ContactResult } from "./types";
import { normalizeDomain } from "./types";

const log = createLogger("contact:findymail");
const BASE = "https://app.findymail.com";

/**
 * Findymail contact enricher. Bearer-token auth.
 * Prefer LinkedIn URL lookup; fall back to name + domain.
 */
export class FindymailEnricher implements ContactEnricher {
  readonly name = "findymail";

  async find(query: ContactQuery): Promise<ContactResult> {
    if (query.linkedinUrl) {
      const viaLi = await this.post("/api/search/linkedin", {
        linkedin_url: query.linkedinUrl,
      });
      const email = pickEmail(viaLi);
      if (email) return { email, phone: pickPhone(viaLi), source: this.name };
    }

    const domain = query.domain ? normalizeDomain(query.domain) : undefined;
    if (query.name && domain) {
      const viaName = await this.post("/api/search/name", {
        name: query.name,
        domain,
      });
      const email = pickEmail(viaName);
      if (email) return { email, phone: pickPhone(viaName), source: this.name };
    }

    return { source: this.name };
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.FINDYMAIL_API_KEY!}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
        cache: "no-store",
      });
      const text = await res.text();
      const json = text ? safeJson(text) : null;
      if (!res.ok) {
        log.warn("findymail non-ok", { path, status: res.status, body: json });
        return null;
      }
      return (json as Record<string, unknown>) ?? null;
    } catch (err) {
      log.error("findymail request failed", err);
      return null;
    }
  }
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** Findymail returns { contact: { email, phone, ... } }. */
function pickEmail(body: Record<string, unknown> | null): string | undefined {
  if (!body) return undefined;
  const contact = body.contact as Record<string, unknown> | undefined;
  const c = contact?.email ?? body.email;
  return typeof c === "string" && c.includes("@") ? c : undefined;
}

function pickPhone(body: Record<string, unknown> | null): string | undefined {
  if (!body) return undefined;
  const contact = body.contact as Record<string, unknown> | undefined;
  const c = contact?.phone ?? body.phone;
  return typeof c === "string" && c.trim() ? c.trim() : undefined;
}
