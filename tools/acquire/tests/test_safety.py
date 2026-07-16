"""Unit tests for the shared safety module — the five rules, each proven to
refuse loudly."""

from __future__ import annotations

import unittest

from tools.acquire.safety import (
    Bbox,
    SafetyError,
    SafetyLimits,
    check_advertised_size,
    check_aoi,
    check_job_total,
    is_archive,
)


class TestBbox(unittest.TestCase):
    def test_valid_bbox(self):
        b = Bbox(-123.2, 47.0, -123.0, 47.2)
        self.assertAlmostEqual(b.area_sq_deg, 0.04)
        self.assertEqual(b.as_tnm_string(), "-123.2,47.0,-123.0,47.2")

    def test_inverted_longitude_refused(self):
        with self.assertRaises(SafetyError):
            Bbox(-122.0, 47.0, -123.0, 47.2)

    def test_out_of_range_latitude_refused(self):
        with self.assertRaises(SafetyError):
            Bbox(-123.2, 47.0, -123.0, 95.0)

    def test_nan_refused(self):
        with self.assertRaises(SafetyError):
            Bbox(float("nan"), 47.0, -123.0, 47.2)


class TestSafetyRules(unittest.TestCase):
    def setUp(self):
        self.limits = SafetyLimits()

    def test_aoi_ceiling(self):
        big = Bbox(-125.0, 45.0, -122.0, 48.0)  # 9 sq-deg > 4
        with self.assertRaises(SafetyError):
            check_aoi(big, self.limits)

    def test_missing_advertised_size_refused(self):
        with self.assertRaises(SafetyError):
            check_advertised_size("blind", None, self.limits)

    def test_oversized_file_refused(self):
        with self.assertRaises(SafetyError):
            check_advertised_size("huge", self.limits.max_file_bytes + 1, self.limits)

    def test_size_within_ceiling_ok(self):
        self.assertEqual(check_advertised_size("ok", 1024, self.limits), 1024)

    def test_job_total_ceiling(self):
        with self.assertRaises(SafetyError):
            check_job_total(self.limits.max_job_bytes + 1, self.limits)

    def test_archive_detection(self):
        self.assertTrue(is_archive("data.zip"))
        self.assertTrue(is_archive("D.TAR.GZ"))
        self.assertFalse(is_archive("dem.tif"))


if __name__ == "__main__":
    unittest.main()
