# GeoBase

GeoBase is a local-first geospatial desktop application for renewable-energy
siting workflows, developed by the Affiliated Tribes of Northwest Indians
(ATNI) — Tribal Climate Resilience.

This repository is a **source-reference snapshot**. It contains application
source and developer documentation. It does not include datasets, fixtures,
local configuration, test assets, generated files or application binaries.
The snapshot is not a self-contained build or installable application.

The application uses TypeScript, Electron and CesiumJS. Its source covers:

- explicit CRS validation and coordinate transformation;
- local geospatial file handling, metadata custody and project persistence;
- deterministic screening with distinct exclusions, constraints and unknowns;
- area-centered 3D views and exploratory interpolation of qualified resource
  samples; and
- local file and network restrictions across Electron process boundaries.

Interpolation is a display estimate, not a wind-capacity, energy-yield or
terrain-flow model. Missing coverage remains unavailable.

> **DEVELOPMENT BUILD - SOVEREIGNTY CONTROLS NOT ENFORCED**

The source retains development bypass settings. Publication of this source
does not establish scientific validation, governance enforcement or approval
of the application for operational use. See [DEVELOPER.md](DEVELOPER.md) for
architecture and the local inputs required by the complete application.

## License and attribution

Original work: **GeoBase by the Affiliated Tribes of Northwest Indians
(ATNI) — Tribal Climate Resilience**, <https://github.com/atniclimate/GeoBase>.

Required Notice: Copyright (c) 2026 Affiliated Tribes of Northwest
Indians (ATNI) — Tribal Climate Resilience. Original source:
https://github.com/atniclimate/GeoBase

Distributed by ATNI — Tribal Climate Resilience. This source snapshot,
prepared on 2026-09-08, includes the local desktop, resource-layer screening,
project-custody and exploratory interpolation implementation. Its documentation
describes the source-only distribution; application source is retained without
publication-specific behavior changes.

The [full license](LICENSE.md) is PolyForm Noncommercial 1.0.0 with the
repository's supplementary terms, retained without modification. Dependency
attributions are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
