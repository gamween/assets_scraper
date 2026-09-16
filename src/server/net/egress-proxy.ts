import http from "node:http";
import net from "node:net";
import { limits } from "@/server/config/limits";
import { isTestAllowed, resolvePublicHost } from "./ip";

export interface EgressProxy {
  port: number;
  stats(): { bytes: number; blocked: number; blockedHosts: string[] };
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
 * host, and must resolve only to public addresses; the upstream socket connects to the checked address, so DNS
 * rebinding cannot redirect it. Blocked CONNECTs get 403 and blocked plain requests lose their connection, so Chromium
 * sees a network error rather than a page. Sockets and bytes are capped per proxy; `close()` destroys everything.
 */
export async function startEgressProxy(options: { maxBytes?: number; maxSockets?: number } = {}): Promise<EgressProxy> {
  const maxBytes = options.maxBytes ?? limits.egressMaxBytes;
  const maxSockets = options.maxSockets ?? limits.egressMaxSockets;
  let bytes = 0;
  let blocked = 0;
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
  /** Checks that need no DNS; the caller reserves a socket slot when it returns true. */
  const admit = (host: string, port: number) =>
    !closed && bytes <= maxBytes && active < maxSockets && port >= 1 && port <= 65_535 && (port === 80 || port === 443 || isTestAllowed(host, port));
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
    if (!target || target.protocol !== "http:" || !admit(target.hostname, port)) {
      block(target?.hostname || (req.url ?? "").slice(0, 100));
      res.destroy();
      return;
    }
    const url = target;
    const release = reserve();
    resolvePublicHost(url.hostname, port).then(
      (address) => {
        if (closed || res.destroyed) {
          release();
          res.destroy();
          return;
        }
        const upstream = http.request({
          host: address,
          port,
          method: req.method,
          path: `${url.pathname}${url.search}`,
          headers: [...endToEndHeaders(req.rawHeaders, ["host"]), "Host", url.host],
          setHost: false,
          agent: false,
          timeout: UPSTREAM_IDLE_MS,
        });
        upstream.on("socket", (socket) => {
          track(socket);
          socket.on("data", (chunk: Buffer) => count(chunk.length));
        });
        upstream.on("response", (response) => {
          res.writeHead(response.statusCode ?? 502, response.statusMessage, endToEndHeaders(response.rawHeaders));
          response.pipe(res);
          response.on("error", () => res.destroy());
        });
        upstream.on("timeout", () => upstream.destroy());
        upstream.on("error", () => res.destroy());
        upstream.on("close", release);
        req.on("data", (chunk: Buffer) => count(chunk.length));
        res.on("close", () => upstream.destroy());
        req.pipe(upstream);
      },
      () => {
        release();
        block(url.hostname);
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
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    };
    if (!match || !admit(host, port)) return deny();
    const release = reserve();
    resolvePublicHost(host, port).then(
      (address) => {
        if (closed || client.destroyed) {
          release();
          client.destroy();
          return;
        }
        let established = false;
        const upstream = net.connect({ host: address, port });
        track(upstream);
        upstream.setTimeout(UPSTREAM_CONNECT_MS);
        upstream.once("connect", () => {
          established = true;
          upstream.setTimeout(UPSTREAM_IDLE_MS);
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
        upstream.on("timeout", () => upstream.destroy());
        upstream.on("error", () => {
          if (!established && !client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
        });
        upstream.on("close", () => {
          release();
          if (established) client.destroy();
        });
        client.on("close", () => upstream.destroy());
      },
      () => {
        release();
        deny();
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
    stats: () => ({ bytes, blocked, blockedHosts: [...blockedHosts] }),
    close: async () => {
      if (closed) return;
      closed = true;
      destroyAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
