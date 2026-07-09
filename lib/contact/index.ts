import type { ContactEnricher } from "./types";
import { AnymailFinderEnricher } from "./anymailfinder";

let cached: ContactEnricher | null = null;

/** Returns the contact enricher (AnyMail Finder, singleton). */
export function getContactEnricher(): ContactEnricher {
  if (!cached) cached = new AnymailFinderEnricher();
  return cached;
}

export type { ContactEnricher };
