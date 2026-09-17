import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { parseArgs, shouldRetry, summarize } from "./scan-sites.mjs";

const script = fileURLToPath(new URL("./scan-sites.mjs", import.meta.url));
const run = promisify(execFile);

/** A scan result as scanSite returns it, with only the fields summarize reads. */
const result = (over = {}) => ({
  site: "example.com", url: "https://example.com/", wallMs: 10,
  events: [], assets: [], fonts: [], pages: [], warnings: [],
  palette: undefined, done: null, error: null, badLines: [], ...over,
});

describe("parseArgs", () => {
  it("reports a flag given without a value instead of throwing on undefined", () => {
    expect(() => parseArgs(["--sites"])).toThrow("Missing value for --sites");
    expect(() => parseArgs(["--base"])).toThrow("Missing value for --base");
  });

  it("still reports an unknown flag", () => {
    expect(() => parseArgs(["--nope", "x"])).toThrow("Unknown option --nope");
    expect(() => parseArgs(["--nope"])).toThrow("Unknown option --nope");
  });

  it("reads values inline and as the next argument", () => {
    expect(parseArgs(["--base=http://localhost:3201/", "--sites", "a.com, b.com"])).toMatchObject({
      base: "http://localhost:3201", sites: ["a.com", "b.com"],
    });
  });
});

describe("shouldRetry", () => {
  it("retries a stream that died before the done event", () => {
    const truncated = summarize(result({ events: ["assets"], assets: [{ kind: "svg", role: "other" }] }));
    expect(truncated.status).toBe("truncated");
    expect(shouldRetry(truncated)).toBe(true);
  });

  it("retries a transport failure but not a real scan result", () => {
    expect(shouldRetry(summarize(result({ transport: "timeout after 1 ms" })))).toBe(true);
    expect(shouldRetry(summarize(result({ done: { type: "done", partial: false, stats: {} } })))).toBe(false);
  });
});

describe("main", () => {
  it("exits non zero and dates the run from its start when every site fails", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "scan-sites-"));
    const args = [script, "--base", "http://127.0.0.1:1", "--sites", "example.com", "--retries", "0", "--out", out];
    const failure = await run(process.execPath, args).then(() => null, (error) => error);
    expect(failure?.code).toBe(1);

    const summary = JSON.parse(await readFile(path.join(out, "summary.json"), "utf8"));
    expect(summary.rows[0].status).toBe("transport");
    expect(Date.parse(summary.startedAt)).toBeLessThanOrEqual(Date.parse(summary.finishedAt));
  }, 30_000);
});
