# Reference site scans

Plan task 2.3, measurement pass. The 23 reference sites of the discovery lab, scanned through the app itself
(`POST /api/scan`, NDJSON) with `scripts/scan-sites.mjs`, then compared with the research labs.

- Run: 2026-09-17, local production build (`pnpm build`, `pnpm start -p 3201`), Chrome 153, macOS Apple Silicon, warm cache
  except for the first site, one scan at a time.
- Command: `OPS_TOKEN=... node scripts/scan-sites.mjs --base http://localhost:3201 --out <dir>`. Point `--out` outside
  the repo; the default `scan-results/` is git ignored. The script exits 1 when a site ends without a scan result. The
  permanent block on `g2.com` is the one expected outcome of that kind, so it is allowed by default (`--expect-blocked`)
  and a full sweep exits 0; `g2.com` failing any other way, or any other site failing, still exits 1.
- Raw results (one JSON per site plus `summary.json` and `summary.md`) are kept outside git, in the scratchpad
  directory of the run. The script gained its `fallbackAssets` field after that run, so only `g2.com`, re-scanned with
  the committed version (same status, counts and diagnostics), carries the fallback asset list; the other 22 files
  predate the field.
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
`Site logo` records that a site logo was found, not that the right one is ranked first, and this run does not measure
logo precision. framer.com is the clearest case: it returns two `site-logo` assets and the top one (score 1049.6) is a
16x24 css-background SVG named `On`, a customer logo, ahead of the json-ld `Framer logo` (999.5). The discovery lab
picks the same two sources in the same order (`computed:background-image`, then `meta:jsonld:logo`), so this is not a
regression. Same class elsewhere: coinbase.com marks the X, LinkedIn, Instagram and TikTok icons as `site-logo` (5 in
all), sanity.io's second `site-logo` is an 850x559 merch photo, techcrunch.com's fourth is an ad vendor privacy icon.

## What matches the lab

- Every unblocked site finishes: 22 of 23 `done`, none `partial`, no `internal` error, slowest 13.8 s against the 60 s
  production target, `collector: "isolated"` everywhere except `g2.com` (`"none"`).
- A site logo is found on all 22 unblocked sites (found, not necessarily ranked first: see the note under the table).
- `g2.com` behaves as in the lab: `blocked` with `blockReason: "challenge-markup"`, HTTP 403, and one fallback asset
  on the error event.
- Asset counts are within five of the lab on 15 of 22 sites, and exact on allbirds.com (33/29), chain.link
  (88 SVG), framer.com (168 SVG), gatsbyjs.com (11/11), medium.com (2/16), notion.com (44/37), vercel.com (44/30),
  webflow.com (69 SVG) and ilovechickpea.ca (3/41).
- The palette lab covers 11 of the reference sites: its twelfth result file, `www.spotify.com`, is lab only and was
  never scanned here. The top brand colour matches on all 11. The full brand list is identical on 8 of them
  (apple.com, linear.app, notion.com, uniswap.org, webflow.com, and empty on allbirds.com, framer.com and vercel.com,
  as in the lab) and differs on 3 (chain.link, coinbase.com and stripe.com, see R5). The neutral ramp is identical on
  6 and differs on 5: allbirds.com (R6), chain.link (R5), linear.app (an improvement, below), plus framer.com and
  vercel.com, whose brand lists are empty in both.
- linear.app is better than the lab and lands a fix `reports/palette-verify.md` asked for: its background neutral is
  `#08090a` where the lab gave `#101112`, which moves the site from 4/5 to 5/5. Re-measured twice on 2026-09-17 with
  the same result, so this one reproduces.

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

### R3: declared CSS URLs stop at the probe cap (xrpl.org, 101 SVG and 99 images against 204 and 160)

The SVG baseline is the lab's 192 SVG files plus its 12 unique inline SVG, as in the counting note above, so the SVG
loss is 103, not 91.

Evidence: 175 of the 352 URLs the lab kept are missing from the app result, almost all of them `https://xrpl.org/img/...`
files declared in stylesheets, plus a handful of CSS data-URI icons. The app keeps exactly 151 `declaredOnly` assets,
emits a `verify-skipped` warning, and its `hidden` record only counts `probe-failed: 10`, so the footer does not
account for the drop either.

Suspected cause: `limits.maxDeclaredProbes` is 150 (`src/server/config/limits.ts`). In `assemble.ts` `resolve`, a
group past the cap sets `skipped`, returns `{ kind: "skipped" }` and the asset is dropped with no `hidden` entry. The
cap is a deliberate defence, but the result is silent loss on a site that declares a few hundred image URLs in CSS.

### R4: lazy content below the fold is missed (gymshark.com, 64 images against 100)

Evidence, counted on the raster subset the heading compares (the app's 64 non SVG asset URLs against the lab's 100 non
SVG `best` URLs): 63 of the lab's URLs are missing, 42 of them `cdn.shopify.com` product photos, 16
`www.gymshark.com/_next/image` URLs and 4 `assets.gymshark.com` hero images, that is content in the carousels far down
the page. The app records `img` on 72 candidates where the lab saw 105 `img.currentSrc`, and its scroll phase is
4088 ms against the lab's 6331 ms. The app also has 27 raster URLs the lab does not. Over all formats, 129 lab URLs
against 93 app URLs, the two figures are 64 and 28.

