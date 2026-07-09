import { env } from "@/lib/env";

/**
 * All scheduling math is done in the configured TZ (env.TZ). We derive the
 * wall-clock date and hour via Intl so it's correct regardless of the host
 * clock's zone.
 */

function parts(date = new Date()): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: env.TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return out;
}

/** Calendar date "YYYY-MM-DD" in the configured TZ. */
export function todayInTz(date = new Date()): string {
  const p = parts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Fractional hour-of-day (0..24) in the configured TZ. */
export function hourFractionInTz(date = new Date()): number {
  const p = parts(date);
  const h = Number(p.hour === "24" ? "0" : p.hour);
  const m = Number(p.minute);
  const s = Number(p.second);
  return h + m / 60 + s / 3600;
}

export interface EnrichWindow {
  start: number;
  end: number;
  hour: number;
  inWindow: boolean;
  /** fraction [0..1] of the window elapsed (0 before start, 1 after end) */
  elapsedFraction: number;
}

export function enrichWindow(date = new Date()): EnrichWindow {
  const start = env.ENRICH_WINDOW_START_HOUR;
  const end = env.ENRICH_WINDOW_END_HOUR;
  const hour = hourFractionInTz(date);
  const span = Math.max(1e-6, end - start);
  const elapsedFraction = Math.min(1, Math.max(0, (hour - start) / span));
  return {
    start,
    end,
    hour,
    inWindow: hour >= start && hour < end,
    elapsedFraction,
  };
}
