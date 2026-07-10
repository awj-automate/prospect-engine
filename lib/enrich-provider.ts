/**
 * Profile-enrichment provider seam.
 *
 * `enrich.ts` talks to whichever provider PROFILE_ENRICH_PROVIDER selects rather
 * than importing LeadShark directly, so the enrichment backend is a one-env-var
 * flip and stays A/B-able.
 *
 *   PROFILE_ENRICH_PROVIDER=leadshark  → authenticated LeadShark enrichment
 *   PROFILE_ENRICH_PROVIDER=scrapfly   → public LinkedIn scraping via Scrapfly
 *
 * Note: this only swaps profile/company *enrichment*. Lead sourcing + signals
 * (lib/sync.ts) always run on LeadShark — Scrapfly can't discover engagers.
 */

import { env } from "@/lib/env";
import { leadshark } from "@/lib/leadshark";
import { scrapfly } from "@/lib/scrapfly";
import type {
  EnrichPersonResponse,
  EnrichCompanyResponse,
  LinkedinSearchResponse,
} from "@/lib/types";

export interface ProfileEnricher {
  readonly name: string;
  enrichPerson(linkedinId: string, sections?: string): Promise<EnrichPersonResponse>;
  enrichCompany(linkedinId: string): Promise<EnrichCompanyResponse>;
  searchLinkedin(
    params: { company?: string; title?: string; keywords?: string },
    limit?: number
  ): Promise<LinkedinSearchResponse>;
}

const providers: Record<string, ProfileEnricher> = {
  leadshark: {
    name: "leadshark",
    enrichPerson: leadshark.enrichPerson,
    enrichCompany: leadshark.enrichCompany,
    searchLinkedin: leadshark.searchLinkedin,
  },
  scrapfly: {
    name: "scrapfly",
    enrichPerson: scrapfly.enrichPerson,
    enrichCompany: scrapfly.enrichCompany,
    searchLinkedin: scrapfly.searchLinkedin,
  },
};

/** The selected profile enricher (singleton per process). */
export function getProfileEnricher(): ProfileEnricher {
  return providers[env.PROFILE_ENRICH_PROVIDER] ?? providers.leadshark;
}
