import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

const SITE = path.join(import.meta.dirname, "site");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".avif": "image/avif", ".ico": "image/x-icon", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
};

export interface FixtureServer { origin: string; host: string; port: number; close(): Promise<void> }

export async function serveFixture(routes: Record<string, http.RequestListener> = {}, root = SITE): Promise<FixtureServer> {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    const reply = (status: number, text: string) => {
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(text);
    };
    let pathname: string;
    try {
      pathname = decodeURIComponent((req.url ?? "/").split("?")[0]);
    } catch {
      return reply(400, "bad request");
    }
    const route = routes[pathname];
    if (route) return route(req, res);
    const file = path.join(base, pathname === "/" ? "/index.html" : pathname);
    if (!file.startsWith(base + path.sep) || !existsSync(file) || !statSync(file).isFile()) return reply(404, "not found");
    res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
