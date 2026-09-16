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
});
