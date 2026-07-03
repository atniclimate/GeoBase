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
