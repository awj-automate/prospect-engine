import { env } from "@/lib/env";
import type { ContactEnricher } from "./types";
import { LeadMagicEnricher } from "./leadmagic";
import { FindymailEnricher } from "./findymail";

let cached: ContactEnricher | null = null;

/** Returns the configured contact enricher (singleton). */
export function getContactEnricher(): ContactEnricher {
  if (cached) return cached;
  cached =
    env.CONTACT_PROVIDER === "findymail"
      ? new FindymailEnricher()
      : new LeadMagicEnricher();
  return cached;
}

export type { ContactEnricher };
