#!/usr/bin/env python
"""Generate Terrarium terrain tiles (XYZ, EPSG:3857) from a TSDF-tagged T0 baseline GPKG.

The classification is DERIVED from the baseline artifact, never re-declared:
this script reads the DEM table's gpkg_metadata TSDF tag and refuses to emit
anything into a public tile directory for any tier other than T0. Tile math
targets Web Mercator (EPSG:3857) in XYZ layout — MapLibre raster-dem sources
have no `scheme` property and always request XYZ.

Usage:
    python scripts/generate_terrain_tiles.py --baseline data/baselines/squaxin_t0.gpkg \
        --out engine-light/public/tiles/terrain
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import sqlite3
import sys
from pathlib import Path

try:
    import numpy as np
    import rasterio
    from PIL import Image
    from rasterio.transform import from_bounds
    from rasterio.warp import Resampling, reproject, transform_bounds
except ImportError as exc:  # pragma: no cover
    sys.exit(f"preflight failed — geo stack is not functional: {exc}")

TSDF_URI = "https://github.com/atniclimate/TieredSovereignDataFramework"
MERC_ORIGIN = 20037508.342789244  # meters; EPSG:3857 half-extent
TILE_SIZE = 256

REPO_ROOT = Path(__file__).resolve().parents[1]
RUST_FIXTURE = REPO_ROOT / "crates" / "geobase-core" / "tests" / "fixtures" / "geobase-baseline.json"


def read_tsdf_tag(baseline: Path) -> tuple[str, dict]:
    """Discover the gridded-coverage table and its table-scoped TSDF tag."""
    con = sqlite3.connect(baseline)
    try:
        row = con.execute(
            "SELECT table_name FROM gpkg_contents WHERE data_type='2d-gridded-coverage'"
        ).fetchone()
        assert row, f"{baseline}: no gridded-coverage raster table"
        table = row[0]
        tag_row = con.execute(
            "SELECT m.metadata FROM gpkg_metadata m "
            "JOIN gpkg_metadata_reference r ON r.md_file_id = m.id "
            "WHERE m.md_standard_uri = ? AND r.reference_scope='table' AND r.table_name = ?",
            (TSDF_URI, table),
        ).fetchone()
        assert tag_row, f"{baseline}:{table} carries no TSDF tag — refusing to tile untagged data"
    finally:
        con.close()
    return table, json.loads(tag_row[0])


def encode_terrarium(elevation: np.ndarray) -> np.ndarray:
    """elevation = (R*256 + G + B/256) - 32768; 1/256 m precision."""
    shifted = np.clip(elevation, -32768, 32767).astype(np.float64) + 32768
    r = np.floor(shifted / 256).astype(np.uint8)
    g = np.floor(shifted % 256).astype(np.uint8)
    b = np.floor((shifted * 256) % 256).astype(np.uint8)
    return np.stack([r, g, b], axis=-1)


def decode_terrarium(rgb: np.ndarray) -> np.ndarray:
    r = rgb[:, :, 0].astype(np.float64)
    g = rgb[:, :, 1].astype(np.float64)
    b = rgb[:, :, 2].astype(np.float64)
    return (r * 256 + g + b / 256) - 32768


def lonlat_to_xyz_tile(lon: float, lat: float, zoom: int) -> tuple[int, int]:
    """XYZ tile indices (top-left origin) — never TMS."""
    n = 2**zoom
    x = int((lon + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    y = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)


def xyz_tile_merc_bounds(x: int, y: int, zoom: int) -> tuple[float, float, float, float]:
    """Tile bounds in EPSG:3857 METERS (west, south, east, north). Resampling in
    mercator space fixes the donor script's degree-space distortion."""
    n = 2**zoom
    span = 2 * MERC_ORIGIN / n
    west = -MERC_ORIGIN + x * span
    north = MERC_ORIGIN - y * span
    return west, north - span, west + span, north


