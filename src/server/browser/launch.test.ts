import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import chromium from "@sparticuz/chromium";
import { describe, expect, it } from "vitest";
import { browserEnv, chromiumArgs, isServerlessRuntime, parseMemAvailableMb, PIDFILE_ENV, userAgentFor, wrapperScript } from "./launch";

describe("chromiumArgs", () => {
  it("drops the insecure serverless flags and adds the hardening flags", () => {
    const args = chromiumArgs(chromium.args);
    for (const insecure of ["--disable-web-security", "--allow-running-insecure-content", "--disable-site-isolation-trials"]) expect(args).not.toContain(insecure);
    for (const extra of ["--disable-blink-features=AutomationControlled", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--hide-scrollbars", "--mute-audio"])
      expect(args.filter((arg) => arg === extra)).toHaveLength(1);
    expect(args).toContain("--single-process");
    expect(args).toContain("--no-sandbox");
  });

  it("drops insecure flags given with a value and keeps local launches minimal", () => {
    expect(chromiumArgs(["--disable-web-security=true", "--mute-audio"])).toEqual([
      "--mute-audio",
      "--disable-blink-features=AutomationControlled",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--hide-scrollbars",
    ]);
  });
});

describe("wrapperScript", () => {
  it("disables core dumps, writes its PID and execs the quoted binary", () => {
    const script = wrapperScript("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain("ulimit -c 0");
    expect(script).toContain(`echo $$ > "$${PIDFILE_ENV}"`);
    expect(script).toContain(`unset ${PIDFILE_ENV}`);
    expect(script.trimEnd().endsWith(`exec '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' "$@"`)).toBe(true);
    expect(wrapperScript("/tmp/it's here/chromium")).toContain(`exec '/tmp/it'\\''s here/chromium' "$@"`);
  });

  it("runs the binary with its own PID, no core dumps and without the pidfile variable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wrapper-test-"));
    try {
      const wrapper = path.join(dir, "wrapper.sh");
      const pidfile = path.join(dir, "browser.pid");
      await writeFile(wrapper, wrapperScript("/bin/sh"));
      await chmod(wrapper, 0o755);
      const script = `echo "$$ $(ulimit -c) [\${${PIDFILE_ENV}:-unset}] $1"`;
      const { stdout } = await promisify(execFile)(wrapper, ["-c", script, "sh", "arg with space"], { env: { PATH: process.env.PATH, [PIDFILE_ENV]: pidfile } as unknown as NodeJS.ProcessEnv });
      const [pid, core, variable, ...rest] = stdout.trim().split(" ");
      expect(pid).toBe((await readFile(pidfile, "utf8")).trim());
      expect(core).toBe("0");
      expect(variable).toBe("[unset]");
      expect(rest.join(" ")).toBe("arg with space");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseMemAvailableMb", () => {
  it("reads MemAvailable in megabytes", () => {
    expect(parseMemAvailableMb("MemTotal:        2333696 kB\nMemFree:          812344 kB\nMemAvailable:    1536000 kB\n")).toBe(1500);
    expect(parseMemAvailableMb("MemTotal: 100 kB\n")).toBeUndefined();
    expect(parseMemAvailableMb("")).toBeUndefined();
  });
});

describe("browserEnv", () => {
  it("keeps only the variables Chromium needs", () => {
    expect(
      browserEnv({ PATH: "/bin", HOME: "/home/x", TZ: "UTC", FONTCONFIG_PATH: "/tmp/fonts", LD_LIBRARY_PATH: "/tmp/lib", ASSET_URL_SECRET: "s", UPSTASH_REDIS_REST_TOKEN: "t", LANG: "C" }),
    ).toEqual({ PATH: "/bin", HOME: "/home/x", TZ: "UTC", FONTCONFIG_PATH: "/tmp/fonts", LD_LIBRARY_PATH: "/tmp/lib" });
    expect(browserEnv({ PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });
});

describe("isServerlessRuntime", () => {
  it("recognizes Vercel and AWS Lambda functions on Linux", () => {
    expect(isServerlessRuntime({ VERCEL: "1", VERCEL_ENV: "production" }, "linux")).toBe(true);
    expect(isServerlessRuntime({ VERCEL: "1", VERCEL_ENV: "preview" }, "linux")).toBe(true);
    expect(isServerlessRuntime({ AWS_LAMBDA_FUNCTION_NAME: "scan" }, "linux")).toBe(true);
  });

  it("never takes a developer's machine for one, under vercel dev or with pulled Vercel variables", () => {
    // `vercel dev` sets VERCEL=1 and VERCEL_ENV=development.
    expect(isServerlessRuntime({ VERCEL: "1", VERCEL_ENV: "development" }, "linux")).toBe(false);
    expect(isServerlessRuntime({ VERCEL: "1", VERCEL_ENV: "development" }, "darwin")).toBe(false);
    expect(isServerlessRuntime({ VERCEL: "1" }, "linux")).toBe(false);
    // The Linux build of @sparticuz/chromium cannot run on macOS, whatever the environment says.
    expect(isServerlessRuntime({ VERCEL: "1", VERCEL_ENV: "production" }, "darwin")).toBe(false);
    expect(isServerlessRuntime({ AWS_LAMBDA_FUNCTION_NAME: "scan" }, "darwin")).toBe(false);
    expect(isServerlessRuntime({}, "linux")).toBe(false);
  });
});

describe("userAgentFor", () => {
  it("claims a regular Chrome of the same major version", () => {
    const ua = userAgentFor("153.0.8010.0");
    expect(ua).toContain("Chrome/153.0.0.0");
    expect(ua).not.toContain("Headless");
  });
});
