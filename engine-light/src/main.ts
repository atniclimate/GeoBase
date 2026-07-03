import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

/**
 * GeoBase Light Engine — Phase 0.1 scaffold placeholder.
 *
 * By design this boots with NO external tile/terrain dependency. The prototype
 * failed by leaning on Cesium Ion for terrain; GeoBase's rule is a local
 * `raster-dem` source served by the Desktop Engine (or bundled for a static
 * demo). Phase 0.2 wires the real T0 terrain baseline and enables 3D terrain;
 * until then this renders a self-contained style so the page always loads.
 */

const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    // No remote sources yet — sovereignty-safe placeholder.
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#0b1a1f" },
      },
    ],
  },
  center: [-122.92, 47.17], // prototype AOI (South Puget Sound) as a stand-in
  zoom: 8,
  pitch: 0,
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

// Phase 0.2 will add, from a LOCAL source (no cloud):
//
//   map.addSource("terrain-dem", { type: "raster-dem", tiles: [localTileUrl], ... });
//   map.setTerrain({ source: "terrain-dem", exaggeration: 1.5 });
//
// and the acceptance gate is a headless screenshot at ~45° pitch proving the
// terrain renders as true 3D — not a flat drape. See docs/LESSONS-FROM-PROTOTYPE.md.

map.on("load", () => {
  // eslint-disable-next-line no-console
  console.log("[GeoBase] Light Engine loaded — Phase 0.1 scaffold placeholder.");
});
