import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { sleep } from "@/lib/utils";
import type {
  ListLeadsResponse,
  ListSignalsResponse,
  EnrichPersonResponse,
  LinkedinSearchResponse,
  EnrichCompanyResponse,
  Lead,
  Signal,
} from "@/lib/types";

const log = createLogger("leadshark");

const BASE_URL = "https://apex.leadshark.io";

/* ─────────────────────── in-memory rate limiter ───────────────────────
 * Respects LeadShark's published limits: 100/min, 250/hr, 1000/day.
 * Sliding-window timestamp buckets. Shared across ALL endpoints since the
 * limits are account-wide. Both web and worker run their own process, so each
 * keeps its own limiter; the caps below are deliberately conservative and the
 * worker is the primary heavy caller.
 */
class RateLimiter {
  private minute: number[] = [];
  private hour: number[] = [];
  private day: number[] = [];

  private readonly perMinute = 100;
  private readonly perHour = 250;
  private readonly perDay = 1000;

  private prune(now: number) {
    this.minute = this.minute.filter((t) => now - t < 60_000);
    this.hour = this.hour.filter((t) => now - t < 3_600_000);
    this.day = this.day.filter((t) => now - t < 86_400_000);
  }

  /** ms until a slot frees up across all windows (0 if free now). */
  private waitMs(now: number): number {
    this.prune(now);
    const waits: number[] = [];
    if (this.minute.length >= this.perMinute) {
      waits.push(60_000 - (now - this.minute[0]));
    }
    if (this.hour.length >= this.perHour) {
      waits.push(3_600_000 - (now - this.hour[0]));
    }
    if (this.day.length >= this.perDay) {
      waits.push(86_400_000 - (now - this.day[0]));
    }
    return waits.length ? Math.max(0, Math.max(...waits)) : 0;
  }

  async acquire(): Promise<void> {
    // Loop because after sleeping, another caller may have taken the slot.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();
      const wait = this.waitMs(now);
      if (wait <= 0) {
        this.minute.push(now);
        this.hour.push(now);
        this.day.push(now);
        return;
      }
      log.warn("rate limit reached; waiting", { waitMs: wait });
      await sleep(Math.min(wait + 25, 60_000));
    }
  }
}

const limiter = new RateLimiter();

/* ─────────────────────── first-call debug logging ───────────────────────
 * On the FIRST call to each enrich endpoint, log the full request URL + raw
 * response once so params can be eyeball-verified against the live API.
 */
const loggedEndpoints = new Set<string>();

function maybeLogFirstCall(endpoint: string, url: string, raw: unknown) {
  if (loggedEndpoints.has(endpoint)) return;
  loggedEndpoints.add(endpoint);
  log.info(`FIRST-CALL VERIFY [${endpoint}]`, {
    requestUrl: url,
    rawResponse: raw,
  });
}

/* ─────────────────────── low-level request w/ backoff ─────────────────────── */

interface RequestOpts {
  method?: "GET" | "POST";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** endpoint key for first-call verify logging; omit to skip */
  verifyKey?: string;
  /** treat these status codes as a non-throwing signal to the caller */
  allowStatuses?: number[];
}

export class LeadSharkError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown
  ) {
    super(message);
    this.name = "LeadSharkError";
  }
}

function buildUrl(path: string, query?: RequestOpts["query"]): string {
  const url = new URL(path, BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }
  return url.toString();
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const { method = "GET", query, body, verifyKey, allowStatuses = [] } = opts;
  const url = buildUrl(path, query);

  const maxAttempts = 6;
  let attempt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    await limiter.acquire();

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "x-api-key": env.LEADSHARK_API_KEY,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        // No Next fetch cache for API calls.
        cache: "no-store",
      });
    } catch (netErr) {
      if (attempt >= maxAttempts) {
        throw new LeadSharkError(
          `network error after ${attempt} attempts: ${(netErr as Error).message}`,
          0
        );
      }
      const backoff = Math.min(2 ** attempt * 500, 30_000);
      log.warn("network error; backing off", { attempt, backoff, url });
      await sleep(backoff);
      continue;
    }

    // 429 → exponential backoff and retry.
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(2 ** attempt * 750, 60_000);
      log.warn("429 from LeadShark; backing off", { attempt, backoff, url });
      if (attempt >= maxAttempts) {
        throw new LeadSharkError("rate limited (429) after retries", 429);
      }
      await sleep(backoff);
      continue;
    }

    const rawText = await res.text();
    let parsed: unknown = undefined;
    if (rawText) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = rawText;
      }
    }

    if (verifyKey) maybeLogFirstCall(verifyKey, url, parsed);

    if (allowStatuses.includes(res.status)) {
      throw new LeadSharkError(
        `handled status ${res.status}`,
        res.status,
        parsed
      );
    }

    if (!res.ok) {
      // 5xx → retry a couple times; other 4xx → throw immediately.
      if (res.status >= 500 && attempt < maxAttempts) {
        const backoff = Math.min(2 ** attempt * 500, 20_000);
        log.warn("5xx from LeadShark; retrying", { status: res.status, attempt, backoff });
        await sleep(backoff);
        continue;
      }
      throw new LeadSharkError(
        `LeadShark ${method} ${path} failed: ${res.status}`,
        res.status,
        parsed
      );
    }

    return parsed as T;
  }
}

