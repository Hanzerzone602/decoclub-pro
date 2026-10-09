# Digitize tab → wq + prep

Commit: `Digitize tab: wq+prep engine, cached DST/EXP/PES, travel rules` on `main`.

## What changed
Studio Digitize (admin-only) preview, stats, and DST/EXP/PES downloads now use the wq engine with `digitize_prep --late-colors all` for the job width/fabric. The 3D canvas still uses `DigitizePreview`; it is fed wq stitches. Results are cached per job+settings and generated in a worker so the HTTP loop stays free. Vectorize packet SVG/EPS and Stripe/pricing/gating are unchanged.

Files: `lib/stitch/wq.js`, `lib/digitize.js`, `lib/digitize-worker.js`, `lib/stitch/export.js`, `lib/exports.js`, `server.js`, `public/app.js`, `public/app.html`, `public/styles.css`, `package.json`, `test/stitch.test.js`, `test/digitize-tab.test.js`.

## Pass bar
Through `node server` + admin + `FEATURE_DIGITIZE=1`, Summit 4 in tee: **11104 stitches, 3 colours** (1242 Blue Ink, 1071 Natural White, 1278 Pumpkin), 2 colour changes. DST 36 trims / PES 35 (PES = DST−1). Downloads from cache in ~0.2 s after a ~19 s job. No stitch <0.3 mm or >7 mm. `npm test` + stitch tests pass.

## Before / after (prepped summit/tiger/bee @ 4 in, tee)

Before = progress-log wq finals (Oct 7). Tab/packet before this work was legacy (Summit live: 6 colours / CO:5). After = this batch.

| logo   | stitches before→after | colours | CO | DST trims | travel-on-top mm | max hits/mm² |
|--------|----------------------:|--------:|---:|----------:|-----------------:|-------------:|
| summit | 11012 → 11118         | 3       | 2  | 24 → 37   | 17.1 → **4.4**   | — → 11       |
| tiger  | 19705 → 20144         | 6→6*    | 7  | 119 → 175 | 174 → **117.7**  | 16 → 17      |
| bee    | 4401 → 4460           | 4       | 3  | 17 → 23   | 22 → **15.4**    | 15 → 15      |

\*Tiger still 6 unique Madeira threads; 8 colour stops because two late revisits (same as docs extra colour changes). Stitch counts within 10% of the log. PES trims = DST−1 on all three. Server Summit (fresh prep from JPEG) 11104 / 3 / 36 DST.

Travel on top of a **different** colour is trimmed. Under a later layer: any length, ≥0.5 mm inside the cover, 2–2.5 mm stitches. Same-colour on-top fill: short, along rows or edge. Satin inner-curve stitches shortened.

## Preview
`out/report/summit-tab-preview.png` is a realistic stitch render of the same wq Summit stitches the tab 3D view is fed. The in-browser WebGL orbit canvas was not available here.

Prep `textWarnings` / `minRecommendedWidthIn` show in the tab (Summit: thin lettering, recommend ≥5 in). Busy-art score/simplify is wired and stays hidden when prep omits those fields.
