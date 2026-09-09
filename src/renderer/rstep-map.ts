import Cartesian3 from "@cesium/engine/Source/Core/Cartesian3.js";
import Color from "@cesium/engine/Source/Core/Color.js";
import createGuid from "@cesium/engine/Source/Core/createGuid.js";
import PolygonHierarchy from "@cesium/engine/Source/Core/PolygonHierarchy.js";
import type Entity from "@cesium/engine/Source/DataSources/Entity.js";
import type { Geometry, Position } from "geojson";
import { transformGeometry } from "../core/crs";
import type { CesiumScene } from "./cesium-scene";

export interface RstepMapFeature {
  id: string;
  geometry: Geometry;
  color: string;
  visible: boolean;
  opacity?: number;
  outline?: boolean;
}

/** Disposable Cesium views: source and scenario objects never live in these entities. */
export class RstepMap {
  #entities: Entity[] = [];
  #visibility = new Map<Entity, boolean>();
  #legacy = new Map<Entity, boolean>();
  #terrain = false;
  #globe = true;
  #exaggeration = 1;
  #active = false;
  constructor(private readonly scene: CesiumScene) {}

  activate(enabled: boolean): void {
    if (enabled === this.#active) return;
    this.#active = enabled;
    if (enabled) {
      this.#terrain = this.scene.terrainEnabled;
      this.#globe = this.scene.viewer.scene.globe.show;
      this.#exaggeration = this.scene.viewer.scene.verticalExaggeration;
      this.scene.setTerrainEnabled(false);
      this.scene.setDrawingEnabled(false);
      this.scene.viewer.scene.globe.show = true;
      this.scene.viewer.scene.verticalExaggeration = 1;
      for (const entity of this.scene.viewer.entities.values) {
        if (this.#entities.includes(entity)) continue;
        this.#legacy.set(entity, entity.show);
        entity.show = false;
      }
    } else {
      this.scene.setTerrainEnabled(this.#terrain);
      this.scene.viewer.scene.globe.show = this.#globe;
      this.scene.viewer.scene.verticalExaggeration = this.#exaggeration;
      for (const [entity, show] of this.#legacy) entity.show = show;
      this.#legacy.clear();
    }
    for (const entity of this.#entities) entity.show = enabled && this.#visibility.get(entity) === true;
    this.scene.viewer.scene.requestRender();
  }

  render(features: readonly RstepMapFeature[]): void {
    for (const entity of this.#entities) this.scene.viewer.entities.remove(entity);
    this.#entities = [];
    this.#visibility.clear();
    const remember = (entity: Entity, visible: boolean): void => {
      this.#entities.push(entity);
      this.#visibility.set(entity, visible);
    };
    const position = (p: Position) => Cartesian3.fromDegrees(p[0] ?? NaN, p[1] ?? NaN, 20);
    const draw = (
      id: string,
      geometry: Geometry,
      color: Color,
      visible: boolean,
      opacity: number,
      outline: boolean,
    ): void => {
      if (geometry.type === "GeometryCollection") {
        geometry.geometries.forEach((part, i) => {
          draw(`${id}.${i}`, part, color, visible, opacity, outline);
        });
        return;
      }
      if (geometry.type === "MultiPolygon") {
        geometry.coordinates.forEach((coordinates, i) => {
          draw(`${id}.${i}`, { type: "Polygon", coordinates }, color, visible, opacity, outline);
        });
        return;
      }
      if (geometry.type === "MultiPoint" || geometry.type === "MultiLineString") {
        geometry.coordinates.forEach((coordinates, i) => {
          draw(
            `${id}.${i}`,
            geometry.type === "MultiPoint"
              ? { type: "Point", coordinates: coordinates as Position }
              : { type: "LineString", coordinates: coordinates as Position[] },
            color,
            visible,
            opacity,
            outline,
          );
        });
        return;
      }
      const base = { id: createGuid(), show: visible && this.#active };
      if (geometry.type === "Polygon") {
        const outer = geometry.coordinates[0];
        if (outer === undefined || outer.length === 0) return;
        remember(
          this.scene.viewer.entities.add({
            ...base,
            polygon: {
              hierarchy: new PolygonHierarchy(
                outer.map(position),
                geometry.coordinates.slice(1).map((ring) => new PolygonHierarchy(ring.map(position))),
              ),
              material: color.withAlpha(opacity),
              height: 20,
              outline: false,
            },
          }),
          visible,
        );
        if (outline)
          geometry.coordinates.forEach((ring) => {
            remember(
              this.scene.viewer.entities.add({
                id: createGuid(),
                show: base.show,
                polyline: { positions: ring.map(position), material: color, width: 2 },
              }),
              visible,
            );
          });
      } else if (geometry.type === "Point") {
        remember(
          this.scene.viewer.entities.add({
            ...base,
            position: position(geometry.coordinates),
            point: {
              pixelSize: 11,
              color,
              outlineColor: Color.BLACK,
              outlineWidth: 2,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          }),
          visible,
        );
      } else if (geometry.type === "LineString") {
        remember(
          this.scene.viewer.entities.add({
            ...base,
            polyline: { positions: geometry.coordinates.map(position), width: 3, material: color },
          }),
          visible,
        );
      }
    };
    for (const feature of features)
      draw(
        feature.id,
        transformGeometry(feature.geometry, "EPSG:5070", "EPSG:4326"),
        Color.fromCssColorString(feature.color),
        feature.visible,
        feature.opacity ?? 0.48,
        feature.outline ?? true,
      );
    this.scene.viewer.scene.requestRender();
  }
}
