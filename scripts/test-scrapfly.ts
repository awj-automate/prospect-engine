/**
 * Standalone smoke test for the Scrapfly LinkedIn enricher.
 *
 * Runs against the REAL Scrapfly API — no database, no full app env. It only
 * needs SCRAPFLY_API_KEY (and optionally SCRAPFLY_COUNTRY / SCRAPFLY_RENDER_JS).
 *
 * Usage (env auto-loaded from .env.local by the npm script):
 *   pnpm test:scrapfly                         # defaults: Bill Gates + Microsoft
 *   pnpm test:scrapfly <profileSlugOrUrl>      # e.g. williamhgates
 *   pnpm test:scrapfly <profileSlug> <company> # e.g. williamhgates microsoft
 *
 * Or directly, passing the key inline:
 *   SCRAPFLY_API_KEY=... tsx scripts/test-scrapfly.ts williamhgates
 *   (PowerShell: $env:SCRAPFLY_API_KEY="..."; tsx scripts/test-scrapfly.ts williamhgates)
 *
 * Each person + company scrape spends Scrapfly credits, so this hits the network
 * at most twice per run.
 */

import { scrapfly, slugFromCompanyUrl } from "@/lib/scrapfly";

function show(title: string, value: unknown) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  if (!process.env.SCRAPFLY_API_KEY) {
    console.error(
      "✗ SCRAPFLY_API_KEY is not set.\n" +
        "  Add it to .env.local (then: pnpm test:scrapfly), or pass it inline:\n" +
        '    PowerShell:  $env:SCRAPFLY_API_KEY="scp-live-..."; tsx scripts/test-scrapfly.ts\n'
    );
    process.exit(1);
  }

  const profile = process.argv[2] ?? "williamhgates";
  const companyArg = process.argv[3];

  console.log(`Scrapfly enricher smoke test`);
  console.log(`  country:   ${process.env.SCRAPFLY_COUNTRY ?? "us"}`);
  console.log(`  render_js: ${process.env.SCRAPFLY_RENDER_JS ?? "false"}`);
  console.log(`  profile:   ${profile}`);

  // ── person ──
  const person = await scrapfly.enrichPerson(profile);
  show("PERSON enrichment", person.data);
  console.log(`\n→ companySlug resolved from profile: ${person.companySlug ?? "(none)"}`);

  // ── company ── (explicit arg wins; otherwise use the slug read off the profile)
  const companySlug = companyArg ?? person.companySlug;
  if (!companySlug) {
    console.log("\nNo company slug to enrich (profile had no resolvable employer). Done.");
    return;
  }
  console.log(`\nEnriching company: ${companySlug}`);
  const company = await scrapfly.enrichCompany(companySlug);
  show("COMPANY enrichment", company.data);

  // sanity: prove the slug helper is doing what we think
  const sample = slugFromCompanyUrl("https://www.linkedin.com/company/microsoft/");
  console.log(`\n(slug helper check: microsoft url → "${sample}")`);
  console.log("\n✓ done");
}

main().catch((err) => {
  console.error("\n✗ test failed:", err);
  process.exit(1);
});
