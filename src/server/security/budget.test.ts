import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const upstash = vi.hoisted(() => {
  const calls: { config: Record<string, unknown>; commands: [string, ...unknown[]][] }[] = [];
  const totals = new Map<string, number>();
  class Redis {
    readonly commands: [string, ...unknown[]][] = [];
    constructor(readonly config: Record<string, unknown>) {
      calls.push({ config, commands: this.commands });
    }
    async get(key: string) {
      this.commands.push(["get", key]);
      return totals.get(key) ?? null;
    }
    pipeline() {
      const queued: [string, ...unknown[]][] = [];
      const pipe = {
        incrby: (key: string, by: number) => { queued.push(["incrby", key, by]); return pipe; },
        expire: (key: string, ttl: number) => { queued.push(["expire", key, ttl]); return pipe; },
        exec: async () => {
          this.commands.push(...queued);
          return queued.map(([name, key, value]) => {
            if (name !== "incrby") return 1;
            const next = (totals.get(key as string) ?? 0) + (value as number);
            totals.set(key as string, next);
            return next;
          });
        },
      };
      return pipe;
    }
  }
  return { Redis, calls, totals };
});

const runtimeCache = vi.hoisted(() => {
  const entries = new Map<string, { value: unknown; ttl?: number }>();
  /** Delay of each get and set: a get reads when called and answers late, a set writes late. */
  const latency = { ms: 0 };
  const settle = () => new Promise((resolve) => setTimeout(resolve, latency.ms));
  return {
    entries,
    latency,
    getCache: vi.fn(() => ({
      get: async (key: string) => {
        const value = entries.get(key)?.value ?? null;
        await settle();
        return value;
      },
      set: async (key: string, value: unknown, options?: { ttl?: number }) => {
        await settle();
        entries.set(key, { value, ttl: options?.ttl });
      },
      delete: async (key: string) => { entries.delete(key); },
      expireTag: async () => {},
    })),
  };
});

vi.mock("@upstash/redis", () => ({ Redis: upstash.Redis }));
vi.mock("@vercel/functions", () => ({ getCache: runtimeCache.getCache }));

import {
  getBudgetStore,
  MemoryBudgetStore,
  meterProxyBytes,
  PROXY_BYTES_BLOCK,
  RuntimeCacheBudgetStore,
  setBudgetStoreForTests,
  takeProxyBytes,
  refundScanBudget,
  takeScanBudget,
  UpstashBudgetStore,
  type BudgetStore,
} from "./budget";

const day1 = new Date("2026-09-16T23:59:00Z");
const day2 = new Date("2026-09-17T00:01:00Z");
const day3 = new Date("2026-09-18T10:00:00Z");

async function takeMany(count: number, now: Date): Promise<boolean[]> {
  const results: boolean[] = [];
  for (let i = 0; i < count; i++) results.push(await takeScanBudget(null, now));
  return results;
}

