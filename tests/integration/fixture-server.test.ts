import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveFixture, type FixtureServer } from "../fixtures/serve";

let server: FixtureServer;
beforeAll(async () => {
  server = await serveFixture({ "/hello": (_req, res) => res.end("hi") });
});
afterAll(() => server.close());

describe("fixture server", () => {
  it("serves the site, assets and extra routes", async () => {
    const html = await fetch(`${server.origin}/`).then((r) => r.text());
    expect(html).toContain("<title>Fixture Co</title>");
    const font = await fetch(`${server.origin}/assets/__inter.woff2`);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(await fetch(`${server.origin}/hello`).then((r) => r.text())).toBe("hi");
    expect((await fetch(`${server.origin}/nope`)).status).toBe(404);
  });

  it("answers 400 to a malformed escape and keeps serving", async () => {
    expect((await fetch(`${server.origin}/%E0%A4%A`)).status).toBe(400);
    expect((await fetch(`${server.origin}/hello`)).status).toBe(200);
  });

  it("never serves files outside the root, including from a sibling directory with the same prefix", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fixture-root-"));
    await mkdir(path.join(dir, "site"));
    await mkdir(path.join(dir, "site-x"));
    await writeFile(path.join(dir, "site", "index.html"), "home");
    await writeFile(path.join(dir, "site-x", "secret.txt"), "secret");
    const scoped = await serveFixture({}, path.join(dir, "site"));
    try {
      expect(await fetch(`${scoped.origin}/`).then((r) => r.text())).toBe("home");
      expect((await fetch(`${scoped.origin}/..%2fsite-x%2fsecret.txt`)).status).toBe(404);
      expect((await fetch(`${scoped.origin}/..%2f..%2fetc%2fpasswd`)).status).toBe(404);
    } finally {
      await scoped.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
