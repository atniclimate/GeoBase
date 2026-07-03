# The CRS Pipeline — One Discipline

The prototype lost days to coordinate-reference-system confusion: sessions
oscillated between EPSG:26910, 32610, 4269, 4326, and 3857, and silent CRS
mismatches produced operations that "succeeded" but returned garbage. GeoBase
does not fix this by mandating one CRS — it serves many Tribes in many UTM zones.
It fixes it by mandating one **pipeline**.

## The rule

```
   validate source CRS  →  store in native CRS  →  reproject to viewer CRS
        (assert)                (assert)                 (EPSG:3857)
```

1. **Validate on ingest.** Every input must have a known CRS. If it is missing or
   unparseable, reject — never assume. Assert the declared CRS matches the data's
   actual extent (a sanity bounds check catches swapped lon/lat and wrong zones).
2. **Store native.** Data is kept in its source CRS (e.g. `EPSG:26910` for PNW
   UTM 10N). No lossy up-front reprojection of stored data.
3. **Reproject for the viewer.** Both engines display in `EPSG:3857`
   (`CrsPipeline::VIEWER_CRS`). Reprojection happens at serve/render time.
4. **Assert at every hop.** After any reproject/mosaic/clip, assert CRS and bounds
   match expectations. Never swallow a CRS error.

## Specific pitfalls (carried from the prototype)

- **Silent CRS mismatch** — the headline pitfall. Two layers in different CRSs
  will happily "overlay" and be wrong. Always check, never trust.
- **NoData before encoding** — replace NoData/NaN with sea-level/0 *before*
  encoding elevation, or you get −32768 m spikes and `NaN` bounding spheres.
- **TMS vs XYZ Y-flip** — terrain/Cesium-style tiling uses TMS (Y increases
  north); web maps use XYZ. Getting it wrong flips or mislocates tiles.
  `y_tms = 2^zoom − 1 − y_xyz`.
- **NetCDF axis names** — some sources use `x`=longitude, `y`=latitude; slicing by
  `lon`/`lat` silently returns empty.
- **Datum near-equality is not equality** — EPSG:26910 (NAD83) vs 32610 (WGS84)
  differ <1 cm in the PNW, but they are still different CRSs; pick one per dataset
  and record it, don't mix them silently.

## In code

`geobase-core` fixes the vocabulary: `Crs("EPSG:26910")`, `Crs::epsg(3857)`, and
`CrsPipeline::VIEWER_CRS`. The reprojection + assertion implementation lands with
the baseline-render work in **Phase 0.2** (see [`ROADMAP.md`](ROADMAP.md)).
