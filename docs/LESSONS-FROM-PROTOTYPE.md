# Lessons From the Prototype

GeoBase is a ground-up rebuild following the Squaxin Island 3D-terrain prototype
(`Tribal3DMap_dev/SquaxinIsland_test`), which was explicitly abandoned as a
"complete failure." The failure was instructive. Each lesson below is encoded as
a GeoBase design rule so the same wall is not hit twice.

## 1. Verification theatre killed the prototype
The data pipeline verified **green at every step** — correct CRS, bounds, 255
tiles, confirmed hillshade relief — yet the viewer never rendered true 3D terrain.
No checkpoint ever confirmed the *rendered output*.

> **Rule:** every render phase's acceptance gate is an **observed rendered
> artifact** (a screenshot at ~45° pitch showing displaced terrain), not a data
> checkbox. Data-level green is necessary, never sufficient. (Roadmap 0.2.)

## 2. Cloud-terrain lock-in
Cesium would not render local Terrarium tiles as true 3D; terrain was entangled
with a Cesium Ion dependency. Data was fine; the *renderer* was the problem.

**Root cause, refined (Phase 0.2):** the failure was a renderer–format
mismatch, not "local 3D is impossible." Cesium's terrain provider consumes
quantized-mesh — RSTEP's Gorge viewer proves local Cesium terrain works when
fed that format (`ctb-tile -f Mesh`). Terrarium raster PNGs, which the
prototype produced, are *MapLibre's* native `raster-dem` food; the prototype
made MapLibre food and fed it to Cesium. GeoBase chose MapLibre because
Terrarium tiles are its first-class terrain source and the static-deploy path
is simpler — proven by the Phase 0.2 gate. If MapLibre ever becomes untenable,
the documented fallback is the quantized-mesh pipeline (note: its baking
toolchain — GDAL + ctb-tile — is not provisioned on the dev machine, and a
Cesium pivot would reverse rules 2–3; cost it accordingly).

> **Rule:** MapLibre GL with a **local `raster-dem` source**. No Cesium Ion, no
> cloud-terrain dependency, in either engine. Sovereignty-safe by default.

## 3. Viewer sprawl
~29 duplicate HTML viewers (`create_3d_viewer_v2 … v8`, parallel `Working3Dmap/`
and `ReferenceGrid/` trees) with no single source of truth.

> **Rule:** exactly **one** rendering stack (MapLibre), config-driven. The desktop
> engine embeds the same front-end as the light engine. Never fork viewers.

## 4. CRS oscillation
Sessions swapped between EPSG:26910 / 32610 / 4269 / 4326 / 3857; silent mismatches
produced garbage.

> **Rule:** one **CRS pipeline** — validate → store native → reproject to 3857 —
> with asserts at every hop. See [`CRS-PIPELINE.md`](CRS-PIPELINE.md).

## 5. Data co-located with code
~46 GB of data lived with the code; no `.gitignore`, no LFS strategy, "not
suitable for standard git."

> **Rule:** **data never enters git.** Code + specs + tiny fixtures only. Real
> data lives outside VCS. T2/T3 egress guarantees are enforced by the node, not
> by ignore rules.

## 6. Environment fragility
Reliance on a hardcoded interpreter path (`D:/miniconda3/python.exe`) and
GDAL-not-on-PATH made the build non-reproducible.

> **Rule:** pinned, reproducible toolchains (`rust-toolchain.toml`, pinned
> `packageManager`). No machine-specific absolute paths in code.

## 7. Elevation / tiling gotchas
NoData spikes (−32768 m), `NaN` bounding spheres, TMS↔XYZ Y-flips, intertidal
seams from mismatched tide states, and a `getTileDataAvailable` bug that returned
`false` and killed root-tile rendering.

> **Rule:** these are captured as concrete checks in [`CRS-PIPELINE.md`](CRS-PIPELINE.md)
> and will be enforced in the Phase 0.2 baseline work.

## 8. TSDF was always deferred, never built
Every prototype session listed "TSDF / Data Sovereignty integration" as **out of
scope**. Sovereignty was aspirational, bolted on last (and so, never).

> **Rule:** TSDF is the **backbone from day one**. Default classification is T3;
> tier semantics load from a versioned resolver; the whole platform is built
> around enforcement, not the other way around. See [`TSDF-INTEGRATION.md`](TSDF-INTEGRATION.md).

## What was worth keeping

- **Local-data-first / offline-capable** design (strong fit for sovereignty).
- Clean **source vs. derived** separation.
- **Verification-checkpoint discipline** — kept, but extended to rendered output.
- **Adaptive resolution** (validate at 10 m before scaling to 1 m).
- The prototype's own `BEST-PRACTICES.md` (CRS helpers, NoData masking, Terrarium
  encode/decode, TMS math) — a genuinely useful playbook to mine during Phase 0.2.
