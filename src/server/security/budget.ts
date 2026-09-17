import { Redis } from "@upstash/redis";
import { getCache } from "@vercel/functions";
import { limits } from "@/server/config/limits";

export interface BudgetStore {
  /** Adds `by` to the counter at `key` (created with a TTL) and returns the new total. */
  incr(key: string, by: number, ttlSeconds: number): Promise<number>;
}

const DAY_SECONDS = 86_400;
const SCAN_DAY_TTL = 2 * DAY_SECONDS;
const SCAN_MONTH_TTL = 40 * DAY_SECONDS;
const PROXY_DAY_TTL = 2 * DAY_SECONDS;
const UPSTASH_TIMEOUT_MS = 2_000;

/** Per-instance counters. */
export class MemoryBudgetStore implements BudgetStore {
  private readonly counters = new Map<string, { total: number; expiresAt: number }>();

  async incr(key: string, by: number, ttlSeconds: number): Promise<number> {
    const now = Date.now();
    for (const [name, counter] of this.counters) if (counter.expiresAt <= now) this.counters.delete(name);
    const counter = this.counters.get(key) ?? { total: 0, expiresAt: now + ttlSeconds * 1000 };
    counter.total += by;
    this.counters.set(key, counter);
    return counter.total;
  }
}

/** Shared counters in Upstash Redis: atomic INCRBY and the TTL in one pipeline. */
export class UpstashBudgetStore implements BudgetStore {
  private readonly redis: Redis;

  constructor(url: string, token: string) {
    this.redis = new Redis({
      url,
      token,
      enableTelemetry: false,
      retry: { retries: 1, backoff: () => 100 },
      signal: () => AbortSignal.timeout(UPSTASH_TIMEOUT_MS),
    });
  }

  async incr(key: string, by: number, ttlSeconds: number): Promise<number> {
    const [total] = await this.redis.pipeline().incrby(key, by).expire(key, ttlSeconds).exec<[number, number]>();
    return total;
  }
}

/**
 * Shared counters in the Vercel Runtime Cache. It has no atomic increment, so concurrent scans on several instances
 * can undercount, and it reports errors as misses; the in-memory shadow counter in `incr` keeps each instance within
 * the limit anyway.
 */
export class RuntimeCacheBudgetStore implements BudgetStore {
  async incr(key: string, by: number, ttlSeconds: number): Promise<number> {
    const cache = getCache({ namespace: "budget", keyHashFunction: (value) => value });
    const current = Number(await cache.get(key));
    const total = (Number.isFinite(current) ? current : 0) + by;
    await cache.set(key, total, { ttl: ttlSeconds });
    return total;
  }
}

let memory = new MemoryBudgetStore();
let testStore: BudgetStore | null = null;
let upstash: { credentials: string; store: UpstashBudgetStore } | null = null;
const runtimeCache = new RuntimeCacheBudgetStore();

/** Upstash when both credentials exist, the Vercel Runtime Cache on Vercel, otherwise in-memory (spec 11.3). */
export function getBudgetStore(): BudgetStore {
  if (testStore) return testStore;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    const credentials = `${url}\n${token}`;
    if (upstash?.credentials !== credentials) upstash = { credentials, store: new UpstashBudgetStore(url, token) };
    return upstash.store;
  }
  if (process.env.VERCEL) return runtimeCache;
  return memory;
}

export function setBudgetStoreForTests(store: BudgetStore | null): void {
  testStore = store;
  memory = new MemoryBudgetStore();
}

/**
 * Every increment also lands in the in-memory counter. When the shared store throws, the in-memory total is used;
 * when it answers, the larger of both, so a store that silently loses writes cannot lift this instance's limit.
 */
async function incr(key: string, by: number, ttlSeconds: number): Promise<number> {
  const store = getBudgetStore();
  const local = await memory.incr(key, by, ttlSeconds);
  if (store === memory) return local;
  try {
    return Math.max(await store.incr(key, by, ttlSeconds), local);
  } catch (error) {
    console.error(`Budget store failed, using the in-memory counter: ${error instanceof Error ? error.message : String(error)}`);
    return local;
  }
}

/** Takes one scan from the daily and monthly budgets. A scan refused for the day does not count toward the month. */
export async function takeScanBudget(now: Date = new Date()): Promise<boolean> {
  const iso = now.toISOString();
  if ((await incr(`scan:d:${iso.slice(0, 10)}`, 1, SCAN_DAY_TTL)) > limits.scansPerDay) return false;
  return (await incr(`scan:m:${iso.slice(0, 7)}`, 1, SCAN_MONTH_TTL)) <= limits.scansPerMonth;
}

const proxyKey = (now: Date) => `proxy:d:${now.toISOString().slice(0, 10)}`;
const byteCount = (bytes: number) => (Number.isFinite(bytes) && bytes > 0 ? Math.ceil(bytes) : 0);

/**
 * Takes bytes about to be served from today's `PROXY_BYTES_PER_DAY`. A take that would go past the limit is refused
 * and handed back, so bytes never served do not spend the budget (two concurrent takes near the limit can both be
 * refused). Taking 0 bytes asks whether any budget is left.
 */
export async function takeProxyBytes(bytes: number, now: Date = new Date()): Promise<boolean> {
  const amount = byteCount(bytes);
  const total = await incr(proxyKey(now), amount, PROXY_DAY_TTL);
  if (amount > 0 ? total <= limits.proxyBytesPerDay : total < limits.proxyBytesPerDay) return true;
  if (amount > 0) await incr(proxyKey(now), -amount, PROXY_DAY_TTL);
  return false;
}

/** Counts bytes already served (a body of unknown length, counted once it ends), even past the limit. */
export async function countProxyBytes(bytes: number, now: Date = new Date()): Promise<void> {
  await incr(proxyKey(now), byteCount(bytes), PROXY_DAY_TTL);
}
