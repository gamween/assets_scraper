# Reference site scans

Plan task 2.3, measurement pass. The 23 reference sites of the discovery lab, scanned through the app itself
(`POST /api/scan`, NDJSON) with `scripts/scan-sites.mjs`, then compared with the research labs.

- Runs: run1 on 2026-09-17, the first measurement pass, and run2 the same day after the fixes below. Both on a local
  production build (`pnpm build`, `pnpm start -p 3201`), Chrome 153, macOS Apple Silicon, one scan at a time. The table
  holds run2; a `(was N)` note gives the run1 number wherever the two differ.
- Command: `OPS_TOKEN=... node scripts/scan-sites.mjs --base http://localhost:3201 --out <dir>`. Point `--out` outside
  the repo; the default `scan-results/` is git ignored. The script exits 1 when a site ends without a scan result. The
  permanent block on `g2.com` is the one expected outcome of that kind, so it is allowed by default (`--expect-blocked`)
  and a full sweep exits 0; `g2.com` failing any other way, or any other site failing, still exits 1.
- Raw results (one JSON per site plus `summary.json` and `summary.md`) are kept outside git, in the scratchpad
  directory of the run.
- Baselines: `discovery-lab/table.md` and `discovery-lab/out-final/<host>/result.json` for assets and fonts,
  `discovery-lab/cdn-verify.json` for CDN originals, `palette-lab/results/*.json` and `reports/palette-verify.md` for
  palettes.
- Counting note: the lab's asset numbers are already merged (its `variants` field), so lab and app numbers are
  comparable. `svg` is SVG files plus unique inline SVG, as in the lab's `svgFiles + svgInlineUnique`.
- Every number below was re-measured for run2. An earlier version of this document carried several that did not
  reproduce, so single-run claims about a live page are now marked as such.

## Results

| Site | Status | Duration | SVG | Images | Fonts | Site logo | Palette top brand | Hidden | Partial | Error |
|---|---|---|---|---|---|---|---|---|---|---|
| allbirds.com | done | 10114 ms | 33 | 29 | 6 | yes (Allbirds logo) | none | 11 (was 12) | false | - |
| apple.com | done | 4164 ms | 72 | 72 (was 98) | 13 | yes (Apple) | #0071e3 | 2 (was 3) | false | - |
| binance.com | done | 10175 ms | 58 | 29 | 2 | yes (Binance) | #f0b90b | 106 | false | - |
| chain.link | done | 7024 ms | 88 | 52 | 17 | yes (Chainlink) | #0847f7 | 10 | false | - |
| coinbase.com | done | 4924 ms | 14 | 30 (was 29) | 6 | yes (Coinbase Logo) | #0052ff | 7 (was 8) | false | - |
| framer.com | done | 6215 ms | 168 | 94 | 34 | yes (On) | none | 1 | false | - |
| g2.com | error | 2037 ms | 0 | 0 | 0 | no | none | 0 | - | blocked |
| gatsbyjs.com | done | 2828 ms | 11 | 11 | 1 | yes (Link to home) | #663399 | 1 | false | - |
| gymshark.com | done | 11070 ms | 29 | 64 | 9 | yes (Gymshark) | #42b296 | 2 | false | - |
| ilovechickpea.ca | done | 7857 ms | 3 | 41 | 6 | yes (Chickpea logo) | #55c3f2 | 4 | false | - |
| linear.app | done | 7433 ms | 148 | 40 | 2 | yes (Linear) | #5e6ad2 | 337 | false | - |
| medium.com | done | 3158 ms | 2 | 16 | 9 | yes (Medium logo) | none | 31 | false | - |
| notion.com | done | 6347 ms | 44 | 37 | 6 | yes (Notion Home) | #0075de | 1 | false | - |
| porsche.com | done | 7434 ms | 33 | 40 | 1 | yes (Porsche.com) | none | 2 | false | - |
| ripple.com | done | 4980 ms | 48 | 17 | 3 | yes (Home) | #006aff | 1 | false | - |
| sanity.io | done | 12974 ms | 138 (was 137) | 45 | 2 | yes (Home) | #ff4100 | 33 | false | - |
| squarespace.com | done | 10202 ms | 18 | 136 (was 210) | 9 | yes (Squarespace homepage) | none | 9 | false | - |
| stripe.com | done | 8066 ms | 173 | 57 (was 56) | 2 | yes (Logo Stripe) | #533afd | 22 (was 23) | false | - |
| techcrunch.com | done | 8475 ms | 51 (was 50) | 54 (was 50) | 30 | yes (TechCrunch logo) | #0a8935 | 43 | false | - |
| uniswap.org | done | 7839 ms | 51 (was 52) | 36 | 2 | yes (uniswap logo) | #ff37c7 | 2 | false | - |
| vercel.com | done | 4971 ms | 44 | 30 | 3 | yes (Vercel) | none | 3 (was 2) | false | - |
| webflow.com | done | 6474 ms | 69 | 111 | 5 | yes (Home Page) | #146ef5 | 31 | false | - |
| xrpl.org | done | 6052 ms | 101 | 99 | 7 | yes (XRP Ledger Home) | #21e46b | 174 (was 10) | false | - |

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

