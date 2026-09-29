import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertInside, createFileInside, resolveDestination, sanitizeHost } from "./dest";

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

  /**
   * `~/.claude` exists on every machine Claude Code has run on, and a dotfiles checkout puts `.git` in home too, so home
   * itself answered the project rule for any working directory under it: 60 files plus a manifest landed in `~/scrap`
   * and the documented Downloads fallback was unreachable (review issue 9).
   */
  it("never treats the home directory itself as a project", () => {
    const home = makeTree(".claude", ".git", "Desktop", "Downloads", "notes/deep");
    vi.stubEnv("HOME", home);

    for (const cwd of [home, path.join(home, "Desktop"), path.join(home, "notes", "deep")]) {
      expect(resolveDestination({ host: "stripe.com", cwd }), cwd).toMatchObject({
        dir: path.join(home, "Downloads", "assets-scraper", "stripe.com"),
        fallback: true,
      });
    }

    // A real project under home still answers, marker or git root alike.
    const project = path.join(home, "work", "app");
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.writeFileSync(path.join(project, "package.json"), "{}\n");
    expect(resolveDestination({ host: "stripe.com", cwd: path.join(project, "src") }).projectRoot).toBe(project);

    // And an agent-supplied dest is confined to the fallback directory rather than to the whole home directory.
    expect(() =>
      resolveDestination({ host: "stripe.com", cwd: path.join(home, "Desktop"), dest: path.join(home, "scrap", "x"), restrictToProject: true }),
    ).toThrow(/outside/i);
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
    expect(sanitizeHost(`${"a".repeat(400)}.com`)).toBe("a".repeat(100));
    expect(resolveDestination({ host: "www.stripe.com", cwd: makeTree(".git") })).toMatchObject({ host: "stripe.com" });
    for (const host of ["../../etc", "a/b", "..", ""]) {
      const dir = resolveDestination({ host, cwd: makeTree(".git") }).dir;
      expect(path.basename(path.dirname(dir))).toBe("scrap");
    }
  });
  it("refuses an explicit dest outside the scrap folder when the caller asks it to", () => {
    // Regression: the guard only checked the project root, so an agent-supplied dest of "<project>/src" was accepted and
    // scraped files could land in the source tree.
    const root = makeTree(".git", "scrap", "src");
    const outside = makeTree();
    expect(() => resolveDestination({ host: "stripe.com", cwd: root, dest: path.join(root, "src"), restrictToProject: true })).toThrow(/outside/i);
    expect(() => resolveDestination({ host: "stripe.com", cwd: root, dest: path.join(outside, "anywhere"), restrictToProject: true })).toThrow(/outside/i);
    expect(resolveDestination({ host: "stripe.com", cwd: root, dest: path.join(root, "scrap", "stripe.com"), restrictToProject: true }).dir).toBe(
      path.join(root, "scrap", "stripe.com"),
    );
    // Without the flag, a dest the user typed is the user's own choice.
    expect(resolveDestination({ host: "stripe.com", cwd: root, dest: path.join(outside, "anywhere") }).dir).toBe(path.join(outside, "anywhere"));
    expect(() => resolveDestination({ host: "stripe.com", cwd: root, dest: root, restrictToProject: true })).toThrow(/outside/i);
    expect(resolveDestination({ host: "stripe.com", cwd: root, dest: path.join(root, "scrap"), restrictToProject: true }).dir).toBe(
      path.join(root, "scrap"),
    );
    expect(resolveDestination({ host: "stripe.com", cwd: root, dest: path.join(root, "scrap", "deep", "nested"), restrictToProject: true }).dir).toBe(
      path.join(root, "scrap", "deep", "nested"),
    );
    // No project, so the fallback directory is the one place an agent-supplied dest may write.
    const home = makeTree();
    vi.stubEnv("HOME", home);
    const bare = makeTree();
    expect(() => resolveDestination({ host: "stripe.com", cwd: bare, dest: path.join(bare, "anywhere"), restrictToProject: true })).toThrow(/outside/i);
    expect(
      resolveDestination({ host: "stripe.com", cwd: bare, dest: path.join(home, "Downloads", "assets-scraper", "x"), restrictToProject: true }).dir,
    ).toBe(path.join(home, "Downloads", "assets-scraper", "x"));
  });

  /**
   * Regression: a relative `dest` resolved against the server's working directory, so `stripe-brand` was always refused
   * and `scrap/x` only worked when the session started at the repository root, while the schema says "a directory
   * inside the project scrap folder".
   */
  it("reads a relative agent-supplied dest from the scrap folder, wherever the server runs", () => {
    const root = makeTree(".git", "apps/web");
    const cwd = path.join(root, "apps/web");
    expect(resolveDestination({ host: "stripe.com", cwd, dest: "stripe-brand", restrictToProject: true }).dir).toBe(path.join(root, "scrap", "stripe-brand"));
    expect(resolveDestination({ host: "stripe.com", cwd, dest: path.join(root, "scrap", "abs"), restrictToProject: true }).dir).toBe(
      path.join(root, "scrap", "abs"),
    );
    expect(() => resolveDestination({ host: "stripe.com", cwd, dest: "../src", restrictToProject: true })).toThrow(/outside/i);
  });

  /**
   * Regression: the project rule never checked where its links led, so a repository committing `scrap -> ../outside`
   * (or `scrap/<host>` pointing out) had every download write there and replace the `manifest.json` it found.
   */
  it("refuses a scrap folder, or a host folder, that a symbolic link leads out of the project", () => {
    const root = makeTree(".git");
    const outside = makeTree();
    fs.symlinkSync(outside, path.join(root, "scrap"));
    expect(() => resolveDestination({ host: "stripe.com", cwd: root })).toThrow(/leads out of/);
    expect(() => resolveDestination({ host: "stripe.com", cwd: root, dest: "x", restrictToProject: true })).toThrow(/outside/i);

    const other = makeTree(".git", "scrap");
    fs.symlinkSync(outside, path.join(other, "scrap", "stripe.com"));
    expect(() => resolveDestination({ host: "stripe.com", cwd: other })).toThrow(/ASSETS_SCRAPER_OUT/);

    // A link that stays inside the project is fine, and so is anywhere the user names.
    const inside = makeTree(".git", "assets");
    fs.symlinkSync(path.join(inside, "assets"), path.join(inside, "scrap"));
    expect(resolveDestination({ host: "stripe.com", cwd: inside }).dir).toBe(path.join(inside, "scrap", "stripe.com"));
    vi.stubEnv("ASSETS_SCRAPER_OUT", outside);
    expect(resolveDestination({ host: "stripe.com", cwd: root }).dir).toBe(path.join(outside, "stripe.com"));
  });

  it("refuses a host folder of the fallback directory that leads out of it", () => {
    const home = makeTree("Downloads/assets-scraper");
    const outside = makeTree();
    vi.stubEnv("HOME", home);
    fs.symlinkSync(outside, path.join(home, "Downloads", "assets-scraper", "stripe.com"));
    expect(() => resolveDestination({ host: "stripe.com", cwd: makeTree() })).toThrow(/leads out of/);
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

  it("throws for a symlink whose target does not exist yet", () => {
    const root = makeTree("scrap/images");
    const outside = makeTree();
    const evil = path.join(outside, "does-not-exist-yet", "evil.png");
    fs.symlinkSync(evil, path.join(root, "scrap", "images", "logo.png"));
    expect(() => assertInside(path.join(root, "scrap"), "images/logo.png")).toThrow(/symlink/i);
    expect(() => assertInside(path.join(root, "scrap"), "images/logo.png")).not.toThrow(/outside/i);
    fs.mkdirSync(path.dirname(evil), { recursive: true });
    expect(fs.existsSync(evil)).toBe(false);
  });

  it("throws for a dangling symlink above the target", () => {
    const root = makeTree("scrap");
    fs.symlinkSync(path.join(makeTree(), "gone"), path.join(root, "scrap", "images"));
    expect(() => assertInside(path.join(root, "scrap"), "images/logo.png")).toThrow(/symlink/i);
  });
});

