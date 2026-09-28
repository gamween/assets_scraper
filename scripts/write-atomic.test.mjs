import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeAtomic } from "./write-atomic.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const root = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "write-atomic-"));
  roots.push(dir);
  return dir;
};

describe("writeAtomic", () => {
  it("writes the file and leaves nothing beside it", async () => {
    const dir = await root();
    const file = path.join(dir, "generated.ts");

    await writeAtomic(file, "export const A = 1;\n");

    expect(await readFile(file, "utf8")).toBe("export const A = 1;\n");
    expect(await readdir(dir)).toEqual(["generated.ts"]);
  });

  /**
   * Regression: the generated in-page modules were written with a plain `writeFile`, so the esbuild of a second MCP
   * launcher rebuilding at the same time could read one of them half written. A reader here only ever sees one whole
   * version, which is the property the rename buys. The old content is megabytes, which is what a plain write needs to
   * be caught in the act; the assertion cannot fail on a correct write however the reads land.
   */
  it("never shows a reader part of one version and part of another", async () => {
    const dir = await root();
    const file = path.join(dir, "collector.ts");
    const before = `export const SOURCE = "${"a".repeat(4_000_000)}";\n`;
    const after = `export const SOURCE = "${"b".repeat(4_000_000)}";\n`;
    await writeFile(file, before);

    let reading = true;
    const seen = new Set();
    const reads = (async () => {
      while (reading) {
        try {
          seen.add(readFileSync(file, "utf8"));
        } catch {
          // The file is never missing here, but a reader that found it missing would be a different failure
          seen.add("missing");
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    await writeAtomic(file, after);
    reading = false;
    await reads;

    expect([...seen].every((content) => content === before || content === after)).toBe(true);
    expect(await readFile(file, "utf8")).toBe(after);
  });

  it("leaves the last good file and no temporary behind when the write fails", async () => {
    const dir = await root();
    const file = path.join(dir, "generated.ts");
    await writeFile(file, "export const A = 1;\n");

    // Content node cannot write, so the write throws once the temporary name is taken
    await expect(writeAtomic(file, { length: -1 })).rejects.toThrow();

    expect(await readFile(file, "utf8")).toBe("export const A = 1;\n");
    expect(await readdir(dir)).toEqual(["generated.ts"]);
  });
});