- Every unblocked site finishes: 22 of 23 `done`, none `partial`, no `internal` error, slowest 13.0 s against the 60 s
  production target, `collector: "isolated"` everywhere except `g2.com` (`"none"`).
- A site logo is found on all 22 unblocked sites (found, not necessarily ranked first: see the note under the table).
- `g2.com` behaves as in the lab: `blocked` with `blockReason: "challenge-markup"`, HTTP 403, and one fallback asset
  on the error event.
- Asset counts are within five of the lab on both kinds on 14 of 22 sites in run2 (13 in run1), and exact on both on
  allbirds.com (33/29), gatsbyjs.com (11/11), ilovechickpea.ca (3/41), medium.com (2/16), notion.com (44/37) and
  vercel.com (44/30). The eight that are not: apple.com (images, R2), squarespace.com (images, R1), gymshark.com
  (images, R4), xrpl.org (both, R3), binance.com and linear.app (SVG, R9), porsche.com (images, content drift) and
  techcrunch.com (images, R9).
- Every CDN original candidate the app produces is now adopted: `diagnostics.originals` reads `attempted` equal to
  `adopted` and zero `failed`, `noise` and `skipped` on all 22 unblocked sites (stripe.com 55 of 55, gymshark.com 48 of
  48, notion.com 32 of 32, coinbase.com 9 of 9). Counted against the lab's own verified-bigger list
  (`cdn-verify.json`), the app carries 24 of 24 in run2, against 20 of 24 in run1.
- The palette lab covers 11 of the reference sites: its twelfth result file, `www.spotify.com`, is lab only and was
  never scanned here. The top brand colour matches on all 11. The full brand list is identical on 7 of them
  (apple.com, linear.app, notion.com, webflow.com, and empty on allbirds.com, framer.com and vercel.com, as in the
  lab) and differs on 4 (chain.link, coinbase.com, stripe.com and, in run2 only, uniswap.org, see R5). The neutral ramp
  is identical on 6 and differs on 5: allbirds.com (R6), chain.link (R5), linear.app (an improvement, below), plus
  framer.com and vercel.com, whose brand lists are empty in both.
- linear.app is better than the lab and lands a fix `reports/palette-verify.md` asked for: its background neutral is
  `#08090a` where the lab gave `#101112`, which moves the site from 4/5 to 5/5. Re-measured twice on 2026-09-17 with
  the same result, so this one reproduces.

## Regressions

Each entry carries the run1 measurement that opened it, the cause, and a verdict from run2: `Fixed` with the commit,
`Improved` where the change moved the number without closing the gap, or `Explained` where the difference is expected
and no code change is right. Only gymshark.com and squarespace.com were ever scanned twice within run1 (run1b holds
those two files and nothing else); run2 re-measured all 23, so every verdict below rests on two runs.

Summary: R1, R3 and R8 are fixed, R2 is improved, R4, R5, R6, R7 and R9 are explained or still open.

### R1: responsive width variants become separate assets (squarespace.com, 210 images against 116)

Evidence: `services-desktop` comes back as seven assets whose URLs differ only by the width suffix
(`-100w`, `-300w`, `-500w`, `-750w`, `-1000w`, `-1500w`, `-2500w`, all `.webp`, one visible at 1500x844 and six
invisible), and the same shape repeats for `online-store-desktop`, `invoicing-desktop` and the hero video posters.
Stripping `-<N>w` from the 210 URLs leaves 16 groups holding 107 assets, so about 91 assets are duplicates of one
another. The lab merged these and reported 116.

