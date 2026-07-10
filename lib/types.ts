/**
 * Shared domain types. Fully typed LeadShark payloads (no `any`), plus the
 * shapes we persist in jsonb columns and pass across the app/worker boundary.
 */

/* ───────────────────────── LeadShark: leads ───────────────────────── */

export interface IcpAnalysis {
  // LeadShark returns an opaque analysis object; keep it open but typed.
  summary?: string;
  reasons?: string[];
  [key: string]: unknown;
}

export interface LeadEngagement {
  type?: string; // e.g. "comment" | "reaction" | "repost" | "lead_magnet_click"
  date?: string; // ISO
  post_id?: string;
  source_url?: string;
  [key: string]: unknown;
}

export type IcpFit = "fit" | "maybe" | "not";

export interface Lead {
  id: string; // uuid
  name: string | null;
  title: string | null;
  linkedin_url: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
  commenter_id: string | null;
  post_id: string | null;
  linkedin_username: string | null;
  first_name: string | null;
  icp_score: number | null; // 0..1
  icp_analysis: IcpAnalysis | null;
  lead_type: string | null;
  engagements: LeadEngagement[];
  icp_fit: IcpFit | null;
  archived: boolean;
  enriched_profile: Record<string, unknown> | null;
  enriched_at: string | null;
  email: string | null;
}

export interface Pagination {
  total: number;
  page: number;
  limit: number;
  total_pages: number;
  has_more: boolean;
}

export interface ListLeadsResponse {
  data: Lead[];
  pagination: Pagination;
}

/* ───────────────────────── LeadShark: signals ───────────────────────── */

export interface SignalBreakdown {
  comment?: number;
  reaction?: number;
  repost?: number;
  profile_view?: number;
  lead_magnet_click?: number;
  email_capture?: number;
  [key: string]: number | undefined;
}

export interface TopSignal {
  type: string;
  date: string; // ISO
  source_url: string | null;
}

export interface Signal {
  id: string;
  actor_name: string | null;
  actor_linkedin_id: string | null;
  actor_linkedin_url: string | null;
  actor_profile_picture_url: string | null;
  heat_score: number; // ~0..100
  signal_count: number;
  signal_breakdown: SignalBreakdown;
  top_signals: TopSignal[];
  connection_status: string | null;
  first_seen_at: string | null;
  computed_at: string | null;
}

export interface SignalsPagination {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

export interface ListSignalsResponse {
  signals: Signal[];
  pagination: SignalsPagination;
}

/* ───────────────────── LeadShark: person enrichment ───────────────────── */

export interface PersonBasic {
  first_name: string | null;
  last_name: string | null;
  headline: string | null;
  location: string | null;
  public_identifier: string | null;
  follower_count: number | null;
  connections_count: number | null;
}

export interface PersonExperience {
  position: string | null;
  company: string | null;
  start: string | null;
  end: string | null;
}

export interface PersonEducation {
  school: string | null;
  degree: string | null;
}

export interface PersonSkill {
  name: string;
  endorsement_count: number | null;
}

export interface PersonLanguage {
  name: string;
  proficiency: string | null;
}

export interface PersonEnrichmentData {
  basic: PersonBasic;
  about: string | null;
  experience: PersonExperience[];
  education: PersonEducation[];
  skills: PersonSkill[];
  languages: PersonLanguage[];
}

export interface EnrichPersonResponse {
  success: boolean;
  data: PersonEnrichmentData;
  /**
   * Optional: the company LinkedIn slug the enricher resolved directly from the
   * person's profile (Scrapfly reads it from the profile's `worksFor` data).
   * LeadShark leaves this undefined and relies on the searchLinkedin name→slug
   * hop instead.
   */
  companySlug?: string | null;
}

/* ───────────────────── LeadShark: linkedin search ───────────────────── */

export interface LinkedinSearchResult {
  linkedin_id: string;
  name: string | null;
  headline: string | null;
}

export interface LinkedinSearchResponse {
  success: boolean;
  data: {
    results: LinkedinSearchResult[];
    total: number;
    returned: number;
  };
}

/* ───────────────────── LeadShark: company enrichment ───────────────────── */

export interface CompanyEnrichmentData {
  name: string | null;
  industry: string | null;
  company_size: string | null;
  headquarters: string | null;
  founded_year: number | null;
  follower_count: number | null;
}

export interface EnrichCompanyResponse {
  success: boolean;
  data: CompanyEnrichmentData;
}

/* ───────────────────────────── scoring ───────────────────────────── */

export interface ScoreBreakdown {
  icp: number; // 0..40
  heat: number; // 0..30
  recency: number; // 0..20
  intent: number; // 0..10
}

export interface ScoreResult {
  score: number; // 0..100
  breakdown: ScoreBreakdown;
}

/* ───────────────────────────── contact ───────────────────────────── */

export interface ContactResult {
  email?: string;
  phone?: string;
  source: string;
}

export interface ContactQuery {
  name?: string;
  linkedinUrl?: string;
  company?: string;
  domain?: string;
}

/* ───────────────────────────── research ───────────────────────────── */

export interface ResearchCitation {
  title: string;
  url: string;
}

export interface WebResearchResult {
  summary: string;
  citations: ResearchCitation[];
}

export interface ResearchStructured {
  snapshot?: string;
  company_overview?: string;
  signals_and_triggers?: string;
  fit?: string;
  outreach_angle?: string;
  suggested_opener?: string;
  [key: string]: unknown;
}
