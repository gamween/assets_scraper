import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import type { Asset, AssetFormat, AssetKind, AssetRole } from "@/lib/contract";
import { normalizeAssetName, selectAssets } from "./select";
import { TEMPLATE_CARD_HEIGHT, TEMPLATE_CARD_WIDTH, templateCardImage } from "./testing";

interface Make {
  file: string;
  id?: string;
  role?: AssetRole;
  kind?: AssetKind;
  format?: AssetFormat;
  score?: number;
  order?: number;
  width?: number;
  height?: number;
}

let order = 0;

const make = ({ file, ...rest }: Make): Asset => {
  const format = rest.format ?? ((file.split(".").pop() ?? "png") as AssetFormat);
  const kind: AssetKind = rest.kind ?? (format === "svg" ? "svg" : "image");
  const at = rest.order ?? (order += 1);
  return {
    id: rest.id ?? file,
    kind,
    role: rest.role ?? "image",
    name: file.replace(/\.[^.]+$/, ""),
    filename: file,
    format,
    foundIn: ["img"],
    visible: true,
    declaredOnly: false,
    order: at,
    score: rest.score ?? 50,
    usedCount: 1,
    width: rest.width,
    height: rest.height,
    tone: "unknown",
    display: { url: `https://cdn.example.com/${file}`, proxy: "", format, width: rest.width, height: rest.height },
    original: null,
  };
};

const kept = async (...args: Parameters<typeof selectAssets>): Promise<string[]> => (await selectAssets(...args)).keep.map((asset) => asset.id);

const ROLES: AssetRole[] = ["site-logo", "logo", "social", "illustration", "image"];

/** A wordmark on a transparent canvas: the asset a deck download exists to fetch, and the one dHash merged. */
const wordmark = (text: string): Promise<Buffer> =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200"><rect width="800" height="200" fill="none"/>` +
        `<text x="40" y="140" font-family="sans-serif" font-size="110" fill="#000">${text}</text></svg>`,
    ),
  )
    .png()
    .toBuffer();

