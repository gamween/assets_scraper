# Reference site scans

Plan task 2.3, measurement pass. The 23 reference sites of the discovery lab, scanned through the app itself
(`POST /api/scan`, NDJSON) with `scripts/scan-sites.mjs`, then compared with the research labs.

- Run: 2026-09-17, local production build (`pnpm build`, `pnpm start -p 3201`), Chrome 153, macOS Apple Silicon, warm cache
  except for the first site, one scan at a time.
- Command: `OPS_TOKEN=... node scripts/scan-sites.mjs --base http://localhost:3201 --out <dir>`.
- Raw results (one JSON per site plus `summary.json` and `summary.md`) are kept outside git, in the scratchpad
  directory of the run.
- Baselines: `discovery-lab/table.md` and `discovery-lab/out-final/<host>/result.json` for assets and fonts,
  `palette-lab/results/*.json` and `reports/palette-verify.md` for palettes.
- Counting note: the lab's asset numbers are already merged (its `variants` field), so lab and app numbers are
  comparable. `svg` is SVG files plus unique inline SVG, as in the lab's `svgFiles + svgInlineUnique`.

## Results

| Site | Status | Duration | SVG | Images | Fonts | Site logo | Palette top brand | Hidden | Partial | Error |
|---|---|---|---|---|---|---|---|---|---|---|
| allbirds.com | done | 10103 ms | 33 | 29 | 6 | yes (Allbirds logo) | none | 12 | no | - |
| apple.com | done | 4371 ms | 72 | 98 | 13 | yes (Apple) | #0071e3 | 3 | no | - |
| binance.com | done | 10204 ms | 58 | 29 | 2 | yes (Binance) | #f0b90b | 106 | no | - |
| chain.link | done | 8109 ms | 88 | 52 | 17 | yes (Chainlink) | #0847f7 | 10 | no | - |
| coinbase.com | done | 5215 ms | 14 | 29 | 6 | yes (Coinbase Logo) | #0052ff | 8 | no | - |
| framer.com | done | 7557 ms | 168 | 94 | 34 | yes (On) | none | 1 | no | - |
| g2.com | error | 3630 ms | 0 | 0 | 0 | no | none | 0 | - | blocked |
| gatsbyjs.com | done | 4538 ms | 11 | 11 | 1 | yes (Link to home) | #663399 | 1 | no | - |
| gymshark.com | done | 12745 ms | 29 | 64 | 9 | yes (Gymshark) | #42b296 | 2 | no | - |
| ilovechickpea.ca | done | 9480 ms | 3 | 41 | 6 | yes (Chickpea logo) | #55c3f2 | 4 | no | - |
| linear.app | done | 6980 ms | 148 | 40 | 2 | yes (Linear) | #5e6ad2 | 337 | no | - |
| medium.com | done | 3148 ms | 2 | 16 | 9 | yes (Medium logo) | none | 31 | no | - |
| notion.com | done | 6129 ms | 44 | 37 | 6 | yes (Notion, Home) | #0075de | 1 | no | - |
| porsche.com | done | 6716 ms | 33 | 40 | 1 | yes (Porsche.com) | none | 2 | no | - |
| ripple.com | done | 7897 ms | 48 | 17 | 3 | yes (Home) | #006aff | 1 | no | - |
| sanity.io | done | 7904 ms | 137 | 45 | 2 | yes (Home) | #ff4100 | 33 | no | - |
| squarespace.com | done | 13794 ms | 18 | 210 | 9 | yes (Squarespace homepage) | none | 9 | no | - |
| stripe.com | done | 12207 ms | 173 | 56 | 2 | yes (Logo Stripe) | #533afd | 23 | no | - |
| techcrunch.com | done | 11412 ms | 50 | 50 | 30 | yes (TechCrunch logo) | #0a8935 | 43 | no | - |
| uniswap.org | done | 6544 ms | 52 | 36 | 2 | yes (uniswap logo) | #ff37c7 | 2 | no | - |
| vercel.com | done | 5734 ms | 44 | 30 | 3 | yes (Vercel) | none | 2 | no | - |
| webflow.com | done | 6855 ms | 69 | 111 | 5 | yes (Home Page) | #146ef5 | 31 | no | - |
| xrpl.org | done | 7874 ms | 101 | 99 | 7 | yes (XRP Ledger Home) | #21e46b | 10 | no | - |