Cause: `variantKey` (spec 8.5) removed `_small/_medium/_large/_xlarge`, `@2x` and `_2x` but not the `-<N>w` form, and
these URLs come from `srcset` width descriptors inside one `<picture>`, so the element group merge did not catch them
either.

Fixed in `928214b`. `variantKey` now drops a two-digit-or-longer width descriptor before the extension, which is the
convention every `srcset` build pipeline writes. run2: 136 images against the lab's 116, down from 210. The two-digit
floor keeps `apple-touch-icon-180.png` and `apple-touch-icon-1024.png` apart, which have no `w` and are distinct files.
The 20 that remain over the lab are format variants of the same picture (`.webp` next to `.jpg`), which spec 8.3 keeps
separate on purpose.

### R2: CDN size in the path becomes separate assets (apple.com, 98 images against 51)

Evidence: the same mzstatic image is three assets,
`.../image/thumb/x5JjmiSD75wN12-HmmZRcg/980x522sr.jpg`, `/1376x736sr.jpg` and `/2500x1336sr.jpg`; six assets share
the alt text "Stream now, Slow Horses - Thriller - New season."; 66 of the 98 raster assets are invisible and 45 of
them are found only in `picture` plus `noscript`. All 98 URLs are distinct, so nothing is counted twice; they are
variants that did not merge.

Cause: the same `variantKey` gap as R1, for a CDN path that carries the size as its last segment
(`/<width>x<height><flags>.<ext>`).

Improved in `928214b`, not closed. `variantKey` now drops that segment on `*.mzstatic.com/image/thumb/` URLs, where it
is the requested size and not the file. run2: 72 images against the lab's 51, down from 98. The rest is art direction,
which is intended: apple.com serves `hero_..._large.jpg`, `_largetall.jpg`, `_small_2x.jpg` and `_mediumtall_2x.jpg`
behind `<source media>`, and spec 8.3 keeps `media` sources separate. Merging the orientation suffix would close the
gap on this site and lose a real crop everywhere else, so it is deliberately not done.

### R3: declared CSS URLs stop at the probe cap (xrpl.org, 101 SVG and 99 images against 204 and 160)

The SVG baseline is the lab's 192 SVG files plus its 12 unique inline SVG, as in the counting note above, so the SVG
loss is 103, not 91.

Evidence: 175 of the 352 URLs the lab kept are missing from the app result, almost all of them `https://xrpl.org/img/...`
files declared in stylesheets, plus a handful of CSS data-URI icons. The app keeps exactly 151 `declaredOnly` assets,
emits a `verify-skipped` warning, and its `hidden` record only counts `probe-failed: 10`, so the footer does not
account for the drop either.

Cause: `limits.maxDeclaredProbes` is 150 (`src/server/config/limits.ts`). In `assemble.ts` `resolve`, a group past the
cap set `skipped`, returned `{ kind: "skipped" }` and the asset was dropped with no `hidden` entry. The cap is a
deliberate defence; the silent loss was not.

Fixed in `cd854d0`, as a reporting bug, which is what it is. A capped drop is now counted under a new `probe-skipped`
hidden reason, across contract, engine and the results footer ("unchecked files"). run2 on xrpl.org: `hidden` reads
`probe-skipped: 164` next to `probe-failed: 10`, so the footer accounts for 174 drops where it used to show 10, and
the asset counts are unchanged at 101 SVG and 99 images. The counts stay below the lab because the cap is still 150
and still right: a page that declares a few hundred image URLs in CSS is exactly what it defends against. What changed
is that the user is told.

### R4: lazy content below the fold is missed (gymshark.com, 64 images against 100)

Evidence, counted on the raster subset the heading compares (the app's 64 non SVG asset URLs against the lab's 100 non
SVG `best` URLs): 63 of the lab's URLs are missing, 42 of them `cdn.shopify.com` product photos, 16
`www.gymshark.com/_next/image` URLs and 4 `assets.gymshark.com` hero images, that is content in the carousels far down
the page. The app records `img` on 72 candidates where the lab saw 105 `img.currentSrc`, and its scroll phase is
4088 ms against the lab's 6331 ms. The app also has 27 raster URLs the lab does not. Over all formats, 129 lab URLs
against 93 app URLs, the two figures are 64 and 28.

