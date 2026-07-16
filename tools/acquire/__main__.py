"""CLI for `tools/acquire` (F4).

    python -m tools.acquire <source> --bbox W,S,E,N --out staging/ [--dry-run]
    python -m tools.acquire --list

`--dry-run` runs the full index + safety pass and writes provenance without
downloading files — what the acquire-gate uses to prove the pipeline offline
against recorded fixtures without a large fetch.
"""

from __future__ import annotations

import argparse
import json
import sys

from .client import TransportError, UrllibTransport
from .fetchers import fetch_index_source
from .safety import Bbox, SafetyError
from .sources import SOURCES, get_source

_INDEX_SOURCES = {"3dep-dem", "3dep-lidar", "nhd"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m tools.acquire")
    parser.add_argument("source", nargs="?", help="source key (see --list)")
    parser.add_argument("--bbox", help="AOI as W,S,E,N in WGS84")
    parser.add_argument("--out", help="staging directory")
    parser.add_argument("--datasets", help="comma-separated dataset names (source-specific)")
    parser.add_argument("--dry-run", action="store_true", help="index + safety only, no download")
    parser.add_argument("--list", action="store_true", help="list sources and exit")
    args = parser.parse_args(argv)

    if args.list or not args.source:
        for key, source in sorted(SOURCES.items()):
            print(f"{key:12s} {source.name} [{source.default_tier} source]")
            print(f"             {source.attribution}")
        return 0

    try:
        source = get_source(args.source)
        if args.source not in _INDEX_SOURCES:
            # LANDFIRE uses the async LFPS job API; its fetcher is a separate,
            # deliberately-not-yet-wired path (submit/poll/download). Fail
            # honestly rather than pretend.
            print(
                f"source '{args.source}' uses the async LFPS job API — its "
                f"fetcher (submit->poll->download) is scaffolded in sources.py "
                f"but not wired into the CLI yet. Index sources: "
                f"{sorted(_INDEX_SOURCES)}",
                file=sys.stderr,
            )
            return 2
        if not args.bbox or not args.out:
            parser.error("--bbox and --out are required")
        west, south, east, north = (float(v) for v in args.bbox.split(","))
        bbox = Bbox(west, south, east, north)
        datasets = args.datasets.split(",") if args.datasets else None
        transport = UrllibTransport(source.allowed_hosts)
        result = fetch_index_source(
            args.source, bbox, args.out, transport, datasets=datasets, download=not args.dry_run
        )
    except (SafetyError, TransportError, KeyError, ValueError) as err:
        print(f"acquire failed: {err}", file=sys.stderr)
        return 1

    print(json.dumps({
        "source": result.source_key,
        "staged": len(result.items),
        "skipped_archives": result.skipped_archives,
        "dry_run": args.dry_run,
        "staging_dir": result.staging_dir,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
