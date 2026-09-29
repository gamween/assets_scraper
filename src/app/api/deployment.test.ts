import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { limits } from "@/server/config/limits";

/**
 * The functions' limits live in `vercel.json` and only there. A route file exports no `maxDuration`, `runtime` or
 * `dynamic` of its own: Node is the default runtime, a route handler is dynamic unless it opts out, and a timeout set in
 * two places is raised in one and left in the other. `supportsCancellation`, which only `vercel.json` can set, is what
 * lets a scan hear its caller leave.
 */

const ROOT = path.resolve(import.meta.dirname, "../../..");
const vercel = JSON.parse(readFileSync(path.join(ROOT, "vercel.json"), "utf8")) as {
  functions: Record<string, { maxDuration: number; supportsCancellation?: boolean }>;
};
const routes = readdirSync(path.join(ROOT, "src/app"), { recursive: true, encoding: "utf8" })
  .filter((file) => /(^|\/)route\.ts$/.test(file))
  .map((file) => `src/app/${file}`);

describe("vercel.json functions", () => {
  it("names only route files that exist", () => {
    for (const file of Object.keys(vercel.functions)) expect(existsSync(path.join(ROOT, file)), file).toBe(true);
  });

  it("gives every route that runs a browser room past the scan deadline, and lets it hear the caller leave", () => {
    for (const route of ["src/app/api/scan/route.ts", "src/app/api/v1/scan/route.ts", "src/app/api/v1/assets.zip/route.ts"]) {
      expect(vercel.functions[route].maxDuration * 1000, route).toBeGreaterThanOrEqual(limits.scanDeadlineMs + 20_000);
      expect(vercel.functions[route].supportsCancellation, route).toBe(true);
    }
    expect(vercel.functions["src/app/api/asset/route.ts"].maxDuration * 1000).toBeGreaterThan(limits.proxyTimeoutMs);
  });

  it.each(routes)("is the only place %s gets its function config", (route) => {
    expect(readFileSync(path.join(ROOT, route), "utf8")).not.toMatch(/export const (maxDuration|runtime|dynamic|preferredRegion)\b/);
  });
});
