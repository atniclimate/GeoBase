#!/usr/bin/env python3
"""RStep 1.3d oracle — re-prove the export from OUTSIDE the product (Phase A, A4).

The product's own verifier (export.rs) reopens its output; this oracle is the
cross-implementation check in the 0.3 house pattern (GDAL/pyogrio, CI-only —
never a product dependency). It asserts, independently of any Rust code:

  1. The shapefile carries EXACTLY the product whitelist [id, area_m2, score]
     in that order, EPSG:4326, the expected feature count, finite values.
  2. Output geometry == painted geometry (coordinate multisets; ring rotation
     and closure tolerated), painted as REPORTED BY THE PAGE (paint.features()).
  3. NO output geometry equals any source-pack geometry (zero source
     disclosure), checked against every feature table of every source GPKG.
  4. The .tsdf.json sidecar carries exactly the documented key schema, no
     absolute filesystem paths, and source_packs entries expose only
     {id, tier, sha256} — never attributes, paths, or geometry.

Exit 0 = all assertions hold. Exit 1 = the export is not what it claims.

usage: verify_rstep_oracle.py --product-shp P.shp --painted-json painted.json
           --sidecar P.tsdf.json --expect-features N --source S1.gpkg [S2.gpkg ...]
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

import pyogrio

FAILURES: list[str] = []

PRODUCT_FIELDS = ["id", "area_m2", "score"]  # export.rs PRODUCT_FIELDS, verbatim
SIDECAR_KEYS = {
    "tier",
    "tsdf_version",
    "tsdf_source_origin",
    "basis",
    "process",
    "product",
    "features",
    "source_packs",
    "files",
}
SOURCE_PACK_KEYS = {"id", "tier", "sha256"}
ABSOLUTE_PATH_PATTERN = re.compile(r"[A-Za-z]:[\\/]|/home/|/tmp/|/Users/")


def fail(why: str) -> None:
    FAILURES.append(why)
    print(f"ORACLE-FAIL: {why}", file=sys.stderr)


def canonical_ring(ring) -> tuple:
    """Ring as a rotation- and closure-invariant canonical tuple."""
    coords = [(float(x), float(y)) for x, y in ring]
    if len(coords) > 1 and coords[0] == coords[-1]:
        coords = coords[:-1]
    if not coords:
        return ()
    # Rotation invariance: start at the lexicographically smallest vertex;
    # direction invariance: pick the smaller of the two traversals.
    start = min(range(len(coords)), key=lambda i: coords[i])
    forward = tuple(coords[start:] + coords[:start])
    backward_list = list(reversed(coords))
    bstart = min(range(len(backward_list)), key=lambda i: backward_list[i])
    backward = tuple(backward_list[bstart:] + backward_list[:bstart])
    return min(forward, backward)


def canonical_geometry(geom: dict) -> tuple:
    if geom["type"] == "Polygon":
        polys = [geom["coordinates"]]
    elif geom["type"] == "MultiPolygon":
        polys = geom["coordinates"]
    else:
        return ("nonpolygonal", geom["type"])
    return (
        "polys",
        tuple(sorted(tuple(sorted(canonical_ring(r) for r in poly)) for poly in polys)),
    )


def read_geometries(path: Path, layer: str | None = None) -> tuple[list[dict], list[str], str | None, int]:
    """Read (geometries-as-geojson, field names, crs, feature count)."""
    import pyogrio.raw

    meta, _index, geometry_wkb, field_data = pyogrio.raw.read(
        str(path), layer=layer, return_fids=False
    )
    fields = list(meta["fields"])
    crs = meta.get("crs")
    from struct import unpack_from

    def wkb_to_geojson(buf: bytes) -> dict:
        # Narrow WKB reader: Polygon (3) / MultiPolygon (6), little-endian —
        # exactly what the narrow product writer emits and what GPKG vector
        # fixtures contain (GPKG geometry blobs carry a GP header first).
        offset = 0
        if buf[:2] == b"GP":  # GeoPackage geometry blob header
            flags = buf[3]
            envelope_sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
            envelope = envelope_sizes.get((flags >> 1) & 0x07)
            if envelope is None:
                raise ValueError("unsupported GPKG envelope contents indicator")
            offset = 8 + envelope
        little = buf[offset] == 1
        endian = "<" if little else ">"
        (geom_type,) = unpack_from(f"{endian}I", buf, offset + 1)
        offset += 5

        def read_ring(off: int) -> tuple[list[list[float]], int]:
            (n,) = unpack_from(f"{endian}I", buf, off)
            off += 4
            ring = []
            for _ in range(n):
                x, y = unpack_from(f"{endian}dd", buf, off)
                off += 16
                ring.append([x, y])
            return ring, off

        def read_polygon(off: int) -> tuple[list[list[list[float]]], int]:
            (nrings,) = unpack_from(f"{endian}I", buf, off)
            off += 4
            rings = []
            for _ in range(nrings):
                ring, off = read_ring(off)
                rings.append(ring)
            return rings, off

        if geom_type == 3:
            rings, _ = read_polygon(offset)
            return {"type": "Polygon", "coordinates": rings}
        if geom_type == 6:
            (npolys,) = unpack_from(f"{endian}I", buf, offset)
            offset += 4
            polys = []
            for _ in range(npolys):
                # Each sub-polygon repeats byte order + type.
                sub_little = buf[offset] == 1
                if sub_little != little:
                    raise ValueError("mixed endianness in MultiPolygon")
                offset += 5
                rings, offset = read_polygon(offset)
                polys.append(rings)
            return {"type": "MultiPolygon", "coordinates": polys}
        raise ValueError(f"unsupported WKB geometry type {geom_type}")

    geometries = [wkb_to_geojson(bytes(blob)) for blob in geometry_wkb]
    return geometries, fields, crs, len(geometry_wkb)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--product-shp", required=True, type=Path)
    parser.add_argument("--painted-json", required=True, type=Path)
    parser.add_argument("--sidecar", required=True, type=Path)
    parser.add_argument("--expect-features", required=True, type=int)
    parser.add_argument("--source", action="append", default=[], type=Path)
    args = parser.parse_args()

    # ---- 1. Product shapefile: whitelist, CRS, count, finiteness ----------
    import pyogrio.raw

    meta, _index, product_wkb, field_data = pyogrio.raw.read(
        str(args.product_shp), return_fids=False
    )
    fields = list(meta["fields"])
    if fields != PRODUCT_FIELDS:
        fail(f"fields {fields} != product whitelist {PRODUCT_FIELDS} (exact, ordered)")
    crs = meta.get("crs") or ""
    if "4326" not in str(crs):
        fail(f"product CRS {crs!r} is not EPSG:4326")
    if len(product_wkb) != args.expect_features:
        fail(f"feature count {len(product_wkb)} != expected {args.expect_features}")
    for column, name in zip(field_data, fields):
        for value in column:
            if value is None or (
                isinstance(value, float) and not math.isfinite(value)
            ):
                fail(f"non-finite/None value in product field '{name}': {value!r}")

    product_geoms, _, _, _ = read_geometries(args.product_shp)
    product_canon = sorted(canonical_geometry(g) for g in product_geoms)

    # ---- 2. Output == painted (as the page reported it) -------------------
    painted = json.loads(args.painted_json.read_text(encoding="utf-8"))
    painted_canon = sorted(canonical_geometry(f["geometry"]) for f in painted)
    if product_canon != painted_canon:
        fail("product geometry does not equal the painted geometry (canonical compare)")

    # ---- 3. Zero source disclosure ----------------------------------------
    product_set = set(product_canon)
    for source in args.source:
        for layer_name, geometry_type in pyogrio.list_layers(str(source)):
            # Aspatial tables (e.g. geobase_audit) carry no geometry — nothing
            # to disclose, and reading geometry from them yields None.
            if geometry_type is None:
                continue
            try:
                source_geoms, _, _, count = read_geometries(source, layer=layer_name)
            except ValueError as err:
                fail(f"source {source.name}:{layer_name} unreadable by oracle: {err}")
                continue
            if count == 0:
                continue
            for geom in source_geoms:
                if canonical_geometry(geom) in product_set:
                    fail(
                        f"OUTPUT GEOMETRY EQUALS SOURCE GEOMETRY — source "
                        f"disclosure via {source.name}:{layer_name}"
                    )

    # ---- 4. Sidecar schema + no paths --------------------------------------
    sidecar_text = args.sidecar.read_text(encoding="utf-8")
    sidecar = json.loads(sidecar_text)
    keys = set(sidecar.keys())
    if keys != SIDECAR_KEYS:
        fail(f"sidecar keys {sorted(keys)} != expected {sorted(SIDECAR_KEYS)}")
    if ABSOLUTE_PATH_PATTERN.search(sidecar_text):
        fail("sidecar contains an absolute filesystem path")
    if sidecar.get("tier") != "T2":
        fail(f"sidecar tier {sidecar.get('tier')!r} != 'T2'")
    for entry in sidecar.get("source_packs", []):
        extra = set(entry.keys()) - SOURCE_PACK_KEYS
        if extra:
            fail(f"sidecar source_packs entry leaks keys beyond id/tier/sha256: {sorted(extra)}")

    if FAILURES:
        print(f"ORACLE-FAIL: {len(FAILURES)} assertion(s) failed", file=sys.stderr)
        return 1
    print(
        f"ORACLE-OK: product-only whitelist, painted-equality, zero source "
        f"disclosure, sidecar schema — all hold ({len(product_wkb)} feature(s))"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
