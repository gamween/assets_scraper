import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrandFile } from "@/lib/contract";
import { SafeFetchError } from "@/server/net/safe-fetch";
import type { SafeFetch, SafeResponse } from "@/server/scan/types";
import { brandFileName, downloadBrandFiles } from "./brand-download";
import { agentLimitEnvName } from "./limits";
import { buildZip, TEST_PNG, TEST_SVG, testScan } from "./testing";
import type { AgentScan } from "./types";

let dir: string;
const restore: Record<string, string | undefined> = {};

const setLimit = (name: Parameters<typeof agentLimitEnvName>[0], value: number): void => {
  const variable = agentLimitEnvName(name);
  if (!(variable in restore)) restore[variable] = process.env[variable];
  process.env[variable] = String(value);
};

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-brand-")));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(restore)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete restore[name];
  }
});

type Answer = { status?: number; type?: string; body: Buffer | string } | Error;

/** A guarded fetch answering from `answers` by URL; an absent URL is a 404 page. */
const fakeFetch = (answers: Record<string, Answer>): SafeFetch & { urls: string[] } => {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    const answer = answers[url] ?? { status: 404, type: "text/html", body: "<!doctype html><title>Not found</title>" };
    if (answer instanceof Error) throw answer;
    const body = Buffer.from(answer.body);
    return { url, status: answer.status ?? 200, headers: new Headers({ "content-type": answer.type ?? "application/octet-stream" }), buffer: async () => body, cancel: async () => {} } as unknown as SafeResponse;
  }) as SafeFetch;
  return Object.assign(fetch, { urls });
};

const file = (id: string, url: string, name: string, type: BrandFile["type"]): BrandFile => ({ id, url, name, type, foundIn: "link" });

const KIT = buildZip([
  { name: "Fixture Brand Kit/" },
  { name: "__MACOSX/Fixture Brand Kit/._Logo.svg", data: "metadata" },
  { name: "Fixture Brand Kit/Logos/Logo.svg", data: TEST_SVG },
  { name: "Fixture Brand Kit/Logos/Mark.png", data: TEST_PNG },
  { name: "Fixture Brand Kit/../../escape.svg", data: TEST_SVG },
  { name: "Fixture Brand Kit/Fonts.zip", data: buildZip([{ name: "x.otf", data: "font" }]) },
]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "latin1");

const kitUrl = "https://monad.xyz/brand-page-assets/Fixture%20Brand%20Kit.zip";
const guideUrl = "https://cdn.sanity.io/files/e2r40yh6/production/c155385509c73b245ff4f752ade94048a06245bc.pdf";
const scanWith = (files: BrandFile[]): AgentScan => {
  const scan = testScan({ assets: [], fonts: [] });
  return { ...scan, page: { ...scan.page, host: "monad.xyz", brandFiles: files } };
};
const kit = file("aaaaaaaaaaaa", kitUrl, "Fixture Brand Kit", "zip");
const guide = file("bbbbbbbbbbbb", guideUrl, "Discover the brand guide", "pdf");