describe("createFileInside", () => {
  it("creates the file and its parent directories inside the root", () => {
    const root = path.join(makeTree("scrap"), "scrap");
    const handle = createFileInside(root, "images/logo.png");
    try {
      fs.writeFileSync(handle.fd, "bytes");
    } finally {
      fs.closeSync(handle.fd);
    }
    expect(handle.path).toBe(path.join(root, "images", "logo.png"));
    expect(fs.readFileSync(handle.path, "utf8")).toBe("bytes");
  });

  it("creates a destination that does not exist yet", () => {
    // The first download into a project: nothing below the project root has been made yet.
    const root = path.join(makeTree(), "scrap", "stripe.com");
    const handle = createFileInside(root, "svg/logo.svg");
    fs.closeSync(handle.fd);
    expect(handle.path).toBe(path.join(root, "svg", "logo.svg"));
    expect(fs.existsSync(handle.path)).toBe(true);
  });

  it("refuses a name that already exists", () => {
    const root = path.join(makeTree("scrap"), "scrap");
    fs.writeFileSync(path.join(root, "logo.png"), "first");
    expect(() => createFileInside(root, "logo.png")).toThrow(/EEXIST/);
  });

  it("refuses to write through a symlink, dangling or not", () => {
    const root = path.join(makeTree("scrap"), "scrap");
    const outside = makeTree();
    const dangling = path.join(outside, "gone", "evil.png");
    fs.symlinkSync(dangling, path.join(root, "dangling.png"));
    fs.mkdirSync(path.dirname(dangling), { recursive: true });
    fs.writeFileSync(path.join(outside, "there.png"), "there");
    fs.symlinkSync(path.join(outside, "there.png"), path.join(root, "there.png"));
    expect(() => createFileInside(root, "dangling.png")).toThrow();
    expect(() => createFileInside(root, "there.png")).toThrow();
    expect(fs.existsSync(dangling)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "there.png"), "utf8")).toBe("there");
  });

  it("refuses a path outside the root", () => {
    const root = path.join(makeTree("scrap"), "scrap");
    expect(() => createFileInside(root, "../evil.png")).toThrow(/outside/i);
  });
});
