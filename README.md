# Prospect Engine

Internal lead-qualification and research tool built on the **LeadShark / Apex** engagement layer.
Ingests leads captured from LinkedIn lead-magnet posts, scores them, drip-enriches them within
strict rate limits, and generates on-demand AI research briefs.

Deploy-only. Runs on **Railway** as **two services from one repo**, against a **Neon Postgres** DB.

- **Stack:** Next.js 15 (App Router) · TypeScript · Tailwind + shadcn/ui · TanStack Query · Zod
- **DB:** Drizzle ORM + `postgres-js` against Neon's **pooled** connection · drizzle-kit migrations
- **AI:** `@anthropic-ai/sdk` (model `claude-sonnet-4-6`) for brief synthesis
- **Auth:** cookie-based single-password gate via middleware

---

## 1. Create the database (Neon)

1. Create a Neon project.
2. Copy the **POOLED** connection string (host contains `-pooler`) into `DATABASE_URL`.
   The app opens a small `postgres-js` pool with `prepare: false` (required for PgBouncer
   transaction pooling).

## 2. Deploy on Railway — two services, one repo

Create **two services** from this same GitHub repo, sharing all environment variables:

| Service    | Start command                    | Notes                                            |
| ---------- | -------------------------------- | ------------------------------------------------ |
| **web**    | `npm run migrate && next start`  | Runs migrations, then serves Next.js.            |
| **worker** | `tsx worker/index.ts`            | node-cron: sync every 6h, drip enricher every 5m. |

Build command for both: `npm run build` (the worker doesn't strictly need the Next build, but a
shared build keeps images identical). Enable **auto-deploy on push**.

> `npm run migrate` applies the pre-generated migration in `./drizzle` and exits. It is safe to run
> on every web boot (idempotent `IF NOT EXISTS` DDL).

### Environment variables (set on BOTH services)

Copy `.env.example`. All are validated at startup with Zod (fail-fast):

```
DATABASE_URL            Neon POOLED connection string
LEADSHARK_API_KEY       Apex / LeadShark API key (x-api-key header) — always required (lead source)
PROFILE_ENRICH_PROVIDER leadshark (default) | scrapfly — profile/company enrichment backend
SCRAPFLY_API_KEY        required if PROFILE_ENRICH_PROVIDER=scrapfly
SCRAPFLY_COUNTRY        default us — Scrapfly proxy country (ISO alpha-2)
SCRAPFLY_RENDER_JS      default false — spend Scrapfly credits on JS rendering (not needed for profiles)
ANTHROPIC_API_KEY       Claude API key (brief synthesis, claude-sonnet-4-6)
WEB_RESEARCH_PROVIDER   perplexity | linkup
PERPLEXITY_API_KEY      required if WEB_RESEARCH_PROVIDER=perplexity
LINKUP_API_KEY          required if WEB_RESEARCH_PROVIDER=linkup
ANYMAILFINDER_API_KEY   AnyMail Finder API key (email lookup)
APP_PASSWORD            single shared password for the cookie gate
CRON_SECRET             shared secret for internal/cron API calls (x-cron-secret header)
TZ                      default Europe/London — controls the enrichment window
DAILY_PERSON_ENRICH_CAP default 150  (LeadShark suggests ~200–250 profile views/day total)
DAILY_COMPANY_ENRICH_CAP default 75
ENRICH_WINDOW_START_HOUR default 8
ENRICH_WINDOW_END_HOUR   default 20
PERSON_ENRICH_SECTIONS   default "about,experience,education"
```

> **TZ controls the enrichment window.** Enrichment only runs between
> `ENRICH_WINDOW_START_HOUR` and `ENRICH_WINDOW_END_HOUR` in the configured timezone, paced so
> ~`DAILY_*_ENRICH_CAP` LinkedIn profile-views spread evenly across the window.

## 3. First run

On first deploy the **worker** kicks an initial sync ~5s after boot, paginating all LeadShark
leads and (if your account is Apex) all signals, then computes scores and auto-enqueues person
enrichment for the top-scored leads. You can also hit **Sync now** in the dashboard.

Open the web URL, sign in with `APP_PASSWORD`, and you're in.

---

## How it works

- **Sync** (worker, every 6h + manual): paginate leads + signals → join on `commenter_id ==
  actor_linkedin_id` → upsert → recompute **all** scores (two-pass; heat is min-max normalized
  against the dataset, independently of the 0–1 ICP score) → auto-enqueue `person` jobs for the
  top eligible leads. A `403` on the Apex-only signals endpoint is logged once and skipped — sync
  never breaks; scoring falls back to each lead's `icp_score`.
- **Drip enricher** (worker, every 5m): within the window, processes just enough
  highest-priority pending jobs to hit the even-pacing target, never exceeding the daily caps.
  Two-hop company enrichment is modelled as its own `company_resolve` step (name → slug via
  LinkedIn search) so it's observable and retryable. `searchLinkedin` and contact enrichment do
  **not** count against the LinkedIn profile-view caps.
- **Research brief** (web, on demand): runs inline (Railway has no serverless timeout) and streams
  progress via SSE — ensure person + company enrichment → optional contact → 3–5 web-research
  queries → Claude synthesis into Snapshot / Company Overview / Signals & Triggers / Fit /
  Outreach Angle / Suggested Opener. Stored as markdown + structured JSON + citations.

### Enrichment provider: LeadShark vs Scrapfly

Profile/company **enrichment** is pluggable via `PROFILE_ENRICH_PROVIDER` (`lib/enrich-provider.ts`).
Lead **sourcing** (engagement discovery + heat signals in `lib/sync.ts`) always stays on LeadShark —
Scrapfly can't discover who engaged with a post.

- `leadshark` (default): authenticated enrichment. Full experience history, skills, connections.
- `scrapfly`: scrapes **public** LinkedIn profile/company pages via the Scrapfly Web Scraping API —
  no LinkedIn login. Data is thinner: name, headline, about, current/most-recent employer (+ its
  company slug, read straight off the profile so the `company_resolve` search hop is skipped),
  education, languages, follower count. **No skills**, usually **no full work history**, no
  connection count. Set `SCRAPFLY_API_KEY` and flip `PROFILE_ENRICH_PROVIDER=scrapfly`.

Smoke-test Scrapfly against the live API without touching the DB (spends ≤2 Scrapfly credits/run):

```
pnpm test:scrapfly                    # defaults: williamhgates + microsoft (needs SCRAPFLY_API_KEY in .env.local)
pnpm test:scrapfly <profileSlug> [companySlug]
```

### Local-only helpers (not needed to deploy)

- `npm run db:generate` — regenerate a migration after editing `lib/db/schema.ts`.
- `npm run migrate` — apply migrations manually.
- `npm run typecheck` — `tsc --noEmit`.
- `pnpm test:scrapfly` — live smoke test of the Scrapfly enricher (see above).

### Verifying the LeadShark `linkedin_id` param

The LeadShark client logs the full request URL + raw response **once** on the first call to each
enrich endpoint (`enrich/person`, `enrich/company`, `linkedin-search`). Check the **worker logs**
after the first enrichment to eyeball-verify the params against the live API.
