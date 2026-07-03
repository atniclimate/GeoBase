#!/usr/bin/env python
"""GeoPack-lite: package a terrain DEM + surface grid into a TSDF-tagged T0 baseline GeoPackage.

This is the Phase 0.2 precursor of the GeoPack ingestor (Phase 0.3). It applies
the CRS pipeline discipline from docs/CRS-PIPELINE.md — validate source CRS,
store native, assert at every hop — and writes TSDF classification metadata
into standard gpkg_metadata tables so the classification travels with the
artifact, not the docs.

Usage (input paths are CLI-only; no machine paths live in this file):
    python scripts/make_t0_baseline.py --dem <dem.tif> --grid <grid.gpkg> --out <baseline.gpkg>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Preflight: functional imports only. dist-info can lie (ghost installs);
# importing the symbols we actually call cannot.
# ---------------------------------------------------------------------------
try:
    import numpy as np
    import rasterio
    import rasterio.shutil as rio_shutil
    from pyogrio import read_info
    from pyogrio.raw import read as ogr_read
    from pyogrio.raw import write as ogr_write
except ImportError as exc:  # pragma: no cover
    sys.exit(
        f"preflight failed — geo stack is not functional: {exc}\n"
        "Repair with: python -m pip install --ignore-installed --no-deps pyogrio shapely pandas"
    )

TSDF_URI = "https://github.com/atniclimate/TieredSovereignDataFramework"
# Ascending sensitivity; mirrors geobase_tsdf::Tier ordering.
TIER_ORDER = {"T0": 0, "T1": 1, "T2": 2, "T3": 3}

METADATA_DDL = """
CREATE TABLE IF NOT EXISTS gpkg_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  md_scope TEXT NOT NULL DEFAULT 'dataset',
  md_standard_uri TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'text/xml',
  metadata TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS gpkg_metadata_reference (
  reference_scope TEXT NOT NULL,
  table_name TEXT,
  column_name TEXT,
  row_id_value INTEGER,
  timestamp DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  md_file_id INTEGER NOT NULL,
  md_parent_id INTEGER,
  CONSTRAINT crmr_mfi_fk FOREIGN KEY (md_file_id) REFERENCES gpkg_metadata(id),
  CONSTRAINT crmr_mpi_fk FOREIGN KEY (md_parent_id) REFERENCES gpkg_metadata(id)
);
CREATE TABLE IF NOT EXISTS gpkg_extensions (
  table_name TEXT,
  column_name TEXT,
  extension_name TEXT NOT NULL,
  definition TEXT NOT NULL,
  scope TEXT NOT NULL,
  CONSTRAINT ge_tce UNIQUE (table_name, column_name, extension_name)
);
"""


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def effective_tier(tiers: list[str]) -> str:
    """Most restrictive tier wins — mirrors geobase_core::LayerPackage::effective_tier."""
    return max(tiers, key=lambda t: TIER_ORDER[t])


def raster_table_of(gpkg: Path) -> str:
    """Name of the gridded-coverage table (rasterio uppercases creation-option
    values, so RASTER_TABLE=dem lands as DEM — discover, don't assume)."""
    con = sqlite3.connect(gpkg)
    try:
        row = con.execute(
            "SELECT table_name FROM gpkg_contents WHERE data_type='2d-gridded-coverage'"
        ).fetchone()
    finally:
        con.close()
    assert row, f"{gpkg}: no gridded-coverage raster table found"
    return row[0]


def copy_raster(dem: Path, out: Path) -> dict:
    """Hop 1: DEM -> GPKG raster coverage, stored in its NATIVE CRS, lossless.

    Ordering invariant: the raster MUST be written first. GDAL's GPKG
    CreateCopy destroys an existing file unless APPEND_SUBDATASET=YES;
    pyogrio (hop 2) opens an existing GPKG in update mode and preserves it.
    TILE_FORMAT is pinned to TIFF: Float32 PNG tiles would quantize to
    per-tile 16-bit and remap nodata (never degrade the encoding).
    """
    with rasterio.open(dem) as src:
        assert src.crs is not None, f"{dem}: source CRS is missing — refusing to assume"
        src_meta = {
            "crs": src.crs.to_string(),
            "width": src.width,
            "height": src.height,
            "dtype": src.dtypes[0],
            "nodata": src.nodata,
            "bounds": tuple(src.bounds),
        }
        data = src.read(1)
        nodata_count = int((data == src.nodata).sum()) if src.nodata is not None else 0
        finite = data[np.isfinite(data)] if np.isnan(data).any() else data
        if src.crs.is_geographic:
            w, s, e, n = src_meta["bounds"]
            assert -180 <= w < e <= 180 and -90 <= s < n <= 90, (
                f"{dem}: bounds {src_meta['bounds']} are not sane lon/lat — swapped axes?"
            )
        print(
            f"[dem] {src_meta['crs']} {src.width}x{src.height} {src_meta['dtype']} "
            f"nodata={src.nodata} ({nodata_count} px) elev {finite.min():.1f}..{finite.max():.1f} m"
        )

    rio_shutil.copy(str(dem), str(out), driver="GPKG", RASTER_TABLE="dem", TILE_FORMAT="TIFF")
    table = raster_table_of(out)

    # Assert the hop: reopen the copy and compare against the source.
    with rasterio.open(f"GPKG:{out}:{table}") as chk, rasterio.open(dem) as src:
        assert chk.crs == src.crs, f"CRS changed in copy: {src.crs} -> {chk.crs}"
        assert (chk.width, chk.height) == (src.width, src.height), "shape changed in copy"
        assert chk.dtypes[0] == src.dtypes[0], f"dtype changed: {src.dtypes[0]} -> {chk.dtypes[0]}"
        assert chk.nodata == src.nodata, f"nodata changed: {src.nodata} -> {chk.nodata}"
        assert np.array_equal(chk.read(1), src.read(1)), "raster data not preserved losslessly"
    print(f"[dem] -> {out}:{table} verified lossless (TIFF gridded coverage)")
    src_meta["table"] = table
    return src_meta


def copy_vector(grid: Path, out: Path, layer: str) -> dict:
    """Hop 2: surface grid -> vector layer in the SAME GPKG, native CRS preserved."""
    src_info = read_info(str(grid))
    assert src_info["crs"], f"{grid}: source CRS is missing — refusing to assume"
    meta, _index, geometry, field_data = ogr_read(str(grid))
    ogr_write(
        str(out),
        geometry,
        field_data,
        fields=meta["fields"],
        layer=layer,
        driver="GPKG",
        crs=meta["crs"],
        geometry_type=meta["geometry_type"],
    )
    chk = read_info(str(out), layer=layer)
    assert chk["crs"] == src_info["crs"], f"vector CRS changed: {src_info['crs']} -> {chk['crs']}"
    assert chk["features"] == src_info["features"], (
        f"feature count changed: {src_info['features']} -> {chk['features']}"
    )
    print(f"[grid] {chk['crs']} {chk['features']} features -> {out}:{layer} verified")
    return {"crs": src_info["crs"], "features": src_info["features"]}


def tag_tsdf(out: Path, tsdf_version: str, entries: list[tuple[str | None, str, dict]]) -> None:
    """Hop 3: TSDF classification via standard gpkg_metadata tables (stdlib sqlite3 —
    GDAL exposes no API for custom metadata rows; rasterio/pyogrio tags would emit
    GDAL-XML, not our JSON). entries = [(table_name or None for geopackage-scope,
    tier, payload_extras)]."""
    con = sqlite3.connect(out)
    try:
        cur = con.cursor()
        cur.executescript(METADATA_DDL)
        for table in ("gpkg_metadata", "gpkg_metadata_reference"):
            cur.execute(
                "INSERT OR IGNORE INTO gpkg_extensions "
                "(table_name, column_name, extension_name, definition, scope) "
                "VALUES (?, NULL, 'gpkg_metadata', "
                "'http://www.geopackage.org/spec121/#extension_metadata', 'read-write')",
                (table,),
            )
        for table_name, tier, extras in entries:
            payload = {
                "tier": tier,
                "tsdf_version": tsdf_version,
                "tsdf_source_origin": "vendored:embedded",
                "classified_on": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "classified_by": (
                    "implementer, provisional — no sovereign classification process "
                    "exists yet (GeoBase issue: governance/classification authority)"
                ),
                **extras,
            }
            cur.execute(
                "INSERT INTO gpkg_metadata (md_scope, md_standard_uri, mime_type, metadata) "
                "VALUES ('dataset', ?, 'application/json', ?)",
                (TSDF_URI, json.dumps(payload)),
            )
            md_id = cur.lastrowid
            scope = "geopackage" if table_name is None else "table"
            cur.execute(
                "INSERT INTO gpkg_metadata_reference "
                "(reference_scope, table_name, md_file_id) VALUES (?, ?, ?)",
                (scope, table_name, md_id),
            )
            print(f"[tsdf] {scope}:{table_name or '*'} tagged {tier}")
        con.commit()
    finally:
        con.close()


def verify_final(out: Path, dem_meta: dict, grid_meta: dict, layer: str) -> None:
    """Artifact-level completeness check: BOTH tables present and correct, tags parse.

    This is the guard that makes the raster-first ordering invariant unbreakable —
    a future edit that reorders the hops fails here, loudly, not silently.
    """
    with rasterio.open(f"GPKG:{out}:{dem_meta['table']}") as chk:
        assert chk.crs.to_string() == dem_meta["crs"]
        assert (chk.width, chk.height) == (dem_meta["width"], dem_meta["height"])
    info = read_info(str(out), layer=layer)
    assert info["crs"] == grid_meta["crs"] and info["features"] == grid_meta["features"]

    con = sqlite3.connect(out)
    try:
        cur = con.cursor()
        n_ext = cur.execute(
            "SELECT COUNT(*) FROM gpkg_extensions WHERE extension_name='gpkg_metadata'"
        ).fetchone()[0]
        assert n_ext == 2, f"expected 2 gpkg_metadata extension rows, found {n_ext}"
        rows = cur.execute(
            "SELECT r.reference_scope, r.table_name, m.metadata "
            "FROM gpkg_metadata m JOIN gpkg_metadata_reference r ON r.md_file_id = m.id "
            "WHERE m.md_standard_uri = ?",
            (TSDF_URI,),
        ).fetchall()
        assert len(rows) == 3, f"expected 3 TSDF metadata rows, found {len(rows)}"
        pkg = [json.loads(md) for scope, _t, md in rows if scope == "geopackage"]
        assert pkg and pkg[0]["tier"] == "T0", "geopackage roll-up tag missing or not T0"
    finally:
        con.close()
    print(f"[verify] {out}: raster + vector + 3 TSDF tags all present and correct")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dem", required=True, type=Path, help="terrain/elevation GeoTIFF")
    parser.add_argument("--grid", required=True, type=Path, help="surface grid GeoPackage")
    parser.add_argument("--out", required=True, type=Path, help="output baseline GeoPackage")
    parser.add_argument(
        "--tsdf-version",
        default=(Path(__file__).resolve().parents[1] / "spec" / "tsdf" / "VERSION")
        .read_text()
        .strip(),
        help="TSDF framework version stamp (default: vendored spec/tsdf/VERSION)",
    )
    args = parser.parse_args()

    for src in (args.dem, args.grid):
        if not src.is_file():
            sys.exit(f"input not found: {src}")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.out.exists():
        args.out.unlink()  # idempotent build: always from scratch

    dem_meta = copy_raster(args.dem, args.out)  # raster FIRST — see docstring
    grid_meta = copy_vector(args.grid, args.out, layer="grid_10m")

    basis_public_federal = (
        "derived exclusively from public-domain US federal sources "
        "(USGS 3DEP 1/3 arc-second + NOAA CRM Vol8 PNW); "
        "no Tribal-sourced or culturally sensitive attributes"
    )
    dem_tier, grid_tier = "T0", "T0"
    tag_tsdf(
        args.out,
        args.tsdf_version,
        [
            (
                dem_meta["table"],
                dem_tier,
                {
                    "classification_basis": basis_public_federal,
                    "source": {"path": str(args.dem), "sha256": sha256_of(args.dem)},
                    "native_crs": dem_meta["crs"],
                },
            ),
            (
                "grid_10m",
                grid_tier,
                {
                    "classification_basis": (
                        "boundary flags derive from public U.S. Census AIANNH data; "
                        "handoff hedged boundary data as T0/T1 — resolved T0 on the "
                        "public-release basis, recorded here per TSDF audit doctrine"
                    ),
                    "source": {"path": str(args.grid), "sha256": sha256_of(args.grid)},
                    "native_crs": grid_meta["crs"],
                },
            ),
            (
                None,  # geopackage scope: most restrictive of the table tiers
                effective_tier([dem_tier, grid_tier]),
                {"rule": "most restrictive of table tiers (geobase_core::LayerPackage::effective_tier)"},
            ),
        ],
    )

    verify_final(args.out, dem_meta, grid_meta, layer="grid_10m")
    print(f"[done] T0 baseline written: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
