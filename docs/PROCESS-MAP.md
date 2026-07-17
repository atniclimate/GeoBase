# GeoBase Process Map

Every load-bearing process in the platform, end to end, with the exact
components that implement it. Written at the close of Phase 1.3a–c
(2026-07-06). `docs/ARCHITECTURE.md` explains why the shape is what it
is; this file maps *what runs where* so any feature proposal can be
checked against the components it would touch.

Standing decisions every process below honors (docs/DECISIONS.md):
**one rendering stack** (MapLibre in both engines), **pure Rust in the
product** (GDAL is a CI oracle only), **T3 architectural egress
guarantee**, **loopback-only node**, **observed-behavior gates**.

## 1. Ingest — one source pair → one GeoPack

`geopack ingest` (`crates/geobase-ingestor/src/bin/geopack.rs`) →
`ingest()` (`crates/geobase-ingestor/src/lib.rs`):

1. Tier resolution — unspecified defaults to **T3**
   (`geobase-tsdf::VendoredSource`, spec vendored from
   `spec/tsdf/tiers.toml`).
2. Input validation — narrow readers, loud rejections:
   GeoTIFF `crates/geobase-ingestor/src/geotiff.rs`, shapefile
   `crates/geobase-ingestor/src/shp.rs` (column order from the DBF
   header), CRS identification `crates/geobase-ingestor/src/crs_id.rs`
   (root AUTHORITY → curated-name table → operator declaration recorded
   in audit — never assumed).
3. Artifact write — raster coverage FIRST (write-ordering invariant),
   then vectors: `crates/geobase-gpkg/src/raster.rs`, `vector.rs`;
   container + SRS + metadata machinery `crates/geobase-gpkg/src/lib.rs`.
4. Classification travels with the artifact — TSDF tags in
   `gpkg_metadata` (per-table + whole-artifact roll-up), append-only
   audit trail (`geobase_audit`, UPDATE/DELETE abort by trigger).
5. Reopen-and-verify the COMPLETE artifact, then atomic rename.

## 2. Package — N inputs → one layer package (Phase 1.1a)

`geopack package --manifest pkg.toml`
(`crates/geobase-ingestor/src/package.rs`): frozen manifest schema
(`[package]` id/name/tier/basis + `[[inputs]]`), total loud validation,
same ingest hops over N inputs, package identity + manifest sha256 in
the roll-up tag, reopen-verify, backup-aside replace. Effective tier =
most restrictive (`geobase-core::LayerPackage::effective_tier` rule via
`GeoPackage::geopackage_tier()`).

## 3. Node — grounding, vault, catalog (Phase 1.0)

`Node::boot` (`crates/geobase-engine-desktop/src/lib.rs`):
- Grounding from `place.toml`
  (`crates/geobase-engine-desktop/src/place.rs`, total loud validation;
  shape frozen by `place.example.toml`).
- Vault scan → catalog (`crates/geobase-engine-desktop/src/vault.rs`):
  every `*.gpkg` becomes a `CatalogEntry` (id, path, effective tier,
  tables). Untagged artifacts read as T3.

## 4. Serve — the loopback node API (Phases 1.0–1.3)

`crates/geobase-engine-desktop/src/server.rs` (axum):
- **Egress stance**: binds 127.0.0.1 only (not configurable);
  `guard_localhost` middleware refuses non-loopback `Host` headers
  (DNS-rebinding defense) and non-loopback `Origin`s (CORS allowlist,
  echoed not `*`); answers CORS preflight for loopback origins only.
- Routes: `/api/node`, `/api/packs`, `/api/packs/{id}/layers`
  (Phase 1.1b: vector render metadata, T2/T3 refused before the
  artifact is opened, `color_seed` = BE u32 of SHA-256("pack/table")),
  `/api/packs/{id}/tables/{table}/features` (T0/T1 only, native-CRS
  GeoJSON via geozero), `/tiles/terrain/*` (pre-derived T0 pyramid),
  `POST /api/export` (Phase 1.3b, below).
- Responses carry `x-geobase-tier` and `cache-control: no-store`.