def kernel_for(zoom: int, lat: float, native_res_m: float) -> Resampling:
    """average for heavy decimation (>2x), bilinear otherwise — bilinear alone
    point-samples at low zooms and produces aliased, speckled terrain."""
    ground_res = (2 * MERC_ORIGIN / (2**zoom * TILE_SIZE)) * math.cos(math.radians(lat))
    return Resampling.average if ground_res / native_res_m > 2 else Resampling.bilinear


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True, type=Path, help="TSDF-tagged baseline GPKG")
    parser.add_argument("--out", required=True, type=Path, help="tile output directory")
    parser.add_argument("--minzoom", type=int, default=8)
    parser.add_argument("--maxzoom", type=int, default=12)
    args = parser.parse_args()

    table, tag = read_tsdf_tag(args.baseline)
    tier, tsdf_version = tag.get("tier"), tag.get("tsdf_version")
    # The public-tile emitter's guardrail: only T0 may leave for a public directory.
    assert tier == "T0", f"baseline {table} is {tier}, not T0 — refusing to emit public tiles"
    print(f"[tsdf] {args.baseline}:{table} tier={tier} tsdf_version={tsdf_version} — OK to tile")

    with rasterio.open(f"GPKG:{args.baseline}:{table}") as src:
        assert src.crs is not None, "baseline DEM has no CRS"
        dem = src.read(1)
        src_transform, src_crs, nodata = src.transform, src.crs, src.nodata
        bounds_4326 = transform_bounds(src_crs, "EPSG:4326", *src.bounds)
        native_res_m = abs(src_transform.a) * (
            111_320 * math.cos(math.radians((bounds_4326[1] + bounds_4326[3]) / 2))
            if src_crs.is_geographic
            else 1.0
        )

    # NoData -> 0 (sea level) BEFORE encoding — the -32768 m spike lesson.
    if nodata is not None:
        dem = np.where(dem == nodata, 0.0, dem)
    dem = np.nan_to_num(dem, nan=0.0).astype(np.float32)
    elev_min, elev_max = float(dem.min()), float(dem.max())
    print(f"[dem] {src_crs} native ~{native_res_m:.1f} m/px, elev {elev_min:.1f}..{elev_max:.1f} m")

    # This script OWNS the output dir: committed tree is exactly tiles + manifest.
    if args.out.exists():
        shutil.rmtree(args.out)
    args.out.mkdir(parents=True)

    west, south, east, north = bounds_4326
    lat_mid = (south + north) / 2
    tile_count, total_bytes, max_rt_err = 0, 0, 0.0
    for zoom in range(args.minzoom, args.maxzoom + 1):
        x_min, y_min = lonlat_to_xyz_tile(west, north, zoom)  # NW corner
        x_max, y_max = lonlat_to_xyz_tile(east, south, zoom)  # SE corner
        kernel = kernel_for(zoom, lat_mid, native_res_m)
        for x in range(x_min, x_max + 1):
            for y in range(y_min, y_max + 1):
                tile = np.zeros((TILE_SIZE, TILE_SIZE), dtype=np.float32)
                dst_transform = from_bounds(*xyz_tile_merc_bounds(x, y, zoom), TILE_SIZE, TILE_SIZE)
                reproject(
                    source=dem,
                    destination=tile,
                    src_transform=src_transform,
                    src_crs=src_crs,
                    dst_transform=dst_transform,
                    dst_crs="EPSG:3857",
                    src_nodata=None,
                    dst_nodata=0.0,
                    resampling=kernel,
                )
                tile = np.nan_to_num(tile, nan=0.0)
                rgb = encode_terrarium(tile)
                # Round-trip against the RAW encoder input — the encode-corruption
                # tripwire (a stray -999999 would decode ~967 km off and fail here).
                rt_err = float(np.abs(decode_terrarium(rgb) - tile).max())
                assert rt_err <= 0.5, f"terrarium round-trip error {rt_err:.3f} m at {zoom}/{x}/{y}"
                max_rt_err = max(max_rt_err, rt_err)
                tile_dir = args.out / str(zoom) / str(x)
                tile_dir.mkdir(parents=True, exist_ok=True)
                path = tile_dir / f"{y}.png"
                Image.fromarray(rgb, "RGB").save(path, "PNG", optimize=True)
                tile_count += 1
                total_bytes += path.stat().st_size
        print(f"[z{zoom}] x {x_min}-{x_max}, y {y_min}-{y_max} ({kernel.name})")

    mb = total_bytes / (1024 * 1024)
    print(f"[tiles] {tile_count} tiles, {mb:.2f} MB, max round-trip err {max_rt_err:.4f} m")

    # Manifest is an ALLOWLIST — no filesystem paths, no hashes (those live only
    # in the gitignored GPKG metadata). tier/tsdf_version come from the artifact.
    manifest = {
        "tilejson": "3.0.0",
        "name": "GeoBase T0 terrain baseline",
        "attribution": "USGS 3DEP 1/3 Arc-Second, NOAA CRM Vol8 PNW",
        "classification": "T0 (provisional, pending governance)",
        "tier": tier,
        "tsdf_version": tsdf_version,
        "encoding": "terrarium",
        "scheme": "xyz",
        "crs_chain": [str(src_crs), "EPSG:3857"],
        "elevation_range_m": [round(elev_min, 1), round(elev_max, 1)],
        "minzoom": args.minzoom,
        "maxzoom": args.maxzoom,
        "bounds": [round(v, 6) for v in bounds_4326],
        # Relative to this manifest's own directory; consumers must absolutize
        # (MapLibre will not — maplibre-gl-js issue #182).
        "tiles": ["{z}/{x}/{y}.png"],
    }
    # Written twice via one serializer call: shipped copy + Rust test fixture,
    # so workspace compilation never depends on the web bundle's lifecycle.
    payload = json.dumps(manifest, indent=2) + "\n"
    (args.out / "geobase-baseline.json").write_text(payload, encoding="utf-8", newline="\n")
    RUST_FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    RUST_FIXTURE.write_text(payload, encoding="utf-8", newline="\n")
    print(f"[manifest] {args.out / 'geobase-baseline.json'} (+ Rust fixture)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