Cause: the scroll pass finishes before the product carousels load. Part of the delta is content drift, since the
storefront changes daily, which is also why the app has extra URLs; the missing set being whole product rows points at
the scroll budget rather than at a discovery bug.

Open, not fixed here. run2 reads 64 images again, so this is stable and not noise. Closing it means spending more of
the scan budget on scrolling, which trades the 60 s target against a site that lazy-loads deep, and that is a spec
level decision (the scroll budget in `limits.ts`), not a bug fix. Nothing in the CDN or variant work above touches it,
which run2 confirms: the count did not move.

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

Explained, with one exception. The palette runs on a live page, and chain.link, coinbase.com and stripe.com all rotate
hero content, so the signals are not the lab's. run2 adds a fourth: uniswap.org returned the lab's five brand colours
in the lab's order in run1 and the same five reordered in run2 (`#00c3a0` and `#2abdff` swap ends), which is the same
instability with nothing lost. Tuning the extractor against any single scan of a rotating page would be fitting to
noise.

The exception is chain.link: `#fbbd11` is a real brand colour, it is missing in both runs, and
`reports/palette-verify.md` already noted that the site has no background role although 88 percent of the viewport is
blue. That one is a genuine extraction gap and needs the palette ablation harness, not a reference scan.

### R6: neutral order on allbirds.com

Evidence: the app returns `#212121 #ffffff #ece9e2 #000000`, the lab `#ece9e2 #000000 #212121 #ffffff`. The same four
colours, but the app leads with the near black where the lab leads with the warm off white that the page actually
uses as its background.

Open, and now known to be deterministic: run2 returns `#212121 #ffffff #ece9e2 #000000` again, so this is the
ordering step inside the neutral ramp and not page drift. The UI shows the first neutral first, so the order is user
visible.

Not fixed here on purpose. The order comes out of the background and text selection in `palette/build.ts`, which is
tuned against the whole palette lab; changing the thresholds to put the warm off white first on this page would need
the ablation harness and a check against the other ten sites, and doing it from one site's result is how a rule gets
overfitted.

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

Explained. Family grouping (spec 9) keys on the cleaned CSS family name, and Apple declares a numbered family per
weight, so the weight number is part of the name. Merging them needs a rule for a trailing weight number, which would
merge real families elsewhere (`Roboto 900` is not `Roboto`), and the cost of not merging is nine extra rows on one
site whose three used families are right. run2 reads 13 again. The single family gaps on the other two sites are page
composition, as above. No change made.

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

Cause, found by instrumenting `resolve` and then reading what it reported. Two separate bugs, both now fixed.

First, no candidate was produced on a CDN the host list does not name. `images.stripeassets.com` is a Contentful
custom domain; the Contentful rule in `src/server/scan/post/cdn.ts` matched `images.(eu.)ctfassets.net` or else the
`server` hint, and that hint comes from `capture.server`, so it only exists for URLs whose response the collector
captured. `originalCandidates` returned an empty list for 26 of stripe.com's 26 stuck URLs. The `cdn.test.ts` case for
this shape ("Contentful by Server header", `cdn.test.ts:42`) supplies the hint as the fourth element of its row,
destructured at `cdn.test.ts:56` and passed at `cdn.test.ts:57`, so it shows the rule needs the hint, not that the
rule fires without it.

Fixed in `e58c6dc`. Every host rule in that file is one instance of one shape: a path that already names an image file,
a query built only from transform parameters. That shape is now a last-resort rewrite, applied only at the top level
and only when no host rule matched, so a rule that knows the host still wins and the probe that follows decides
whether the stripped URL is real. Version and cache-busting keys stay out, which is why notion.com's two
`front-static/...?v=2` URLs still produce no candidate, correctly: that query names the same bytes.