## 5. Render — one MapLibre stack, two engines

- **engine-light** (`engine-light/src/main.ts`): T0 terrain baseline
  from bundled tiles or a validated loopback node (`?node=` /
  `__GEOBASE_NODE__`); terrain+hillshade raster-dem; pinned-camera URL
  params. Layer panel (`engine-light/src/layers.ts`, Phase 1.1c):
  `?layers=pack.table,…` URL-as-state, toggles add/remove GeoJSON
  source+layers (`pkg:<key>[:fill|:line|:circle]`), color from the
  server seed, non-EPSG:4326 layers listed but refused loudly (no
  silent CRS fallback).
- **Desktop shell** (`crates/geobase-engine-desktop/src/bin/
  geobase-desktop.rs`, `--features shell`, Tauri 2): boots the node,
  serves on an ephemeral loopback port, opens the embedded engine-light
  dist with `__GEOBASE_NODE__` injected; `GEOBASE_LAYERS` env surfaces
  boot view state; `GEOBASE_EXPORTS` opts into export capability.
- Example node for harnesses: `crates/geobase-engine-desktop/examples/
  node.rs` (`place vault [tiles] [port] [exports]`).

## 6. SoLO + RStep — paint and product (Phase 1.3c)

- SDK (`solo/sdk/src/index.ts`): typed `NodeClient` (loopback-validated
  constructor — the SDK never widens egress), API shapes mirroring the
  server, `NodeRequestError` carrying server wording verbatim, and the
  **`PaintTool` adapter seam** (decision 2026-07-06: hand-rolled tool
  behind a replaceable interface; terra-draw becomes a drop-in when
  editing arrives).
- RStep (`solo/rstep/src/main.ts`, `paint.ts`): node-only app; same
  terrain + layer-stacking idiom as engine-light; hand-rolled polygon
  paint (click vertices, Backspace undo-vertex, Enter/dblclick close
  with degenerate-ring refusal, Escape cancel, select+Delete); gate
  handle `window.__rstep` (map, ready, paint, client, activePacks).

## 7. Export — zero-source-disclosure product (Phase 1.3a/b)

The chain, every step observable:
1. `POST /api/export` (server.rs) — first mutating endpoint: 503
   without `exports_dir`, 404 unknown source pack, 400 invalid.
   **Interim operator guard (Phase A, A1):** an operator-held token
   (`x-geobase-export-token`; `GEOBASE_EXPORT_TOKEN` or boot-generated)
   is required *before* the ceremony seam runs — missing/wrong → 403 +
   `export.refused` audit row; exports enabled with no token → 503
   (fail-closed misconfiguration). Provisional by design: replaced by
   real requester authentication in Phase B (B5).
2. **CeremonyGate seam** (`crates/geobase-gpkg/src/ceremony.rs`):
   every export authorized BEFORE any file is written. **Since B3
   (2026-07-16) the composed gate is the sovereign
   `RecordedConsentGate`** (`consent_gate.rs`): node-witnessed session
   source set (§4), T3 floor before any store access, recorded-consent
   matching (`consent_store.rs`, reserved `node-consent.gpkg`),
   governance-vs-infrastructure refusal split (403/503), typed identity
   and evidence (`consent.rs` — free-text requester/conditions
   abolished). `ProvisionalDevGate` survives for tests only.
   Handoff/contract: `docs/CEREMONY-GATE.md`; design of record:
   `docs/CEREMONY-DESIGN.md`.
3. `export_product()` (`crates/geobase-engine-desktop/src/export.rs`):
   builds the product layer (fields exactly `id, area_m2, score`;
   Chamberlain–Duquette spherical areas), writes via the narrow
   shapefile writer (`crates/geobase-ingestor/src/shp_write.rs`:
   Polygon/MultiPolygon + DBF TEXT/INTEGER/REAL + `.prj` from the
   curated EPSG table, winding enforced, torn sets cleaned).
4. **Verifier, not promise**: reopens its own output — exact feature
   count, exact field whitelist, output == painted (coordinate
   multisets), and NO output geometry equals any source-pack geometry.
   Failure removes everything.
