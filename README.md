DecoClub Pro
Shop OS
npm start

## CorelDRAW path-transfer import (explicit -- not default PNG Vectorize)

Studio can ingest CorelDRAW SVG exports whose art sits outside the page viewBox.
This remaps paths into a square studio SVG + colorspec layers.

Not used by the default Vectorize button (Bezier / VTracer on PNG).

### Call from Studio / API

1. Upload CorelDRAW .svg as job artwork -- auto path-transfer when Corel detected.
2. POST /api/jobs/:id/corel-import  body: { sizeIn, pad, apply_mockup }
3. POST /api/jobs/:id/vectorize  body: { engine: "corel-import" }

Implementation: lib/corelImport.js (port of scripts/corel_path_transfer.py).
