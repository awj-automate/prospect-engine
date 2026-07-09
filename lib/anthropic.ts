import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";

// Model pinned by spec. Sonnet 4.6 uses adaptive thinking (budget_tokens is
// deprecated on 4.6); assistant prefills 400, so we never prefill.
export const BRIEF_MODEL = "claude-sonnet-4-6";

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}
