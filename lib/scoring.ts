import type {
  LeadEngagement,
  TopSignal,
  SignalBreakdown,
  ScoreResult,
} from "@/lib/types";
import { clamp } from "@/lib/utils";

/**
 * Pure scoring. icp_score is 0..1 while heat_score is 0..100 — they are
 * normalized INDEPENDENTLY. Heat is min-max normalized against the dataset
 * min/max supplied in ctx (gathered in a first pass over all leads).
 */

export interface ScoringLead {
  icpScore: number | null;
  icpFit: string | null;
  heatScore: number | null;
  signalCount: number | null;
  signalBreakdown: SignalBreakdown | null;
  topSignals: TopSignal[] | null;
  engagements: LeadEngagement[] | null;
}

export interface ScoringContext {
  /** dataset-wide min/max of heat_score across leads that have one */
  heatMin: number;
  heatMax: number;
  /** reference "now" for recency; defaults to current time */
  now?: Date;
}

const DAY_MS = 86_400_000;

/** Latest engagement moment across engagements[] and top_signals[]. */
export function deriveLastEngagementAt(lead: {
  engagements: LeadEngagement[] | null;
  topSignals: TopSignal[] | null;
}): Date | null {
  let latest = 0;
  for (const e of lead.engagements ?? []) {
    const d = e?.date ? Date.parse(e.date) : NaN;
    if (Number.isFinite(d)) latest = Math.max(latest, d);
  }
  for (const s of lead.topSignals ?? []) {
    const d = s?.date ? Date.parse(s.date) : NaN;
    if (Number.isFinite(d)) latest = Math.max(latest, d);
  }
  return latest > 0 ? new Date(latest) : null;
}

/** Keys/type-substrings that indicate golden buyer intent. */
const INTENT_KEYS = ["lead_magnet_click", "email_capture", "lead_magnet", "email_click"];

function hasIntentSignal(lead: ScoringLead): boolean {
  const bd = lead.signalBreakdown ?? {};
  for (const key of Object.keys(bd)) {
    const v = bd[key];
    if (typeof v === "number" && v > 0) {
      const k = key.toLowerCase();
      if (INTENT_KEYS.some((ik) => k.includes(ik))) return true;
    }
  }
  for (const s of lead.topSignals ?? []) {
    const t = (s?.type ?? "").toLowerCase();
    if (INTENT_KEYS.some((ik) => t.includes(ik))) return true;
    // generic "click" that isn't a plain reaction/comment/repost counts as intent
    if (t.includes("click")) return true;
  }
  for (const e of lead.engagements ?? []) {
    const t = (e?.type ?? "").toLowerCase();
    if (INTENT_KEYS.some((ik) => t.includes(ik))) return true;
  }
  return false;
}

function hasRepost(lead: ScoringLead): boolean {
  if ((lead.signalBreakdown?.repost ?? 0) > 0) return true;
  if ((lead.topSignals ?? []).some((s) => (s?.type ?? "").toLowerCase().includes("repost")))
    return true;
  if ((lead.engagements ?? []).some((e) => (e?.type ?? "").toLowerCase().includes("repost")))
    return true;
  return false;
}

/* ── component scorers ── */

function scoreIcp(lead: ScoringLead): number {
  if (lead.icpScore != null && Number.isFinite(lead.icpScore)) {
    // icp_score is 0..1
    return clamp(lead.icpScore, 0, 1) * 40;
  }
  switch (lead.icpFit) {
    case "fit":
      return 40;
    case "maybe":
      return 20;
    default:
      return 0; // "not" | null
  }
}

function scoreHeat(lead: ScoringLead, ctx: ScoringContext): number {
  if (lead.heatScore != null && Number.isFinite(lead.heatScore)) {
    const range = ctx.heatMax - ctx.heatMin;
    if (range <= 0) {
      // Every lead shares one heat value — give full credit only if it's > 0.
      return lead.heatScore > 0 ? 30 : 0;
    }
    const norm = (lead.heatScore - ctx.heatMin) / range;
    return clamp(norm, 0, 1) * 30;
  }
  // Fallback: engagement count, log-normalized. log2(1+n)/log2(1+16) capped.
  const n = lead.engagements?.length ?? 0;
  if (n <= 0) return 0;
  const norm = Math.log2(1 + n) / Math.log2(1 + 16);
  return clamp(norm, 0, 1) * 30;
}

function scoreRecency(lead: ScoringLead, ctx: ScoringContext): number {
  const last = deriveLastEngagementAt(lead);
  if (!last) return 0;
  const now = ctx.now ?? new Date();
  const days = Math.max(0, (now.getTime() - last.getTime()) / DAY_MS);
  return 20 * Math.pow(0.5, days / 21);
}

function scoreIntent(lead: ScoringLead): number {
  let intent = 0;
  if (hasIntentSignal(lead)) intent += 10;
  if (hasRepost(lead)) intent += 3;
  return clamp(intent, 0, 10);
}

/* ── public entry ── */

export function score(lead: ScoringLead, ctx: ScoringContext): ScoreResult {
  const icp = round2(scoreIcp(lead));
  const heat = round2(scoreHeat(lead, ctx));
  const recency = round2(scoreRecency(lead, ctx));
  const intent = round2(scoreIntent(lead));
  const total = round2(icp + heat + recency + intent);
  return {
    score: clamp(total, 0, 100),
    breakdown: { icp, heat, recency, intent },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Compute dataset heat min/max for use as ScoringContext (first pass). */
export function heatBounds(
  leads: { heatScore: number | null }[]
): { heatMin: number; heatMax: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const l of leads) {
    if (l.heatScore != null && Number.isFinite(l.heatScore)) {
      min = Math.min(min, l.heatScore);
      max = Math.max(max, l.heatScore);
    }
  }
  if (!Number.isFinite(min)) {
    min = 0;
    max = 0;
  }
  return { heatMin: min, heatMax: max };
}
