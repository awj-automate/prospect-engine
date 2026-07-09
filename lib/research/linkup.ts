import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import type { WebResearcher } from "./types";
import type { WebResearchResult, ResearchCitation } from "@/lib/types";

const log = createLogger("research:linkup");
const ENDPOINT = "https://api.linkup.so/v1/search";

/**
 * Linkup web researcher. Uses `outputType: "sourcedAnswer"` so a single call
 * returns a synthesized answer plus the sources it drew from.
 */
export class LinkupResearcher implements WebResearcher {
  readonly name = "linkup";

  async research(queries: string[]): Promise<WebResearchResult> {
    const q = queries.join("\n");
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.LINKUP_API_KEY!}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          q,
          depth: "standard",
          outputType: "sourcedAnswer",
        }),
        cache: "no-store",
      });

      const text = await res.text();
      const json = text ? (safeJson(text) as LinkupResponse | null) : null;

      if (!res.ok || !json) {
        log.warn("linkup non-ok", { status: res.status, body: json });
        return { summary: "", citations: [] };
      }

      const summary = json.answer ?? "";
      const citations: ResearchCitation[] = (json.sources ?? [])
        .filter((s) => s?.url)
        .map((s) => ({ title: s.name || s.url!, url: s.url! }));
      return { summary, citations };
    } catch (err) {
      log.error("linkup request failed", err);
      return { summary: "", citations: [] };
    }
  }
}

interface LinkupResponse {
  answer?: string;
  sources?: { name?: string; url?: string; snippet?: string }[];
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}
