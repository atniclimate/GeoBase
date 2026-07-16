"""Public-data source registry for `tools/acquire` (F4).

Every source GeoBase can populate a node from is declared here — ONCE — with:

- its allowed hosts (domain-pinned: the fetcher refuses any other host and
  never falls back to scraping),
- its endpoints as CONFIG (they drift; a drifted endpoint fails loudly with
  the probe response, it is never silently worked around),
- and its **Tier-0 attribution + provenance** (the licensing-in-documentation
  requirement: every source is Tier 0 under the TSDF and may be used freely
  *with attribution and provenance recorded*).

This registry is the machine-readable half of `tools/acquire/README.md`; the
two must agree. `THIRD_PARTY_NOTICES.md` cites this file.

Out-of-product by construction: nothing here is a product dependency, and the
product's pure-Rust posture is untouched. These fetchers produce a staging
directory that `geopack package` ingests through the existing pipeline — they
never write a GeoPackage or a new packaging path themselves.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Source:
    """One public-data source. `endpoints` are config; `allowed_hosts` is the
    domain pin the client enforces."""

    key: str
    name: str
    allowed_hosts: tuple[str, ...]
    endpoints: dict[str, str]
    #: TSDF tier the FETCHED data enters GeoBase as, before any sovereign
    #: reclassification. Public federal data is T0.
    default_tier: str
    #: Attribution string, verbatim, for THIRD_PARTY_NOTICES.md + product docs.
    attribution: str
    #: License / use posture of the source data.
    license: str
    #: Provenance: who publishes it, what it is, how it is accessed.
    provenance: str
    #: Datasets/products this source exposes that the fetcher understands.
    datasets: tuple[str, ...] = field(default_factory=tuple)


# The National Map Access API (TNMAccess) — the shared index for 3DEP DEM,
# 3DEP LiDAR staged products, and NHDPlus HR / WBD staged products.
_TNM_HOSTS = ("tnmaccess.nationalmap.gov",)

SOURCES: dict[str, Source] = {
    "3dep-dem": Source(
        key="3dep-dem",
        name="USGS 3DEP Digital Elevation Model",
        allowed_hosts=_TNM_HOSTS + ("prd-tnm.s3.amazonaws.com", "rockyweb.usgs.gov"),
        endpoints={
            "products": "https://tnmaccess.nationalmap.gov/api/v1/products",
        },
        default_tier="T0",
        attribution=(
            "Elevation data courtesy of the U.S. Geological Survey 3D Elevation "
            "Program (3DEP), The National Map."
        ),
        license=(
            "U.S. Government work — public domain (17 U.S.C. § 105). No "
            "copyright; USGS requests attribution as a courtesy."
        ),
        provenance=(
            "Published by USGS 3DEP; indexed by the TNMAccess API "
            "(tnmaccess.nationalmap.gov/api/v1/products), which returns direct "
            "GeoTIFF/staged-product download URLs by bbox + dataset name. "
            "Staged products are served from prd-tnm.s3.amazonaws.com / "
            "rockyweb.usgs.gov."
        ),
        datasets=(
            "National Elevation Dataset (NED) 1/3 arc-second",
            "National Elevation Dataset (NED) 1 meter",
        ),
    ),
    "3dep-lidar": Source(
        key="3dep-lidar",
        name="USGS 3DEP LiDAR point clouds",
        allowed_hosts=_TNM_HOSTS
        + ("prd-tnm.s3.amazonaws.com", "usgs.entwine.io", "s3-us-west-2.amazonaws.com"),
        endpoints={
            "products": "https://tnmaccess.nationalmap.gov/api/v1/products",
            # Pre-tiled, range-readable COPC/EPT mirror (no re-sort needed).
            "entwine_index": "https://usgs.entwine.io/boundaries/resources.geojson",
        },
        default_tier="T0",
        attribution=(
            "LiDAR point clouds courtesy of the U.S. Geological Survey 3D "
            "Elevation Program (3DEP), via the USGS 3DEP LiDAR public dataset."
        ),
        license=(
            "U.S. Government work — public domain (17 U.S.C. § 105). The AWS "
            "Open Data 'usgs-lidar-public' registry mirrors it under the same "
            "public-domain terms."
        ),
        provenance=(
            "Published by USGS 3DEP; LAZ tiles indexed by TNMAccess; pre-tiled "
            "COPC/EPT mirrors at usgs.entwine.io and s3://usgs-lidar-public "
            "(registry.opendata.aws/usgs-lidar). Prefer the COPC/EPT mirrors — "
            "range-readable, no re-sort. NOTE: LiDAR ingests default to T3 in "
            "GeoBase (AGENTS.md §2); T0 here is the SOURCE posture, not the "
            "node classification — the ingestor decides tier on ingest."
        ),
        datasets=("Lidar Point Cloud (LPC)",),
    ),
    "landfire": Source(
        key="landfire",
        name="LANDFIRE fuels & vegetation",
        allowed_hosts=("lfps.usgs.gov", "landfire.gov", "www.landfire.gov"),
        endpoints={
            # LANDFIRE Product Service (LFPS): async AOI clip jobs.
            "submit": "https://lfps.usgs.gov/api/job/submit",
            "status": "https://lfps.usgs.gov/api/job/status",
        },
        default_tier="T0",
        attribution=(
            "Fuels and vegetation data from LANDFIRE, a joint program of the "
            "U.S. Department of Agriculture Forest Service and U.S. Department "
            "of the Interior."
        ),
        license=(
            "U.S. Government work — public domain. LANDFIRE requests citation "
            "of the program and product version."
        ),
        provenance=(
            "Published by the LANDFIRE program; accessed via the LANDFIRE "
            "Product Service (LFPS) async job API (lfps.usgs.gov/api): submit "
            "an AOI clip job, poll status, download the clip. The submit->poll->"
            "download discipline is adapted from zymazza/mazzap_veil (MIT) — "
            "see THIRD_PARTY_NOTICES.md."
        ),
        datasets=("Fuel models (FBFM40)", "Existing Vegetation Type (EVT)"),
    ),
    "nhd": Source(
        key="nhd",
        name="NHDPlus HR / Watershed Boundary Dataset",
        allowed_hosts=_TNM_HOSTS + ("prd-tnm.s3.amazonaws.com",),
        endpoints={
            "products": "https://tnmaccess.nationalmap.gov/api/v1/products",
        },
        default_tier="T0",
        attribution=(
            "Hydrography from the USGS National Hydrography Dataset Plus High "
            "Resolution (NHDPlus HR) and the Watershed Boundary Dataset (WBD)."
        ),
        license=(
            "U.S. Government work — public domain (17 U.S.C. § 105)."
        ),
        provenance=(
            "Published by USGS; staged HU4/HU8 GDB/GPKG products indexed by "
            "TNMAccess and fetched by the HUC(s) intersecting the AOI."
        ),
        datasets=(
            "National Hydrography Dataset Plus High Resolution (NHDPlus HR)",
            "Watershed Boundary Dataset (WBD)",
        ),
    ),
}


def get_source(key: str) -> Source:
    """Look up a source by key, or fail loudly with the valid keys."""
    try:
        return SOURCES[key]
    except KeyError:
        raise KeyError(
            f"unknown source '{key}'. Known sources: {', '.join(sorted(SOURCES))}"
        ) from None
