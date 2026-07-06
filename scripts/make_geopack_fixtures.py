#!/usr/bin/env python
"""Synthetic GeoPack test fixtures for Phase 0.3 — deterministic and adversarial by design.

Writes into data/fixtures/geopack/ (tiny, committed-fixture-sized; AGENTS.md §7):

- ``dem_small.tif``   — 300x280 Float32, EPSG:26910, 10 m pixels, upper-left origin
  (523000, 5215000), DEFLATE. 300x280 at 256 px tiles forces a 2x2 tile matrix with
  a partial right column (44 px) and a partial bottom row (24 px) — exactly the
  adversarial layout the 2026-07-06 review demanded (docs/DECISIONS.md). NoData is
  -9999.0 with BOTH an interior block (rows 60..100, cols 80..140) and a wedge
  touching the top-right corner, so nodata crosses full and partial tiles.
- ``parcels_small.shp`` (+ .shx .dbf .prj) — 8 polygons inside the DEM extent,
  EPSG:26910, fields name (str), zone (int32), area_m2 (float64), one NULL zone.

Determinism: fixed integer seed, analytic surface, no timestamps (the DBF
last-update stamp is pinned), so reruns are byte-identical. The surface is
quantized to 1/32 m so plain DEFLATE (no predictor tag — the Phase 0.3 Rust
reader guarantees only None/LZW/Deflate) keeps the DEM small; every quantized
value is exactly representable in float32, so the fixture stays lossless.

Usage:
    python scripts/make_geopack_fixtures.py [--out-dir DIR]
"""

from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Preflight: functional imports only. dist-info can lie (ghost installs);
# importing the symbols we actually call cannot.
# ---------------------------------------------------------------------------
try:
    import numpy as np
    import rasterio
    from rasterio.crs import CRS
    from rasterio.transform import from_origin
    from pyogrio import read_info
    from pyogrio.raw import read as ogr_read
    from pyogrio.raw import write as ogr_write
except ImportError as exc:  # pragma: no cover
    sys.exit(
        f"preflight failed — geo stack is not functional: {exc}\n"
        "Repair with: python -m pip install --ignore-installed --no-deps pyogrio shapely pandas"
    )

SEED = 26910  # fixed integer seed — reruns are byte-identical
EPSG = 26910  # NAD83 / UTM zone 10N
WIDTH, HEIGHT = 300, 280
PIXEL = 10.0
ORIGIN = (523000.0, 5215000.0)  # upper-left corner of the upper-left pixel
NODATA = -9999.0
QUANT = 32.0  # surface quantization step = 1/32 m (exact in float32)
INTERIOR_NODATA = (slice(60, 100), slice(80, 140))  # rows, cols
WEDGE_ROWS = 40  # nodata wedge touching the top-right corner
SIZE_BUDGET = 200 * 1024  # total fixture budget, bytes
SHP_EXTS = (".shp", ".shx", ".dbf", ".prj", ".cpg")
DBF_UPDATE_STAMP = (126, 1, 1)  # pinned DBF header date (no timestamps in fixtures)

PARCEL_NAMES = [f"parcel_{i:02d}" for i in range(1, 9)]
PARCEL_ZONES = [11, 12, 21, 0, 22, 31, 32, 41]  # index 3 becomes NULL (see below)
NULL_ZONE_INDEX = 3


def dem_values() -> np.ndarray:
    """Smooth synthetic surface, quantized to 1/32 m, with both nodata regions."""
    x, y = np.meshgrid(np.arange(WIDTH, dtype=np.float64), np.arange(HEIGHT, dtype=np.float64))
    raw = 120.0 + 60.0 * np.sin(x / 45.0) * np.cos(y / 38.0)
    values = (np.round(raw * QUANT) / QUANT).astype(np.float32)
    values[INTERIOR_NODATA] = np.float32(NODATA)
    for r in range(WEDGE_ROWS):  # shrinking wedge; row 0 includes the corner pixel
        values[r, WIDTH - WEDGE_ROWS + r :] = np.float32(NODATA)
    return values


def write_dem(path: Path, values: np.ndarray) -> None:
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=WIDTH,
        height=HEIGHT,
        count=1,
        dtype="float32",
        crs=CRS.from_epsg(EPSG),
        transform=from_origin(ORIGIN[0], ORIGIN[1], PIXEL, PIXEL),
        nodata=NODATA,
        compress="deflate",
        zlevel=9,
    ) as dst:
        dst.write(values, 1)


def wkb_polygon(ring: list[tuple[float, float]]) -> bytes:
    """Little-endian WKB for a single-ring polygon (ring must be closed)."""
    buf = struct.pack("<BII", 1, 3, 1) + struct.pack("<I", len(ring))
    for px, py in ring:
        buf += struct.pack("<dd", px, py)
    return buf


