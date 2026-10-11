# Tiger trims: route hops under later layers

Commit: `e290841` (this commit on `main`). Engine `lib/stitch/wq.js` only. Prep 1.6 untouched. Inputs: summit/tiger/bee prepped @ 4 in tee.

## What changed
Before trimming a same-colour hop, the engine searches a path under later (not-yet-sewn) objects and remaining unsewn rows of the current fill, staying inside that cover, 2–2.5 mm stitches. Object order uses nearest entry/exit on the sew mask (not the centroid). Same-colour fill hops along rows/edge up to ~4 mm are sewn, not trimmed. Finished stitching of a different colour is never crossed; that hop trims. Existing stitch-length, pile-up, tie, and PES=DST−1 rules stay.

## Before → after

Before = REPORT-DIGITIZE-TAB.md (prepped 4 in tee). After = this batch.

| logo   | stitches | CO | DST trims | PES trims | travel-on-top mm | max hits/mm² |
|--------|---------:|---:|----------:|----------:|-----------------:|-------------:|
| summit | 11118 → **11185** | 2 | 37 → **21** | 36 → **20** | 4.4 → **3.2** | 11 → **11** |
| tiger  | 20144 → **20093** | 7 | 175 → **105** | 174 → **104** | 117.7 → **22.4** | 17 → **17** |
| bee    | 4460 → **4478** | 3 | 23 → **15** | 22 → **14** | 15.4 → **1.4** | 15 → **15** |

Colours/colour-changes unchanged. No stitch <0.3 mm or >7 mm. `npm test` passes. PES trims = DST−1. Untrimmed jump moves = 0.

## Preview
`out/report/tiger-after.png` — TrueView of the after tiger stitches.