/** Every file under `root`, relative, with forward slashes. */
const tree = (root: string): string[] =>
  (fs.readdirSync(root, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();

describe("downloadBrandFiles", () => {
  it("unpacks the logo files of a kit under its name, writes a document as it is, and records both", async () => {
    const fetch = fakeFetch({ [kitUrl]: { type: "application/zip", body: KIT }, [guideUrl]: { type: "application/pdf", body: PDF } });
    const result = await downloadBrandFiles(scanWith([kit, guide]), { dest: dir, fetch });

    expect(result.dir).toBe(path.join(dir, "brand"));
    // Nothing outside the folder, no metadata, no nested archive, and not the archive itself.
    expect(tree(dir)).toEqual(["brand/Discover the brand guide.pdf", "brand/Fixture Brand Kit/Logos/Logo.svg", "brand/Fixture Brand Kit/Logos/Mark.png", "brand/manifest.json"]);
    expect(fs.readFileSync(path.join(dir, "brand/Fixture Brand Kit/Logos/Logo.svg"), "utf8")).toBe(TEST_SVG);
    expect(result.files.map(({ name, type, from }) => ({ name, type, from }))).toEqual([
      { name: "Logos/Logo.svg", type: "svg", from: kit.id },
      { name: "Logos/Mark.png", type: "png", from: kit.id },
      { name: "Discover the brand guide", type: "pdf", from: undefined },
    ]);
    expect(result.archives).toEqual([{ id: kit.id, name: "Fixture Brand Kit", files: 2, skipped: { metadata: 1, "unsafe-path": 1, "nested-archive": 1 } }]);
    expect(result.failed).toEqual([]);
    expect(result.totalBytes).toBe(TEST_SVG.length + TEST_PNG.length + PDF.length);

    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
    expect(manifest).toMatchObject({ tool: "assets-scraper", manifestVersion: 1, kind: "brand-files", page: { host: "monad.xyz" } });
    expect(manifest.files.map((row: { file: string; url: string }) => [row.file, row.url])).toEqual([
      ["Fixture Brand Kit/Logos/Logo.svg", kitUrl],
      ["Fixture Brand Kit/Logos/Mark.png", kitUrl],
      ["Discover the brand guide.pdf", guideUrl],
    ]);
  });

  it("writes the archive as it is when asked, and only the files named by id", async () => {
    const fetch = fakeFetch({ [kitUrl]: { type: "application/zip", body: KIT }, [guideUrl]: { type: "application/pdf", body: PDF } });
    const result = await downloadBrandFiles(scanWith([kit, guide]), { dest: dir, fetch, ids: [kit.id, "unknown"], extract: false });
    expect(fetch.urls).toEqual([kitUrl]);
    expect(tree(dir)).toEqual(["brand/Fixture Brand Kit.zip", "brand/manifest.json"]);
    expect(result.archives).toEqual([]);
    expect(fs.readFileSync(path.join(dir, "brand/Fixture Brand Kit.zip")).equals(KIT)).toBe(true);
  });

  it("says why a file did not come: a bot check, a page, the wrong bytes, the size cap", async () => {
    const challenge = file("c1", "https://arbitrum.io/brandkit/downloads/1225_Arbitrum_Logo_all.zip", "Arbitrum logos", "zip");
    const page = file("c2", "https://x.com/brand/kit.zip", "Kit", "zip");
    const wrong = file("c3", "https://x.com/brand/guide.pdf", "Guide", "pdf");
    const huge = file("c4", "https://x.com/brand/huge.zip", "Huge", "zip");
    const fetch = fakeFetch({
      [challenge.url]: { status: 403, type: "text/html; charset=UTF-8", body: "<!DOCTYPE html><title>Just a moment...</title>" },
      [page.url]: { status: 200, type: "text/html", body: "<!doctype html><title>Sign in</title>" },
      [wrong.url]: { type: "application/pdf", body: TEST_PNG },
      [huge.url]: new SafeFetchError("too-large", "Declared 99999999 bytes, over 67108864"),
    });
    const result = await downloadBrandFiles(scanWith([challenge, page, wrong, huge]), { dest: dir, fetch });
    expect(result.files).toEqual([]);
    expect(result.failed.map((row) => [row.id, row.reason])).toEqual([
      ["c1", "arbitrum.io answered HTTP 403 with a text/html page rather than the file, likely a sign-in or a bot check only a browser passes"],
      ["c2", "x.com answered HTTP 200 with a text/html page rather than the file, likely a sign-in or a bot check only a browser passes"],
      ["c3", "the bytes of https://x.com/brand/guide.pdf are not a pdf file"],
      ["c4", "it is larger than the 64 MB one brand file may take (AGENT_BRAND_FILE_MAX_BYTES)"],
    ]);
    expect(tree(dir)).toEqual(["brand/manifest.json"]);
  });

  it("writes an archive it cannot read as it is, and says why", async () => {
    const split = Buffer.from(KIT);
    split.writeUInt16LE(1, split.length - 22 + 4);
    const result = await downloadBrandFiles(scanWith([kit]), { dest: dir, fetch: fakeFetch({ [kitUrl]: { body: split } }) });
    expect(result.archives).toEqual([{ id: kit.id, name: "Fixture Brand Kit", files: 0, skipped: {}, error: "this archive is split over several files" }]);
    expect(tree(dir)).toEqual(["brand/Fixture Brand Kit.zip", "brand/manifest.json"]);
  });

  it("never overwrites: the same bytes are left as they are, other bytes get a new name, the manifest keeps both runs", async () => {
    const answers: Record<string, Answer> = { [guideUrl]: { type: "application/pdf", body: PDF } };
    await downloadBrandFiles(scanWith([guide]), { dest: dir, fetch: fakeFetch(answers) });
    const again = await downloadBrandFiles(scanWith([guide]), { dest: dir, fetch: fakeFetch(answers) });
    expect(again.files.map((row) => path.basename(row.path))).toEqual(["Discover the brand guide.pdf"]);
    answers[guideUrl] = { type: "application/pdf", body: Buffer.concat([PDF, Buffer.from("% new\n")]) };
    const changed = await downloadBrandFiles(scanWith([guide]), { dest: dir, fetch: fakeFetch(answers) });
    expect(changed.files.map((row) => path.basename(row.path))).toEqual(["Discover the brand guide-2.pdf"]);
    const manifest = JSON.parse(fs.readFileSync(changed.manifestPath, "utf8"));
    expect(manifest.files.map((row: { file: string }) => row.file)).toEqual(["Discover the brand guide-2.pdf", "Discover the brand guide.pdf"]);
  });

  it("stops fetching past the download's byte budget", async () => {
    setLimit("maxDownloadBytes", 10);
    const other = file("cccccccccccc", "https://x.com/brand/other.pdf", "Other", "pdf");
    const fetch = fakeFetch({ [guideUrl]: { type: "application/pdf", body: PDF }, [other.url]: { type: "application/pdf", body: PDF } });
    const result = await downloadBrandFiles(scanWith([guide, other]), { dest: dir, fetch });
    expect(fetch.urls).toEqual([guideUrl]);
    expect(result.failed).toEqual([{ id: other.id, name: "Other", reason: "not fetched: the download already took 10 bytes (AGENT_MAX_DOWNLOAD_BYTES)" }]);
  });

  it("bounds what one archive unpacks by the archive limits", async () => {
    setLimit("archiveMaxFiles", 1);
    const result = await downloadBrandFiles(scanWith([kit]), { dest: dir, fetch: fakeFetch({ [kitUrl]: { body: KIT } }) });
    expect(result.archives[0]).toMatchObject({ files: 1, skipped: { cap: 1 } });
  });
});

describe("brandFileName", () => {
  it("is the URL's file name unless it is a hash, with the extension of the type", () => {
    expect(brandFileName(kit)).toBe("Fixture Brand Kit.zip");
    expect(brandFileName(guide)).toBe("Discover the brand guide.pdf");
    expect(brandFileName(file("id", "https://x.com/brand/logo.svg.exe", "Logo", "svg"))).toBe("logo.svg.svg");
    expect(brandFileName(file("id", "https://x.com/", "../../etc/passwd", "pdf"))).toBe("passwd.pdf");
  });
});
