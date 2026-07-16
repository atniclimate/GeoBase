# tools/acquire — populate a GeoBase node from public federal data (F4)

**AOI in → GeoPacks out, in one page.** `tools/acquire` gives a data-poor Tribe
a populated node from an area-of-interest bounding box, using only public
federal sources that require no API keys. It is **out-of-product** tooling: it
is never a product dependency, never a required CI check, and it does not touch
the product's pure-Rust posture or its runtime network-denial guarantee (Phase
B B7 — that is about the *product*; this tool is deliberately network-enabled).

The seam is a **staging directory**: `acquire` downloads public data into a
staging dir; `geopack package` ingests that dir through the existing pipeline.
`acquire` never writes a GeoPackage and never reimplements packaging.

## Quick start

```powershell
# List sources
python -m tools.acquire --list

# Dry-run: index + safety pass + provenance, NO download (what CI does)
python -m tools.acquire 3dep-dem --bbox -123.20,47.00,-123.00,47.20 `
    --out .\staging --dry-run

# Real fetch into a staging dir
python -m tools.acquire 3dep-dem --bbox -123.20,47.00,-123.00,47.20 --out .\staging

# Then ingest the staged data with the product CLI (unclassified -> T3)
cargo run -p geobase-ingestor --bin geopack -- ingest .\staging\USGS_13_n48w124.tif `
    --out .\data\vault\elevation.gpkg
```

`--bbox` is `west,south,east,north` in WGS84. Every request is clipped to the
AOI; an AOI larger than the safety ceiling is refused before any request.

> **Note:** because a west longitude starts with `-`, pass the bbox with an
> equals sign so the shell/argparse doesn't read it as a flag:
> `--bbox=-123.20,47.00,-123.00,47.20`.

## The five safety rules (`safety.py`)

Applied by every fetcher so no source can drift into downloading the country:

1. **advertised-size check** — an index that hides its size is refused (drift
   signal, not a default).
2. **free-disk headroom** — the download must leave a margin free.
3. **refuse-oversized** — hard per-file (2 GiB) and per-job (8 GiB) ceilings.
4. **clip-to-AOI** — every request is AOI-bounded; a >4 sq-deg AOI is refused.
5. **discard raw archives** — the staging dir holds usable data, not zips.

All failures are **loud** (`SafetyError`) — never a silent truncation. Endpoints
are **config**; a drifted endpoint fails with the probe response body, and the
tool **never falls back to scraping**. Hosts are **domain-pinned**
(`allowed_hosts` per source in `sources.py`).

## TSDF tier note

Sources here are **Tier 0** (public federal data). That is the *source*
posture. GeoBase assigns the node's TSDF tier **at ingest** — unclassified data
defaults to **T3** (`AGENTS.md` §2). LiDAR in particular ingests as T3 by
default. `provenance.json` (written into every staging dir) records the source
posture and this distinction.

## Attribution & provenance (Tier-0 requirement, recorded)

All sources are Tier 0 and may be used freely **with attribution and provenance
recorded**. This is the authoritative record; `THIRD_PARTY_NOTICES.md` cites it,
and `sources.py` is its machine-readable twin.

### USGS 3DEP Digital Elevation Model (`3dep-dem`)
- **Attribution:** Elevation data courtesy of the U.S. Geological Survey 3D
  Elevation Program (3DEP), The National Map.
- **License:** U.S. Government work — public domain (17 U.S.C. § 105).
  Attribution requested as a courtesy.
- **Provenance:** Indexed by the TNMAccess API
  (`tnmaccess.nationalmap.gov/api/v1/products`); staged products from
  `prd-tnm.s3.amazonaws.com` / `rockyweb.usgs.gov`.

### USGS 3DEP LiDAR point clouds (`3dep-lidar`)
- **Attribution:** LiDAR point clouds courtesy of the USGS 3D Elevation Program
  (3DEP).
- **License:** U.S. Government work — public domain. AWS Open Data
  `usgs-lidar-public` mirrors it under the same terms.
- **Provenance:** LAZ tiles via TNMAccess; pre-tiled COPC/EPT mirrors at
  `usgs.entwine.io` and `s3://usgs-lidar-public`
  (`registry.opendata.aws/usgs-lidar`).

### LANDFIRE fuels & vegetation (`landfire`)
- **Attribution:** Fuels and vegetation data from LANDFIRE, a joint program of
  the USDA Forest Service and U.S. Department of the Interior.
- **License:** U.S. Government work — public domain. LANDFIRE requests citation
  of the program and product version.
- **Provenance:** LANDFIRE Product Service (LFPS) async job API
  (`lfps.usgs.gov/api`): submit → poll → download an AOI clip. The
  submit→poll→download discipline is adapted from `zymazza/mazzap_veil` (MIT) —
  see `THIRD_PARTY_NOTICES.md`.

### NHDPlus HR / Watershed Boundary Dataset (`nhd`)
- **Attribution:** Hydrography from the USGS National Hydrography Dataset Plus
  High Resolution (NHDPlus HR) and the Watershed Boundary Dataset (WBD).
- **License:** U.S. Government work — public domain (17 U.S.C. § 105).
- **Provenance:** Staged HU4/HU8 GDB/GPKG products indexed by TNMAccess, fetched
  by the HUC(s) intersecting the AOI.

## Status (2026-07-16)

- **Wired into the CLI:** the TNMAccess index sources — `3dep-dem`,
  `3dep-lidar`, `nhd` (index + safety + staging + provenance; `--dry-run`
  proven offline against recorded fixtures).
- **Scaffolded, not yet CLI-wired:** `landfire` (the async LFPS submit→poll→
  download job path). Its source config + attribution are recorded; the CLI
  fails honestly if invoked rather than pretending.
- Tests: `python -m unittest discover -s tools/acquire/tests` (no network).
- CI: `.github/workflows/acquire-gate.yml` — `workflow_dispatch` + `schedule`
  only, **never a required check**, `contents: read`, no secrets.
