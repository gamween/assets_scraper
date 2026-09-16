declare global {
  var __assetsScraperPalette:
    | { collect(options: Record<string, unknown>): unknown; restore(): void; decodeIconColors(arg: { b64: string; mime: string }): Promise<[string, number][]> }
    | undefined;
}

globalThis.__assetsScraperPalette = {
  collect() {
    throw new Error("Not implemented: E: palette collect");
  },
  restore() {},
  async decodeIconColors() {
    return [];
  },
};

// Makes this file a module so `declare global` is allowed (the collector source gets this from its type import).
export {};
