/**
 * Scrapfly-backed LinkedIn enrichment.
 *
 * Drop-in replacement for the enrichment half of `lib/leadshark.ts`
 * (enrichPerson / enrichCompany / searchLinkedin). It scrapes *public* LinkedIn
 * profile and company pages through Scrapfly's Web Scraping API and parses the
 * `application/ld+json` block (plus a little HTML for company "About" fields)
 * into the same PersonEnrichmentData / CompanyEnrichmentData shapes the rest of
 * the app already persists.
 *
 * Design notes:
 *  - No LinkedIn login is used. Only publicly visible data is read.
 *  - This module reads its config straight from `process.env` (NOT @/lib/env)
 *    so it can be exercised standalone by scripts/test-scrapfly.ts without the
 *    full app env being present.
 *  - Public ld+json is thinner than LeadShark's authenticated enrichment: no
 *    skills, and usually only the current/most-recent experience. Fields that
 *    aren't present come back as null/[] rather than throwing.
 *  - The company slug is read for free from the profile's `worksFor` url, so we
 *    skip the (impossible for public users) LinkedIn search step entirely.
 */

import { parse, type HTMLElement } from "node-html-parser";
import { createLogger } from "@/lib/logger";
import { sleep } from "@/lib/utils";
import type {
  PersonEnrichmentData,
  CompanyEnrichmentData,
  EnrichPersonResponse,
  EnrichCompanyResponse,
  LinkedinSearchResponse,
  PersonExperience,
  PersonEducation,
  PersonLanguage,
} from "@/lib/types";

const log = createLogger("scrapfly");

const SCRAPE_URL = "https://api.scrapfly.io/scrape";

/* ─────────────────────────────── config ─────────────────────────────── */

interface ScrapflyConfig {
  apiKey: string;
  country: string;
  /** JS rendering costs extra Scrapfly credits; profiles/companies don't need it. */
  renderJs: boolean;
}

function loadConfig(): ScrapflyConfig {
  const apiKey = process.env.SCRAPFLY_API_KEY?.trim();
  if (!apiKey) {
    throw new ScrapflyError(
      "SCRAPFLY_API_KEY is not set (required to use the Scrapfly enricher)",
      0
    );
  }
  return {
    apiKey,
    country: process.env.SCRAPFLY_COUNTRY?.trim() || "us",
    renderJs: /^(1|true|yes)$/i.test(process.env.SCRAPFLY_RENDER_JS?.trim() ?? ""),
  };
}

let cachedConfig: ScrapflyConfig | null = null;
function config(): ScrapflyConfig {
  if (!cachedConfig) cachedConfig = loadConfig();
  return cachedConfig;
}

export class ScrapflyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown
  ) {
    super(message);
    this.name = "ScrapflyError";
  }
}

/* ─────────────────────── low-level scrape w/ backoff ─────────────────────── */

interface ScrapeApiBody {
  result?: {
    content?: string;
    status_code?: number;
    success?: boolean;
    reason?: string;
  };
}

/** Fetch a URL's rendered HTML through Scrapfly. Retries transient failures. */
async function scrape(targetUrl: string): Promise<string> {
  const cfg = config();
  const url = new URL(SCRAPE_URL);
  url.searchParams.set("key", cfg.apiKey);
  url.searchParams.set("url", targetUrl);
  // Anti-scraping-protection: rotates fingerprint/proxy to clear the bot walls.
  url.searchParams.set("asp", "true");
  url.searchParams.set("country", cfg.country);
  url.searchParams.set("headers[Accept-Language]", "en-US,en;q=0.9");
  if (cfg.renderJs) url.searchParams.set("render_js", "true");

  const maxAttempts = 5;
  let attempt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;

    let res: Response;
    try {
      res = await fetch(url, { method: "GET", cache: "no-store" });
    } catch (netErr) {
      if (attempt >= maxAttempts) {
        throw new ScrapflyError(
          `network error after ${attempt} attempts: ${(netErr as Error).message}`,
          0
        );
      }
      const backoff = Math.min(2 ** attempt * 500, 20_000);
      log.warn("network error; backing off", { attempt, backoff, targetUrl });
      await sleep(backoff);
      continue;
    }

    const text = await res.text();
    let body: ScrapeApiBody | undefined;
    try {
      body = text ? (JSON.parse(text) as ScrapeApiBody) : undefined;
    } catch {
      body = undefined;
    }

    // Scrapfly signals throttling/concurrency with 429; upstream hiccups with 5xx.
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= maxAttempts) {
        throw new ScrapflyError(`Scrapfly ${res.status} after retries`, res.status, body);
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoff =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(2 ** attempt * 750, 30_000);
      log.warn("Scrapfly transient error; backing off", {
        status: res.status,
        attempt,
        backoff,
      });
      await sleep(backoff);
      continue;
    }

    if (!res.ok) {
      throw new ScrapflyError(`Scrapfly request failed: ${res.status}`, res.status, body);
    }

    const result = body?.result;
    const scrapedStatus = result?.status_code;
    if (scrapedStatus === 404 || scrapedStatus === 410) {
      throw new ScrapflyError(
        `target page not found (${scrapedStatus})`,
        scrapedStatus,
        body
      );
    }
    if (!result?.content) {
      throw new ScrapflyError(
        `Scrapfly returned no content (reason: ${result?.reason ?? "unknown"})`,
        scrapedStatus ?? 0,
        body
      );
    }

    return result.content;
  }
}

