import { createRequire } from "node:module";
import path from "node:path";
import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";

const require = createRequire(import.meta.url);

/** Real (symlink-resolved) package directory, so pnpm does not get traced twice. */
function pkgDir(entry: string, up = 1): string {
  const resolved = require.resolve(entry);
  return path
    .relative(process.cwd(), path.resolve(path.dirname(resolved), ...Array(up).fill("..")))
    .split(path.sep)
    .join("/");
}

const chromiumFiles = [`./${pkgDir("@sparticuz/chromium")}/bin/**`, `./${pkgDir("playwright-core", 0)}/browsers.json`];

// React needs eval() in development only (error stack reconstruction, see the Next.js CSP guide).
const isDev = process.env.NODE_ENV === "development";

const CSP = [
  "default-src 'self'",
  "img-src 'self' blob: data: https:",
  "font-src 'self' blob: data:",
  "connect-src 'self' https:",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Every path except the asset proxy. Next only copies a route handler header when the config did not set it
 * already, so an app-wide CSP would replace the proxy's own sandbox CSP (spec 11.2).
 */
const APP_CSP_SOURCE = "/((?!api/asset(?:/|$)).*)";

const nextConfig: NextConfig = {
  typedRoutes: true,
  reactCompiler: true,
  serverExternalPackages: ["@sparticuz/chromium", "playwright-core", "sharp", "fontkit", "wawoff2"],
  outputFileTracingIncludes: { "/api/scan": chromiumFiles },
  poweredByHeader: false,
  async headers() {
    return [
      { source: APP_CSP_SOURCE, headers: [{ key: "Content-Security-Policy", value: CSP }] },
      {
        source: "/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default withBotId(nextConfig);
