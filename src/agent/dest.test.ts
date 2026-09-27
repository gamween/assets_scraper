import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertInside, resolveDestination, sanitizeHost } from "./dest";

const trees: string[] = [];

/** A temp tree outside any project (nothing above `os.tmpdir()` holds a marker), with `dirs` created inside it. */
const makeTree = (...dirs: string[]): string => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-dest-")));
  trees.push(root);
  for (const dir of dirs) fs.mkdirSync(path.join(root, dir), { recursive: true });
  return root;
};

afterEach(() => {
  for (const tree of trees.splice(0)) fs.rmSync(tree, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("resolveDestination", () => {
  it("writes into the git root of the working directory", () => {
    const root = makeTree(".git", "packages/web");
    expect(resolveDestination({ host: "stripe.com", cwd: path.join(root, "packages/web") })).toEqual({
      dir: path.join(root, "scrap", "stripe.com"),
      projectRoot: root,
      host: "stripe.com",
      fallback: false,
    });
  });

  it("treats a worktree .git file as a git root", () => {
    const root = makeTree("src");
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    expect(resolveDestination({ host: "stripe.com", cwd: path.join(root, "src") }).projectRoot).toBe(root);
  });

  it("falls back to the nearest package.json, pyproject.toml or .claude directory", () => {
    const node = makeTree("src/app");
    fs.writeFileSync(path.join(node, "package.json"), "{}\n");
    expect(resolveDestination({ host: "stripe.com", cwd: path.join(node, "src/app") })).toMatchObject({
      dir: path.join(node, "scrap", "stripe.com"),
      projectRoot: node,
      fallback: false,
    });

    const python = makeTree("pkg");
    fs.writeFileSync(path.join(python, "pyproject.toml"), "[project]\n");
    expect(resolveDestination({ host: "stripe.com", cwd: path.join(python, "pkg") }).projectRoot).toBe(python);

    const claude = makeTree(".claude", "notes");
    expect(resolveDestination({ host: "stripe.com", cwd: path.join(claude, "notes") }).projectRoot).toBe(claude);
  });

  it("prefers the git root over a nearer package.json", () => {
    const root = makeTree(".git", "packages/web");
    fs.writeFileSync(path.join(root, "packages/web/package.json"), "{}\n");
    expect(resolveDestination({ host: "stripe.com", cwd: path.join(root, "packages/web") }).projectRoot).toBe(root);
  });

  it("uses ~/Downloads/assets-scraper outside any project", () => {
    const home = makeTree("Downloads");
    vi.stubEnv("HOME", home);
    const elsewhere = makeTree("work");
    expect(resolveDestination({ host: "stripe.com", cwd: path.join(elsewhere, "work") })).toEqual({
      dir: path.join(home, "Downloads", "assets-scraper", "stripe.com"),
      projectRoot: path.join(home, "Downloads", "assets-scraper"),
      host: "stripe.com",
      fallback: true,
    });
  });

  it("uses an explicit dest as is, resolving a relative one against the working directory", () => {
    const root = makeTree(".git", "src");
    const cwd = path.join(root, "src");
    expect(resolveDestination({ host: "stripe.com", cwd, dest: "out/assets" })).toEqual({
      dir: path.join(cwd, "out", "assets"),
      projectRoot: path.join(cwd, "out", "assets"),
      host: "stripe.com",
      fallback: false,
    });

    const absolute = path.join(makeTree(), "elsewhere");
    expect(resolveDestination({ host: "stripe.com", cwd, dest: absolute }).dir).toBe(absolute);
  });

  it("lets ASSETS_SCRAPER_OUT win over the project rule and lose to an explicit dest", () => {
    const root = makeTree(".git", "src");
    const out = makeTree("shared");
    vi.stubEnv("ASSETS_SCRAPER_OUT", path.join(out, "shared"));
    expect(resolveDestination({ host: "stripe.com", cwd: path.join(root, "src") })).toEqual({
      dir: path.join(out, "shared", "stripe.com"),
      projectRoot: path.join(out, "shared"),
      host: "stripe.com",
      fallback: false,
    });
    expect(resolveDestination({ host: "stripe.com", cwd: path.join(root, "src"), dest: "here" }).dir).toBe(path.join(root, "src", "here"));
  });

  it("sanitizes the host", () => {
    expect(sanitizeHost("www.stripe.com")).toBe("stripe.com");
    expect(sanitizeHost("WWW.Stripe.COM")).toBe("stripe.com");
    expect(sanitizeHost("xn--caf-dma.com")).toBe("xn--caf-dma.com");
    expect(sanitizeHost("127.0.0.1:8787")).toBe("127.0.0.1-8787");
    expect(sanitizeHost("../../etc/passwd")).toBe("etc-passwd");
    expect(sanitizeHost("..")).toBe("site");
    expect(sanitizeHost("a/b\\c")).toBe("a-b-c");
    expect(sanitizeHost("")).toBe("site");
    expect(resolveDestination({ host: "www.stripe.com", cwd: makeTree(".git") })).toMatchObject({ host: "stripe.com" });
    for (const host of ["../../etc", "a/b", "..", ""]) {
      const dir = resolveDestination({ host, cwd: makeTree(".git") }).dir;
      expect(path.basename(path.dirname(dir))).toBe("scrap");
    }
  });
});

describe("assertInside", () => {
  it("passes for a nested path and returns it resolved", () => {
    const root = makeTree("scrap");
    const target = path.join(root, "scrap", "svg", "logo.svg");
    expect(assertInside(path.join(root, "scrap"), target)).toBe(target);
    expect(assertInside(path.join(root, "scrap"), "svg/logo.svg")).toBe(target);
    expect(assertInside(path.join(root, "scrap"), path.join(root, "scrap"))).toBe(path.join(root, "scrap"));
  });

  it("throws for a .. escape", () => {
    const root = makeTree("scrap");
    expect(() => assertInside(path.join(root, "scrap"), "../evil.svg")).toThrow(/outside/i);
    expect(() => assertInside(path.join(root, "scrap"), path.join(root, "scrap", "..", "..", "evil.svg"))).toThrow(/outside/i);
  });

  it("throws for an absolute path outside the root", () => {
    const root = makeTree("scrap");
    expect(() => assertInside(path.join(root, "scrap"), path.join(makeTree(), "evil.svg"))).toThrow(/outside/i);
    expect(() => assertInside(path.join(root, "scrap"), `${path.join(root, "scrap")}-sibling/evil.svg`)).toThrow(/outside/i);
  });

  it("throws for a symlink that points outside the root", () => {
    const root = makeTree("scrap");
    const outside = makeTree("target");
    fs.symlinkSync(path.join(outside, "target"), path.join(root, "scrap", "link"));
    expect(() => assertInside(path.join(root, "scrap"), path.join(root, "scrap", "link", "evil.svg"))).toThrow(/outside/i);
    expect(() => assertInside(path.join(root, "scrap"), path.join(root, "scrap", "link"))).toThrow(/outside/i);
  });
});