/* ───────────────────────────── typed methods ───────────────────────────── */

export interface ListLeadsParams {
  page?: number;
  limit?: number;
  lead_type?: string;
  source?: string;
}

async function listLeads(params: ListLeadsParams = {}): Promise<ListLeadsResponse> {
  const { page = 1, limit = 250, lead_type, source } = params;
  return request<ListLeadsResponse>("/api/leads", {
    method: "GET",
    query: { page, limit, lead_type, source },
  });
}

/** Paginate /api/leads until pagination.has_more === false. */
async function listAllLeads(params: Omit<ListLeadsParams, "page"> = {}): Promise<Lead[]> {
  const all: Lead[] = [];
  let page = 1;
  // Hard safety cap to avoid an infinite loop on a misbehaving API.
  for (let guard = 0; guard < 1000; guard++) {
    const res = await listLeads({ ...params, page });
    all.push(...(res.data ?? []));
    if (!res.pagination?.has_more) break;
    page = (res.pagination?.page ?? page) + 1;
  }
  log.info("listAllLeads complete", { count: all.length });
  return all;
}

export interface ListSignalsParams {
  page?: number;
  limit?: number;
  min_score?: number;
  sort?: string;
}

/** Returns null if the account is non-Apex (403) — caller must degrade gracefully. */
async function listSignals(
  params: ListSignalsParams = {}
): Promise<ListSignalsResponse | null> {
  const { page = 1, limit = 100, min_score, sort } = params;
  try {
    return await request<ListSignalsResponse>("/api/v1/signals", {
      method: "GET",
      query: { page, limit, min_score, sort },
      allowStatuses: [403],
    });
  } catch (err) {
    if (err instanceof LeadSharkError && err.status === 403) {
      log.warn("signals returned 403 (non-Apex account); skipping signals");
      return null;
    }
    throw err;
  }
}

/** Paginate all signals; returns null on 403 (non-Apex). */
async function listAllSignals(
  params: Omit<ListSignalsParams, "page"> = {}
): Promise<Signal[] | null> {
  const first = await listSignals({ ...params, page: 1 });
  if (first === null) return null; // non-Apex
  const all: Signal[] = [...(first.signals ?? [])];
  const totalPages = first.pagination?.total_pages ?? 1;
  for (let page = 2; page <= totalPages && page < 1000; page++) {
    const res = await listSignals({ ...params, page });
    if (res === null) break;
    all.push(...(res.signals ?? []));
  }
  log.info("listAllSignals complete", { count: all.length });
  return all;
}

/**
 * Person enrichment. COUNTS against the 50/day person cap.
 * `linkedinId` MUST be the vanity slug (lead.linkedin_username), e.g. "john-doe".
 */
async function enrichPerson(
  linkedinId: string,
  sections: string = env.PERSON_ENRICH_SECTIONS
): Promise<EnrichPersonResponse> {
  return request<EnrichPersonResponse>("/api/enrich/person", {
    method: "GET",
    query: {
      linkedin_id: linkedinId,
      linkedin_sections: sections || undefined,
    },
    verifyKey: "enrich/person",
  });
}

export interface LinkedinSearchParams {
  keywords?: string;
  title?: string;
  company?: string;
}

/** Resolve a company display-name to a slug. Does NOT count against caps. */
async function searchLinkedin(
  params: LinkedinSearchParams,
  limit = 10
): Promise<LinkedinSearchResponse> {
  return request<LinkedinSearchResponse>("/api/linkedin-search", {
    method: "POST",
    body: { params, limit },
    verifyKey: "linkedin-search",
  });
}

/**
 * Company enrichment. COUNTS against the 50/day company cap.
 * `linkedinId` MUST be the company slug, e.g. "google".
 */
async function enrichCompany(linkedinId: string): Promise<EnrichCompanyResponse> {
  return request<EnrichCompanyResponse>("/api/enrich/company", {
    method: "GET",
    query: { linkedin_id: linkedinId },
    verifyKey: "enrich/company",
  });
}

export const leadshark = {
  listLeads,
  listAllLeads,
  listSignals,
  listAllSignals,
  enrichPerson,
  searchLinkedin,
  enrichCompany,
};

export type LeadSharkClient = typeof leadshark;
