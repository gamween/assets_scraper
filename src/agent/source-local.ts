import { randomBytes } from "node:crypto";
import type { Asset, FontFamily, PageInfo, Palette, ScanStats } from "@/lib/contract";
import { limits } from "@/server/config/limits";
import { ScanFailure } from "@/server/errors";
import { safeFetch } from "@/server/net/safe-fetch";
import { scanEngine } from "@/server/scan/engine";
import type { SafeFetch, ScanBackend } from "@/server/scan/types";
import { sanitizeHost } from "./dest";
import type { AgentScan, ScanSource } from "./types";

/**
 * The local scan source: the v1 engine in this process, driving the user's Chrome behind the egress proxy (spec 2).
 * It folds the NDJSON event stream into one `AgentScan`, so the CLI and the MCP server see the same shape a remote
 * scan returns.
 */

export interface LocalScanSourceDeps {
  /** The scan engine. Overridden by the tests so they can watch what the engine was asked. */
  backend?: ScanBackend;
  /** Used by `fetchBytes`. Every URL came from a scanned page, so it is always a guarded fetch. */
  fetch?: SafeFetch;
}

/** `stripe.com-m1kq2z-4f9a1c`: the host of the final URL, when the scan ran, and enough randomness to be unique. */
export const scanIdFor = (host: string, at: number = Date.now()): string =>
  `${sanitizeHost(host)}-${at.toString(36)}-${randomBytes(3).toString("hex")}`;

export function createLocalScanSource(deps: LocalScanSourceDeps = {}): ScanSource {
  const backend = deps.backend ?? scanEngine;
  const fetch = deps.fetch ?? safeFetch;

  return {
    kind: "local",

    async scan(url, options) {
      const assets: Asset[] = [];
      const warnings: string[] = [];
      let page: PageInfo | undefined;
      let fonts: FontFamily[] = [];
      let palette: Palette | null = null;
      let stats: ScanStats | undefined;
      let diagnostics: AgentScan["diagnostics"];
      let partial = false;

      const signal = options?.signal ?? new AbortController().signal;
      for await (const event of backend.scan({ url }, { signal })) {
        switch (event.type) {
          case "step":
            if (event.state === "start") options?.onStep?.(event.step);
            break;
          case "page":
            // Sent twice: the last one carries the brand links and the signed favicon (contract).
            page = event.page;
            break;
          case "palette":
            palette = event.palette;
            break;
          case "assets":
            assets.push(...event.items);
            break;
          case "fonts":
            fonts = event.families;
            break;
          case "warning":
            warnings.push(event.detail ? `${event.code}: ${event.detail}` : event.code);
            break;
          case "done":
            stats = event.stats;
            diagnostics = event.diagnostics;
            partial = event.partial;
            break;
          case "error":
            throw new ScanFailure(event.code, event.message, { httpStatus: event.httpStatus, fallback: event.fallback });
          default:
            break;
        }
      }

      if (!page || !stats) throw new ScanFailure("internal", "the scan ended without a result");
      if (partial && !warnings.some((warning) => warning.startsWith("partial"))) warnings.unshift("partial");

      return {
        scanId: scanIdFor(page.host),
        scannedAt: new Date().toISOString(),
        source: "local",
        page: {
          url: page.requestedUrl,
          finalUrl: page.finalUrl,
          host: page.host,
          title: page.title,
          ...(page.siteName === undefined ? {} : { siteName: page.siteName }),
        },
        assets,
        fonts,
        palette,
        stats,
        warnings,
        ...(diagnostics === undefined ? {} : { diagnostics }),
      };
    },

    async fetchBytes(target, options) {
      const inline = "inline" in target ? target.inline : undefined;
      if (inline) return Buffer.from(inline.base64, "base64");
      const url = target.url;
      if (!url) throw new Error("this file has no URL to fetch");
      if (url.startsWith("data:")) return decodeDataUri(url);
      const response = await fetch(url, {
        maxBytes: limits.proxyMaxBytes,
        timeoutMs: limits.proxyTimeoutMs,
        maxRedirects: limits.proxyMaxRedirects,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      if (response.status >= 400) {
        await response.cancel();
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      return response.buffer();
    },
  };
}

/** The bytes of a `data:` URI, base64 or percent encoded. A font family declared that way has no network path. */
export function decodeDataUri(url: string): Buffer {
  const comma = url.indexOf(",");
  if (comma === -1) throw new Error("malformed data URI");
  const meta = url.slice("data:".length, comma);
  const payload = url.slice(comma + 1);
  return /;base64$/i.test(meta) ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
}
