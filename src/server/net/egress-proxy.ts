import http from "node:http";
import net from "node:net";
import { limits } from "@/server/config/limits";
import { isTestAllowed, pinnedConnectOptions, resolvePublicAddresses } from "./ip";

export interface EgressProxyOptions {
  maxBytes?: number;
  maxSockets?: number;
  /**
   * Time to resolve an upstream host, then again to open a connection across every address it resolved to. A lookup
   * past it is abandoned (the resolver thread still finishes it) and answered like a connect timeout.
   */
  connectTimeoutMs?: number;
  /** Time an open upstream connection may stay silent. */
  idleTimeoutMs?: number;
}

export interface EgressProxyStats {
  /** Bytes relayed in both directions. */
  bytes: number;
  /** Requests refused by policy: malformed targets, other ports, own hosts, private or unresolvable addresses. */
  blocked: number;
  /** The first distinct hosts behind `blocked`. */
  blockedHosts: string[];
  /** Allowed requests turned away for capacity: the socket cap, the byte cap or a closed proxy. Not in `blocked`. */
  refused: number;
}

export interface EgressProxy {
  port: number;
  stats(): EgressProxyStats;
  close(): Promise<void>;
}

/** Hop-by-hop headers (RFC 9110 7.6.1) plus the proxy ones Chromium sends. Never forwarded in either direction. */
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade",
]);
const CONNECT_TARGET = /^(\[[0-9a-f:.]+\]|[^\s:[\]/@]+):(\d{1,5})$/i;
const MAX_BLOCKED_HOSTS = 50;
const UPSTREAM_CONNECT_MS = 10_000;
const UPSTREAM_IDLE_MS = 30_000;
const EMPTY_REPLY = "\r\nContent-Length: 0\r\n\r\n";
/** The rejection of `resolveWithin` when the lookup outlasts its deadline, apart from the policy refusals of the resolver. */
const DNS_TIMEOUT = Symbol("dns-timeout");

/** Removes hop-by-hop headers, every header named in `Connection` and `extra` names from a raw header list. */
function endToEndHeaders(raw: string[], extra: string[] = []): string[] {
  const named = new Set<string>(extra);
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() === "connection") for (const token of raw[i + 1].split(",")) named.add(token.trim().toLowerCase());
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i].toLowerCase();
    if (!HOP_BY_HOP.has(name) && !named.has(name)) out.push(raw[i], raw[i + 1]);
  }
  return out;
}

/**
 * Per-scan forward proxy for Chromium (spec 11.1). Plain HTTP arrives in absolute form, everything else (HTTPS,
 * WebSocket) as CONNECT. Each target must use port 80 or 443 (or an exact test allowlist entry), must not be an own
 * host, and must resolve only to public addresses; the upstream socket connects only to the checked addresses, trying
 * the next one when a connection fails, so DNS rebinding cannot redirect it. Blocked CONNECTs get 403, CONNECTs over
 * capacity 503, and a tunnel whose upstream cannot be reached 502 (refused, unreachable) or 504 (DNS or connect timeout).
 * Plain requests lose their connection in all these cases, so Chromium sees a network error rather than a page.
 * Sockets and bytes are capped per proxy; `close()` destroys everything.
 */
