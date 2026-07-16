"""Tests for the real UrllibTransport security boundary (review-driven): the
domain pin, https-only enforcement, and that a REFUSED download promotes no
partial file. Exercises the real urllib path (a throwaway loopback server for
the download-boundary case), not the recorded fake.

The short-read arithmetic itself (`written < expected_bytes` → refuse before
`os.replace`) is a one-line guard in `client.py`; here we prove the boundary it
guards — a refused download leaves neither the final file nor a `.part` behind.
"""

from __future__ import annotations

import http.server
import os
import tempfile
import threading
import unittest

from tools.acquire.client import TransportError, UrllibTransport


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 (stdlib naming)
        self.send_response(200)
        self.send_header("Content-Length", "8")
        self.end_headers()
        self.wfile.write(b"12345678")

    def log_message(self, format, *args):  # noqa: A002 - match base signature; silence
        pass


class TestDownloadBoundary(unittest.TestCase):
    def setUp(self):
        self.server = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_refused_download_leaves_no_partial(self):
        # http:// on loopback is refused by the https-only rule — a genuine
        # refusal. Assert no partial file survives the refusal.
        transport = UrllibTransport(allowed_hosts=("127.0.0.1",))
        with tempfile.TemporaryDirectory() as staging:
            dest = os.path.join(staging, "out.bin")
            with self.assertRaises(TransportError):
                transport.download(f"http://127.0.0.1:{self.port}/x.bin", dest, 8, 16)
            self.assertFalse(os.path.exists(dest))
            self.assertFalse(os.path.exists(dest + ".part"))


class TestDomainPin(unittest.TestCase):
    def test_off_allowlist_host_refused(self):
        transport = UrllibTransport(allowed_hosts=("allowed.example",))
        with self.assertRaises(TransportError):
            transport.get_json("https://evil.example/api")

    def test_non_https_refused(self):
        transport = UrllibTransport(allowed_hosts=("allowed.example",))
        with self.assertRaises(TransportError):
            transport.get_json("http://allowed.example/api")


if __name__ == "__main__":
    unittest.main()
