import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { TABLES, tablesSource } from "./build-cn-tables.mjs";

describe("cn tables", () => {
  // The page merges classes with these tables and nothing else: stale ones would merge by an old type scale, or by a
  // table format an upgraded engine no longer reads. `pnpm build:cn` writes them again.
  it("match the installed cn and cn-config.mjs", async () => {
    expect(readFileSync(TABLES, "utf8"), "cn-tables.ts is out of date: run pnpm build:cn").toBe(await tablesSource());
  }, 30_000);
});
