import { Redis } from "@upstash/redis";
import { getCache } from "@vercel/functions";
import { limits } from "@/server/config/limits";

export interface BudgetStore {
  /**
   * Adds `by` to the counter at `key` (created with a TTL) and returns the new total. A `by` of 0 only reads the total
   * and writes nothing, so a probe can never write back a stale total over a concurrent increment.
   */
  incr(key: string, by: number, ttlSeconds: number): Promise<number>;
}

const DAY_SECONDS = 86_400;
const SCAN_DAY_TTL = 2 * DAY_SECONDS;
const SCAN_MONTH_TTL = 40 * DAY_SECONDS;
const PROXY_DAY_TTL = 2 * DAY_SECONDS;
const UPSTASH_TIMEOUT_MS = 2_000;
/** After a shared store failure, requests use the in-memory counter alone for this long instead of waiting on it. */
const STORE_RETRY_MS = 30_000;

/** Per-instance counters. */
export class MemoryBudgetStore implements BudgetStore {
  private readonly counters = new Map<string, { total: number; expiresAt: number }>();

  async incr(key: string, by: number, ttlSeconds: number): Promise<number> {
    const now = Date.now();
    for (const [name, counter] of this.counters) if (counter.expiresAt <= now) this.counters.delete(name);
    if (by === 0) return this.counters.get(key)?.total ?? 0;
    const counter = this.counters.get(key) ?? { total: 0, expiresAt: now + ttlSeconds * 1000 };
    counter.total += by;
    this.counters.set(key, counter);
    return counter.total;
  }
}

/** Shared counters in Upstash Redis: atomic INCRBY and the TTL in one pipeline, a plain GET for a zero probe. */
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
    if (by === 0) return Number(await this.redis.get<number>(key)) || 0;
    const [total] = await this.redis.pipeline().incrby(key, by).expire(key, ttlSeconds).exec<[number, number]>();
    return total;
  }
}

/**
 * Shared counters in the Vercel Runtime Cache. It has no atomic increment (get, then set), so concurrent increments on
 * several instances can undercount, and it reports errors as misses; the in-memory shadow counter in `incr` keeps each
 * instance within the limit anyway. A zero probe, which every proxied request starts with, only reads.
 */
export class RuntimeCacheBudgetStore implements BudgetStore {
  async incr(key: string, by: number, ttlSeconds: number): Promise<number> {
    const cache = getCache({ namespace: "budget", keyHashFunction: (value) => value });
    const current = Number(await cache.get(key));
    const total = (Number.isFinite(current) ? current : 0) + by;
    if (by !== 0) await cache.set(key, total, { ttl: ttlSeconds });
    return total;
  }
}

let memory = new MemoryBudgetStore();
let sharedStoreDownUntil = 0;
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
  sharedStoreDownUntil = 0;
}

/**
 * Every increment also lands in the in-memory counter. When the shared store throws, the in-memory total is used;
 * when it answers, the larger of both, so a store that silently loses writes cannot lift this instance's limit. A
 * failure skips the shared store for `STORE_RETRY_MS`, so a store that hangs until its timeout does not add that wait
 * to every request.
 */
async function incr(key: string, by: number, ttlSeconds: number): Promise<number> {
  const store = getBudgetStore();
  const local = await memory.incr(key, by, ttlSeconds);
  if (store === memory || Date.now() < sharedStoreDownUntil) return local;
  try {
    return Math.max(await store.incr(key, by, ttlSeconds), local);
  } catch (error) {
    sharedStoreDownUntil = Date.now() + STORE_RETRY_MS;
    console.error(`Budget store failed, using the in-memory counter for ${STORE_RETRY_MS / 1000} s: ${error instanceof Error ? error.message : String(error)}`);
    return local;
  }
}

/**
 * Takes one scan from the client's daily budget, then from the shared daily and monthly budgets. A scan refused for
 * the day does not count toward the month, and a client over its own quota spends nothing from the shared budget, so
 * one address cannot empty the day for everyone. A null client (local dev, tests, any host with no client address)
 * skips the per-client check.
 */
export async function takeScanBudget(client: string | null = null, now: Date = new Date()): Promise<boolean> {
  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  if (client && (await incr(`scan:d:${day}:${client}`, 1, SCAN_DAY_TTL)) > limits.scansPerIpPerDay) return false;
  if ((await incr(`scan:d:${day}`, 1, SCAN_DAY_TTL)) > limits.scansPerDay) return false;
  return (await incr(`scan:m:${iso.slice(0, 7)}`, 1, SCAN_MONTH_TTL)) <= limits.scansPerMonth;
}

/**
 * Hands one scan back to every counter `takeScanBudget` moved, for a unit that bought nothing: a scan refused as
 * `busy` never reached a browser. A refund that crosses UTC midnight credits the new day, the same rounding the proxy
 * meter accepts.
 */
export async function refundScanBudget(client: string | null = null, now: Date = new Date()): Promise<void> {
  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  if (client) await incr(`scan:d:${day}:${client}`, -1, SCAN_DAY_TTL);
  await incr(`scan:d:${day}`, -1, SCAN_DAY_TTL);
  await incr(`scan:m:${iso.slice(0, 7)}`, -1, SCAN_MONTH_TTL);
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

/**
 * The least a body of unknown length takes from the budget at a time while it streams. Every body in flight holds at
 * most one partly used block, so concurrent bodies overshoot a store without atomic increments by at most one block
 * each, instead of by everything they stream before being counted.
 */
export const PROXY_BYTES_BLOCK = 1024 * 1024;

/** Today's proxied bytes for one body or one piece of work, taken before they are used; see `meterProxyBytes`. */
export interface ProxyBytesMeter {
  /** Takes exactly `bytes` more ahead of use (a known length, a first block, the largest possible output). False when they do not fit. */
  reserve(bytes: number): Promise<boolean>;
  /**
   * Counts `bytes` about to be used. When the reservation does not cover them, first reserves the difference, and at
   * least `PROXY_BYTES_BLOCK`. False when that does not fit, and then nothing is counted.
   */
  take(bytes: number): Promise<boolean>;
  /** Hands back the reserved bytes that were not used, once. Later reservations and takes are refused. */
  settle(): Promise<void>;
}

/**
 * Meters bytes against today's `PROXY_BYTES_PER_DAY` (the day of `now`, also for what is handed back later): bytes are
 * reserved before they are used, refusals go through `takeProxyBytes` (nothing counted), and `settle` hands back the
 * unused part. A reservation granted after `settle` is handed back at once.
 */
export function meterProxyBytes(now: Date = new Date()): ProxyBytesMeter {
  let reserved = 0;
  let used = 0;
  let settled = false;
  const handBack = async (bytes: number) => {
    if (bytes > 0) await incr(proxyKey(now), -bytes, PROXY_DAY_TTL);
  };
  const reserve = async (bytes: number) => {
    const amount = byteCount(bytes);
    if (settled || !(await takeProxyBytes(amount, now))) return false;
    if (settled) {
      await handBack(amount);
      return false;
    }
    reserved += amount;
    return true;
  };
  return {
    reserve,
    async take(bytes) {
      const amount = byteCount(bytes);
      const shortfall = used + amount - reserved;
      if (shortfall > 0 && !(await reserve(Math.max(PROXY_BYTES_BLOCK, shortfall)))) return false;
      // a settle that ran while the block was being granted already handed it back
      if (settled) return false;
      used += amount;
      return true;
    },
    async settle() {
      if (settled) return;
      settled = true;
      await handBack(reserved - used);
    },
  };
}