/* ─────────────────────────── ld+json extraction ─────────────────────────── */

type Json = Record<string, unknown>;

function extractLdJson(root: HTMLElement): Json[] {
  const nodes = root.querySelectorAll('script[type="application/ld+json"]');
  const out: Json[] = [];
  for (const n of nodes) {
    const raw = n.text?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      // A single ld+json block may itself be a @graph container or an array.
      if (Array.isArray(parsed)) out.push(...(parsed as Json[]));
      else out.push(parsed as Json);
    } catch {
      /* skip malformed block */
    }
  }
  return out;
}

/** Flatten any `@graph` arrays and find the first node whose @type matches. */
function findByType(blocks: Json[], type: string): Json | null {
  const flat: Json[] = [];
  for (const b of blocks) {
    const graph = b["@graph"];
    if (Array.isArray(graph)) flat.push(...(graph as Json[]));
    else flat.push(b);
  }
  for (const node of flat) {
    const t = node["@type"];
    if (t === type) return node;
    if (Array.isArray(t) && t.includes(type)) return node;
  }
  return null;
}

/* ──────────────────────────── small coercions ──────────────────────────── */

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v];
}

/** LinkedIn ld+json exposes follower count via a FollowAction interaction counter. */
function extractFollowerCount(person: Json): number | null {
  for (const stat of asArray(person.interactionStatistic)) {
    const s = stat as Json;
    const kind = asStr(s.interactionType);
    const count = s.userInteractionCount;
    if (kind && /Follow/i.test(kind) && typeof count === "number") return count;
  }
  return null;
}

/** Pull the `/company/<slug>` slug out of a LinkedIn organization url. */
export function slugFromCompanyUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/company\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

/** Pull the `/in/<slug>` vanity slug out of a LinkedIn profile url. */
export function slugFromProfileUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

/* ───────────────────────────── person parsing ───────────────────────────── */

function parsePerson(html: string): { data: PersonEnrichmentData; companySlug: string | null } {
  const root = parse(html);
  const person = findByType(extractLdJson(root), "Person");
  if (!person) {
    throw new ScrapflyError("no Person ld+json found (page may be login-walled)", 0);
  }

  const fullName = asStr(person.name);
  const nameParts = fullName ? fullName.split(/\s+/) : [];
  const firstName = nameParts[0] ?? null;
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : null;

  const jobTitles = asArray(person.jobTitle).map(asStr).filter(Boolean) as string[];

  const address = (person.address as Json) ?? {};
  const location =
    [asStr(address.addressLocality), asStr(address.addressCountry)]
      .filter(Boolean)
      .join(", ") || null;

  const worksFor = asArray(person.worksFor).map((o) => o as Json);
  const experience: PersonExperience[] = worksFor.map((org, i) => ({
    position: i === 0 ? jobTitles[0] ?? null : null,
    company: asStr(org.name),
    start: memberDate(org, "startDate"),
    end: memberDate(org, "endDate"),
  }));

  const education: PersonEducation[] = asArray(person.alumniOf).map((o) => {
    const org = o as Json;
    return { school: asStr(org.name), degree: null };
  });

  const languages: PersonLanguage[] = asArray(person.knowsLanguage).map((l) => {
    const lang = l as Json;
    return { name: asStr(lang.name) ?? String(lang), proficiency: null };
  });

  const data: PersonEnrichmentData = {
    basic: {
      first_name: firstName,
      last_name: lastName,
      headline: jobTitles.join(", ") || asStr(person.description),
      location,
      public_identifier: slugFromProfileUrl(asStr(person.url)),
      follower_count: extractFollowerCount(person),
      connections_count: null, // not exposed in public ld+json
    },
    about: asStr(person.description),
    experience,
    education,
    skills: [], // public profiles don't ship skills in ld+json
    languages,
  };

  const companySlug = slugFromCompanyUrl(asStr(worksFor[0]?.url));
  return { data, companySlug };
}

