import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import type { WebResearcher } from "./types";
import type { WebResearchResult, ResearchCitation } from "@/lib/types";

const log = createLogger("research:perplexity");
const ENDPOINT = "https://api.perplexity.ai/chat/completions";

/**
 * Perplexity "sonar" web researcher. One chat completion whose user message
 * bundles all queries; Perplexity returns a synthesized answer plus a
 * `citations` array of source URLs.
 */
export class PerplexityResearcher implements WebResearcher {
  readonly name = "perplexity";

  async research(queries: string[]): Promise<WebResearchResult> {
    const prompt = buildPrompt(queries);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.PERPLEXITY_API_KEY!}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          model: "sonar",
          messages: [
            {
              role: "system",
              content:
                "You are a precise B2B research assistant. Answer only with verifiable facts and always cite sources. If unsure, say so.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
        }),
        cache: "no-store",
      });

      const text = await res.text();
      const json = text ? (safeJson(text) as PerplexityResponse | null) : null;

      if (!res.ok || !json) {
        log.warn("perplexity non-ok", { status: res.status, body: json });
        return { summary: "", citations: [] };
      }

      const summary = json.choices?.[0]?.message?.content ?? "";
      const citations = extractCitations(json);
      return { summary, citations };
    } catch (err) {
      log.error("perplexity request failed", err);
      return { summary: "", citations: [] };
    }
  }
}

interface PerplexityResponse {
  choices?: { message?: { content?: string } }[];
  citations?: string[];
  search_results?: { title?: string; url?: string }[];
}

function extractCitations(json: PerplexityResponse): ResearchCitation[] {
  const out: ResearchCitation[] = [];
  // Newer responses: search_results with title+url.
  for (const s of json.search_results ?? []) {
    if (s?.url) out.push({ title: s.title || s.url, url: s.url });
  }
  // Older responses: flat citations url array.
  if (out.length === 0) {
    for (const url of json.citations ?? []) {
      if (typeof url === "string") out.push({ title: url, url });
    }
  }
  return dedupe(out);
}

function dedupe(cites: ResearchCitation[]): ResearchCitation[] {
  const seen = new Set<string>();
  const out: ResearchCitation[] = [];
  for (const c of cites) {
    if (!seen.has(c.url)) {
      seen.add(c.url);
      out.push(c);
    }
  }
  return out;
}

function buildPrompt(queries: string[]): string {
  return [
    "Research the following questions about a sales prospect and their company. Provide a concise, factual synthesis with citations.",
    "",
    ...queries.map((q, i) => `${i + 1}. ${q}`),
  ].join("\n");
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}
