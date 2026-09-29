/**
 * Runs before every integration test file (vitest `setupFiles`). A developer's shell can hold the variables that point
 * the agent at a hosted app, a destination or a shared budget store: the ones docs/agents.md tells a user to export,
 * and the Upstash credentials `vercel env pull` and direnv bring along. Left in place, the CLI, MCP and parity tests
 * sent the fixture's loopback URLs to the hosted app, which refuses them, parity downloads landed outside the temporary
 * tree, and the API tests spent units of the production scan and byte budgets on every run. CI sets none of them, so
 * this only makes a local run behave like CI's. A child process a test spawns inherits the cleaned environment.
 */
const AMBIENT = [
  "ASSETS_SCRAPER_REMOTE",
  "ASSETS_SCRAPER_TOKEN",
  "ASSETS_SCRAPER_ACCESS_CODE",
  "ASSETS_SCRAPER_OUT",
  "ASSETS_SCRAPER_BUILD_ID",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "VERCEL",
];

for (const name of AMBIENT) delete process.env[name];
