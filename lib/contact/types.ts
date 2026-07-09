import type { ContactQuery, ContactResult } from "@/lib/types";

export type { ContactQuery, ContactResult };

export interface ContactEnricher {
  readonly name: string;
  find(query: ContactQuery): Promise<ContactResult>;
}

/** Best-effort: pull a bare domain out of a company name or URL. */
export function guessDomain(query: ContactQuery): string | undefined {
  if (query.domain) return normalizeDomain(query.domain);
  return undefined;
}

export function normalizeDomain(input: string): string | undefined {
  const s = input.trim().toLowerCase();
  if (!s) return undefined;
  try {
    if (s.startsWith("http")) return new URL(s).hostname.replace(/^www\./, "");
  } catch {
    /* fall through */
  }
  return s.replace(/^www\./, "");
}

export function splitName(name?: string): { first?: string; last?: string } {
  if (!name) return {};
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}
