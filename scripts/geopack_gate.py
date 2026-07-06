#!/usr/bin/env python
"""Phase 0.3 acceptance gate — the observed round-trip, positive AND negative.

Positive: fixtures -> `geopack ingest --tier T0` -> cross-implementation
oracle (GDAL/rasterio reads what Rust wrote, value-for-value) -> the engine
tile path consumes the pack and emits tiles.

Negative: the same fixtures ingested UNCLASSIFIED default to T3 (TSDF
posture), the oracle confirms the T3 tags, and the public tile emitter
REFUSES the pack. Enforcement is observed, not asserted (AGENTS.md §8).

Usage:
    python scripts/geopack_gate.py            # full gate
    python scripts/geopack_gate.py --keep     # keep the temp workdir for inspection
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
FIXTURES = REPO / "data" / "fixtures" / "geopack"
DEM = FIXTURES / "dem_small.tif"
SHP = FIXTURES / "parcels_small.shp"


def run(label: str, cmd: list[str], expect_failure: bool = False) -> subprocess.CompletedProcess:
    print(f"[gate] {label}: {' '.join(str(c) for c in cmd)}")
    proc = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True)
    sys.stdout.write(proc.stdout)
    if proc.returncode == 0 and expect_failure:
        sys.stderr.write(proc.stderr)
        sys.exit(f"[gate] FAIL: '{label}' succeeded but MUST be refused")
    if proc.returncode != 0 and not expect_failure:
        sys.stderr.write(proc.stderr)
        sys.exit(f"[gate] FAIL: '{label}' exited {proc.returncode}")
    if expect_failure:
        combined = proc.stdout + proc.stderr
        assert "refusing" in combined.lower(), (
            f"[gate] '{label}' failed, but not with the tier refusal "
            f"(exit {proc.returncode}) — wrong failure mode is not enforcement"
        )
        print(f"[gate] {label}: refused as required (exit {proc.returncode})")
    return proc


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", action="store_true", help="keep temp workdir")
    args = parser.parse_args()

    workdir = Path(tempfile.mkdtemp(prefix="geopack-gate-"))
    print(f"[gate] workdir {workdir}")
    try:
        # 0) Fixtures: regenerate deterministically so gate inputs are
        #    self-consistent with this checkout's generator.
        run("fixtures", [sys.executable, "scripts/make_geopack_fixtures.py"])
        for f in (DEM, SHP):
            assert f.is_file(), f"[gate] fixture missing after generation: {f}"

        # 1) Build the ingestor CLI once (debug).
        run("build", ["cargo", "build", "--locked", "-p", "geobase-ingestor", "--bin", "geopack"])
        geopack_bin = REPO / "target" / "debug" / ("geopack.exe" if sys.platform == "win32" else "geopack")

        # 2) Positive path: explicit T0 (synthetic fixture, public by construction).
        t0 = workdir / "fixture_t0.gpkg"
        run(
            "ingest T0",
            [
                str(geopack_bin), "ingest",
                "--tif", str(DEM), "--shp", str(SHP), "--out", str(t0),
                "--tier", "T0", "--actor", "geopack-gate",
                "--dataset-id", "geopack-gate-fixture",
                "--basis", "synthetic fixture, public by construction",
            ],
        )
        run(
            "oracle T0",
            [
                sys.executable, "scripts/verify_geopack_oracle.py",
                "--geopack", str(t0), "--dem", str(DEM), "--shp", str(SHP),
                "--raster-table", "dem_small", "--vector-table", "parcels_small",
                "--expect-tier", "T0",
            ],
        )
        tiles = workdir / "tiles"
        run(
            "engine tile path (T0 accepted)",
            [
                sys.executable, "scripts/generate_terrain_tiles.py",
                "--baseline", str(t0), "--out", str(tiles),
                "--minzoom", "10", "--maxzoom", "11", "--no-rust-fixture",
            ],
        )
        emitted = list(tiles.rglob("*.png"))
        assert emitted, "[gate] engine tile path emitted no tiles"
        print(f"[gate] engine consumed the GeoPack: {len(emitted)} tiles")

        # 3) Negative path: unclassified -> T3 by default -> emitter refuses.
        t3 = workdir / "fixture_default.gpkg"
        run(
            "ingest unclassified (defaults T3)",
            [
                str(geopack_bin), "ingest",
                "--tif", str(DEM), "--shp", str(SHP), "--out", str(t3),
                "--actor", "geopack-gate", "--dataset-id", "geopack-gate-unclassified",
            ],
        )
        run(
            "oracle T3",
            [
                sys.executable, "scripts/verify_geopack_oracle.py",
                "--geopack", str(t3), "--dem", str(DEM), "--shp", str(SHP),
                "--raster-table", "dem_small", "--vector-table", "parcels_small",
                "--expect-tier", "T3",
            ],
        )
        run(
            "engine tile path (T3 refused)",
            [
                sys.executable, "scripts/generate_terrain_tiles.py",
                "--baseline", str(t3), "--out", str(workdir / "tiles-refused"),
                "--minzoom", "10", "--maxzoom", "11", "--no-rust-fixture",
            ],
            expect_failure=True,
        )

        print("[gate] PASS: round-trip verified (T0 accepted, oracle green, T3 refused)")
        return 0
    finally:
        if args.keep:
            print(f"[gate] kept workdir {workdir}")
        else:
            shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