/** LinkedIn wraps tenure dates inside a `member` OrganizationRole; dig it out. */
function memberDate(org: Json, key: "startDate" | "endDate"): string | null {
  const direct = asStr(org[key]);
  if (direct) return direct;
  for (const m of asArray(org.member)) {
    const d = asStr((m as Json)[key]);
    if (d) return d;
  }
  return null;
}

/* ───────────────────────────── company parsing ───────────────────────────── */

/** Build a { label -> value } map from the company "About" dt/dd definition list. */
function aboutMap(root: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  const sections = root.querySelectorAll('[data-test-id*="about-us"]');
  for (const section of sections) {
    const dts = section.querySelectorAll("dt");
    const dds = section.querySelectorAll("dd");
    for (let i = 0; i < dts.length; i++) {
      const label = dts[i]?.text?.trim();
      const value = dds[i]?.text?.replace(/\s+/g, " ").trim();
      if (label && value) out[label.toLowerCase()] = value;
    }
  }
  return out;
}

function firstMatch(map: Record<string, string>, ...needles: string[]): string | null {
  for (const [k, v] of Object.entries(map)) {
    if (needles.some((n) => k.includes(n))) return v;
  }
  return null;
}

function parseCompany(html: string): CompanyEnrichmentData {
  const root = parse(html);
  const org = findByType(extractLdJson(root), "Organization") ?? {};
  const about = aboutMap(root);

  const employees = (org.numberOfEmployees as Json) ?? {};
  const address = (org.address as Json) ?? {};
  const hqFromLd =
    [asStr(address.addressLocality), asStr(address.addressCountry)]
      .filter(Boolean)
      .join(", ") || null;

  const foundedRaw = firstMatch(about, "founded");
  const foundedYear = foundedRaw ? Number((foundedRaw.match(/\d{4}/) ?? [])[0]) : NaN;

  return {
    name: asStr(org.name) ?? firstMatch(about, "name"),
    industry: firstMatch(about, "industr"),
    company_size: firstMatch(about, "company size", "size") ?? asStr(employees.value),
    headquarters: firstMatch(about, "headquarter") ?? hqFromLd,
    founded_year: Number.isFinite(foundedYear) ? foundedYear : null,
    follower_count: extractFollowerCount(org),
  };
}

/* ─────────────────────────── public URL builders ─────────────────────────── */

function profileUrl(idOrUrl: string): string {
  if (/^https?:\/\//i.test(idOrUrl)) return idOrUrl;
  return `https://www.linkedin.com/in/${encodeURIComponent(idOrUrl)}/`;
}

function companyUrl(idOrUrl: string): string {
  const base = /^https?:\/\//i.test(idOrUrl)
    ? idOrUrl.replace(/\/+$/, "")
    : `https://www.linkedin.com/company/${encodeURIComponent(idOrUrl)}`;
  // The /about/ tab is where the ld+json + About definition list live.
  return /\/about\/?$/.test(base) ? base : `${base}/about/`;
}

/* ───────────────────────── LeadShark-compatible API ───────────────────────── */

/**
 * Person enrichment. `linkedinId` is the vanity slug (lead.linkedin_username),
 * e.g. "john-doe", or a full profile URL.
 */
async function enrichPerson(
  linkedinId: string,
  _sections?: string // accepted for interface parity; Scrapfly returns all public sections
): Promise<EnrichPersonResponse> {
  const html = await scrape(profileUrl(linkedinId));
  const { data, companySlug } = parsePerson(html);
  return { success: true, data, companySlug };
}

/**
 * Company enrichment. `linkedinId` is the company slug, e.g. "google", or a full
 * company URL.
 */
async function enrichCompany(linkedinId: string): Promise<EnrichCompanyResponse> {
  const html = await scrape(companyUrl(linkedinId));
  return { success: true, data: parseCompany(html) };
}

/**
 * Name→slug search. Public LinkedIn search is fully login-walled, so Scrapfly
 * can't do this. We resolve the company slug directly from the person's profile
 * instead (see enrichPerson → companySlug), so this returns empty and callers
 * degrade gracefully.
 */
async function searchLinkedin(
  _params: { company?: string; title?: string; keywords?: string },
  _limit = 10
): Promise<LinkedinSearchResponse> {
  log.warn("searchLinkedin is unsupported on Scrapfly (public search is login-walled)");
  return { success: true, data: { results: [], total: 0, returned: 0 } };
}

export const scrapfly = {
  enrichPerson,
  enrichCompany,
  searchLinkedin,
};

export type ScrapflyClient = typeof scrapfly;
