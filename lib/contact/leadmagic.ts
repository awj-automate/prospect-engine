import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import type { ContactEnricher, ContactQuery, ContactResult } from "./types";
import { splitName, normalizeDomain } from "./types";

const log = createLogger("contact:leadmagic");
const BASE = "https://api.leadmagic.io";

/**
 * LeadMagic contact enricher.
 * Preferred path when we have a LinkedIn URL: profile → email. Otherwise fall
 * back to name + domain email finder. Header auth is `X-API-Key`.
 *
 * NOTE: response shapes are defensive (optional chaining across a few known
 * field names) so a minor API drift degrades to "no result", never a throw.
 */
export class LeadMagicEnricher implements ContactEnricher {
  readonly name = "leadmagic";

  async find(query: ContactQuery): Promise<ContactResult> {
    // 1) If we have a LinkedIn URL, try the profile→email route first.
    if (query.linkedinUrl) {
      const viaProfile = await this.byLinkedin(query.linkedinUrl);
      if (viaProfile?.email) {
        return { email: viaProfile.email, phone: viaProfile.phone, source: this.name };
      }
    }

    // 2) Fall back to name + domain email finder.
    const { first, last } = splitName(query.name);
    const domain = query.domain ? normalizeDomain(query.domain) : undefined;
    if (first && last && domain) {
      const viaName = await this.byName(first, last, domain);
      if (viaName?.email) {
        return { email: viaName.email, phone: viaName.phone, source: this.name };
      }
    }

    return { source: this.name };
  }

  private async byLinkedin(url: string): Promise<{ email?: string; phone?: string } | null> {
    const body = await this.post("/b2b-social-email", { profile_url: url });
    if (!body) return null;
    return {
      email: pickEmail(body),
      phone: pickPhone(body),
    };
  }

  private async byName(
    first: string,
    last: string,
    domain: string
  ): Promise<{ email?: string; phone?: string } | null> {
    const body = await this.post("/email-finder", {
      first_name: first,
      last_name: last,
      domain,
    });
    if (!body) return null;
    return { email: pickEmail(body), phone: pickPhone(body) };
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: {
          "X-API-Key": env.LEADMAGIC_API_KEY!,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
        cache: "no-store",
      });
      const text = await res.text();
      const json = text ? safeJson(text) : null;
      if (!res.ok) {
        log.warn("leadmagic non-ok", { path, status: res.status, body: json });
        return null;
      }
      return (json as Record<string, unknown>) ?? null;
    } catch (err) {
      log.error("leadmagic request failed", err);
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

function pickEmail(body: Record<string, unknown>): string | undefined {
  const candidates = [body.email, (body.data as Record<string, unknown>)?.email];
  for (const c of candidates) {
    if (typeof c === "string" && c.includes("@")) return c;
  }
  // LeadMagic sometimes returns status "valid" with an email field.
  const status = typeof body.email_status === "string" ? body.email_status : undefined;
  if (status && status !== "valid" && status !== "catch_all") return undefined;
  return undefined;
}

function pickPhone(body: Record<string, unknown>): string | undefined {
  const candidates = [body.phone, body.mobile, (body.data as Record<string, unknown>)?.phone];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return undefined;
}
