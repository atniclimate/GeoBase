"""Per-source fetch logic for `tools/acquire` (F4).

Each fetcher composes the domain-pinned transport + the shared safety module to
turn an AOI into a set of downloaded files in a STAGING directory that
`geopack package` then ingests. Fetchers never write a GeoPackage and never
reimplement packaging — the staging dir is the seam.

Every fetcher:
  1. validates the AOI (safety rule 4, front half),
  2. queries the source index (transport, domain-pinned),
  3. applies the advertised-size + per-job + headroom checks (rules 1-3),
  4. downloads, discards raw archives (rule 5),
  5. writes a `provenance.json` recording the source, endpoints hit, AOI, and
     the Tier-0 attribution — so provenance travels with the staged data into
     the ingest step.

The result is a `StagedFetch` the CLI prints and the acquire-gate asserts on.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field

from .client import Transport
from .safety import (
    Bbox,
    SafetyError,
    SafetyLimits,
    check_advertised_size,
    check_aoi,
    check_disk_headroom,
    check_job_total,
    is_archive,
    safe_basename_or_none,
)
from .sources import Source, get_source


@dataclass
class StagedItem:
    name: str
    url: str
    #: The actual local filename written (review H2: record the real name, not
    #: just the index title).
    filename: str
    advertised_bytes: int
    written_bytes: int


@dataclass
class StagedFetch:
    source_key: str
    bbox: list[float]
    staging_dir: str
    items: list[StagedItem] = field(default_factory=list)
    skipped_archives: list[str] = field(default_factory=list)


def _index_products(source: Source, bbox: Bbox, transport: Transport, datasets: list[str]):
    """Query TNMAccess-style product index. Returns a list of
    {title, downloadURL, sizeInBytes} dicts (already filtered to the AOI by the
    API's own bbox param)."""
    params = {
        "bbox": bbox.as_tnm_string(),
        "datasets": ",".join(datasets),
        "outputFormat": "JSON",
    }
    payload = transport.get_json(source.endpoints["products"], params)
    if not isinstance(payload, dict) or "items" not in payload:
        raise SafetyError(
            f"{source.key}: index response missing 'items' — endpoint drift? "
            f"(endpoints are config; this fails loudly, it does not scrape)"
        )
    return payload["items"]


def fetch_index_source(
    source_key: str,
    bbox: Bbox,
    staging_dir: str,
    transport: Transport,
    *,
    limits: SafetyLimits | None = None,
    datasets: list[str] | None = None,
    download: bool = True,
) -> StagedFetch:
    """Fetch a TNMAccess-indexed source (3DEP DEM, 3DEP LiDAR, NHDPlus/WBD).

    `download=False` performs the full index + safety pass without writing
    files — the dry-run the acquire-gate uses to prove the pipeline without a
    large fetch."""
    source = get_source(source_key)
    limits = limits or SafetyLimits()
    check_aoi(bbox, limits)
    os.makedirs(staging_dir, exist_ok=True)

    wanted = datasets or list(source.datasets[:1])  # first dataset by default
    items = _index_products(source, bbox, transport, wanted)

    # Safety pass over the WHOLE candidate set before any download.
    planned: list[tuple[str, str, int]] = []
    total = 0
    for item in items:
        title = str(item.get("title") or item.get("sourceName") or "unnamed")
        url = item.get("downloadURL") or item.get("urls", {}).get("TIFF")
        if not url:
            raise SafetyError(f"{source_key}: index item '{title}' has no downloadURL")
        size = check_advertised_size(title, item.get("sizeInBytes"), limits)
        planned.append((title, url, size))
        total += size
    check_job_total(total, limits)
    if download:
        check_disk_headroom(staging_dir, total, limits)

    result = StagedFetch(source_key=source_key, bbox=_bbox_list(bbox), staging_dir=staging_dir)
    # Per-file HARD ceiling handed to the transport = the advertised size, but
    # never above the per-file limit (a lying stream is capped either way).
    used_names: set[str] = set()
    for title, url, size in planned:
        if is_archive(url):
            # Rule 5: we do not stage raw archives. A source that only offers
            # archives needs an extraction step added deliberately, not a
            # silent zip dropped into the ingest dir.
            result.skipped_archives.append(url)
            continue
        filename = _unique_safe_name(url, title, used_names)
        dest = os.path.join(staging_dir, filename)
        hard_max = min(max(size, 1), limits.max_file_bytes)
        written = transport.download(url, dest, size, hard_max) if download else 0
        result.items.append(
            StagedItem(name=title, url=url, filename=filename, advertised_bytes=size, written_bytes=written)
        )

    _write_provenance(source, bbox, result, contacted_endpoint=source.endpoints["products"])
    return result


def _unique_safe_name(url: str, title: str, used: set[str]) -> str:
    """A safe, unique staging filename derived from the URL (review H1/B4). A
    server-controlled name that is unsafe (traversal, reserved, provenance.json)
    is replaced by a synthesized one; collisions get a numeric suffix so one
    download never clobbers another or the provenance record."""
    base = safe_basename_or_none(url) or f"acquire-{abs(hash(title)) % 10_000_000}.dat"
    if base == "provenance.json":  # never let a payload overwrite the record
        base = f"payload-{base}"
    candidate = base
    counter = 1
    while candidate in used:
        stem, dot, ext = base.partition(".")
        candidate = f"{stem}-{counter}{dot}{ext}"
        counter += 1
    used.add(candidate)
    return candidate


def _write_provenance(
    source: Source, bbox: Bbox, result: StagedFetch, *, contacted_endpoint: str
) -> None:
    """Write the operator-facing provenance record (Tier-0 directive:
    attribution + provenance recorded). This is a SIDECAR for the operator —
    the authoritative in-artifact classification is set by the ingestor at
    ingest time (source hashes, TSDF tier/version, basis in gpkg_metadata);
    this file does not travel into the artifact, it documents the fetch."""
    provenance = {
        "source_key": source.key,
        "source_name": source.name,
        "source_default_tier": source.default_tier,
        "attribution": source.attribution,
        "license": source.license,
        "provenance": source.provenance,
        # Only the endpoint actually contacted (review H2) — not every
        # configured endpoint. Configured-but-unused endpoints are separate.
        "endpoint_contacted": contacted_endpoint,
        "configured_endpoints": source.endpoints,
        "aoi_bbox_wgs84": _bbox_list(bbox),
        "aoi_semantics": (
            "index query intersecting the AOI; returned staged tiles are NOT "
            "clipped to the AOI by this tool — clipping/subsetting happens at "
            "ingest/use, not here"
        ),
        "staged_items": [asdict(item) for item in result.items],
        "skipped_archives": result.skipped_archives,
        "note": (
            "Fetched by tools/acquire (out-of-product). This provenance.json is "
            "an operator-facing sidecar; it does NOT enter the GeoPackage. "
            "GeoBase assigns the node's TSDF tier at INGEST (unclassified "
            "defaults to T3, AGENTS.md §2); source_default_tier is the source "
            "posture, not the node classification."
        ),
    }
    with open(os.path.join(result.staging_dir, "provenance.json"), "w", encoding="utf-8") as out:
        json.dump(provenance, out, indent=2)


def _bbox_list(bbox: Bbox) -> list[float]:
    return [bbox.west, bbox.south, bbox.east, bbox.north]
