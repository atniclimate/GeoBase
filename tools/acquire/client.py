"""Domain-pinned HTTP transport for `tools/acquire` (F4; hardened per review).

Stdlib-only (`urllib`) so the tool runs anywhere without a dependency surprise.
Hard rules, all from the directive + the adversarial review:

- **HTTPS only**: a non-`https` URL is refused (no silent loss of transport
  security via an `http://` index item).
- **Domain pin, redirect-safe**: every URL AND every redirect hop AND the final
  response URL must resolve to a host in the source's `allowed_hosts`. Automatic
  redirects are disabled; hops are followed manually and each is re-validated.
- **Bounded download**: streaming stops at a HARD absolute ceiling (not a
  tolerance multiple); a lying index cannot exceed it. Bytes are written to a
  tool-owned `.part` file and promoted atomically only on success; any failure
  deletes the partial.
- **Fail loudly, never scrape**: a non-2xx response raises with the probe body;
  there is no fallback to HTML scraping or a guessed URL.

The transport is injectable so the fetchers are unit-testable against recorded
responses with no network (see `tests/`).
"""

from __future__ import annotations

import json
import os
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

    def download(self, url: str, dest_path: str, expected_bytes: int, hard_max_bytes: int) -> int: ...


def _host_of(url: str) -> str:
    return (urllib.parse.urlparse(url).hostname or "").lower()


def _scheme_of(url: str) -> str:
    return (urllib.parse.urlparse(url).scheme or "").lower()


class _PinnedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-validate every redirect hop's host + scheme against the allowlist.
    A redirect to an off-allowlist host (or to http) raises instead of being
    followed — closing the redirect-escapes-the-pin hole."""

    def __init__(self, allowed: set[str]) -> None:
        self._allowed = allowed

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if _scheme_of(newurl) != "https":
            raise TransportError(f"refusing redirect to non-https URL: {newurl}")
        host = _host_of(newurl)
        if host not in self._allowed:
            raise TransportError(
                f"refusing redirect to host '{host}' — not in allowed_hosts "
                f"{sorted(self._allowed)} (domain pin holds across redirects)"
            )
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class UrllibTransport:
    """The network transport. Enforces the domain pin on every call + hop."""

    def __init__(self, allowed_hosts: tuple[str, ...], timeout: float = 60.0) -> None:
        self._allowed = {host.lower() for host in allowed_hosts}
        self._timeout = timeout
        self._opener = urllib.request.build_opener(_PinnedRedirectHandler(self._allowed))

    def _check_url(self, url: str) -> None:
        if _scheme_of(url) != "https":
            raise TransportError(
                f"refusing non-https URL '{url}' (transport security is not optional)"
            )
        host = _host_of(url)
        if host not in self._allowed:
            raise TransportError(
                f"refusing request to host '{host}' — not in the source's "
                f"allowed_hosts {sorted(self._allowed)} (domain pin; endpoints "
                f"are config, drift fails loudly, we never scrape)"
            )

    def _check_final(self, response) -> None:
        # Belt-and-suspenders: the redirect handler validates hops, this
        # validates the URL the bytes actually came from.
        final = response.geturl()
        if _host_of(final) not in self._allowed or _scheme_of(final) != "https":
            raise TransportError(f"response came from off-allowlist URL: {final}")

    def get_json(self, url: str, params: dict[str, str] | None = None) -> object:
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        self._check_url(url)
        request = urllib.request.Request(url, headers={"Accept": "application/json"})
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                self._check_final(response)
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            body = err.read().decode("utf-8", errors="replace")[:2000]
            raise TransportError(f"GET {url} failed: HTTP {err.code}. Probe body:\n{body}") from err
        except urllib.error.URLError as err:
            raise TransportError(f"GET {url} failed: {err.reason}") from err

    def download(self, url: str, dest_path: str, expected_bytes: int, hard_max_bytes: int) -> int:
        self._check_url(url)
        part_path = f"{dest_path}.part"
        request = urllib.request.Request(url)
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                self._check_final(response)
                written = 0
                with open(part_path, "wb") as out:
                    while True:
                        chunk = response.read(1024 * 256)
                        if not chunk:
                            break
                        written += len(chunk)
                        # HARD ceiling, not a tolerance: stop the moment the
                        # stream would exceed the caller's absolute limit.
                        if written > hard_max_bytes:
                            raise TransportError(
                                f"{url} exceeded the hard {hard_max_bytes}-byte "
                                f"ceiling mid-stream — aborting (index lied)"
                            )
                        out.write(chunk)
                    out.flush()
                    os.fsync(out.fileno())
            # Reject a SHORT read before promotion: a connection that ended
            # early must not become a staged "success" (review advisory). The
            # advertised size is the source's own exact byte count, so a
            # truncated download is a failure, not a smaller success.
            if written < expected_bytes:
                _remove_quietly(part_path)
                raise TransportError(
                    f"{url} downloaded {written} of {expected_bytes} advertised "
                    f"bytes — truncated, refusing to promote a short file"
                )
            os.replace(part_path, dest_path)  # atomic promotion on success only
            return written
        except (urllib.error.HTTPError, urllib.error.URLError, TransportError, OSError) as err:
            _remove_quietly(part_path)
            if isinstance(err, urllib.error.HTTPError):
                body = err.read().decode("utf-8", errors="replace")[:2000]
                raise TransportError(
                    f"download {url} failed: HTTP {err.code}. Probe body:\n{body}"
                ) from err
            if isinstance(err, TransportError):
                raise
            reason = getattr(err, "reason", err)
            raise TransportError(f"download {url} failed: {reason}") from err


def _remove_quietly(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass
