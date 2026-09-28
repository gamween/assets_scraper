import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The repo gates a performance guarantee on counted operations (`opGrowth`), not on wall time: a ratio of two timings
 * flakes, and one of the checks below failed CI on exactly that. The wall-clock helpers are still used in this folder,
 * which is why AGENTS.md calls them the exception rather than the rule. This test pins the exception so the wording
 * stays true: a new `growthFactor` or `fastestMs` call fails here, and the fix is a counted gate, or an edit to both
 * this list and AGENTS.md when wall time really is the only way to measure it.
 */

const HERE = path.join(process.cwd(), "src/server/scan/fonts");

/** Wall-clock measurements per test file, as they stand. Counts, not line numbers, so an edit above one does not move it. */
const WALL_CLOCK: Record<string, number> = {
  // `resolveFamilyName` on hostile names
  "names.test.ts": 1,
  // parsing against tokenizing, the tokenizer's state between parses, rules per sheet, and hostile `src` values
  "css.test.ts": 6,
  // the opt-in benchmark of the hostile inputs, and the name-length check that reads two runs
  "index.test.ts": 3,
};

describe("the performance gate convention", () => {
  it("has no more wall-clock measurements in the font tests than AGENTS.md admits to", () => {
    const counts: Record<string, number> = {};
    for (const name of readdirSync(HERE)) {
      if (!name.endsWith(".test.ts") || name === "perf-convention.test.ts") continue;
      const source = readFileSync(path.join(HERE, name), "utf8");
      const found = source.match(/\b(?:growthFactor|fastestMs)\(/g)?.length ?? 0;
      if (found > 0) counts[name] = found;
    }
    expect(counts).toEqual(WALL_CLOCK);
  });
});
