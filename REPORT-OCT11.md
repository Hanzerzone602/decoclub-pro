# Oct 11: Vectorize speed cache + Digitize polish

Commit: `b2b6c24`. Local only, not pushed. Tracer `lib/vai-trace/trace.py` md5 `6c33a1ef`. Engine `lib/stitch/wq.js` + fabric presets. Prep 1.6 untouched.

## Part A — Vectorize speed

Swapped the live vai-trace engine for `/workspace/vectorizer-build/lib/trace.py`. Default flags write the same SVG as the previous file (md5 `5fcc9121`).

Byte-identical (default `--inches 10 --mode auto`, no cache flags):

| image | old md5 | new md5 | identical |
|---|---|---|---|
| dirt-devils-annual-crop.png | 4924ba1f… | 4924ba1f… | yes |
| summit-before.jpg | 7837ca09… | 7837ca09… | yes |
| david-tiger-football.png | 4f2658a8… | 4f2658a8… | yes |
| bee-clean.png | b14e74d9… | b14e74d9… | yes |

`--cache-dir` on Summit wrote `manifest.json` + `labels.npz` and the SVG matched the no-flag run.

Site wiring (`lib/vai-trace/vectorize.js`, `lib/vaiTrace.js`, worker, `server.js`): one `DATA_DIR/trace-cache/<jobId>` per upload. First trace passes `--cache-dir`; colour-bar retraces pass `--colors N --from-cache` with the same inches/mode. Cache is removed when artwork is replaced or the job is deleted.

Studio colour bar (`public/app.js`): 400 ms idle debounce, run on pointer-up/change, AbortController cancels in-flight, stale seq ignored, small “Updating…” on the Detail control. Logos may not change plates at `--colors N`; the bar is wired, not faked.

Measured through the real server (POST `/api/jobs/:id/vectorize`, 10 in, vai-trace):

| | first trace | bar `--colors 6` | `4` | `10` |
|---|---:|---:|---:|---:|
| Summit | 3.194 s | 0.513 s | 0.494 s | 0.536 s |
| tiger | 3.759 s | 0.373 s | 0.346 s | 0.381 s |

First-trace cache dir had `manifest.json`. Bar moves reused it.

## Part B — Digitize polish

Inputs: summit/tiger/bee prepped @ 4 in tee (same as 407b97d).

- Satin: inner side of tight curves still shortens alternate columns; a second pile-up pass then drops travel/underlay/satin in 1 mm² cells that finished above 15 hits (tiger 17 → 15).
- Fill angles: long axis + ≥30° vs neighbours (including same-colour).
- Pull: satin widened per fabric (jersey 0.35 mm, pique 0.30, fleece 0.40, woven/twill 0.20, cap 0.25). Fill row-ends (edges perpendicular to stitch direction) use the same table except jersey fill stays 0.22 mm — 0.35–0.38 mm there pushed travel-on-top above the 407b97d cap.

Before = 407b97d / REPORT-TIGER-TRIMS.md. After = this batch.

| logo | stitches | CO | DST trims | PES trims | travel-on-top mm | max hits/mm² |
|---|---:|---:|---:|---:|---:|---:|
| summit | 11185 → **11185** | 2 | 21 → **21** | 20 → **20** | 3.2 → **3.2** | 11 → **11** |
| tiger | 20093 → **20082** | 7 | 105 → **105** | 104 → **104** | 22.4 → **22.4** | 17 → **15** |
| bee | 4478 → **4478** | 3 | 15 → **15** | 14 → **14** | 1.4 → **1.4** | 15 → **15** |

Colours/CO unchanged. No stitch <0.3 mm or >7 mm. PES trims = DST−1. Untrimmed jump moves = 0. Trims and travel-on-top not higher than 407b97d. `npm test` passes.

## Previews

`out/report/summit-oct11.png` `out/report/tiger-oct11.png` `out/report/bee-oct11.png`

## Regenerated on c2f33c7

Prep 1.7 (`lib/digitize_prep.py` md5 `32d90c26`) @ 4 in tee → wq (`lib/stitch/wq.js`) via `lib/digitize.js`, same path as the Digitize tab. Tracer `lib/vai-trace/trace.py` md5 `9076a539`. `VAI_SEALED_HOLDOUT=/nonexistent`. No Build.

| logo | stitches | CO | DST trims | PES trims | min mm | max mm |
|---|---:|---:|---:|---:|---:|---:|
| summit | **11164** | 2 | **19** | **18** | 0.300 | 6.003 |
| tiger | **20108** | 7 | **102** | **101** | 0.300 | 6.778 |
| bee | **4478** | 3 | **15** | **14** | 0.361 | 6.185 |

PES trims = DST−1. Untrimmed jump moves = 0. No stitch <0.3 mm or >7 mm. Files: `out/report/{summit,tiger,bee}.{dst,pes,exp,png}`.