export async function startEgressProxy(options: EgressProxyOptions = {}): Promise<EgressProxy> {
  const maxBytes = options.maxBytes ?? limits.egressMaxBytes;
  const maxSockets = options.maxSockets ?? limits.egressMaxSockets;
  const connectTimeoutMs = options.connectTimeoutMs ?? UPSTREAM_CONNECT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? UPSTREAM_IDLE_MS;
  let bytes = 0;
  let blocked = 0;
  let refused = 0;
  let active = 0;
  let closed = false;
  const blockedHosts = new Set<string>();
  const sockets = new Set<net.Socket>();

  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const destroyAll = () => {
    for (const socket of sockets) socket.destroy();
  };
  const count = (size: number) => {
    bytes += size;
    if (bytes > maxBytes) destroyAll();
  };
  const block = (host: string) => {
    blocked += 1;
    if (blockedHosts.size < MAX_BLOCKED_HOSTS) blockedHosts.add(host.slice(0, 255));
  };
  /**
   * Checks that need no DNS: `blocked` for a port outside policy, `refused` when the proxy is closed or a cap is reached
   * (counted apart, so a heavy page past the byte cap does not look like blocked requests), `ok` when the caller may
   * reserve a socket slot. Policy comes first, so a target outside it counts as blocked even at capacity.
   */
  const admit = (host: string, port: number): "ok" | "blocked" | "refused" => {
    if (port !== 80 && port !== 443 && !isTestAllowed(host, port)) return "blocked";
    return closed || bytes > maxBytes || active >= maxSockets ? "refused" : "ok";
  };
  /**
   * `resolvePublicAddresses`, or a rejection with `DNS_TIMEOUT` once `connectTimeoutMs` passes: a name whose DNS never
   * answers must not hold a socket slot, or leave Chromium waiting, for as long as the system resolver keeps trying.
   */
  const resolveWithin = (host: string, port: number) =>
    new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(DNS_TIMEOUT), connectTimeoutMs);
      resolvePublicAddresses(host, port)
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    });
  /** Reserves a socket slot and returns its idempotent release. */
  const reserve = () => {
    active += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        active -= 1;
      }
    };
  };

  const server = http.createServer();
  server.on("connection", track);
  server.on("clientError", (_error, socket) => socket.destroy());

  server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
    let target: URL | null = null;
    try {
      target = new URL(req.url ?? "");
    } catch {}
    const port = target ? Number(target.port || 80) : 0;
    const admission = target?.protocol === "http:" ? admit(target.hostname, port) : "blocked";
    if (!target || admission !== "ok") {
      if (admission === "refused") refused += 1;
      else block(target?.hostname || (req.url ?? "").slice(0, 100));
      res.destroy();
      return;
    }
    const url = target;
    const release = reserve();
    resolveWithin(url.hostname, port).then(
      (addresses) => {
        if (closed || res.destroyed) {
          release();
          res.destroy();
          return;
        }
        let upstream: http.ClientRequest;
        try {
          upstream = http.request({
            ...pinnedConnectOptions(url.hostname, addresses),
            port,
            method: req.method,
            path: `${url.pathname}${url.search}`,
            headers: [...endToEndHeaders(req.rawHeaders, ["host"]), "Host", url.host],
            setHost: false,
            agent: false,
          });
        } catch {
          release();
          res.destroy();
          return;
        }
        upstream.on("socket", (socket) => {
          track(socket);
          // Not the `timeout` request option: Node applies it to the connect too, so a host that drops SYNs would hold
          // the request for the idle time instead of the connect time.
          socket.setTimeout(socket.connecting ? connectTimeoutMs : idleTimeoutMs);
          socket.once("connect", () => socket.setTimeout(idleTimeoutMs));
          socket.on("timeout", () => upstream.destroy());
          socket.on("data", (chunk: Buffer) => count(chunk.length));
        });
        upstream.on("response", (response) => {
          // Node's client parser accepts statuses from 0 to 999 and any reason phrase, but `writeHead` throws on a
          // status below 100 and on a reason phrase or header it refuses, and a throw here would be uncaught. So the
          // reason phrase is never relayed, a status that is not a final HTTP status becomes 502, and anything else
          // `writeHead` refuses drops the connection.
          const status = response.statusCode ?? 0;
          try {
            if (status < 200 || status > 599) {
              response.destroy();
              res.writeHead(502, { "content-length": "0" }).end();
              return;
            }
            res.writeHead(status, endToEndHeaders(response.rawHeaders));
          } catch {
            upstream.destroy();
            res.destroy();
            return;
          }
          response.pipe(res);
          response.on("error", () => res.destroy());
        });
        upstream.on("error", () => res.destroy());
        upstream.on("close", () => {
          release();
          // Node's client closes without an 'error' event in some cases (a 101 reply it has no upgrade handler for)
          if (!res.headersSent) res.destroy();
        });
        req.on("data", (chunk: Buffer) => count(chunk.length));
        res.on("close", () => upstream.destroy());
        req.pipe(upstream);
      },
      (error: unknown) => {
        release();
        if (error !== DNS_TIMEOUT) block(url.hostname);
        res.destroy();
      },
    );
  });

  server.on("connect", (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on("error", () => {});
    const raw = req.url ?? "";
    const match = CONNECT_TARGET.exec(raw);
    const host = match ? match[1] : raw.slice(0, 100);
    const port = match ? Number(match[2]) : 0;
    const deny = () => {
      block(host);
      client.end(`HTTP/1.1 403 Forbidden${EMPTY_REPLY}`);
    };
    const admission = match ? admit(host, port) : "blocked";
    if (admission === "blocked") return deny();
    if (admission === "refused") {
      refused += 1;
      client.end(`HTTP/1.1 503 Service Unavailable${EMPTY_REPLY}`);
      return;
    }
    const release = reserve();
    resolveWithin(host, port).then(
      (addresses) => {
        if (closed || client.destroyed) {
          release();
          client.destroy();
          return;
        }
        let established = false;
        /** Answers a tunnel that never opened, once; Chromium then fails the request instead of waiting on it. */
        const fail = (status: string) => {
          if (!established && !client.destroyed && !client.writableEnded) client.end(`HTTP/1.1 ${status}${EMPTY_REPLY}`);
        };
        const upstream = net.connect({ ...pinnedConnectOptions(host, addresses), port });
        track(upstream);
        upstream.setTimeout(connectTimeoutMs);
        upstream.once("connect", () => {
          established = true;
          upstream.setTimeout(idleTimeoutMs);
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          upstream.on("data", (chunk: Buffer) => count(chunk.length));
          client.on("data", (chunk: Buffer) => count(chunk.length));
          if (head.length > 0) {
            count(head.length);
            upstream.write(head);
          }
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on("timeout", () => {
          fail("504 Gateway Timeout");
          upstream.destroy();
        });
        upstream.on("error", () => fail("502 Bad Gateway"));
        upstream.on("close", () => {
          release();
          // a destroy without an error (the proxy closing) still answers a tunnel that never opened
          if (established) client.destroy();
          else fail("502 Bad Gateway");
        });
        client.on("close", () => upstream.destroy());
      },
      (error: unknown) => {
        release();
        if (error !== DNS_TIMEOUT) deny();
        else if (!client.destroyed && !client.writableEnded) client.end(`HTTP/1.1 504 Gateway Timeout${EMPTY_REPLY}`);
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as net.AddressInfo;

  return {
    port,
    stats: () => ({ bytes, blocked, blockedHosts: [...blockedHosts], refused }),
    close: async () => {
      if (closed) return;
      closed = true;
      destroyAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