`Duration` is `done.stats.durationMs`, or the wall time for `g2.com`, which ends with an `error` event.
`Fonts` is `done.stats.fonts` (declared families). `Hidden` is the sum of `done.stats.hidden`.
`Palette top brand` is `palette.brand[0]`; `none` means the palette has neutrals only, which is also what the lab
produced for allbirds.com, framer.com and vercel.com.

## What matches the lab

- Every unblocked site finishes: 22 of 23 `done`, none `partial`, no `internal` error, slowest 13.8 s against the 60 s
  production target, `collector: "isolated"` everywhere except `g2.com` (`"none"`).
- A site logo is found on all 22 unblocked sites.
- `g2.com` behaves as in the lab: `blocked` with `blockReason: "challenge-markup"`, HTTP 403, and one fallback asset
  on the error event.
- Asset counts are within five of the lab on 15 of 22 sites, and exact on allbirds.com (33/29), chain.link
  (88 SVG), framer.com (168 SVG), gatsbyjs.com (11/11), medium.com (2/16), notion.com (44/37), vercel.com (44/30),
  webflow.com (69 SVG) and ilovechickpea.ca (3/41).
- Palettes match the palette lab on 11 of the 12 sites it covers. Brand lists are identical on apple.com, linear.app,
  notion.com, uniswap.org, webflow.com, and empty on allbirds.com, framer.com and vercel.com, as in the lab.
- linear.app is better than the lab: the background neutral is `#08090a` where the lab gave `#101112`, which is exactly
  the fix `reports/palette-verify.md` asked for (it moves the site from 4/5 to 5/5).

## Regressions

Nothing is fixed here. Each entry is what the run measured, against which lab number, and the most likely cause
found by reading the result files and the code. gymshark.com and squarespace.com were scanned twice and gave identical
counts both times, so these are deterministic, not run to run noise.

### R1: responsive width variants become separate assets (squarespace.com, 210 images against 116)

Evidence: `services-desktop` comes back as seven assets whose URLs differ only by the width suffix
(`-100w`, `-300w`, `-500w`, `-750w`, `-1000w`, `-1500w`, `-2500w`, all `.webp`, one visible at 1500x844 and six
invisible), and the same shape repeats for `online-store-desktop`, `invoicing-desktop` and the hero video posters.
Stripping `-<N>w` from the 210 URLs leaves 16 groups holding 107 assets, so about 91 assets are duplicates of one
another. The lab merged these and reported 116.

Suspected cause: `variantKey` (spec 8.5) removes `_small/_medium/_large/_xlarge`, `@2x` and `_2x` but not the
`-<N>w` form, and these URLs come from `srcset` width descriptors inside one `<picture>`, so the element group merge
does not catch them either.

### R2: CDN size in the path becomes separate assets (apple.com, 98 images against 51)

Evidence: the same mzstatic image is three assets,
`.../image/thumb/x5JjmiSD75wN12-HmmZRcg/980x522sr.jpg`, `/1376x736sr.jpg` and `/2500x1336sr.jpg`; six assets share
the alt text "Stream now, Slow Horses - Thriller - New season."; 66 of the 98 raster assets are invisible and 45 of
them are found only in `picture` plus `noscript`. All 98 URLs are distinct, so nothing is counted twice; they are
variants that did not merge.

Suspected cause: the same `variantKey` gap as R1 for CDN paths that carry the size as a path segment
(`/<width>x<height><flags>.<ext>`). Part of the gap may be intended: apple.com art-directs with `media`, and spec 8.3
keeps `media` sources separate, so the fix has to separate real art direction from pure size variants.

### R3: declared CSS URLs stop at the probe cap (xrpl.org, 101 SVG and 99 images against 192 and 160)

