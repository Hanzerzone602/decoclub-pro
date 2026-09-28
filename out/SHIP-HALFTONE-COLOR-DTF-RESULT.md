# SHIP · Halftone color (DTF) + service-aware Studio UI

**Stamp:** `ht-color-v6` · cache `?v=ht6`

## 1) Color-preserving HT
- Default `colorMode: "source"` — sample per-cell average RGB (alpha-aware); luminance → spot size; each mark gets its own `fill`/`stroke`.
- Optional `colorMode: "ink"` + `color` for single-ink shops.
- Parent `<g fill="none">` in source mode (no forced black).
- Layer label: `Full color HT · …`; SVG remains geometry truth.
- UI: Art colors default; “Use one ink color” checkbox shows Ink picker only when checked.
- Preview + Apply share payload (`colorMode`).

## 2) Hide Vectorize chrome in HT mode
When HT panel open (`setHtModeUi(true)` / `body.ht-mode`):
- Hide `#vzOptions`, `#vzUsed`, `#vzLiveHint`, `#colorModeRow`, layer list, Vectorize / greyscale / invert.
- Close restores them.
- `?tool=halftones` (start.html → app) opens HT panel; HT jobs reopen panel.

## Files
- `lib/vectorHalftone.js`
- `server.js`
- `public/app.js`, `app.html`, `styles.css`, `start.html`, `index.html`, `admin.html`
- `test/halftone-color.test.js`

## Hard locks
No Vectorizer.AI / vai-trace / whisker-gate changes. No paid credits spent.
