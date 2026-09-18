import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { isEdgeDenial, isFailure, parseArgs, shouldRetry, summarize } from "./scan-sites.mjs";

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

  it("rejects a --sites value that names no site instead of scanning nothing", () => {
    expect(() => parseArgs(["--sites", ""])).toThrow("--sites must name at least one site");
    expect(() => parseArgs(["--sites", ", ,"])).toThrow("--sites must name at least one site");
  });

  it("keeps the expected block on g2.com by default and lets --expect-blocked clear it", () => {
    expect(parseArgs([]).expectBlocked).toEqual(["g2.com"]);
    expect(parseArgs(["--expect-blocked", "a.com,b.com"]).expectBlocked).toEqual(["a.com", "b.com"]);
    expect(parseArgs(["--expect-blocked", ""]).expectBlocked).toEqual([]);
  });
});

describe("isFailure", () => {
  const row = (over) => ({ site: "g2.com", status: "error", error: { code: "blocked" }, ...over });

  it("does not fail the run on the expected block", () => {
    expect(isFailure(row(), ["g2.com"])).toBe(false);
    expect(isFailure(row({ site: "stripe.com" }), ["g2.com"])).toBe(true);
    expect(isFailure(row(), [])).toBe(true);
  });

  it("still fails when an expected-blocked site breaks another way", () => {
    expect(isFailure(row({ status: "transport", error: { code: "transport" } }), ["g2.com"])).toBe(true);
    expect(isFailure(row({ status: "truncated", error: null }), ["g2.com"])).toBe(true);
    expect(isFailure(row({ status: "error", error: { code: "internal" } }), ["g2.com"])).toBe(true);
  });

  it("passes a scan result whatever the site", () => {
    expect(isFailure(row({ status: "done", error: null }), [])).toBe(false);
    expect(isFailure(row({ status: "partial", error: null }), [])).toBe(false);
  });
});

describe("isEdgeDenial", () => {
  it("tells the edge rate limit apart from a scan that failed", () => {
    expect(isEdgeDenial({ status: 429, code: "429", message: "Too Many Requests", mitigated: "deny" })).toBe(true);
    // The app's own rate-limited error is an ApiError with a 429 body but no mitigation header.
    expect(isEdgeDenial({ status: 429, code: "429", message: "Too Many Requests", mitigated: null })).toBe(true);
    expect(isEdgeDenial({ status: 503, code: "busy", message: "All browsers are busy", mitigated: null })).toBe(false);
    expect(isEdgeDenial(undefined)).toBe(false);
  });
});

describe("summarize", () => {
  it("falls back to the collected events when a done event carries no stats", () => {
    const row = summarize(result({
      events: ["assets", "fonts", "done"],
      assets: [{ kind: "svg", role: "other" }, { kind: "image", role: "other" }],
      fonts: [{ usedOnPage: true }],
      done: { type: "done", partial: false },
    }));
    expect(row.status).toBe("done");
    expect(row.durationMs).toBe(null);
    expect(row.counts).toMatchObject({ assets: 2, svg: 1, images: 1, fonts: 1 });
    expect(row.hidden).toEqual({});
    expect(row.hiddenTotal).toBe(0);
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

/** A stub /api/scan that answers every site with one NDJSON error event. */
const blockingServer = async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.end(`${JSON.stringify({ type: "error", code: "blocked", message: "The site blocked the scan", httpStatus: 403 })}\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
};

/** The Vercel WAF answer: a bare 429 from the edge, whose body is not an ApiError, before the function runs. */
const denyingServer = async () => {
  const server = createServer((request, response) => {
    response.writeHead(429, { "content-type": "application/json", "x-vercel-mitigated": "deny" });
    response.end(JSON.stringify({ error: { code: "429", message: "Too Many Requests" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
};

/** A stub /api/scan that streams the given NDJSON lines verbatim. */
const streamingServer = async (lines) => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.end(lines.map((line) => `${line}\n`).join(""));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
};

describe("main", () => {
  it("skips NDJSON lines that are valid JSON but not events, instead of losing the scan", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "scan-sites-"));
    // `null` is the damaging one: reading `.type` off it used to throw and turn the whole scan into a transport failure.
    const server = await streamingServer([
      "null",
      "42",
      '"a string"',
      "[1, 2]",
      JSON.stringify({ type: "done", partial: false, stats: { durationMs: 7, assets: 0, svg: 0, images: 0, fonts: 0, hidden: {} } }),
    ]);
    try {
      const args = [script, "--base", server.base, "--sites", "example.com", "--retries", "0", "--out", out];
      await run(process.execPath, args);

      const summary = JSON.parse(await readFile(path.join(out, "summary.json"), "utf8"));
      expect(summary.rows[0].status).toBe("done");
      expect(summary.rows[0].durationMs).toBe(7);
      expect(summary.rows[0].badLines).toEqual(["null", "42", '"a string"', "[1, 2]"]);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("does not fail the run when the only site without a result is blocked as expected", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "scan-sites-"));
    const server = await blockingServer();
    try {
      const args = [script, "--base", server.base, "--sites", "g2.com", "--retries", "0", "--out", out];
      const { stdout } = await run(process.execPath, args);
      expect(stdout).toContain("Blocked as expected: g2.com");

      const summary = JSON.parse(await readFile(path.join(out, "summary.json"), "utf8"));
      expect(summary.rows[0].error.code).toBe("blocked");

      const other = [script, "--base", server.base, "--sites", "stripe.com", "--retries", "0", "--out", out];
      const failure = await run(process.execPath, other).then(() => null, (error) => error);
      expect(failure?.code).toBe(1);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("reports an edge denial as never scanned, apart from the sites without a scan result", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "scan-sites-"));
    const server = await denyingServer();
    try {
      const args = [script, "--base", server.base, "--sites", "stripe.com", "--retries", "0", "--out", out];
      const failure = await run(process.execPath, args).then(() => null, (error) => error);
      expect(failure?.code).toBe(1);
      expect(failure?.stdout).toContain("Denied by the edge rate limit, never scanned: stripe.com");
      expect(failure?.stdout).not.toContain("Sites without a scan result");

      const summary = JSON.parse(await readFile(path.join(out, "summary.json"), "utf8"));
      expect(summary.rows[0].status).toBe("edge-denied");
    } finally {
      await server.close();
    }
  }, 30_000);

  it("paces a sweep so it stays under the edge rate limit", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "scan-sites-"));
    const server = await streamingServer([JSON.stringify({ type: "done", partial: false, stats: { durationMs: 1, assets: 0, svg: 0, images: 0, fonts: 0, hidden: {} } })]);
    try {
      const args = [script, "--base", server.base, "--sites", "a.com,b.com,c.com", "--retries", "0", "--pace", "2", "--pace-window", "1200", "--out", out];
      const started = Date.now();
      const { stdout } = await run(process.execPath, args);
      expect(stdout).toContain("Pacing: 2 scans done, waiting");
      // Two scans, then the rest of the first window, then the third.
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);

      const summary = JSON.parse(await readFile(path.join(out, "summary.json"), "utf8"));
      expect(summary.rows.map((row) => row.status)).toEqual(["done", "done", "done"]);
    } finally {
      await server.close();
    }
  }, 30_000);

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
