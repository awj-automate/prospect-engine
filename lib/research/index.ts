import { env } from "@/lib/env";
import type { WebResearcher } from "./types";
import { PerplexityResearcher } from "./perplexity";
import { LinkupResearcher } from "./linkup";

let cached: WebResearcher | null = null;

export function getWebResearcher(): WebResearcher {
  if (cached) return cached;
  cached =
    env.WEB_RESEARCH_PROVIDER === "linkup"
      ? new LinkupResearcher()
      : new PerplexityResearcher();
  return cached;
}

export type { WebResearcher };
