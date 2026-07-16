"""Shared safety module for `tools/acquire` (F4, adapted from mazzap_veil's
fetch discipline — see THIRD_PARTY_NOTICES.md).

One module, five rules, applied by every fetcher so no source can drift into
downloading the whole country:

1. **advertised-size check** — trust the index's `sizeInBytes` before fetching.
2. **free-disk headroom** — refuse if the download would not leave a margin.
3. **refuse-oversized** — a hard per-file and per-job ceiling.
4. **clip-to-AOI** — every request is bounded by the operator's AOI bbox.
5. **discard raw archives** — the staging dir holds usable data, not zips.

These are guardrails, not policy: they fail LOUDLY (raise `SafetyError`), never
silently truncate or partial-fetch. The product-runtime network-denial
guarantee (Phase B B7) is separate — this tool is deliberately network-enabled
and lives OUTSIDE the product; it is never a required CI check.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass


class SafetyError(RuntimeError):
    """A safety rule refused the operation. Always loud, never silent."""


@dataclass(frozen=True)
class SafetyLimits:
    """Operator-tunable ceilings. Defaults are conservative on purpose."""

    #: Hard per-file ceiling. A single advertised file over this is refused.
    max_file_bytes: int = 2 * 1024**3  # 2 GiB
    #: Hard per-job ceiling across all files in one acquire run.
    max_job_bytes: int = 8 * 1024**3  # 8 GiB
    #: Free-disk margin that must remain AFTER the download completes.
    min_free_headroom_bytes: int = 5 * 1024**3  # 5 GiB
    #: Largest AOI the fetchers will accept, in square degrees (a coarse guard
    #: against "fetch the whole state" typos; ~1 deg^2 is a large county).
    max_aoi_sq_deg: float = 4.0


@dataclass(frozen=True)
class Bbox:
    """AOI bounding box in WGS84 (west, south, east, north). Loud validation:
    no half-specified or inverted AOI reaches a fetcher."""

    west: float
    south: float
    east: float
    north: float

    def __post_init__(self) -> None:
        for name, value in (
            ("west", self.west),
            ("south", self.south),
            ("east", self.east),
            ("north", self.north),
        ):
            if not isinstance(value, (int, float)) or value != value:  # NaN check
                raise SafetyError(f"bbox {name} is not a finite number: {value!r}")
        if not (-180.0 <= self.west < self.east <= 180.0):
            raise SafetyError(
                f"bbox longitudes must satisfy -180 <= west < east <= 180 "
                f"(got west={self.west}, east={self.east})"
            )
        if not (-90.0 <= self.south < self.north <= 90.0):
            raise SafetyError(
                f"bbox latitudes must satisfy -90 <= south < north <= 90 "
                f"(got south={self.south}, north={self.north})"
            )

    @property
    def area_sq_deg(self) -> float:
        return (self.east - self.west) * (self.north - self.south)

    def as_tnm_string(self) -> str:
        """TNMAccess `bbox` param: 'west,south,east,north'."""
        return f"{self.west},{self.south},{self.east},{self.north}"


def check_aoi(bbox: Bbox, limits: SafetyLimits) -> None:
    """Rule 4 (clip-to-AOI, front half): refuse an AOI larger than the ceiling
    BEFORE any request is made."""
    if bbox.area_sq_deg > limits.max_aoi_sq_deg:
        raise SafetyError(
            f"AOI is {bbox.area_sq_deg:.3f} sq-deg, over the "
            f"{limits.max_aoi_sq_deg} sq-deg ceiling — clip the AOI smaller "
            f"(this guard prevents accidental whole-region downloads)"
        )


def check_advertised_size(name: str, size_bytes: int | None, limits: SafetyLimits) -> int:
    """Rules 1+3: an index that advertises a size must respect the per-file
    ceiling; an index that advertises NONE is refused (we do not fetch blind)."""
    if size_bytes is None:
        raise SafetyError(
            f"'{name}' advertises no sizeInBytes — refusing to fetch blind "
            f"(a source that hides its size is a drift signal, not a default)"
        )
    if size_bytes < 0:
        raise SafetyError(f"'{name}' advertises a negative sizeInBytes: {size_bytes}")
    if size_bytes > limits.max_file_bytes:
        raise SafetyError(
            f"'{name}' is {size_bytes} bytes, over the "
            f"{limits.max_file_bytes}-byte per-file ceiling — refused"
        )
    return size_bytes


def check_job_total(total_bytes: int, limits: SafetyLimits) -> None:
    """Rule 3 (per-job half): the sum of a run's advertised sizes has a ceiling
    too, so many small files cannot add up to an unbounded download."""
    if total_bytes > limits.max_job_bytes:
        raise SafetyError(
            f"this run would fetch {total_bytes} bytes, over the "
            f"{limits.max_job_bytes}-byte per-job ceiling — narrow the AOI or "
            f"datasets"
        )


def check_disk_headroom(dest_dir: str, needed_bytes: int, limits: SafetyLimits) -> None:
    """Rule 2: the download must leave `min_free_headroom_bytes` free AFTER it
    lands, or it is refused before the first byte."""
    free = shutil.disk_usage(dest_dir).free
    if free - needed_bytes < limits.min_free_headroom_bytes:
        raise SafetyError(
            f"insufficient disk: {free} bytes free, need {needed_bytes} + "
            f"{limits.min_free_headroom_bytes} headroom — refused before fetch"
        )


ARCHIVE_SUFFIXES = (".zip", ".tar", ".tar.gz", ".tgz", ".7z", ".gz")


def is_archive(filename: str) -> bool:
    """Rule 5 helper: is this a raw archive to discard after extraction?"""
    lowered = filename.lower()
    return any(lowered.endswith(suffix) for suffix in ARCHIVE_SUFFIXES)