def shoelace_area(ring: list[tuple[float, float]]) -> float:
    """Unsigned area of a closed ring."""
    total = 0.0
    for (x0, y0), (x1, y1) in zip(ring[:-1], ring[1:]):
        total += x0 * y1 - x1 * y0
    return abs(total) / 2.0


def parcel_rings() -> list[list[tuple[float, float]]]:
    """8 jittered quadrilaterals on a 4x2 grid, strictly inside the DEM extent."""
    rng = np.random.default_rng(SEED)
    jitter = np.round(rng.uniform(-60.0, 60.0, size=(8, 4, 2)), 2)
    rings: list[list[tuple[float, float]]] = []
    for i in range(8):
        col, row = i % 4, i // 4
        x0 = 523150.0 + col * 675.0 + 140.0
        x1 = 523150.0 + (col + 1) * 675.0 - 140.0
        y0 = 5212350.0 + row * 1250.0 + 140.0
        y1 = 5212350.0 + (row + 1) * 1250.0 - 140.0
        corners = [(x0, y1), (x1, y1), (x1, y0), (x0, y0)]  # UL, UR, LR, LL
        ring = [(cx + float(jx), cy + float(jy)) for (cx, cy), (jx, jy) in zip(corners, jitter[i])]
        ring.append(ring[0])
        rings.append(ring)
    return rings


def _patch_dbf(dbf: Path, null_field: str, null_record: int) -> None:
    """Blank one numeric field to spaces (OGR reads that as NULL — DBF has no
    other null encoding) and pin the header's last-update date so reruns are
    byte-identical (no timestamps in fixtures)."""
    raw = bytearray(dbf.read_bytes())
    raw[1:4] = bytes(DBF_UPDATE_STAMP)
    n_records = struct.unpack_from("<I", raw, 4)[0]
    header_size = struct.unpack_from("<H", raw, 8)[0]
    record_size = struct.unpack_from("<H", raw, 10)[0]
    assert 0 <= null_record < n_records, f"record {null_record} out of range ({n_records})"
    offset, target = 1, None  # offset 0 in each record is the deletion flag
    for d in range(32, header_size - 1, 32):
        fname = bytes(raw[d : d + 11]).split(b"\x00")[0].decode("ascii")
        flen = raw[d + 16]
        if fname == null_field:
            target = (offset, flen)
        offset += flen
    assert target is not None, f"field {null_field!r} not found in {dbf}"
    rec = header_size + null_record * record_size
    raw[rec + target[0] : rec + target[0] + target[1]] = b" " * target[1]
    dbf.write_bytes(bytes(raw))


def write_parcels(shp: Path) -> dict:
    rings = parcel_rings()
    areas = [shoelace_area(r) for r in rings]
    geometry = np.array([wkb_polygon(r) for r in rings], dtype=object)
    field_data = [
        np.array(PARCEL_NAMES, dtype=object),
        np.array(PARCEL_ZONES, dtype="int32"),
        np.array(areas, dtype="float64"),
    ]
    ogr_write(
        str(shp),
        geometry,
        field_data,
        fields=["name", "zone", "area_m2"],
        layer=shp.stem,
        driver="ESRI Shapefile",
        crs=f"EPSG:{EPSG}",
        geometry_type="Polygon",
    )
    # DBF is the only shapefile member that can carry a NULL int32 — blank it in place.
    _patch_dbf(shp.with_suffix(".dbf"), "zone", NULL_ZONE_INDEX)
    return {"names": PARCEL_NAMES, "zones": PARCEL_ZONES, "areas": areas, "rings": rings}


def _null_mask(arr: np.ndarray) -> np.ndarray:
    """Nulls as pyogrio may express them: masked array, or NaN after promotion
    of an int column with NULLs to float64."""
    if np.ma.isMaskedArray(arr):
        return np.ma.getmaskarray(arr)
    if arr.dtype.kind == "f":
        return np.isnan(arr)
    return np.zeros(arr.shape, dtype=bool)


