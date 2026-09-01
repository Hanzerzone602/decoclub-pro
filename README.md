DecoClub Pro

Shop production OS. Placeholder brand.

Demo shop owner@anvil.local password anvil123
Demo client client@anvil.local password anvil123
httpOnly session cookie named anvil.

## Run
Use the test and start scripts in package.json. Listen port comes from the PORT variable (3847 if unset).
Configuration names are listed in the env example file next to this README.

## Exports
packet.json with method, size inches, qty, unit price, total, filenames.
cut-contour.svg traced from raster. laser.svg plus laser.plt. gang-sheet.svg on a 22 inch sheet with 0.125 inch gaps. sticker-cutline.svg offset about 1.5mm.

## Billing
Checkout paths exist for trial, shop 79, studio 149. Missing Stripe secret: membership still saved, UI says Billing connects when keys are set.

## Persist shop files
JSON store, uploads, and exports sit in the data directory. Copy them for backups. Point DATA_DIR at durable storage on a host.

## Railway and Fly
Start the Node process. Honor the platform PORT. Attach a volume, set DATA_DIR, set PUBLIC_URL to the https origin. Add your own domain in the platform UI; TLS is issued there. Do not invent a domain in this repo.