Evidence: 175 of the 352 URLs the lab kept are missing from the app result, almost all of them `https://xrpl.org/img/...`
files declared in stylesheets, plus a handful of CSS data-URI icons. The app keeps exactly 151 `declaredOnly` assets,
emits a `verify-skipped` warning, and its `hidden` record only counts `probe-failed: 10`, so the footer does not
account for the drop either.

Suspected cause: `limits.maxDeclaredProbes` is 150 (`src/server/config/limits.ts`). In `assemble.ts` `resolve`, a
group past the cap sets `skipped`, returns `{ kind: "skipped" }` and the asset is dropped with no `hidden` entry. The
cap is a deliberate defence, but the result is silent loss on a site that declares a few hundred image URLs in CSS.

### R4: lazy content below the fold is missed (gymshark.com, 64 images against 100)

Evidence: 60 of the lab's URLs are missing, almost all `cdn.shopify.com` product photos and `assets.gymshark.com`
hero images, that is content in the carousels far down the page. The app records `img` on 72 candidates where the lab
saw 105 `img.currentSrc`, and its scroll phase is 4088 ms against the lab's 6331 ms. The app also has 24 URLs the lab
does not.

Suspected cause: the scroll pass finishes before the product carousels load. Part of the delta is content drift, since
the storefront changes daily, which is also why the app has extra URLs; the missing set being whole product rows
points at the scroll budget rather than at a discovery bug.

### R5: two brand colours differ from the lab (chain.link, coinbase.com)

Evidence: chain.link gives `#0847f7 #6d94f9 #001a62` and drops the lab's fourth brand colour `#fbbd11`, the yellow of
the site. Its neutrals also differ: `#0e1119 #a6aebc #eff6ff #ffffff` against the lab's `#f5f7fa #0e1119 #ffffff
#d8dce2`. coinbase.com adds a sixth colour, `#27ad75`, that the lab did not have. stripe.com keeps five of six lab
colours and swaps the orange `#ff6118` for `#fe8f2c`, which `reports/palette-verify.md` already called a stand-in for
the ribbon orange, so that one is not a loss.

Suspected cause: the palette runs on a live page, and chain.link and coinbase.com both rotate hero content, so the
signals are not identical to the lab's. Worth a second look at chain.link only: `#fbbd11` is a real brand colour and
`reports/palette-verify.md` already noted that the site has no background role although 88 percent of the viewport is
blue.

### R6: neutral order on allbirds.com

Evidence: the app returns `#212121 #ffffff #ece9e2 #000000`, the lab `#ece9e2 #000000 #212121 #ffffff`. The same four
colours, but the app leads with the near black where the lab leads with the warm off white that the page actually
uses as its background.

Suspected cause: the ordering step inside the neutral ramp, not the extraction. The UI shows the first neutral first,
so the order is user visible.

### R7: font families counted differently on apple.com (13 against 7)

Evidence: the app lists `Apple Icons 100` through `Apple Icons 900` as nine separate families, each with one face and
one file, next to `SF Pro Text`, `SF Pro Display`, `SF Pro Icons` and `Apple Legacy Chevron`. The three used families
are the same as the lab's. ilovechickpea.ca (6 against 7) and techcrunch.com (30 against 31) differ by one.

Suspected cause: family grouping (spec 9) keys on the cleaned CSS family name, and Apple declares a numbered family
per weight, so the weight number is part of the name. Merging them would need a rule for a trailing weight number,
which risks merging real families. The single family gaps on the other two sites are probably a page difference, not
a rule difference.

### R8: smaller count differences worth one look

Evidence, app against lab: binance.com 58 SVG against 45, with `unreferenced-symbol: 101` hidden; linear.app 148 SVG
against 139, with `unreferenced-symbol: 337` hidden; porsche.com 40 images against 30 and 33 SVG against 35;
squarespace.com 18 SVG against 22, with two `body-timeout` warnings and `verify-skipped`; uniswap.org 36 images
against 39.

Suspected cause: sprite symbol handling on the two sites with large hidden sprite counts (the app both keeps more
symbols and hides more than the lab counted), and, for squarespace.com, two font or image bodies that timed out
during capture, which also explains its lower SVG count.
