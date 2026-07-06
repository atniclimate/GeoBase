# DECISIONS.md — escalation-ladder log

Every climb past "obvious local fix" on the deep-think ladder produces an
entry here: trigger, causal chain or research summary, options considered,
choice, and the strongest surviving objection. Newest entries last.

---

## 2026-07-06 — Two-agent workflow established (director + offload engine)

**Trigger:** Workflow setup (not a code decision). Claude Code (Fable)
directs: architecture, sequencing, novel code, final judgment. Codex CLI
offloads: well-specified implementation, standing code review of every
non-trivial diff (stop-time review gate enabled), adversarial second
opinions (capped at two rounds), and log/test triage. Contract file:
`AGENTS.md` (invariants + data gate). Sovereignty boundary: Codex context
is limited to tracked repo content — gitignored material and any
real-world data are never piped to it; inference happens on OpenAI
servers, so the data gate is enforced at the director level as well as in
`AGENTS.md`.

## 2026-07-06 — Phase 0.3 geo IO stack: pure Rust, narrow writer, GDAL as CI oracle only

**Trigger:** ladder rung 4 (decision expensive to reverse — data format,
dependency weight, packaging). **Options:** (1) `gdal` crate bindings —
immediate capability parity, but system GDAL on every dev machine, CI, and
eventually bundled into the Tauri desktop app (~100 MB of DLLs, wide
supply-chain surface, Windows toolchain pain); (2) permanent Python
ingestion — contradicts the roadmap and the fragile-Windows-geo-env
history; (3) **pure Rust** (`rusqlite` bundled, `tiff`, `shapefile`,
`geozero`), GeoPackage tables written by us per spec.

**Choice:** (3), amended by one adversarial Codex round (2026-07-06,
read-only): Phase 0.3 ships a *deliberately narrow, conformance-tested
writer*, not a general raster tiler. Accepted input: single-band
Float32/Int16 GeoTIFF (stripped or tiled; uncompressed/LZW/Deflate),
bounded dimensions; six common geometry types for shapefiles; everything
else rejects loudly per CRS-discipline. Conformance details bound into the
implementation: `2d-gridded-coverage` ancillary tables + three
`gpkg_extensions` rows, per-tile ancillary rows, scale/offset exactly 1/0,
exact tile-matrix bounds arithmetic, TIFF tile blobs single-image Float32
with `data_null` (never NaN), upper-left origin. `.prj`→EPSG via AUTHORITY
node or curated table; otherwise reject unless the operator *explicitly
declares* a CRS, recorded in the audit trail (actor, timestamp, reason) —
declaration is never a code-chosen fallback. Geometry blobs via `geozero`,
not hand-rolled WKB. The existing Python/GDAL stack stays as the
**cross-implementation oracle in CI** (rasterio/pyogrio value-for-value
round-trip + multi-tile/nodata/edge-tile fixtures), so GDAL conformance is
proven continuously without GDAL entering the product.

**Strongest surviving objection:** a narrow writer passing a small fixture
matrix can still be non-conformant for shapes outside it; mitigated by the
oracle fixture set (multi-tile, partial edge tiles, interior nodata,
non-square, UTM CRS) and revisited when Phase 2.1 widens raster inputs.

## 2026-07-06 — Node server browser boundary: loopback CORS allowlist + rebinding guard

**Trigger:** rung 2 (root cause of the node-mode render-gate failure was
CORS, and the obvious patch — `Access-Control-Allow-Origin: *` — would
have let any web page the user visits read node data through their
browser: drive-by localhost exfiltration, egress off-node in all but
name). **Choice:** the 127.0.0.1 bind keeps remote sockets out; a guard
middleware keeps remote web pages out — non-loopback `Host` headers are
refused (DNS-rebinding defense; a rebound attacker domain is same-origin
to the victim's browser and bypasses CORS entirely), and `Origin` is
echoed into CORS headers only for loopback origins (`localhost`,
`*.localhost` per RFC 6761, `127.0.0.1`, `[::1]`, `tauri://localhost`);
anything else is a flat 403. **Strongest surviving objection:** any local
web page can still read T0/T1 — acceptable for 1.0 (they are the user's
own local apps); per-app tokens arrive with the Phase 1.2 ceremony work.

## 2026-07-06 — Desktop shell: Tauri 2, feature-gated; workspace MSRV 1.75 → 1.85

**Trigger:** rung 1–2 (Phase 1.0 build decision). Tauri 2 requires a
newer MSRV than the workspace's 1.75 (cargo silently resolved Tauri 1.8
under the old pin — caught, corrected, pinned to `tauri = "2"`).
**Choice:** bump workspace `rust-version` to 1.85; gate the shell behind
`--features shell` with a `required-features` binary so `cargo build
--workspace` stays webkit/GTK-free on CI and on lean machines — the
desktop shell is built deliberately, not incidentally. The shell binary
injects the node URL via initialization script rather than app-URL query
strings (webview-platform-dependent behavior).