describe("budget", () => {
  beforeEach(() => {
    setBudgetStoreForTests(new MemoryBudgetStore());
  });

  afterEach(() => {
    setBudgetStoreForTests(null);
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("limits scans per UTC day", async () => {
    vi.stubEnv("SCANS_PER_DAY", "2");
    expect(await takeMany(3, day1)).toEqual([true, true, false]);
    expect(await takeScanBudget(null, day2)).toBe(true);
  });

  it("limits scans per client per day without spending the shared budget", async () => {
    vi.stubEnv("SCANS_PER_DAY", "10");
    vi.stubEnv("SCANS_PER_IP_PER_DAY", "2");
    expect(await takeScanBudget("203.0.113.7", day1)).toBe(true);
    expect(await takeScanBudget("203.0.113.7", day1)).toBe(true);
    expect(await takeScanBudget("203.0.113.7", day1)).toBe(false);
    // Another client still has its own quota, and the two the first client spent are all it took from the day.
    expect(await takeScanBudget("203.0.113.8", day1)).toBe(true);
    expect(await takeMany(8, day1)).toEqual([true, true, true, true, true, true, true, false]);
    expect(await takeScanBudget("203.0.113.7", day2)).toBe(true);
  });

  it("limits scans per month without spending the month on attempts refused for the day", async () => {
    vi.stubEnv("SCANS_PER_DAY", "1");
    vi.stubEnv("SCANS_PER_MONTH", "2");
    expect(await takeMany(4, day1)).toEqual([true, false, false, false]);
    expect(await takeScanBudget(null, day2)).toBe(true);
    expect(await takeScanBudget(null, day3)).toBe(false);
    expect(await takeScanBudget(null, new Date("2026-10-01T00:00:00Z"))).toBe(true);
  });

  it("hands a scan back to every counter it moved", async () => {
    // A `busy` scan never reaches a browser, and the client retries once, so a unit that bought nothing must go back.
    vi.stubEnv("SCANS_PER_DAY", "2");
    vi.stubEnv("SCANS_PER_IP_PER_DAY", "1");
    expect(await takeScanBudget("203.0.113.9", day1)).toBe(true);
    await refundScanBudget("203.0.113.9", day1);
    expect(await takeScanBudget("203.0.113.9", day1)).toBe(true);
    expect(await takeScanBudget("203.0.113.9", day1)).toBe(false);
    expect(await takeMany(2, day1)).toEqual([true, false]);
  });

  it("sums proxied bytes per day without counting a refused take", async () => {
    vi.stubEnv("PROXY_BYTES_PER_DAY", "1000");
    expect(await takeProxyBytes(400, day1)).toBe(true);
    expect(await takeProxyBytes(0, day1)).toBe(true);
    expect(await takeProxyBytes(700, day1)).toBe(false);
    expect(await takeProxyBytes(600, day1)).toBe(true);
    expect(await takeProxyBytes(1, day1)).toBe(false);
    expect(await takeProxyBytes(0, day1)).toBe(false);
    expect(await takeProxyBytes(900, day2)).toBe(true);
  });

  it("takes bytes of unknown length in blocks, refuses a block that does not fit and hands back what was not used", async () => {
    const block = PROXY_BYTES_BLOCK;
    expect(block).toBe(1024 * 1024);
    vi.stubEnv("PROXY_BYTES_PER_DAY", String(3 * block));
    const store = new MemoryBudgetStore();
    setBudgetStoreForTests(store);
    const spent = () => store.incr("proxy:d:2026-09-16", 0, 60);

    const body = meterProxyBytes(day1);
    expect(await body.take(1000)).toBe(true);
    expect(await spent()).toBe(block);
    // bytes the current block covers take nothing more
    expect(await body.take(block - 1000)).toBe(true);
    expect(await spent()).toBe(block);
    expect(await body.take(1)).toBe(true);
    expect(await spent()).toBe(2 * block);

    // a chunk larger than a block takes what it needs; one that does not fit is refused and counts nothing
    const other = meterProxyBytes(day1);
    expect(await other.take(block + 10)).toBe(false);
    expect(await spent()).toBe(2 * block);
    // a reservation takes exactly what it asks for
    expect(await other.reserve(block - 10)).toBe(true);
    expect(await spent()).toBe(3 * block - 10);
    expect(await other.take(block - 10)).toBe(true);
    expect(await other.take(1)).toBe(false);
    expect(await spent()).toBe(3 * block - 10);

    await body.settle();
    expect(await spent()).toBe(2 * block - 10 + 1);
    await body.settle();
    expect(await spent()).toBe(2 * block - 10 + 1);
    // a settled meter takes nothing more
    expect(await body.take(1)).toBe(false);
    expect(await body.reserve(1)).toBe(false);
    expect(await spent()).toBe(2 * block - 10 + 1);
  });

  it("hands back a block that is granted after the meter settled", async () => {
    const store = new MemoryBudgetStore();
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => { open = resolve; });
    setBudgetStoreForTests({ incr: async (key, by, ttl) => { await gate; return store.incr(key, by, ttl); } });
    const meter = meterProxyBytes(day1);
    const pending = meter.take(10);
    const settled = meter.settle();
    open();
    expect(await pending).toBe(false);
    await settled;
    expect(await store.incr("proxy:d:2026-09-16", 0, 60)).toBe(0);
  });

  it("hands back unused bytes to the day the meter was created on", async () => {
    const seen: [string, number][] = [];
    setBudgetStoreForTests({ incr: async (key, by) => { seen.push([key, by]); return by; } });
    // settled once the clock is past day1, the unused part still goes back to day1
    const meter = meterProxyBytes(day1);
    expect(await meter.reserve(500)).toBe(true);
    expect(await meter.take(200)).toBe(true);
    await meter.settle();
    expect(seen).toEqual([["proxy:d:2026-09-16", 500], ["proxy:d:2026-09-16", -300]]);
  });

  it("uses the documented keys and lifetimes", async () => {
    const seen: [string, number, number][] = [];
    const recording: BudgetStore = { incr: async (key, by, ttl) => { seen.push([key, by, ttl]); return 1; } };
    setBudgetStoreForTests(recording);
    await takeScanBudget(null, day1);
    await takeProxyBytes(123, day1);
    const meter = meterProxyBytes(day1);
    await meter.take(45);
    await meter.settle();
    vi.stubEnv("PROXY_BYTES_PER_DAY", "1000");
    expect(await takeProxyBytes(2000, day1)).toBe(false);
    expect(seen).toEqual([
      ["scan:d:2026-09-16", 1, 2 * 86_400],
      ["scan:m:2026-09", 1, 40 * 86_400],
      ["proxy:d:2026-09-16", 123, 2 * 86_400],
      ["proxy:d:2026-09-16", 1024 * 1024, 2 * 86_400],
      ["proxy:d:2026-09-16", 45 - 1024 * 1024, 2 * 86_400],
      ["proxy:d:2026-09-16", 2000, 2 * 86_400],
      ["proxy:d:2026-09-16", -2000, 2 * 86_400],
    ]);
  });

  it("falls back to the in-memory counter when the store throws", async () => {
    vi.stubEnv("SCANS_PER_DAY", "2");
    vi.spyOn(console, "error").mockImplementation(() => {});
    setBudgetStoreForTests({ incr: async () => { throw new Error("store down"); } });
    expect(await takeMany(3, day1)).toEqual([true, true, false]);
  });

  it("skips a failing store for 30 seconds, then tries it again", async () => {
    vi.stubEnv("SCANS_PER_DAY", "10");
    vi.useFakeTimers();
    vi.setSystemTime(day1);
    vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    let down = true;
    setBudgetStoreForTests({ incr: async (_key, by) => { calls++; if (down) throw new Error("store down"); return by; } });
    expect(await takeMany(3, day1)).toEqual([true, true, true]);
    expect(calls).toBe(1);
    vi.setSystemTime(day1.getTime() + 29_000);
    await takeScanBudget(null, day1);
    expect(calls).toBe(1);
    down = false;
    vi.setSystemTime(day1.getTime() + 31_000);
    await takeScanBudget(null, day1);
    expect(calls).toBe(3);
    // the in-memory counter kept every scan taken meanwhile
    vi.stubEnv("SCANS_PER_DAY", "5");
    expect(await takeScanBudget(null, day1)).toBe(false);
  });

  it("still enforces the limit when a store silently loses counts", async () => {
    vi.stubEnv("SCANS_PER_DAY", "2");
    setBudgetStoreForTests({ incr: async (_key, by) => by });
    expect(await takeMany(3, day1)).toEqual([true, true, false]);
  });

  it("expires in-memory counters", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(day1);
    const store = new MemoryBudgetStore();
    expect(await store.incr("k", 2, 60)).toBe(2);
    expect(await store.incr("k", 3, 60)).toBe(5);
    vi.setSystemTime(day1.getTime() + 61_000);
    expect(await store.incr("k", 1, 60)).toBe(1);
  });
});

