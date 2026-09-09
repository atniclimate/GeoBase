# GeoBase developer guide

## Source layout

| Directory | Responsibility |
| --- | --- |
| `src/core/` | CRS, geometry, source-layer validation, deterministic screening, project serialization and provenance |
| `src/electron/` | Main/preload code, IPC boundaries, local file access and runtime security policy |
| `src/renderer/` | Cesium presentation, local layer controls, area framing and interpolation display |
| `src/shared/` | Shared governance markers and deterministic JSON utilities |

Rendering objects are views of retained source records. Keep native geometry,
attributes, units, nulls, source metadata and transformation history separate
from Cesium entities and display estimates.

## Development context

The complete application uses Windows 11, PowerShell 7, Node.js 22–24 and
pnpm 9.15.9. Reference dependency versions for this snapshot are TypeScript
7.0.2, Electron 43.3.0, Vite 8.2.1, CesiumJS 1.144.0, Cesium engine 26.2.0,
Proj4js 2.21.0, JSTS 2.12.1 and Turf boolean-intersects/boolean-valid 7.4.0.

This repository intentionally distributes application source only. Build
manifests, test suites and supporting local assets are outside this snapshot.
There is no supported install, build or launch command for this repository in
isolation. Do not treat it as a released executable or a reproducible full
application checkout.

The complete renderer requires three local synthetic resource/rule fixtures
at build time. Electron startup requires locally provisioned trusted profiles
and matching authority-document bytes. Those inputs are omitted here; missing
or mismatched trust inputs must continue to cause refusal. Do not replace them
with empty, permissive or invented defaults to make a build launch.

## Behavioral boundaries

- Read CRS from authoritative metadata and transform explicitly. Filenames
  do not establish CRS, and missing values are not zero.
- Keep hard exclusions, soft constraints, context and unknown coverage
  distinguishable in numerical results and the interface.
- Keep interpolation separate from source custody and screening. Its
  inverse-distance-squared model requires compatible measurements, declared
  coverage, native resolution and adequate local neighbors; unsupported
  cells remain unavailable.
- Preserve local-only runtime data paths and explicit user-selected local
  exports. Preserve default-to-T3 behavior and applicable export/network
  denial. Do not add automatic transmission or remote imagery/terrain.
- Preserve source classification, consent, ownership and provenance metadata
  without claiming that retention is enforcement or approval.

The development build persists exactly:

```text
governance_mode=development_bypass
governance_enforced=false
public_distribution_allowed=false
```

Its warning is exactly:

```text
DEVELOPMENT BUILD - SOVEREIGNTY CONTROLS NOT ENFORCED
```

## Verification and contributions

This source snapshot does not contain or claim execution of the complete
application's acceptance suite. Changes intended for the complete application
need verification in its authorized development environment: numerical
controls, the actual Electron entry point, rendered output, save/reopen and
semantic export/re-import comparisons as applicable. File existence or a
browser preview is not desktop acceptance.

Keep contributions limited to application source and these public-facing
documents. Do not commit datasets, local configuration, private inputs,
credentials, runtime projects, exports, caches or generated output. Preserve
the [license](LICENSE.md) and required attribution notices.
