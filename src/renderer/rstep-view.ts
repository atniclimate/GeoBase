import BoundingSphere from "@cesium/engine/Source/Core/BoundingSphere.js";
import Cartesian3 from "@cesium/engine/Source/Core/Cartesian3.js";
import HeadingPitchRange from "@cesium/engine/Source/Core/HeadingPitchRange.js";
import { transformGeometry, visitGeometryPositions } from "../core/crs";
import type { InterpolationSurface } from "../core/rstep/interpolation";
import type { CesiumScene } from "./cesium-scene";
import { createRstepAoi } from "./rstep-aoi";
import type { RstepMapFeature } from "./rstep-map";

/** Sequential scalar colours convey quantity only; they do not encode screening or governance. */
function scalarColour(value: number, minimum: number, maximum: number): string {
  const fraction =
    minimum === maximum ? 0.5 : Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
  const low = [45, 59, 134];
  const high = [255, 230, 161];
  return `#${low
    .map((channel, index) =>
      Math.round(channel + ((high[index] ?? channel) - channel) * fraction)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Projected cell footprints remain EPSG:5070 until the established map transform. */
export function interpolationMapFeatures(
  surface: Pick<InterpolationSurface, "cells" | "minimum" | "maximum">,
  visible: boolean,
): RstepMapFeature[] {
  const { minimum, maximum } = surface;
  if (minimum === null || maximum === null || !Number.isFinite(minimum) || !Number.isFinite(maximum))
    return [];
  return surface.cells.flatMap((cell, index) => {
    if (cell.value === null || !Number.isFinite(cell.value)) return [];
    return [
      {
        id: `interpolation:${index}`,
        geometry: cell.geometry,
        color: scalarColour(cell.value, minimum, maximum),
        visible,
        opacity: 0.82,
        outline: false,
      },
    ];
  });
}

/** Center both views on the validated geographic AOI, with no terrain or data mutation. */
export function focusRstepArea(
  scene: CesiumScene,
  bounds: readonly number[],
  mode: "oblique" | "overhead",
): void {
  // Reuse the existing AOI validator and explicit CRS path, including its bounded-area limit.
  const projected = createRstepAoi(bounds.map(String));
  const geographic = transformGeometry(projected, "EPSG:5070", "EPSG:4326");
  const [west, south, east, north] = bounds as [number, number, number, number];
  const center = Cartesian3.fromDegrees((west + east) / 2, (south + north) / 2, 20);
  let radius = 0;
  visitGeometryPositions(geographic, (position) => {
    const point = Cartesian3.fromDegrees(position[0] ?? NaN, position[1] ?? NaN, 20);
    radius = Math.max(radius, Cartesian3.distance(center, point));
  });
  // Small numerical margin contains the curved perimeter between its validated samples.
  const sphere = new BoundingSphere(center, radius * 1.001);
  const frustum = scene.viewer.camera.frustum;
  let range = Math.max(100, sphere.radius * 3.2);
  if ("fovy" in frustum && "aspectRatio" in frustum) {
    const fovy = frustum.fovy;
    const aspectRatio = frustum.aspectRatio;
    if (
      typeof fovy !== "number" ||
      typeof aspectRatio !== "number" ||
      !Number.isFinite(fovy) ||
      !Number.isFinite(aspectRatio) ||
      fovy <= 0 ||
      fovy >= Math.PI ||
      aspectRatio <= 0
    )
      throw new Error("AOI camera requires a valid perspective field of view.");
    const halfAngle = Math.atan(Math.tan(fovy / 2) * Math.min(1, aspectRatio));
    // Sphere tangent cone fits the narrower viewport dimension at either camera pitch.
    range = Math.max(range, (sphere.radius * 1.1) / Math.sin(halfAngle));
  }
  scene.viewer.camera.flyToBoundingSphere(sphere, {
    duration: 0,
    offset: new HeadingPitchRange(0, ((mode === "overhead" ? -90 : -55) * Math.PI) / 180, range),
  });
  scene.viewer.scene.requestRender();
}
