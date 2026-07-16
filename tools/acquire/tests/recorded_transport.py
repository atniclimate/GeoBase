"""A recorded-response Transport for tests + the acquire-gate: no network.

Enforces the SAME domain pin the real transport does, so a fetcher that would
reach off-allowlist fails in tests exactly as it would in production.
"""

from __future__ import annotations

import json
import os
import urllib.parse

from tools.acquire.client import TransportError

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


class RecordedTransport:
    def __init__(self, allowed_hosts, json_by_endpoint, file_bytes_by_host=None):
        self._allowed = set(allowed_hosts)
        # Map an endpoint URL (without query) -> fixture filename.
        self._json = json_by_endpoint
        # Optional: bytes to "download" per URL for download() tests.
        self._file_bytes = file_bytes_by_host or {}
        self.requested = []

    def _check_host(self, url):
        host = urllib.parse.urlparse(url).hostname or ""
        if host not in self._allowed:
            raise TransportError(f"recorded transport: host '{host}' not in {sorted(self._allowed)}")

    def get_json(self, url, params=None):
        self._check_host(url)
        self.requested.append(url)
        fixture = self._json.get(url.split("?")[0])
        if fixture is None:
            raise TransportError(f"recorded transport: no fixture for {url}")
        with open(os.path.join(FIXTURES, fixture), encoding="utf-8") as handle:
            return json.load(handle)

    def download(self, url, dest_path, expected_bytes):
        self._check_host(url)
        self.requested.append(url)
        payload = self._file_bytes.get(url, b"x" * min(expected_bytes, 1024))
        with open(dest_path, "wb") as out:
            out.write(payload)
        return len(payload)