5. Ledger: `exports_dir/node-audit.gpkg` (T3-tagged, outside the vault
   scan) — since B3, the recoverable publication protocol
   (`docs/CEREMONY-DESIGN.md` §6): `export.intent` → one txn sealing
   `export.ceremony` + `export.t2` (prepared) → atomic bundle-directory
   rename → `export.published`; startup recovery finalizes or aborts
   truthfully. Governance refusals get `export.refused` (carrying
   `observed_at`); infrastructure failures get `export.infrastructure`
   *attempted* + 503. `.tsdf.json` sidecar carries the T2 stamp +
   provenance (shapefiles have no in-band metadata channel — the
   ledger is the record).

## 8. Gates — observed behavior, continuously (CI: .github/workflows/)

| Gate | Proof | Harness | CI job |
|---|---|---|---|
| GeoPack (0.3) | T0 round-trip vs GDAL oracle; unclassified→T3 refused | `scripts/geopack_gate.py` + `scripts/verify_geopack_oracle.py` | `geopack-gate.yml` |
| Render (0.2) | terrain displaced, not draped (pixel diff) | `engine-light/scripts/verify-render.mjs` | `render-gate.yml: render-gate` |
| Node render (1.0) | same proof served by a booted node | same + `NODE_URL` | `render-gate.yml: node-render-gate` |
| Layer (1.1) | two packages toggle+stack+round-trip (pixel diffs), URL boot state | `engine-light/scripts/verify-layers.mjs` | `render-gate.yml: layer-gate` |
| RStep (1.3d) | paint → export → product-only shapefile (pyogrio) + ceremony record in ledger | `solo/rstep/scripts/verify-rstep.mjs` (+ `verify_rstep_oracle.py`, `examples/verify-export-audit.rs`) | `render-gate.yml: rstep-gate` |

**RStep row (updated 2026-07-16 twice: Phase A A3–A7 built the harness;
B3 reworked it to the sovereign gate — acceptance still deferred to
M5/B8.** The 1.3d harness runs **against the sovereign
`RecordedConsentGate`**: it records a fixture agreement through the
LocalOperator path (`examples/record-consent.rs`), drives a
node-witnessed session, and asserts `EXPECT_PROCESS` and `EXPECT_BASIS`
independently plus provisional-wording exclusivity — the B8 bar. The
`rstep-gate` CI job is INFORMATIONAL. Per the acceptance-integrity rule
(`docs/RELEASE-DEFINITION.md`, `CONTRIBUTING.md`), this green is
engineering evidence, **not** Phase 1.3 acceptance — `docs/ROADMAP.md`
1.3 stays not-accepted. Acceptance happens exactly once, at Phase B's
exit (B8), as the single observed acceptance run. The ledger is read
only through the trusted, assertion-only Rust verifier
(`examples/verify-export-audit.rs`) which emits no row contents; that
verifier is the right *place* for Phase B's at-rest decryption to live
(a node opens its own T3 ledger), but it does **not** decrypt anything
today — an encrypted ledger will require a cipher/key there (B4,
DG-2).

Fixtures: `scripts/make_geopack_fixtures.py` → committed synthetic sets
in `data/fixtures/geopack/` (dem+parcels for 0.3; landcover+flood
packages for 1.1; **capacity+nogo for 1.3d, added 2026-07-16**).
Human-endorsed captures in `docs/verification/`.

## 9. TSDF spine (crosscutting)

Tiers/spec: `crates/geobase-tsdf/src/lib.rs` (T0 public → T3 never
leaves; sources: vendored / GitHub / local-server — governance can move
by config). Tags + audit: `crates/geobase-gpkg/src/lib.rs`. Enforcement
points, in order of encounter: ingest default-T3 → catalog effective
tier → features/layers endpoints (T0/T1 only) → tile emitter refusal →
CeremonyGate (export) → export verifier. Phase 1.2 (Patrick) adds the
sovereign ceremony + at-rest encryption behind the same seams.
