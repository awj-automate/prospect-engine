import type { WebResearchResult } from "@/lib/types";

export type { WebResearchResult };

export interface WebResearcher {
  readonly name: string;
  research(queries: string[]): Promise<WebResearchResult>;
}
