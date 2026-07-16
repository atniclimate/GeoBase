"""Domain-pinned HTTP transport for `tools/acquire` (F4).

Stdlib-only (`urllib`) so the tool runs anywhere without a dependency surprise.
Two hard rules, both from the directive:

- **Domain pin**: a request whose host is not in the source's `allowed_hosts`
  is refused. No exceptions, no redirects off the allowlist.
- **Fail loudly, never scrape**: a non-2xx response raises with the probe
  body attached; there is no fallback to HTML scraping or a guessed URL.

The transport is an injectable object so the fetchers are unit-testable against
recorded responses with no network (see `tests/`).
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Protocol


class TransportError(RuntimeError):
    """A transport-level failure, carrying the probe body when there is one."""


class Transport(Protocol):
    """What the fetchers depend on. The real impl is `UrllibTransport`; tests
    inject a recorded-response fake."""

    def get_json(self, url: str, params: dict[str, str] | None = None) -> object: ...

    def download(self, url: str, dest_path: str, expected_bytes: int) -> int: ...


def _host_of(url: str) -> str:
    return urllib.parse.urlparse(url).hostname or ""


class UrllibTransport:
    """The network transport. Enforces the domain pin on every call."""

    def __init__(self, allowed_hosts: tuple[str, ...], timeout: float = 60.0) -> None:
        self._allowed = set(allowed_hosts)
        self._timeout = timeout

    def _check_host(self, url: str) -> None:
        host = _host_of(url)
        if host not in self._allowed:
            raise TransportError(
                f"refusing request to host '{host}' — not in the source's "
                f"allowed_hosts {sorted(self._allowed)} (domain pin; endpoints "
                f"are config, drift fails loudly, we never scrape)"
            )

    def get_json(self, url: str, params: dict[str, str] | None = None) -> object:
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        self._check_host(url)
        request = urllib.request.Request(url, headers={"Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            body = err.read().decode("utf-8", errors="replace")[:2000]
            raise TransportError(
                f"GET {url} failed: HTTP {err.code}. Probe body:\n{body}"
            ) from err
        except urllib.error.URLError as err:
            raise TransportError(f"GET {url} failed: {err.reason}") from err

    def download(self, url: str, dest_path: str, expected_bytes: int) -> int:
        self._check_host(url)
        request = urllib.request.Request(url)
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                written = 0
                with open(dest_path, "wb") as out:
                    while True:
                        chunk = response.read(1024 * 256)
                        if not chunk:
                            break
                        written += len(chunk)
                        # Enforce the advertised ceiling DURING the stream so a
                        # lying index cannot blow past it mid-download.
                        if written > expected_bytes * 2 + 1024:
                            raise TransportError(
                                f"{url} streamed more than twice its advertised "
                                f"{expected_bytes} bytes — aborting (index lied)"
                            )
                        out.write(chunk)
            return written
        except urllib.error.HTTPError as err:
            body = err.read().decode("utf-8", errors="replace")[:2000]
            raise TransportError(
                f"download {url} failed: HTTP {err.code}. Probe body:\n{body}"
            ) from err
        except urllib.error.URLError as err:
            raise TransportError(f"download {url} failed: {err.reason}") from err