describe("budget stores", () => {
  afterEach(() => {
    setBudgetStoreForTests(null);
    vi.unstubAllEnvs();
    upstash.calls.length = 0;
    upstash.totals.clear();
    runtimeCache.entries.clear();
    runtimeCache.latency.ms = 0;
  });

  it("selects Upstash, then the Vercel Runtime Cache, then memory", () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("VERCEL", "");
    expect(getBudgetStore()).toBeInstanceOf(MemoryBudgetStore);
    vi.stubEnv("VERCEL", "1");
    expect(getBudgetStore()).toBeInstanceOf(RuntimeCacheBudgetStore);
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    expect(getBudgetStore()).toBeInstanceOf(RuntimeCacheBudgetStore);
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
    expect(getBudgetStore()).toBeInstanceOf(UpstashBudgetStore);
    expect(getBudgetStore()).toBe(getBudgetStore());
  });

  it("increments and sets the TTL in one Upstash pipeline", async () => {
    const store = new UpstashBudgetStore("https://example.upstash.io", "token");
    expect(await store.incr("scan:d:2026-09-16", 1, 172_800)).toBe(1);
    expect(await store.incr("scan:d:2026-09-16", 4, 172_800)).toBe(5);
    expect(upstash.calls[0].config).toMatchObject({ url: "https://example.upstash.io", token: "token", enableTelemetry: false });
    expect(upstash.calls[0].commands).toEqual([
      ["incrby", "scan:d:2026-09-16", 1], ["expire", "scan:d:2026-09-16", 172_800],
      ["incrby", "scan:d:2026-09-16", 4], ["expire", "scan:d:2026-09-16", 172_800],
    ]);
  });

  it("counts in the Vercel Runtime Cache with a TTL", async () => {
    const store = new RuntimeCacheBudgetStore();
    expect(await store.incr("proxy:d:2026-09-16", 100, 172_800)).toBe(100);
    expect(await store.incr("proxy:d:2026-09-16", 50, 172_800)).toBe(150);
    expect(runtimeCache.entries.get("proxy:d:2026-09-16")).toEqual({ value: 150, ttl: 172_800 });
  });

  it("reads a zero probe from Upstash with GET, without INCRBY or EXPIRE", async () => {
    const store = new UpstashBudgetStore("https://example.upstash.io", "token");
    expect(await store.incr("proxy:d:2026-09-16", 0, 172_800)).toBe(0);
    upstash.totals.set("proxy:d:2026-09-16", 42);
    expect(await store.incr("proxy:d:2026-09-16", 0, 172_800)).toBe(42);
    expect(upstash.calls[0].commands).toEqual([["get", "proxy:d:2026-09-16"], ["get", "proxy:d:2026-09-16"]]);
  });

  it("never writes a zero probe to the Vercel Runtime Cache, so it cannot overwrite a concurrent take", async () => {
    const store = new RuntimeCacheBudgetStore();
    runtimeCache.entries.set("proxy:d:2026-09-16", { value: 100, ttl: 172_800 });
    runtimeCache.latency.ms = 20;
    // the probe reads 100 before the take lands; writing that total back afterwards would erase the take
    const [taken, probed] = await Promise.all([store.incr("proxy:d:2026-09-16", 20_000_000, 172_800), store.incr("proxy:d:2026-09-16", 0, 172_800)]);
    expect([taken, probed]).toEqual([20_000_100, 100]);
    expect(runtimeCache.entries.get("proxy:d:2026-09-16")).toEqual({ value: 20_000_100, ttl: 172_800 });
    expect(await store.incr("proxy:d:2026-09-17", 0, 172_800)).toBe(0);
    expect(runtimeCache.entries.has("proxy:d:2026-09-17")).toBe(false);
  });

  it("uses the selected store through the public helpers", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
    vi.stubEnv("SCANS_PER_DAY", "1");
    upstash.totals.set("scan:d:2026-09-16", 5);
    expect(await takeScanBudget(null, day1)).toBe(false);
  });
});
