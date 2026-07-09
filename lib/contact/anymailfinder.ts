import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import type { ContactEnricher, ContactQuery, ContactResult } from "./types";
import { normalizeDomain } from "./types";

const log = createLogger("contact:anymailfinder");
const ENDPOINT = "https://api.anymailfinder.com/v5.1/find-email/person";

// AMF does real-time SMTP verification; it recommends up to a 180s timeout.
const TIMEOUT_MS = 170_000;

/**
 * AnyMail Finder contact enricher.
 *
 * Sends name + company (and/or LinkedIn URL) to the Find Person Email endpoint;
 * AMF runs the name+company lookup first and falls back to the LinkedIn profile.
 * Only emails with `email_status === "valid"` (via `valid_email`) are treated as
 * deliverable; a "risky" catch-all guess is returned as a best-effort fallback.
 *
 * Auth is a RAW Authorization header (no "Bearer " prefix). AMF does not return
 * phone numbers, so `phone` is always undefined.
 */
export class AnymailFinderEnricher implements ContactEnricher {
  readonly name = "anymailfinder";

  async find(query: ContactQuery): Promise<ContactResult> {
    const payload: Record<string, string> = {};
    if (query.name) payload.full_name = query.name;
    const domain = query.domain ? normalizeDomain(query.domain) : undefined;
    if (domain) payload.domain = domain;
    if (query.company) payload.company_name = query.company;
    if (query.linkedinUrl) payload.linkedin_url = query.linkedinUrl;

    // Needs at least a LinkedIn URL, or a name + (domain|company).
    const hasNameAndCompany = Boolean(payload.full_name && (payload.domain || payload.company_name));
    if (!payload.linkedin_url && !hasNameAndCompany) {
      return { source: this.name };
    }

    const body = await this.post(payload);
    if (!body) return { source: this.name };

    const status = typeof body.email_status === "string" ? body.email_status : undefined;
    const valid = typeof body.valid_email === "string" ? body.valid_email : undefined;
    const found = typeof body.email === "string" ? body.email : undefined;

    // Prefer the verified email; accept a "risky" catch-all as best-effort.
    let email: string | undefined;
    if (valid && valid.includes("@")) email = valid;
    else if (found && found.includes("@") && status === "risky") email = found;

    return { email, source: this.name };
  }

  private async post(payload: Record<string, string>): Promise<Record<string, unknown> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: env.ANYMAILFINDER_API_KEY,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
        cache: "no-store",
        signal: controller.signal,
      });
      const text = await res.text();
      const json = text ? safeJson(text) : null;
      if (!res.ok) {
        log.warn("anymailfinder non-ok", { status: res.status, body: json });
        return null;
      }
      return (json as Record<string, unknown>) ?? null;
    } catch (err) {
      log.error("anymailfinder request failed", err);
      return null;
    } finally {
      clearTimeout(timer);
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