Suspected cause: the scroll pass finishes before the product carousels load. Part of the delta is content drift, since
the storefront changes daily, which is also why the app has extra URLs; the missing set being whole product rows
points at the scroll budget rather than at a discovery bug.

### R5: brand lists differ from the lab (chain.link, coinbase.com, stripe.com)

Evidence: chain.link gives `#0847f7 #6d94f9 #001a62` and drops the lab's fourth brand colour `#fbbd11`, the yellow of
the site. Its neutrals also differ: `#0e1119 #a6aebc #eff6ff #ffffff` against the lab's `#f5f7fa #0e1119 #ffffff
#d8dce2`. coinbase.com returns `#0052ff #27ad75` where the lab returned `#0052ff` alone, so `#27ad75` is the second
entry of a two colour list, not a sixth colour added to a longer one. stripe.com is the third one that differs, and it
is not stable from run to run. run1 read `#533afd #7f7dfc #ffd676 #f795f7 #fe8f2c #ea2261` and an earlier version of
this document called the fifth entry an improvement, on the grounds that `reports/palette-verify.md` had asked for the
ribbon orange and called the lab's `#ff6118` a stand-in. That does not reproduce. Two fresh scans on 2026-09-17 both
returned `#533afd #7f7dfc #ffd676 #1c1e54 #f795f7 #ea2261`: no orange at all, a dark navy `#1c1e54` in fourth place
instead, and the pink and red one rank lower than in run1. So the app agrees with the lab on the first three brand
colours and disagrees on the rest, and which colour fills the tail depends on what the rotating hero was showing.
Treat any single-run claim about stripe.com's tail as noise.

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

Used families, the number the UI actually leads with, differ on the same two sites, which the count above hides.
ilovechickpea.ca: 3 used against the lab's 4, the app missing `Akzidenz-Grotesk BQ Light with`. That lab name is
itself a parse artefact, a `font-family` declaration cut mid sentence, so the app is arguably right here and the lab
wrong. techcrunch.com: 4 used against the lab's 5, and the sets are not nested either way. The app has
`NB International Pro`, `Roboto`, `Yellix` and `Open Sans`; the lab had `NB International Pro`, `Google Sans Text`,
`Yellix`, `Google Symbols` and a starred `Roboto`. The two Google families come in through an embedded third party
widget, so this is a page composition difference more than a rule difference.

Two sites go the other way, the app counting more used families than the lab: gymshark.com 5 against 3 (the app adds
`Roboto`, `Montserrat` and `gymshark-icons`) and webflow.com 3 against 2 (it adds `Inconsolata` and `Roboto`). Those
three extras are fallback and icon families that do render on the page, so counting them is defensible. The other 18
unblocked sites agree with the lab on the used count. Nothing here is a loss of a downloadable font: declared families
match on every site except the three named above, and the licensing and download paths are unaffected.

Suspected cause: family grouping (spec 9) keys on the cleaned CSS family name, and Apple declares a numbered family
per weight, so the weight number is part of the name. Merging them would need a rule for a trailing weight number,
which risks merging real families. The single family gaps on the other two sites are probably a page difference, not
a rule difference.

### R8: the CDN original is not adopted on part of the candidates (stripe.com, gymshark.com, coinbase.com, notion.com)

Evidence: the lab's "CDN originals verified ok (bigger)" column, the baseline named in the header of this document,
lists the originals the lab probed and found bigger than the page's URL. Counting how many of those the app's run1
result actually carries: allbirds.com 26 of 26, framer.com 93 of 94, ilovechickpea.ca 40 of 40, ripple.com 12 of 12,
squarespace.com 11 of 11, vercel.com 2 of 2, sanity.io 46 of 48, notion.com 28 of 32, stripe.com 28 of 45,
coinbase.com 4 of 9, gymshark.com 4 of 81. Adoption therefore runs and succeeds on the majority of candidates,
including on the same hosts and in the same runs as the losses. The open question is a per URL one: what separates the
candidates it upgrades from the ones it leaves transformed.

Where it does not: 26 of stripe.com's 56 image assets stay on `images.stripeassets.com` with the Contentful query
intact, 39 of gymshark.com's 64 stay on `www.gymshark.com/_next/image?url=...&w=...`, 5 on coinbase.com stay on
`images.ctfassets.net` with a query, and 4 on notion.com. The other 30 stripe.com image assets carry no query: 29 are
on `images.stripeassets.com` and one is on `assets.stripeassets.com`, a host no rule covers, so it is clean because
the page served it clean, not because a rule cleaned it. Of the 29, the ones that pair against the lab carried a query
in the lab's observed URL, so those are real upgrades.

Only gymshark.com and squarespace.com were scanned twice: run1b holds those two files and nothing else, so the
identical counts it shows are evidence for gymshark.com alone. There is no repeat-scan evidence for stripe.com,
coinbase.com or notion.com, and an earlier version of this document claimed there was.