/** A page with one horizontal band: contrast, but none of it horizontal, so there is nothing to hash. */
const band = (top: boolean): Promise<Buffer> =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><rect width="1200" height="900" fill="#ffffff"/>` +
        `<rect y="${top ? 0 : 860}" width="1200" height="40" fill="#111111"/></svg>`,
    ),
  )
    .png()
    .toBuffer();

/** A smooth pattern, big enough to pass the size gate, plus the same picture at a smaller size. */
let big: Buffer;
let resized: Buffer;
let other: Buffer;

beforeAll(async () => {
  const raw = (width: number, height: number, phase: number): Promise<Buffer> => {
    const pixels = Buffer.alloc(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        pixels[y * width + x] = Math.max(0, Math.min(255, Math.round(128 + 110 * Math.sin((x / width) * 7 + phase) * Math.cos((y / height) * 3))));
      }
    }
    return sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer();
  };
  big = await raw(1200, 900, 0);
  resized = await sharp(big).resize(800, 600).png().toBuffer();
  other = await raw(1200, 900, 1.7);
});

describe("selectAssets, deck profile", () => {
  it("drops icons and sprite symbols and keeps the usable roles", async () => {
    const assets = [
      make({ file: "icon.svg", role: "icon" }),
      make({ file: "sprite.svg", role: "sprite-symbol" }),
      ...ROLES.map((role) => make({ file: `${role}.svg`, role })),
    ];
    const selection = await selectAssets(assets);
    expect(selection.keep.map((asset) => asset.role).sort()).toEqual([...ROLES].sort());
    expect(selection.dropped).toEqual({ icon: 1, sprite: 1 });
  });

  it("keeps icons when it is asked to", async () => {
    const assets = [make({ file: "icon.svg", role: "icon" }), make({ file: "hero.svg" })];
    expect(await kept(assets, { includeIcons: true })).toEqual(["icon.svg", "hero.svg"]);
  });

  it("drops a small raster unless it is a logo", async () => {
    expect(await kept([make({ file: "photo.png", width: 320, height: 200 })])).toEqual([]);
    expect((await selectAssets([make({ file: "photo.png", width: 320, height: 200 })])).dropped).toEqual({ small: 1 });
    for (const role of ["site-logo", "logo", "favicon"] as AssetRole[]) {
      expect(await kept([make({ file: `${role}.png`, role, width: 320, height: 200 })])).toEqual([`${role}.png`]);
    }
  });

  it("never drops an SVG for its size", async () => {
    expect(await kept([make({ file: "tiny.svg", width: 24, height: 24 })])).toEqual(["tiny.svg"]);
  });

  it("prefers the vector when a raster normalizes to the same name", async () => {
    const assets = [make({ file: "logo.svg", role: "logo" }), make({ file: "logo@2x.png", role: "logo", width: 800, height: 200 })];
    const selection = await selectAssets(assets);
    expect(selection.keep.map((asset) => asset.id)).toEqual(["logo.svg"]);
    expect(selection.dropped).toEqual({ "vector-preferred": 1 });
    expect(normalizeAssetName("logo@2x.png")).toBe(normalizeAssetName("logo.svg"));
    expect(normalizeAssetName("hero-1024x512.jpg")).toBe(normalizeAssetName("hero.webp"));
    expect(normalizeAssetName("card_large.png")).toBe(normalizeAssetName("card.svg"));
    expect(normalizeAssetName("logo-dark.png")).not.toBe(normalizeAssetName("logo.png"));
  });

  it("keeps one of two files with identical bytes, preferring the vector", async () => {
    const assets = [make({ file: "mark.png", width: 900, height: 900 }), make({ file: "brand.svg" })];
    const bytes = new Map([
      ["mark.png", Buffer.from("<svg>same bytes</svg>")],
      ["brand.svg", Buffer.from("<svg>same bytes</svg>")],
    ]);
    const selection = await selectAssets(assets, { profile: "deck" }, bytes);
    expect(selection.keep.map((asset) => asset.id)).toEqual(["brand.svg"]);
    expect(selection.dropped).toEqual({ duplicate: 1 });
    expect(selection.duplicates).toEqual([{ keptId: "brand.svg", droppedIds: ["mark.png"] }]);
  });

  it("keeps the larger of two rasters that look the same", async () => {
    const assets = [
      make({ file: "hero-a.png", width: 800, height: 600 }),
      make({ file: "hero-b.png", width: 1200, height: 900 }),
      make({ file: "hero-c.png", width: 1200, height: 900 }),
    ];
    const bytes = new Map([
      ["hero-a.png", resized],
      ["hero-b.png", big],
      ["hero-c.png", other],
    ]);
    const selection = await selectAssets(assets, {}, bytes);
    expect(selection.keep.map((asset) => asset.id)).toEqual(["hero-b.png", "hero-c.png"]);
    expect(selection.dropped).toEqual({ "near-duplicate": 1 });
    expect(selection.duplicates).toEqual([{ keptId: "hero-b.png", droppedIds: ["hero-a.png"] }]);
  });

  it("keeps distinct logos that a 64 bit hash grouped together", async () => {
    // Regression: transparent wordmarks all hashed to 0000000000000000, so a deck download of three brand marks
    // returned one file and counted the other two as near duplicates.
    const marks = ["ACME", "GLOBEX", "INITECH"];
    const bytes = new Map(await Promise.all(marks.map(async (text, index) => [`logo-${index}.png`, await wordmark(text)] as const)));
    const assets = marks.map((_, index) => make({ file: `logo-${index}.png`, role: "logo", width: 800, height: 200, score: 90 - index }));
    const selection = await selectAssets(assets, {}, bytes);
    expect(selection.keep.map((asset) => asset.id)).toEqual(["logo-0.png", "logo-1.png", "logo-2.png"]);
    expect(selection.dropped).toEqual({});
  });

  it("keeps six cards cut from one template, and still drops a copy of one of them", async () => {
    // Regression: sibling assets that share a layout only differ in detail a 16x16 comparison averages away, so this
    // selection kept 4 of 6 and reported the two it deleted as near duplicates. The seventh asset is a real resize of
    // the first card, so the pass is still doing its job rather than switched off.
    const cards = await Promise.all([0, 1, 2, 3, 4, 5].map((index) => templateCardImage(index)));
    const bytes = new Map<string, Buffer>(cards.map((card, index) => [`card-${index}.png`, card]));
    bytes.set("card-0-small.png", await sharp(cards[0]).resize(400, 300).png().toBuffer());
    const assets = [...bytes.keys()].map((file, index) =>
      make({ file, width: TEMPLATE_CARD_WIDTH, height: TEMPLATE_CARD_HEIGHT, score: 90 - index }),
    );
    const selection = await selectAssets(assets, { profile: "deck" }, bytes);
    expect(selection.keep.map((asset) => asset.id)).toEqual(cards.map((_, index) => `card-${index}.png`));
    expect(selection.dropped).toEqual({ "near-duplicate": 1 });
    expect(selection.duplicates).toEqual([{ keptId: "card-0.png", droppedIds: ["card-0-small.png"] }]);
  });

  it("keeps two flat pages whose only contrast is horizontal bands", async () => {
    // Regression: both hashed to all zero bits, which made every such page a duplicate of every other.
    const bytes = new Map([
      ["page-top.png", await band(true)],
      ["page-bottom.png", await band(false)],
    ]);
    const assets = [
      make({ file: "page-top.png", width: 1200, height: 900, score: 60 }),
      make({ file: "page-bottom.png", width: 1200, height: 900, score: 55 }),
    ];
    const selection = await selectAssets(assets, {}, bytes);
    expect(selection.keep.map((asset) => asset.id)).toEqual(["page-top.png", "page-bottom.png"]);
    expect(selection.dropped).toEqual({});
  });

  it("keeps only the largest favicon", async () => {
    const assets = [
      make({ file: "favicon-16.png", role: "favicon", width: 16, height: 16 }),
      make({ file: "favicon-32.png", role: "favicon", width: 32, height: 32 }),
      make({ file: "favicon-180.png", role: "favicon", width: 180, height: 180 }),
    ];
    const selection = await selectAssets(assets);
    expect(selection.keep.map((asset) => asset.id)).toEqual(["favicon-180.png"]);
    expect(selection.dropped).toEqual({ "extra-favicon": 2 });
  });

  it("caps the selection at the highest scoring assets", async () => {
    const assets = [
      make({ file: "a.svg", score: 70 }),
      make({ file: "b.svg", score: 90 }),
      make({ file: "c.svg", score: 80 }),
    ];
    const selection = await selectAssets(assets, { max: 2 });
    expect(selection.keep.map((asset) => asset.id)).toEqual(["b.svg", "c.svg"]);
    expect(selection.dropped).toEqual({ cap: 1 });
  });

  it("drops an asset with no way to fetch it", async () => {
    const asset = { ...make({ file: "gone.png", width: 900, height: 900 }), display: null, original: null };
    expect((await selectAssets([asset])).dropped).toEqual({ unavailable: 1 });
  });

  it("returns the same order for the same input, by score then order", async () => {
    const assets = [
      make({ file: "d.svg", score: 50, order: 4 }),
      make({ file: "a.svg", score: 90, order: 1 }),
      make({ file: "c.svg", score: 50, order: 3 }),
      make({ file: "b.svg", score: 90, order: 2 }),
    ];
    const first = await kept(assets);
    expect(first).toEqual(["a.svg", "b.svg", "c.svg", "d.svg"]);
    expect(await kept([...assets].reverse())).toEqual(first);
  });
});

describe("selectAssets, explicit options", () => {
  it("keeps the named ids whatever the profile would do", async () => {
    const assets = [make({ file: "icon.svg", role: "icon" }), make({ file: "photo.png", width: 80, height: 80 }), make({ file: "hero.svg" })];
    const selection = await selectAssets(assets, { ids: ["icon.svg", "photo.png"] });
    expect(selection.keep.map((asset) => asset.id)).toEqual(["icon.svg", "photo.png"]);
    expect(selection.dropped).toEqual({ filter: 1 });
  });

  it("still caps a list of ids", async () => {
    // Regression: the ids path returned before the cap, so max was ignored and maxFiles guarded nothing on the MCP
    // download_assets surface, where the ids come straight from an agent.
    const assets = Array.from({ length: 500 }, (_, index) => make({ file: `asset-${index}.svg`, score: 500 - index }));
    const ids = assets.map((asset) => asset.id);
    const capped = await selectAssets(assets, { ids, max: 3 });
    expect(capped.keep.map((asset) => asset.id)).toEqual(["asset-0.svg", "asset-1.svg", "asset-2.svg"]);
    expect(capped.dropped).toEqual({ cap: 497 });
    expect((await selectAssets(assets, { ids })).keep).toHaveLength(60);
  });

  it("filters by kind, role, name and size, counting every drop as a filter", async () => {
    const assets = [
      make({ file: "logo.svg", role: "logo" }),
      make({ file: "hero-shot.png", role: "image", width: 1200, height: 800 }),
      make({ file: "small-logo.png", role: "logo", width: 400, height: 120 }),
    ];
    expect(await kept(assets, { kinds: ["svg"] })).toEqual(["logo.svg"]);
    expect((await selectAssets(assets, { kinds: ["svg"] })).dropped).toEqual({ filter: 2 });
    expect(await kept(assets, { roles: ["image"] })).toEqual(["hero-shot.png"]);
    expect(await kept(assets, { nameContains: "SHOT" })).toEqual(["hero-shot.png"]);
  });

  it("keeps the role exemption when the caller names minLongSide itself", async () => {
    // Regression: an explicit minLongSide filtered before the size gate and with no check on role, so the same 400x120
    // logo was kept with the default 600 and dropped when a caller passed 600, which is spec 4.2's gate either way.
    const assets = [
      make({ file: "logo.svg", role: "logo" }),
      make({ file: "hero-shot.png", role: "image", width: 1200, height: 800 }),
      make({ file: "small-logo.png", role: "logo", width: 400, height: 120 }),
      make({ file: "thumb.png", role: "image", width: 320, height: 200 }),
    ];
    expect(await kept(assets, { minLongSide: 600 })).toEqual(["logo.svg", "hero-shot.png", "small-logo.png"]);
    expect((await selectAssets(assets, { minLongSide: 600 })).dropped).toEqual({ small: 1 });
    expect(await kept(assets)).toEqual(["logo.svg", "hero-shot.png", "small-logo.png"]);
    expect(await kept(assets, { minLongSide: 2000 })).toEqual(["logo.svg", "small-logo.png"]);
  });

  it("applies an explicit minLongSide in the all profile too", async () => {
    const assets = [
      make({ file: "logo.png", role: "logo", width: 400, height: 120 }),
      make({ file: "thumb.png", role: "image", width: 320, height: 200 }),
    ];
    expect(await kept(assets, { profile: "all" })).toEqual(["logo.png", "thumb.png"]);
    expect(await kept(assets, { profile: "all", minLongSide: 600 })).toEqual(["logo.png"]);
    expect((await selectAssets(assets, { profile: "all", minLongSide: 600 })).dropped).toEqual({ small: 1 });
  });
});

describe("selectAssets, all profile", () => {
  it("keeps everything the filters allow, with no size gate and no perceptual de-duplication", async () => {
    const assets = [
      make({ file: "icon.svg", role: "icon" }),
      make({ file: "sprite.svg", role: "sprite-symbol" }),
      make({ file: "favicon-16.png", role: "favicon", width: 16, height: 16 }),
      make({ file: "favicon-32.png", role: "favicon", width: 32, height: 32 }),
      make({ file: "thumb.png", width: 120, height: 90 }),
      make({ file: "logo.svg", role: "logo" }),
      make({ file: "logo@2x.png", role: "logo", width: 800, height: 200 }),
      make({ file: "hero-a.png", width: 800, height: 600 }),
      make({ file: "hero-b.png", width: 1200, height: 900 }),
    ];
    const bytes = new Map([["hero-a.png", resized], ["hero-b.png", big]]);
    const selection = await selectAssets(assets, { profile: "all" }, bytes);
    expect(selection.keep).toHaveLength(assets.length);
    expect(selection.dropped).toEqual({});
    expect(selection.duplicates).toEqual([]);
  });

  it("still drops byte-identical files and still applies the cap", async () => {
    const assets = [make({ file: "a.png", width: 900, height: 900 }), make({ file: "b.png", width: 900, height: 900 })];
    const bytes = new Map([["a.png", big], ["b.png", big]]);
    const selection = await selectAssets(assets, { profile: "all" }, bytes);
    expect(selection.keep).toHaveLength(1);
    expect(selection.dropped).toEqual({ duplicate: 1 });
    expect((await selectAssets(assets, { profile: "all", max: 1 })).dropped).toEqual({ cap: 1 });
  });
});

describe("selectAssets, edge cases", () => {
  it("does not let an unnamed SVG drop the rasters", async () => {
    const assets = [
      { ...make({ file: "..", format: "svg", kind: "svg" }), name: "", filename: "" },
      make({ file: "photo.png", width: 1200, height: 800 }),
    ];
    expect((await selectAssets(assets)).keep).toHaveLength(2);
  });

  it("takes no bytes rule when the map holds nothing for an asset", async () => {
    const assets = [make({ file: "a.png", width: 900, height: 900 }), make({ file: "b.png", width: 900, height: 900 })];
    const selection = await selectAssets(assets, {}, new Map([["a.png", big]]));
    expect(selection.keep).toHaveLength(2);
    expect(selection.dropped).toEqual({});
  });
});
