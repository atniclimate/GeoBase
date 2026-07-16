#!/usr/bin/env python3
"""RStep 1.3d oracle — re-prove the export from OUTSIDE the product (Phase A, A4;
hardened per review B4/H3).

The product's own verifier (export.rs) reopens its output; this oracle is the
cross-implementation check in the 0.3 house pattern (pyogrio, CI-only — never a
product dependency). It asserts, independently of any Rust code:

  1. The shapefile carries EXACTLY the product whitelist [id, area_m2, score]
     in that order, EPSG:4326, the expected feature count, finite values.
  2. `id` is the exact 1..N positional sequence (export.rs writes index+1).
  3. `score` equals the painted score REPORTED BY THE PAGE (paint.features()),
     matched per feature by geometry.
  4. `area_m2` is within tolerance of an INDEPENDENT geodesic area
     (Chamberlain-Duquette, the same family export.rs uses) — a broken
     exporter writing an arbitrary finite area_m2 is caught.
  5. Output geometry == painted geometry (canonical, exterior/hole-aware).
  6. ZERO source disclosure: no output geometry equals any source geometry,
     AND no whitelisted product value equals any source attribute value.
  7. The .tsdf.json sidecar carries exactly the documented key schema, the
     expected product name, tier T2, no absolute paths, and every source_packs
     entry exposes exactly {id, tier, sha256} (missing keys rejected).

Exit 0 = all assertions hold. Exit 1 = the export is not what it claims.

usage: verify_rstep_oracle.py --product-shp P.shp --painted-json painted.json
           --sidecar P.tsdf.json --expect-features N --expect-product NAME
           --source S1.gpkg [S2.gpkg ...]
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path
from struct import unpack_from

import pyogrio
import pyogrio.raw

FAILURES: list[str] = []

PRODUCT_FIELDS = ["id", "area_m2", "score"]  # export.rs PRODUCT_FIELDS, verbatim
SIDECAR_KEYS = {
    "tier",
    "tsdf_version",
    "tsdf_source_origin",
    "basis",
    "process",
    "product",
    "publication_id",  # B3 recoverable-publication protocol
    "features",
    "source_packs",
    "files",
}
SOURCE_PACK_KEYS = {"id", "tier", "sha256"}
ABSOLUTE_PATH_PATTERN = re.compile(r"[A-Za-z]:[\\/]|/home/|/tmp/|/Users/|/var/")
EARTH_RADIUS_M = 6_371_008.8  # mean radius; area tolerance absorbs the model choice
AREA_TOLERANCE = 0.03  # 3% — cross-check, not bit-reproduction


def fail(why: str) -> None:
    FAILURES.append(why)
    print(f"ORACLE-FAIL: {why}", file=sys.stderr)


# Coordinate quantum for geometry comparison. Doubles drift ~1 ULP (~1e-14
# deg) across the JSON->serde->shapefile->pyogrio round-trip, so EXACT double
# equality is fragile (the same 1-ULP class flagged in export.rs). 9 decimals
# (~0.1 mm at the equator) absorbs that drift while staying far tighter than
# any real geometry difference — and it makes the zero-source-disclosure check
# STRICTER (a source polygon shifted <0.1 mm still collides and is caught).
COORD_DECIMALS = 9


def canonical_ring(ring) -> tuple:
    """Ring as a rotation- and direction-invariant canonical tuple, quantized
    to COORD_DECIMALS so 1-ULP serialize drift does not break equality."""
    coords = [(round(float(x), COORD_DECIMALS), round(float(y), COORD_DECIMALS)) for x, y in ring]
    if len(coords) > 1 and coords[0] == coords[-1]:
        coords = coords[:-1]
    if not coords:
        return ()
    start = min(range(len(coords)), key=lambda i: coords[i])
    forward = tuple(coords[start:] + coords[:start])
    backward_list = list(reversed(coords))
    bstart = min(range(len(backward_list)), key=lambda i: backward_list[i])
    backward = tuple(backward_list[bstart:] + backward_list[:bstart])
    return min(forward, backward)


def canonical_polygon(rings) -> tuple:
    # Exterior ring is distinct from holes (review H3): a shell<->hole swap
    # must NOT canonicalize equal. Exterior stays positional; holes are a
    # sorted set among themselves.
    if not rings:
        return ((), ())
    exterior = canonical_ring(rings[0])
    holes = tuple(sorted(canonical_ring(r) for r in rings[1:]))
    return (exterior, holes)


def canonical_geometry(geom: dict) -> tuple:
    # A Polygon and a single-member MultiPolygon are the SAME geometry, so both
    # normalize to a sorted multiset of canonical polygons. Within each polygon
    # the exterior/hole distinction is preserved (review H3): a shell<->hole
    # swap still canonicalizes differently; only the Polygon-vs-1-MultiPolygon
    # container distinction (which shapefiles erase on read) is unified.
    if geom["type"] == "Polygon":
        polys = [geom["coordinates"]]
    elif geom["type"] == "MultiPolygon":
        polys = geom["coordinates"]
    else:
        return ("nonpolygonal", geom["type"])
    return ("polys", tuple(sorted(canonical_polygon(p) for p in polys)))


def _wkb_to_geojson(buf: bytes) -> dict:
    """Narrow WKB reader: Polygon (3) / MultiPolygon (6), with a GPKG header
    if present. Validates child geometry types (review H3)."""
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
            sub_little = buf[offset] == 1
            (sub_type,) = unpack_from(f"{'<' if sub_little else '>'}I", buf, offset + 1)
            if sub_type != 3:
                raise ValueError(f"MultiPolygon child is WKB type {sub_type}, expected Polygon (3)")
            offset += 5
            rings, offset = read_polygon(offset)
            polys.append(rings)
        return {"type": "MultiPolygon", "coordinates": polys}
    raise ValueError(f"unsupported WKB geometry type {geom_type}")


def read_layer(path: Path, layer: str | None = None):
    """Return (geometries-as-geojson, field_names, field_data, crs, count)."""
    meta, _index, geometry_wkb, field_data = pyogrio.raw.read(
        str(path), layer=layer, return_fids=False
    )
    geometries = [_wkb_to_geojson(bytes(blob)) for blob in geometry_wkb]
    return geometries, list(meta["fields"]), field_data, meta.get("crs"), len(geometry_wkb)


def geodesic_area_m2(geom: dict) -> float:
    """Chamberlain-Duquette spherical polygon area (abs), summed over a
    MultiPolygon; holes subtract."""

    def ring_area(ring) -> float:
        total = 0.0
        pts = [(math.radians(x), math.radians(y)) for x, y in ring]
        for i in range(len(pts) - 1):
            lon1, lat1 = pts[i]
            lon2, lat2 = pts[i + 1]
            total += (lon2 - lon1) * (2 + math.sin(lat1) + math.sin(lat2))
        return abs(total * EARTH_RADIUS_M * EARTH_RADIUS_M / 2.0)

    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    area = 0.0
    for rings in polys:
        if not rings:
            continue
        area += ring_area(rings[0])
        for hole in rings[1:]:
            area -= ring_area(hole)
    return abs(area)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--product-shp", required=True, type=Path)
    parser.add_argument("--painted-json", required=True, type=Path)
    parser.add_argument("--sidecar", required=True, type=Path)
    parser.add_argument("--expect-features", required=True, type=int)
    parser.add_argument("--expect-product", required=True)
    parser.add_argument("--source", action="append", default=[], type=Path)
    args = parser.parse_args()

    # ---- 1-2. Product: whitelist, CRS, count, finiteness, id sequence ------
    product_geoms, fields, field_data, crs, count = read_layer(args.product_shp)
    if fields != PRODUCT_FIELDS:
        fail(f"fields {fields} != product whitelist {PRODUCT_FIELDS} (exact, ordered)")
        return 1  # nothing else is meaningful without the right columns
    crs_str = str(crs or "")
    if "4326" not in crs_str or not re.search(r"EPSG|WGS ?84|CRS84", crs_str, re.IGNORECASE):
        fail(f"product CRS {crs_str!r} is not recognizably EPSG:4326")
    if count != args.expect_features:
        fail(f"feature count {count} != expected {args.expect_features}")
    ids = list(field_data[0])
    areas = [float(v) for v in field_data[1]]
    scores = [float(v) for v in field_data[2]]
    for name, column in zip(fields, field_data):
        for value in column:
            if value is None or (isinstance(value, float) and not math.isfinite(value)):
                fail(f"non-finite/None value in product field '{name}': {value!r}")
    if sorted(int(i) for i in ids) != list(range(1, count + 1)):
        fail(f"product ids {sorted(ids)} are not the 1..{count} sequence export.rs writes")

    product_canon = [canonical_geometry(g) for g in product_geoms]

    # ---- 3-5. Painted equality: geometry, score, independent area ----------
    painted = json.loads(args.painted_json.read_text(encoding="utf-8"))
    painted_by_geom = {canonical_geometry(f["geometry"]): f for f in painted}
    if sorted(painted_by_geom.keys()) != sorted(product_canon):
        fail("product geometry set does not equal the painted geometry set (canonical)")
    for geom_canon, geom, area, score in zip(product_canon, product_geoms, areas, scores):
        match = painted_by_geom.get(geom_canon)
        if match is None:
            fail("a product feature has no painted counterpart")
            continue
        if not math.isclose(score, float(match["score"]), rel_tol=1e-9, abs_tol=1e-9):
            fail(f"product score {score} != painted score {match['score']}")
        independent = geodesic_area_m2(geom)
        if independent <= 0 or abs(area - independent) / independent > AREA_TOLERANCE:
            fail(
                f"product area_m2 {area:.2f} is not within {AREA_TOLERANCE:.0%} of the "
                f"independent geodesic area {independent:.2f}"
            )

    # ---- 6. Zero source disclosure: geometry AND attribute values ----------
    product_geom_set = set(product_canon)
    product_values = {round(v, 6) for v in areas + scores} | {int(i) for i in ids}
    for source in args.source:
        for layer_name, geometry_type in pyogrio.list_layers(str(source)):
            if geometry_type is None:  # aspatial (e.g. geobase_audit) — nothing to disclose
                continue
            try:
                s_geoms, _s_fields, s_field_data, _crs, s_count = read_layer(source, layer=layer_name)
            except ValueError as err:
                fail(f"source {source.name}:{layer_name} unreadable by oracle: {err}")
                continue
            for geom in s_geoms:
                if canonical_geometry(geom) in product_geom_set:
                    fail(f"OUTPUT GEOMETRY EQUALS SOURCE GEOMETRY via {source.name}:{layer_name}")
            for column in s_field_data:
                for value in column:
                    if isinstance(value, (int, float)) and not isinstance(value, bool):
                        if round(float(value), 6) in product_values or int(value) in product_values:
                            fail(
                                f"a product value equals a source attribute value from "
                                f"{source.name}:{layer_name} ({value!r}) — possible disclosure"
                            )

    # ---- 7. Sidecar schema + values + no paths -----------------------------
    sidecar_text = args.sidecar.read_text(encoding="utf-8")
    sidecar = json.loads(sidecar_text)
    keys = set(sidecar.keys())
    if keys != SIDECAR_KEYS:
        fail(f"sidecar keys {sorted(keys)} != expected {sorted(SIDECAR_KEYS)}")
    if ABSOLUTE_PATH_PATTERN.search(sidecar_text):
        fail("sidecar contains an absolute filesystem path")
    if sidecar.get("tier") != "T2":
        fail(f"sidecar tier {sidecar.get('tier')!r} != 'T2'")
    if sidecar.get("product") != args.expect_product:
        fail(f"sidecar product {sidecar.get('product')!r} != expected {args.expect_product!r}")
    if sidecar.get("features") != args.expect_features:
        fail(f"sidecar features {sidecar.get('features')!r} != expected {args.expect_features}")
    for entry in sidecar.get("source_packs", []):
        if set(entry.keys()) != SOURCE_PACK_KEYS:
            fail(f"sidecar source_packs entry keys {sorted(entry.keys())} != {sorted(SOURCE_PACK_KEYS)}")

    if FAILURES:
        print(f"ORACLE-FAIL: {len(FAILURES)} assertion(s) failed", file=sys.stderr)
        return 1
    print(
        f"ORACLE-OK: whitelist, id-sequence, painted score/area equality, zero source "
        f"disclosure (geometry + attributes), sidecar values — all hold ({count} feature(s))"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