This is not a stale baseline: two of the originals, re-fetched with the same `Accept` and range headers the app uses
(`VERIFY_ACCEPT` and `bytes=0-262143` in `src/server/scan/post/verify.ts`), still answer 206 with an image body
(stripe.com's `payments-electric-kettle.jpg`, 8979 bytes, and gymshark.com's `image__59_.png` on
`images.ctfassets.net`).

Suspected cause on stripe.com: the rule never produces a candidate, so nothing downstream can adopt one.
`originalCandidates` called on the 26 stuck URLs returns an empty list for 26 of 26. `images.stripeassets.com` is a
Contentful custom domain, and the Contentful rule in `src/server/scan/post/cdn.ts` matches the host pattern
`images.(eu.)ctfassets.net` or else the `server` hint, so on a custom domain it fires through the hint alone. That
hint is `best.server` (`assemble.ts:133`), which comes from `capture.server` (`assemble.ts:411`) and so exists only
for URLs whose response the collector captured. The `cdn.test.ts` case for this shape ("Contentful by Server header",
`cdn.test.ts:42`) supplies the hint as the fourth element of its row; the row is destructured at `cdn.test.ts:56` and
the hint is passed to `originalCandidates` at `cdn.test.ts:57`. So the case shows the rule needs the hint, not that
the rule fires without it. This site needs the hint (or the rule) fixed and re-measured, not a traced run.

coinbase.com is not in this class, although an earlier version of this document put it there. Its 5 stuck URLs are on
`images.ctfassets.net` itself, the native Contentful host, which the rule matches on the host pattern alone:
`originalCandidates` returns a candidate for 5 of 5 with no `server` hint at all. The same holds for 4 of notion.com's
6 stuck URLs (the other 2 are `www.notion.com/front-static/...?v=2`, a cache-busting version query and not a transform,
so no candidate is the right answer there). coinbase.com and notion.com therefore belong with gymshark.com below: the
candidate exists and the loss happens inside `resolve`.

Suspected cause on gymshark.com, coinbase.com and notion.com: not identified, and this one does need instrumentation.
The `/_next/image` rule
matches on the path alone, so the candidate is produced and the loss is inside `resolve`. The verify budget is still
open despite no `verify-skipped` warning, because two paths suppress that warning. `verifyUrl` returns `SKIPPED` from
its own deadline and abort check (`verify.ts:150`) without incrementing `limiter.skipped`, which only the limiter
refusing to start a task does (`verify.ts:187`), so the global warning at `assemble.ts:199` never fires for that path.
And inside `resolve` a `SKIPPED` result only sets the local `skipped` flag (`assemble.ts:169`); the loop then carries
on to the member URLs, where the `member?.capture` branch (`assemble.ts:140-146`) returns before
`warnings.add("verify-skipped")` at `assemble.ts:173` is reached. All 39 stuck gymshark.com assets carry `bytes`, so
that member capture branch is what answered. A failed probe is not the explanation either: four of the stuck originals,
probed with the app's exact headers, returned 206 with an image body (10206 B PNG, and 167313 B, 185758 B and
172730 B JPEG).

Three outcomes are indistinguishable from outside `resolve`, which is what has to be fixed before the cause can be
found: a candidate that is never produced, a candidate whose probe failed, and a candidate whose probe succeeded and
was then rejected by `noiseReason` against the size and type the request found (`assemble.ts:157-162`, where a hit
does `noise ??= reason; continue`). All three fall through to the page's own captured bytes and record nothing.

### R9: smaller count differences worth one look

Evidence, app against lab: binance.com 58 SVG against 45, with `unreferenced-symbol: 101` hidden; linear.app 148 SVG
against 139, with `unreferenced-symbol: 337` hidden; porsche.com 40 images against 30 and 33 SVG against 35;
squarespace.com 18 SVG against 22, with one `body-timeout` warning and one `verify-skipped` warning, and
`bodyTimeouts: 2` in its diagnostics; uniswap.org 36 images
against 39.

Suspected cause: sprite symbol handling on the two sites with large hidden sprite counts (the app both keeps more
symbols and hides more than the lab counted), and, for squarespace.com, the two font or image bodies its diagnostics
counted as timed out during capture, which also explains its lower SVG count.

porsche.com is content drift, not a rule difference, and cannot be compared asset by asset with the lab: its homepage
carousel rotates, so the two runs saw different assets. None of the lab's 7 verified-bigger `a.storyblok.com`
originals (rule "strip `/m/<params>`") appear in the app's result in either form, transformed or original, and the 12
`a.storyblok.com` URLs the app did find are already clean. The one URL the app keeps transformed,
`shop.porsche.com/_next/image?url=...images.ctfassets.net...`, is a different host on a different rule and has no
counterpart in the lab's result, so nothing establishes it as a loss. porsche.com is therefore left out of R8: a
re-scan after a CDN adoption fix would still show 1 transformed `shop.porsche.com` URL and 0 of the lab's 7
Storyblok originals, whether or not the fix worked.