def verify_dem(path: Path, expected: np.ndarray) -> None:
    """Re-open and assert every declared property — trust nothing that was not read back."""
    with rasterio.open(path) as src:
        assert src.crs == CRS.from_epsg(EPSG), f"CRS: {src.crs} != EPSG:{EPSG}"
        assert (src.width, src.height) == (WIDTH, HEIGHT), f"dims {src.width}x{src.height}"
        assert src.dtypes[0] == "float32", f"dtype {src.dtypes[0]}"
        assert src.nodata == NODATA, f"nodata {src.nodata}"
        t = src.transform
        assert (t.a, t.b, t.c, t.d, t.e, t.f) == (PIXEL, 0.0, ORIGIN[0], 0.0, -PIXEL, ORIGIN[1]), (
            f"transform {tuple(t)[:6]}"
        )
        assert src.profile.get("compress") == "deflate", f"compress {src.profile.get('compress')}"
        data = src.read(1)
    assert np.array_equal(data, expected), "DEM pixels differ from the synthetic surface"
    n_nodata = int((data == np.float32(NODATA)).sum())
    n_block = int((data[INTERIOR_NODATA] == np.float32(NODATA)).sum())
    n_wedge = WEDGE_ROWS * (WEDGE_ROWS + 1) // 2
    assert n_nodata > 0, "no nodata pixels at all"
    assert n_block == 40 * 60, f"interior nodata block incomplete ({n_block} px)"
    assert data[0, WIDTH - 1] == np.float32(NODATA), "wedge does not touch the top-right corner"
    assert n_nodata == n_block + n_wedge, f"nodata count {n_nodata} != {n_block + n_wedge}"
    valid = data[data != np.float32(NODATA)]
    assert 59.0 < float(valid.min()) and float(valid.max()) < 181.0, "surface out of range"
    print(
        f"[fixture] dem_small.tif EPSG:{EPSG} {WIDTH}x{HEIGHT} float32 nodata={NODATA} "
        f"({n_nodata} px: {n_block} interior + {n_wedge} corner wedge) "
        f"elev {valid.min():.2f}..{valid.max():.2f} m"
    )
    print("[fixture] dem tile layout @256px: 2x2 matrix, partial right (44 px) + bottom (24 px)")


def verify_parcels(shp: Path, expected: dict) -> None:
    prj = shp.with_suffix(".prj")
    assert prj.is_file() and prj.stat().st_size > 0, f"{prj} missing or empty"
    assert prj.read_text().startswith("PROJCS"), f"{prj} is not WKT (ESRI WKT expected)"
    info = read_info(str(shp))
    assert CRS.from_user_input(info["crs"]) == CRS.from_epsg(EPSG), f"CRS: {info['crs']}"
    assert info["features"] == 8, f"feature count {info['features']} != 8"
    schema = dict(zip(list(info["fields"]), list(info["dtypes"])))
    assert schema.get("zone") == "int32", f"zone schema dtype {schema.get('zone')} != int32"
    assert schema.get("area_m2") == "float64", f"area_m2 dtype {schema.get('area_m2')}"
    assert "name" in schema, f"fields {sorted(schema)}"

    meta, _, geometry, field_data = ogr_read(str(shp))
    fields = dict(zip(list(meta["fields"]), field_data))
    assert len(geometry) == 8 and all(g is not None for g in geometry), "geometry missing"
    assert [str(v) for v in fields["name"]] == expected["names"], "names differ"
    zone, nulls = fields["zone"], _null_mask(fields["zone"])
    assert int(nulls.sum()) == 1 and bool(nulls[NULL_ZONE_INDEX]), (
        f"exactly one NULL zone expected at index {NULL_ZONE_INDEX}, mask={nulls.tolist()}"
    )
    for i, want in enumerate(expected["zones"]):
        if i != NULL_ZONE_INDEX:
            assert int(zone[i]) == want, f"zone[{i}] {zone[i]} != {want}"
    for i, want in enumerate(expected["areas"]):
        got = float(fields["area_m2"][i])
        assert got == want, f"area_m2[{i}] {got!r} != {want!r} (DBF round-trip broke)"
    print(
        f"[fixture] parcels_small.shp EPSG:{EPSG} 8 polygon features, "
        f"zone NULL at {expected['names'][NULL_ZONE_INDEX]}, .prj present (ESRI WKT)"
    )


def report_sizes(out_dir: Path) -> None:
    paths = sorted(p for p in out_dir.iterdir() if p.is_file())
    total = sum(p.stat().st_size for p in paths)
    for p in paths:
        print(f"[fixture] {p.name}: {p.stat().st_size} bytes")
    assert total <= SIZE_BUDGET, f"fixtures total {total} bytes exceeds budget {SIZE_BUDGET}"
    print(f"[fixture] total {total} bytes (budget {SIZE_BUDGET})")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "data" / "fixtures" / "geopack",
        help="output directory (default: data/fixtures/geopack under the repo root)",
    )
    args = parser.parse_args()
    out_dir: Path = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    dem = out_dir / "dem_small.tif"
    shp = out_dir / "parcels_small.shp"
    for stale in [dem, *(shp.with_suffix(ext) for ext in SHP_EXTS)]:
        if stale.exists():
            stale.unlink()  # idempotent build: always from scratch

    values = dem_values()
    write_dem(dem, values)
    verify_dem(dem, values)

    expected = write_parcels(shp)
    verify_parcels(shp, expected)

    report_sizes(out_dir)
    print(f"[done] geopack fixtures written: {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
