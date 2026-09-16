import http from "node:http";
import net from "node:net";
import type { EgressProxy } from "@/server/net/egress-proxy";
import { SafeFetchError } from "@/server/net/safe-fetch";
import type { SafeFetch, SafeResponse, Signer } from "@/server/scan/types";

/**
 * Stand-in for the real egress proxy (Track A) in engine tests: a plain HTTP and CONNECT forwarder that only lets
 * requests reach the `host:port` pairs in `allow`, and answers 403 to everything else.
 */
export interface TestProxy extends EgressProxy {
  /** Every URL or CONNECT target the browser asked for, allowed or not. */
  requests: string[];
}

export async function startTestProxy(options: { allow: string[] }): Promise<TestProxy> {
  const allowed = new Set(options.allow);
  const requests: string[] = [];
  const blockedHosts: string[] = [];
  const sockets = new Set<net.Socket>();
  let bytes = 0;
  const block = (target: string) => blockedHosts.push(target);

  const server = http.createServer((req, res) => {
    const target = req.url ?? "";
    requests.push(target);
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const port = Number(url.port || 80);
    if (!allowed.has(`${url.hostname}:${port}`)) {
      block(url.host);
      res.writeHead(403, { "content-type": "text/plain" }).end("blocked");
      return;
    }
    const upstream = http.request({ host: url.hostname, port, method: req.method, path: `${url.pathname}${url.search}`, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.on("data", (chunk: Buffer) => (bytes += chunk.length));
      response.pipe(res);
    });
    upstream.on("error", () => res.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on("connect", (req, socket, head) => {
    const target = req.url ?? "";
    requests.push(`CONNECT ${target}`);
    if (!allowed.has(target)) {
      block(target);
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const separator = target.lastIndexOf(":");
    const upstream = net.connect(Number(target.slice(separator + 1)), target.slice(0, separator), () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("data", (chunk: Buffer) => (bytes += chunk.length));
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    requests,
    stats: () => ({ bytes, blocked: blockedHosts.length, blockedHosts: [...blockedHosts] }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

type Route = (url: URL) => Response | Promise<Response>;

/**
 * Stand-in for `safeFetch` (Track A): global fetch restricted to `allow` (`host:port` pairs), plus canned `routes`
 * keyed by URL prefix. Everything else fails the way safeFetch fails: `.invalid` hosts with `dns`, the rest with
 * `blocked-address`.
 */
export function createFakeFetch(options: { allow?: string[]; routes?: Record<string, Route> } = {}): SafeFetch & { calls: string[] } {
  const allowed = new Set(options.allow ?? []);
  const calls: string[] = [];
  const fetchFn = async (input: string, init: Parameters<SafeFetch>[1] = {}): Promise<SafeResponse> => {
    calls.push(input);
    const url = new URL(input);
    const signals = [init.signal, init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined].filter((signal): signal is AbortSignal => Boolean(signal));
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    const route = Object.entries(options.routes ?? {}).find(([prefix]) => input.startsWith(prefix))?.[1];
    let response: Response;
    if (route) {
      response = await route(url);
    } else if (allowed.has(`${url.hostname}:${url.port || (url.protocol === "https:" ? 443 : 80)}`)) {
      try {
        response = await fetch(input, { method: init.method ?? "GET", headers: init.headers, signal, redirect: "follow" });
      } catch (error) {
        if (init.signal?.aborted) throw new SafeFetchError("aborted", "aborted");
        if (signal?.aborted) throw new SafeFetchError("timeout", "timeout");
        throw new SafeFetchError("connect", String(error));
      }
    } else if (url.hostname.endsWith(".invalid")) {
      throw new SafeFetchError("dns", `DNS lookup failed for ${url.hostname}`);
    } else {
      throw new SafeFetchError("blocked-address", `${url.host} is not a public address`);
    }
    return toSafeResponse(input, response);
  };
  return Object.assign(fetchFn, { calls });
}

function toSafeResponse(requested: string, response: Response): SafeResponse {
  const empty = () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  return {
    url: response.url || requested,
    status: response.status,
    headers: response.headers,
    redirected: response.redirected,
    stream: () => response.body ?? empty(),
    buffer: async () => Buffer.from(await response.arrayBuffer()),
    text: () => response.text(),
    json: <T>() => response.json() as Promise<T>,
    cancel: async () => {
      await response.body?.cancel().catch(() => {});
    },
  };
}

export function createFakeSigner(): Signer {
  let count = 0;
  return {
    sign(url: string) {
      count += 1;
      return `/api/asset?u=${encodeURIComponent(url)}`;
    },
    get count() {
      return count;
    },
  };
}

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