Second, and this was the whole of the gymshark.com, coinbase.com and notion.com loss, the probe of a candidate that
did exist was failing. The probe asks for `bytes=0-262143` so a large file costs a prefix; `images.ctfassets.net`
answers a ranged request over HTTP/2 by resetting the stream mid-body (`NGHTTP2_INTERNAL_ERROR`), and `verifyUrl`
mapped every exception to `reason: "network"`. The caller then fell through to the page's own bytes and recorded
nothing. The same URLs answer 200 with the whole image when asked without a range, which is why a shell probe with the
same `Accept` and `Referer` looked fine and the app still failed.

Fixed in `0a9c2ea`: a transport failure on the ranged request is retried once without the range, within the same
deadline, and `readPrefix` still stops at the same prefix so a large file costs no more than before.

Making the cause visible was the prerequisite, and is itself part of the fix. Three outcomes used to be
indistinguishable from outside `resolve`: a candidate never produced, a candidate whose probe failed, and a candidate
whose probe answered with something `noiseReason` rejects. `7df80e9` adds `diagnostics.originals`
(`attempted`, `adopted`, `failed`, `noise`, `skipped`), and `fd14b7b` keys those counters on the candidate set rather
than on group membership, so a candidate the page also declared is counted too; without that, coinbase.com read zero
attempts while five candidates were being tried and dropped.

Result in run2, on every unblocked site: `attempted` equals `adopted`, and `failed`, `noise` and `skipped` are zero.
stripe.com 55 of 55 (26 stuck image assets in run1, 0 in run2), gymshark.com 48 of 48 (39 stuck, now 2 that carry a
version query and are not transforms), notion.com 32 of 32, coinbase.com 9 of 9. Against the lab's own
verified-bigger list in `cdn-verify.json`, the app carries 24 of 24 originals in run2 against 20 of 24 in run1, and
coinbase.com goes from 4 of 8 to 8 of 8.

One detail from run1 that was wrong and is worth keeping recorded: of stripe.com's 30 clean image URLs, 29 were on
`images.stripeassets.com` and one on `assets.stripeassets.com`, a host no rule covers, so that one was clean because
the page served it clean.

### R9: smaller count differences worth one look

Evidence, app against lab: binance.com 58 SVG against 45, with `unreferenced-symbol: 101` hidden; linear.app 148 SVG
against 139, with `unreferenced-symbol: 337` hidden; porsche.com 40 images against 30 and 33 SVG against 35;
squarespace.com 18 SVG against 22, with one `body-timeout` warning and one `verify-skipped` warning, and
`bodyTimeouts: 2` in its diagnostics; uniswap.org 36 images
against 39.

Explained, none of it fixed here.

Sprite symbols on binance.com and linear.app: the app both keeps more symbols and hides more than the lab counted,
and run2 reads the same 58 and 148. That is a counting difference between two sprite rules, not a loss: every symbol
is either an asset or a counted `unreferenced-symbol`, and the totals reconcile.

squarespace.com stays at 18 SVG against the lab's 22, with `bodyTimeouts: 2` and, in run2, a single `body-timeout`
warning. The `verify-skipped` warning run1 also carried is gone, which is the R8 fix showing through: nothing is being
skipped there any more. Two bodies still time out during capture on a page that loads 136 images, which is a capture
budget question and not a rule difference. run1 and run2 agree, so it is stable.

uniswap.org at 36 images against 39 and techcrunch.com at 54 against 46 both move between runs (51 and 52 SVG, 50 and
54 images), so those are within the drift of a live homepage.

porsche.com is content drift, not a rule difference, and cannot be compared asset by asset with the lab. run2 reads
33 SVG and 40 images, the same as run1, but against a different set of files: its homepage
carousel rotates, so the two runs saw different assets. None of the lab's 7 verified-bigger `a.storyblok.com`
originals (rule "strip `/m/<params>`") appear in the app's result in either form, transformed or original, and the 12
`a.storyblok.com` URLs the app did find are already clean. The one URL the app keeps transformed,
`shop.porsche.com/_next/image?url=...images.ctfassets.net...`, is a different host on a different rule and has no
counterpart in the lab's result, so nothing establishes it as a loss. porsche.com was therefore left out of R8, and
run2 bears that out: its `diagnostics.originals` reads 17 attempted and 17 adopted, with no transformed URL left, and
the lab's 7 Storyblok originals are still absent because the carousel no longer serves those files at all.
