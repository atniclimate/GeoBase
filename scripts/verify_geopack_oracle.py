#!/usr/bin/env python
"""Cross-implementation oracle for GeoPack artifacts (Phase 0.3).

Per docs/DECISIONS.md (2026-07-06): the product writes GeoPackages in pure
Rust; this script re-reads the artifact through the independent Python/GDAL
stack (rasterio + pyogrio + sqlite3) and asserts spec conformance and
value-for-value fidelity against the original sources. GDAL conformance is
proven continuously in CI without GDAL entering the product.

The oracle FAILS LOUDLY: any mismatch exits nonzero with a message naming the
failed assertion. It never repairs, warns-and-continues, or falls back.

Usage:
    python scripts/verify_geopack_oracle.py --geopack OUT.gpkg --dem SRC.tif --shp SRC.shp \\
        --raster-table dem --vector-table parcels [--expect-tier T0]
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
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
    from rasterio.errors import RasterioIOError
    from pyogrio import read_info
    from pyogrio.errors import DataLayerError, DataSourceError
    from pyogrio.raw import read as ogr_read
except ImportError as exc:  # pragma: no cover
    sys.exit(
        f"preflight failed — geo stack is not functional: {exc}\n"
        "Repair with: python -m pip install --ignore-installed --no-deps pyogrio shapely pandas"
    )

TSDF_URI = "https://github.com/atniclimate/TieredSovereignDataFramework"
EXPECT_TSDF_VERSION = "0.9.4"
EXPECT_NODATA = -9999.0
TRANSFORM_TOL = 1e-6
REQUIRED_FIELDS = ("name", "zone", "area_m2")
COVERAGE_EXT = "gpkg_2d_gridded_coverage"
COVERAGE_ANCILLARY = "gpkg_2d_gridded_coverage_ancillary"
TILE_ANCILLARY = "gpkg_2d_gridded_tile_ancillary"
AUDIT_TRIGGERS = ("geobase_audit_no_update", "geobase_audit_no_delete")
MIN_AUDIT_ROWS = 3
# Mirrors the Rust writers: identifiers are validated before SQL interpolation.
TABLE_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class OracleFailure(Exception):
    """One named assertion failed; main() turns this into a nonzero exit."""


def check(cond: bool, msg: str) -> None:
    if not cond:
        raise OracleFailure(msg)


def group_ok(name: str, detail: str) -> None:
    print(f"[oracle] {name}: {detail}")


def _null_mask(arr: np.ndarray) -> np.ndarray:
    """Nulls as pyogrio may express them: masked array, or NaN after promotion
    of an int column with NULLs to float64."""
    if np.ma.isMaskedArray(arr):
        return np.ma.getmaskarray(arr)
    if arr.dtype.kind == "f":
        return np.isnan(arr)
    return np.zeros(arr.shape, dtype=bool)


def _crs_of(text: object, what: str) -> CRS:
    check(bool(text), f"{what}: CRS is missing — refusing to assume (CRS-pipeline discipline)")
    try:
        return CRS.from_user_input(text)
    except Exception as exc:  # pragma: no cover - depends on PROJ error type
        raise OracleFailure(f"{what}: CRS unparseable ({text!r}): {exc}") from exc


# ---------------------------------------------------------------------------
# (a) raster: GPKG gridded coverage vs source GeoTIFF, value for value
# ---------------------------------------------------------------------------
def check_raster(geopack: Path, dem: Path, raster_table: str) -> int:
    gpkg_name = f"GPKG:{geopack}:{raster_table}"
    try:
        src = rasterio.open(dem)
    except RasterioIOError as exc:
        raise OracleFailure(f"cannot open source DEM {dem}: {exc}") from exc
    with src:
        try:
            chk = rasterio.open(gpkg_name)
        except RasterioIOError as exc:
            raise OracleFailure(
                f"cannot open geopack raster {gpkg_name} — not a GeoPackage, or the "
                f"coverage table is missing/broken: {exc}"
            ) from exc
        with chk:
            check(chk.crs == src.crs, f"raster CRS mismatch: source={src.crs} geopack={chk.crs}")
            check(
                (chk.width, chk.height) == (src.width, src.height),
                f"raster dims mismatch: source={src.width}x{src.height} "
                f"geopack={chk.width}x{chk.height}",
            )
            check(
                chk.dtypes[0] == src.dtypes[0],
                f"raster dtype mismatch: source={src.dtypes[0]} geopack={chk.dtypes[0]}",
            )
            s, g = src.transform, chk.transform
            for coeff, sv, gv in zip("abcdef", s[:6], g[:6]):
                check(
                    abs(sv - gv) <= TRANSFORM_TOL,
                    f"raster transform.{coeff} mismatch: source={sv!r} geopack={gv!r} "
                    f"(tol {TRANSFORM_TOL})",
                )
            check(
                chk.nodata is not None and float(chk.nodata) == EXPECT_NODATA,
                f"geopack nodata is {chk.nodata!r}, expected {EXPECT_NODATA}",
            )
            check(
                src.nodata is not None and float(src.nodata) == EXPECT_NODATA,
                f"source nodata is {src.nodata!r}, expected {EXPECT_NODATA} (fixture contract)",
            )
            group_ok(
                "raster-metadata",
                f"crs={chk.crs} {chk.width}x{chk.height} {chk.dtypes[0]} "
                f"nodata={chk.nodata} transform within {TRANSFORM_TOL}",
            )

            src_arr = src.read(1)
            gp_arr = chk.read(1)
            valid = src_arr != np.float32(src.nodata)
            n_bad_valid = int(np.count_nonzero(src_arr[valid] != gp_arr[valid]))
            check(
                n_bad_valid == 0 and bool(np.array_equal(src_arr[valid], gp_arr[valid])),
                f"raster VALUES differ on {n_bad_valid} valid cells "
                f"(value-for-value equality is the invariant — AGENTS.md §5)",
            )
            n_bad_nodata = int(np.count_nonzero(gp_arr[~valid] != np.float32(chk.nodata)))
            check(
                n_bad_nodata == 0,
                f"{n_bad_nodata} source-nodata cells are not nodata in the geopack",
            )
            group_ok(
                "raster-values",
                f"{int(valid.sum())} valid px exact, {int((~valid).sum())} nodata px preserved",
            )
    return 2


# ---------------------------------------------------------------------------
# (b) vector: GPKG feature layer vs source shapefile
# ---------------------------------------------------------------------------
def check_vector(geopack: Path, shp: Path, vector_table: str) -> int:
    try:
        src_info = read_info(str(shp))
    except (DataSourceError, DataLayerError) as exc:
        raise OracleFailure(f"cannot read source shapefile {shp}: {exc}") from exc
    try:
        gp_info = read_info(str(geopack), layer=vector_table)
    except (DataSourceError, DataLayerError) as exc:
        raise OracleFailure(
            f"cannot read geopack layer {vector_table!r} from {geopack}: {exc}"
        ) from exc

    src_crs = _crs_of(src_info["crs"], f"source {shp.name}")
    gp_crs = _crs_of(gp_info["crs"], f"geopack layer {vector_table!r}")
    check(
        gp_crs == src_crs,
        f"vector CRS not semantically equal: source={src_info['crs']!r} "
        f"geopack={gp_info['crs']!r}",
    )
    check(
        gp_info["features"] == src_info["features"],
        f"feature count mismatch: source={src_info['features']} geopack={gp_info['features']}",
    )
    group_ok(
        "vector-metadata",
        f"crs semantically equal ({gp_info['crs']}), {gp_info['features']} features",
    )

    def fields_of(path: str, what: str, **kwargs) -> dict[str, np.ndarray]:
        try:
            meta, _, _, field_data = ogr_read(path, **kwargs)
        except (DataSourceError, DataLayerError) as exc:
            raise OracleFailure(f"cannot read attributes from {what}: {exc}") from exc
        table = dict(zip(list(meta["fields"]), field_data))
        for field in REQUIRED_FIELDS:
            check(field in table, f"{what}: field {field!r} missing (has {sorted(table)})")
        return table

    src_f = fields_of(str(shp), f"source {shp.name}")
    gp_f = fields_of(str(geopack), f"geopack layer {vector_table!r}", layer=vector_table)

    src_names = [str(v) for v in src_f["name"]]
    gp_names = [str(v) for v in gp_f["name"]]
    check(
        len(set(src_names)) == len(src_names),
        f"source names are not unique ({src_names}) — cannot match order-insensitively",
    )
    check(
        sorted(gp_names) == sorted(src_names),
        f"name sets differ: source={sorted(src_names)} geopack={sorted(gp_names)}",
    )
    gp_index = {name: i for i, name in enumerate(gp_names)}

    src_null = _null_mask(src_f["zone"])
    gp_null = _null_mask(gp_f["zone"])
    src_null_names = {src_names[i] for i in range(len(src_names)) if src_null[i]}
    gp_null_names = {gp_names[i] for i in range(len(gp_names)) if gp_null[i]}
    check(bool(src_null_names), "fixture contract: source has a NULL zone, but none was read")
    check(
        gp_null_names == src_null_names,
        f"zone NULLs did not survive: source NULL at {sorted(src_null_names)}, "
        f"geopack NULL at {sorted(gp_null_names)}",
    )
    for i, name in enumerate(src_names):
        j = gp_index[name]
        if not src_null[i]:
            zs, zg = int(src_f["zone"][i]), int(gp_f["zone"][j])
            check(zs == zg, f"zone mismatch for {name!r}: source={zs} geopack={zg}")
        a_s, a_g = float(src_f["area_m2"][i]), float(gp_f["area_m2"][j])
        check(
            a_s == a_g,
            f"area_m2 mismatch for {name!r}: source={a_s!r} geopack={a_g!r} "
            f"(value-for-value equality is the invariant — AGENTS.md §5)",
        )
    group_ok(
        "vector-attributes",
        f"{len(src_names)} features matched on name; zone NULL preserved "
        f"({sorted(src_null_names)}); zone/area_m2 exact",
    )
    return 2


# ---------------------------------------------------------------------------
# (c) sqlite: GPKG registry tables, gridded-coverage extension, TSDF tags, audit
# ---------------------------------------------------------------------------
def check_sqlite(geopack: Path, raster_table: str, vector_table: str, expect_tier: str) -> int:
    for name in (raster_table, vector_table):
        check(bool(TABLE_NAME_RE.match(name)), f"table name {name!r} is not a valid identifier")
    try:
        con = sqlite3.connect(f"file:{geopack.resolve().as_posix()}?mode=ro", uri=True)
    except sqlite3.Error as exc:
        raise OracleFailure(f"cannot open {geopack} as sqlite (read-only): {exc}") from exc
    try:
        def q(sql: str, params: tuple = ()) -> list[tuple]:
            try:
                return con.execute(sql, params).fetchall()
            except sqlite3.Error as exc:
                raise OracleFailure(f"sqlite assertion query failed: {exc} [sql: {sql}]") from exc

        # -- gpkg_contents ---------------------------------------------------
        cov = q("SELECT table_name FROM gpkg_contents WHERE data_type='2d-gridded-coverage'")
        check(
            len(cov) == 1 and cov[0][0] == raster_table,
            f"gpkg_contents: expected exactly one 2d-gridded-coverage row for "
            f"{raster_table!r}, found {cov}",
        )
        feat = q("SELECT table_name FROM gpkg_contents WHERE data_type='features'")
        check(
            len(feat) == 1 and feat[0][0] == vector_table,
            f"gpkg_contents: expected exactly one features row for {vector_table!r}, "
            f"found {feat}",
        )
        group_ok("contents-registry", f"one 2d-gridded-coverage ({raster_table}) + one features "
                                      f"({vector_table})")

        # -- gpkg_extensions ---------------------------------------------------
        ext = q(
            "SELECT table_name, column_name FROM gpkg_extensions WHERE extension_name=?",
            (COVERAGE_EXT,),
        )
        check(len(ext) == 3, f"expected 3 {COVERAGE_EXT} extension rows, found {len(ext)}: {ext}")
        by_table = {t: c for t, c in ext}
        want = {COVERAGE_ANCILLARY, TILE_ANCILLARY, raster_table}
        check(
            set(by_table) == want,
            f"{COVERAGE_EXT} rows cover {sorted(by_table)}, expected {sorted(want)}",
        )
        check(
            by_table[raster_table] == "tile_data",
            f"({raster_table!r}) extension row column is {by_table[raster_table]!r}, "
            f"expected 'tile_data'",
        )
        for anc in (COVERAGE_ANCILLARY, TILE_ANCILLARY):
            check(by_table[anc] is None, f"({anc}) extension row column should be NULL, "
                                         f"got {by_table[anc]!r}")
        n_meta_ext = q(
            "SELECT COUNT(*) FROM gpkg_extensions WHERE extension_name='gpkg_metadata'"
        )[0][0]
        check(n_meta_ext == 2, f"expected 2 gpkg_metadata extension rows, found {n_meta_ext}")
        group_ok("extensions-registry", "3 gridded-coverage rows + 2 metadata rows")

        # -- gpkg_2d_gridded_coverage_ancillary --------------------------------
        rows = q(
            f"SELECT tile_matrix_set_name, datatype, scale, offset, data_null "
            f"FROM {COVERAGE_ANCILLARY}"
        )
        check(len(rows) == 1, f"expected 1 {COVERAGE_ANCILLARY} row, found {len(rows)}")
        tms, datatype, scale, offset, data_null = rows[0]
        check(tms == raster_table, f"coverage ancillary names {tms!r}, expected {raster_table!r}")
        check(datatype == "float", f"coverage ancillary datatype {datatype!r}, expected 'float'")
        check(scale is not None and float(scale) == 1.0, f"scale is {scale!r}, must be exactly 1.0")
        check(offset is not None and float(offset) == 0.0, f"offset is {offset!r}, must be "
                                                           f"exactly 0.0")
        check(
            data_null is not None and float(data_null) == EXPECT_NODATA,
            f"data_null is {data_null!r}, expected {EXPECT_NODATA}",
        )
        group_ok("coverage-ancillary", "datatype=float scale=1.0 offset=0.0 "
                                       f"data_null={EXPECT_NODATA}")

        # -- gpkg_2d_gridded_tile_ancillary ------------------------------------
        n_tiles = q(f'SELECT COUNT(*) FROM "{raster_table}"')[0][0]
        check(n_tiles >= 1, f"raster table {raster_table!r} contains no tiles")
        n_anc = q(f"SELECT COUNT(*) FROM {TILE_ANCILLARY}")[0][0]
        check(
            n_anc == n_tiles,
            f"{TILE_ANCILLARY} has {n_anc} rows for {n_tiles} tiles (must be one per tile)",
        )
        bad_name = q(f"SELECT COUNT(*) FROM {TILE_ANCILLARY} WHERE tpudt_name != ?",
                     (raster_table,))[0][0]
        check(bad_name == 0, f"{bad_name} tile ancillary rows name a tpudt_name other than "
                             f"{raster_table!r}")
        orphans = q(
            f'SELECT COUNT(*) FROM {TILE_ANCILLARY} a LEFT JOIN "{raster_table}" t '
            f"ON a.tpudt_id = t.id WHERE t.id IS NULL"
        )[0][0]
        check(orphans == 0, f"{orphans} tile ancillary rows have tpudt_id not joining any tile id")
        group_ok("tile-ancillary", f"{n_tiles} tiles, {n_anc} ancillary rows, every tpudt_id joins")

        # -- TSDF tags ---------------------------------------------------------
        tags = q(
            "SELECT r.reference_scope, r.table_name, m.metadata FROM gpkg_metadata m "
            "JOIN gpkg_metadata_reference r ON r.md_file_id = m.id "
            "WHERE m.md_standard_uri = ?",
            (TSDF_URI,),
        )
        check(len(tags) == 3, f"expected exactly 3 TSDF tags, found {len(tags)}")
        scopes = sorted(row[0] for row in tags)
        check(
            scopes == ["geopackage", "table", "table"],
            f"TSDF tag scopes are {scopes}, expected two table-scope + one geopackage-scope",
        )
        table_scope_names = {row[1] for row in tags if row[0] == "table"}
        check(
            table_scope_names == {raster_table, vector_table},
            f"table-scope TSDF tags cover {sorted(table_scope_names)}, expected "
            f"{sorted({raster_table, vector_table})}",
        )
        for scope, tname, metadata in tags:
            where = f"{scope}:{tname or '*'}"
            try:
                payload = json.loads(metadata)
            except ValueError as exc:
                raise OracleFailure(f"TSDF tag {where} payload is not valid JSON: {exc}") from exc
            check(
                payload.get("tier") == expect_tier,
                f"TSDF tag {where} tier is {payload.get('tier')!r}, expected {expect_tier!r}",
            )
            check(
                payload.get("tsdf_version") == EXPECT_TSDF_VERSION,
                f"TSDF tag {where} tsdf_version is {payload.get('tsdf_version')!r}, "
                f"expected {EXPECT_TSDF_VERSION!r}",
            )
        group_ok("tsdf-tags", f"3 tags (2 table + 1 geopackage), tier={expect_tier}, "
                              f"tsdf_version={EXPECT_TSDF_VERSION}")

        # -- audit trail ---------------------------------------------------------
        has_audit = q(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='geobase_audit'"
        )
        check(bool(has_audit), "geobase_audit table is missing")
        n_audit = q("SELECT COUNT(*) FROM geobase_audit")[0][0]
        check(
            n_audit >= MIN_AUDIT_ROWS,
            f"geobase_audit has {n_audit} rows, expected >= {MIN_AUDIT_ROWS}",
        )
        triggers = {
            r[0]
            for r in q(
                "SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (?, ?)",
                AUDIT_TRIGGERS,
            )
        }
        check(
            triggers == set(AUDIT_TRIGGERS),
            f"append-only audit triggers missing: found {sorted(triggers)}, "
            f"expected {sorted(AUDIT_TRIGGERS)}",
        )
        group_ok("audit-trail", f"{n_audit} rows, both append-only triggers present")
    finally:
        con.close()
    return 6


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--geopack", required=True, type=Path, help="GeoPack .gpkg to verify")
    parser.add_argument("--dem", required=True, type=Path, help="source GeoTIFF the raster came from")
    parser.add_argument("--shp", required=True, type=Path, help="source shapefile the vector came from")
    parser.add_argument("--raster-table", required=True, help="gridded-coverage table name")
    parser.add_argument("--vector-table", required=True, help="feature table (layer) name")
    parser.add_argument(
        "--expect-tier",
        default="T0",
        choices=("T0", "T1", "T2", "T3"),
        help="TSDF tier every tag must carry (default: T0)",
    )
    args = parser.parse_args()

    try:
        for label, path in (("geopack", args.geopack), ("dem", args.dem), ("shp", args.shp)):
            check(path.is_file(), f"--{label} input not found: {path}")
        n = check_raster(args.geopack, args.dem, args.raster_table)
        n += check_vector(args.geopack, args.shp, args.vector_table)
        n += check_sqlite(args.geopack, args.raster_table, args.vector_table, args.expect_tier)
    except OracleFailure as exc:
        print(f"[oracle] FAIL: {exc}", file=sys.stderr)
        return 1
    print(f"[oracle] PASS: {n} assertion groups")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
