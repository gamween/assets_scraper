import type { CollectorOptions, RawCollectorOutput } from "../types";

declare global {
  var __assetsScraper: { collect(options: CollectorOptions): Promise<RawCollectorOutput> } | undefined;
}

globalThis.__assetsScraper = {
  async collect() {
    throw new Error("Not implemented: C: collector");
  },
};
