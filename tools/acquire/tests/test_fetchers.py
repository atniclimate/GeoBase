"""Fetcher tests against recorded responses — no network. Proves the index +
safety + staging + provenance pipeline, plus the domain pin and drift-fails-
loudly discipline."""

from __future__ import annotations

import json
import os
import tempfile
import unittest

from tools.acquire.client import TransportError
from tools.acquire.fetchers import fetch_index_source
from tools.acquire.safety import Bbox, SafetyError, SafetyLimits
from tools.acquire.sources import get_source
from tools.acquire.tests.recorded_transport import RecordedTransport

AOI = Bbox(-123.20, 47.00, -123.00, 47.20)
DEM = get_source("3dep-dem")
DEM_ENDPOINT = DEM.endpoints["products"]


def _transport(fixture="tnm_3dep_dem_products.json", allowed=None):
    return RecordedTransport(
        allowed_hosts=allowed or DEM.allowed_hosts,
        json_by_endpoint={DEM_ENDPOINT: fixture},
    )


class TestFetchIndexSource(unittest.TestCase):
    def test_dry_run_stages_nothing_but_writes_provenance(self):
        with tempfile.TemporaryDirectory() as staging:
            result = fetch_index_source(
                "3dep-dem", AOI, staging, _transport(),
                datasets=["National Elevation Dataset (NED) 1/3 arc-second"],
                download=False,
            )
            self.assertEqual(len(result.items), 2)
            self.assertTrue(all(item.written_bytes == 0 for item in result.items))
            prov_path = os.path.join(staging, "provenance.json")
            self.assertTrue(os.path.isfile(prov_path))
            with open(prov_path, encoding="utf-8") as handle:
                prov = json.load(handle)
            # Tier-0 attribution + provenance travel with the staged data.
            self.assertEqual(prov["source_key"], "3dep-dem")
            self.assertIn("U.S. Geological Survey 3D Elevation Program", prov["attribution"])
            self.assertEqual(prov["aoi_bbox_wgs84"], [-123.2, 47.0, -123.0, 47.2])

    def test_download_writes_files(self):
        with tempfile.TemporaryDirectory() as staging:
            result = fetch_index_source(
                "3dep-dem", AOI, staging, _transport(), download=True
            )
            self.assertEqual(len(result.items), 2)
            self.assertTrue(all(item.written_bytes > 0 for item in result.items))
            self.assertTrue(os.path.isfile(os.path.join(staging, "USGS_13_n48w124.tif")))

    def test_oversized_aoi_refused_before_any_request(self):
        transport = _transport()
        with tempfile.TemporaryDirectory() as staging:
            with self.assertRaises(SafetyError):
                fetch_index_source(
                    "3dep-dem", Bbox(-125.0, 45.0, -122.0, 48.0), staging, transport
                )
        self.assertEqual(transport.requested, [], "no request may be made for an over-ceiling AOI")

    def test_domain_pin_refuses_off_allowlist_host(self):
        # A transport whose allowlist omits the staged-product host must refuse
        # the download exactly as production would.
        transport = RecordedTransport(
            allowed_hosts=("tnmaccess.nationalmap.gov",),  # index host only
            json_by_endpoint={DEM_ENDPOINT: "tnm_3dep_dem_products.json"},
        )
        with tempfile.TemporaryDirectory() as staging:
            with self.assertRaises(TransportError):
                fetch_index_source("3dep-dem", AOI, staging, transport, download=True)

    def test_per_job_ceiling_enforced(self):
        # A tiny per-job ceiling makes the two fixture files (together ~0.5 GiB)
        # exceed the limit -> refused before download.
        limits = SafetyLimits(max_job_bytes=1024)
        with tempfile.TemporaryDirectory() as staging:
            with self.assertRaises(SafetyError):
                fetch_index_source("3dep-dem", AOI, staging, _transport(), limits=limits)


if __name__ == "__main__":
    unittest.main()
