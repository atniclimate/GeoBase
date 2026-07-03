# data/

**Geospatial data is never committed to this repository.**

The prototype co-located ~46 GB of data with code. GeoBase keeps code + specs +
small fixtures only. This directory is git-ignored except for:

- `README.md` (this file),
- `fixtures/` — small sample data used by tests/demos (kept intentionally tiny).

Real datasets — secure GeoPackages (`.gpkg`/`.sgpkg`), LiDAR (`.laz`/`.las`),
imagery (`.tif`), bathymetry (`.nc`) — live **outside version control**: a local
data directory today, and a future object store / federated distribution.

**T2 and T3 data must never appear here or anywhere in git.** Their egress
guarantees are enforced by the Desktop Engine node, not by `.gitignore`.

## The one deliberate exception: the Phase 0.2 T0 demo tile bundle

`engine-light/public/tiles/terrain/` holds a **small, size-capped, T0-only**
Terrarium tile set (31 PNG tiles + manifest, ~1.3 MB) so the static Pages demo
is self-contained. Be clear-eyed about what this is: the tiles **are** the
AOI's elevation data, re-encoded at 1/256 m precision and decodable back to
elevations. They are publicly released as **T0 (provisional)** on this basis:
the source DEM derives exclusively from public-domain US federal data
(USGS 3DEP 1/3 arc-second + NOAA CRM), and no Tribal-sourced or culturally
sensitive attributes are present. The classification is *provisional pending
the ATNI governance/classification-authority process* — its first exercise
will be to ratify or revoke this release.

The exception is enforced, not just documented: the render-gate harness
(`engine-light/scripts/verify-render.mjs`, run locally pre-push and in CI)
fails if the bundle exceeds **5 MB** or contains anything other than tiles
and the manifest. Source GeoPackages (e.g. `data/baselines/`) remain outside
git as always.
