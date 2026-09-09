import type Cartesian2 from "@cesium/engine/Source/Core/Cartesian2.js";
import Cartesian3 from "@cesium/engine/Source/Core/Cartesian3.js";
import Cartographic from "@cesium/engine/Source/Core/Cartographic.js";
import Color from "@cesium/engine/Source/Core/Color.js";
import Credit from "@cesium/engine/Source/Core/Credit.js";
import CustomHeightmapTerrainProvider from "@cesium/engine/Source/Core/CustomHeightmapTerrainProvider.js";
import EllipsoidTerrainProvider from "@cesium/engine/Source/Core/EllipsoidTerrainProvider.js";
import CesiumMath from "@cesium/engine/Source/Core/Math.js";
import PolygonHierarchy from "@cesium/engine/Source/Core/PolygonHierarchy.js";
import ScreenSpaceEventHandler from "@cesium/engine/Source/Core/ScreenSpaceEventHandler.js";
import ScreenSpaceEventType from "@cesium/engine/Source/Core/ScreenSpaceEventType.js";
import ColorMaterialProperty from "@cesium/engine/Source/DataSources/ColorMaterialProperty.js";
import ConstantProperty from "@cesium/engine/Source/DataSources/ConstantProperty.js";
import type Entity from "@cesium/engine/Source/DataSources/Entity.js";
import PolylineDashMaterialProperty from "@cesium/engine/Source/DataSources/PolylineDashMaterialProperty.js";
import StripeMaterialProperty from "@cesium/engine/Source/DataSources/StripeMaterialProperty.js";
import StripeOrientation from "@cesium/engine/Source/DataSources/StripeOrientation.js";
import CreditDisplay from "@cesium/engine/Source/Scene/CreditDisplay.js";
import GridImageryProvider from "@cesium/engine/Source/Scene/GridImageryProvider.js";
import HeightReference from "@cesium/engine/Source/Scene/HeightReference.js";
import ImageryLayer from "@cesium/engine/Source/Scene/ImageryLayer.js";
import CesiumWidget from "@cesium/engine/Source/Widget/CesiumWidget.js";
import type { BaselineDisplay } from "../core/baseline/manifest";
import type { TribalGeometryCategory } from "../core/tribal/coverage";
import type { DisplayRing, LongitudeLatitude } from "./display-geometry";
import { LocalDemMesh } from "./local-dem-mesh";

export type { LongitudeLatitude } from "./display-geometry";

type ExistingDisplayKind = "resource" | "hard" | "soft" | "included" | "excluded" | "penalized" | "unknown";

export type WaTribalDisplayKind =
  | "wa_state"
  | "wa_technical_buffer"
  | "border_context"
  | TribalGeometryCategory;

export type DisplayPolygonKind = ExistingDisplayKind | WaTribalDisplayKind;

export type DisplayPolygon = {
  id: string;
  label: string;
  kind: DisplayPolygonKind;
  rings: readonly DisplayRing[];
  visible: boolean;
};

export type DisplayCandidate = {
  id: string;
  name: string;
  rings: readonly DisplayRing[];
  selected: boolean;
};

export type CesiumSceneOptions = {
  onDrawVertex: (coordinate: LongitudeLatitude) => void;
};

const WASHINGTON_FRAME: readonly LongitudeLatitude[] = [
  [-124.85, 45.55],
  [-116.8, 45.55],
  [-116.8, 49.05],
  [-124.85, 49.05],
  [-124.85, 45.55],
];

const WASHINGTON_CONTEXT_BOUNDS = [-124.85, 45.55, -116.8, 49.05] as const;
const MINIMUM_BOUNDS_CAMERA_DISTANCE_METRES = 30_000;
const MAXIMUM_BOUNDS_CAMERA_DISTANCE_METRES = 850_000;
const MINIMUM_POINT_CAMERA_DISTANCE_METRES = 750;
const MAXIMUM_POINT_CAMERA_DISTANCE_METRES = 120_000;
const MEAN_METRES_PER_DEGREE_LATITUDE = 111_320;
const BOUNDS_CAMERA_PADDING = 1.4;
const POINT_CAMERA_CLEARANCE_MULTIPLIER = 16;

const TERRAIN_SIZE = 33;

function syntheticHeight(longitude: number, latitude: number): number {
  const west = smoothWindow(longitude, -125.2, -116.3, 0.35);
  const north = smoothWindow(latitude, 45.2, 49.3, 0.3);
  if (west === 0 || north === 0) return 0;

  const cascade =
    Math.exp(-((longitude + 121.05) ** 2) / 0.16) * (1_900 + 650 * Math.sin((latitude - 45.4) * 5.1));
  const olympic = 1_350 * Math.exp(-((longitude + 123.55) ** 2) / 0.22 - (latitude - 47.65) ** 2 / 0.28);
  const syntheticTexture = 190 * Math.sin((longitude + 122.4) * 8.2) * Math.cos((latitude - 47.1) * 9.4);

  return Math.max(0, (cascade + olympic + syntheticTexture + 160) * west * north);
}

function smoothWindow(value: number, minimum: number, maximum: number, shoulder: number): number {
  if (value <= minimum || value >= maximum) return 0;
  if (value < minimum + shoulder) return (value - minimum) / shoulder;
  if (value > maximum - shoulder) return (maximum - value) / shoulder;
  return 1;
}

function createSyntheticTerrain(): CustomHeightmapTerrainProvider {
  return new CustomHeightmapTerrainProvider({
    width: TERRAIN_SIZE,
    height: TERRAIN_SIZE,
    credit: "Synthetic procedural terrain - visual test fixture, not measured elevation",
    callback: (tileX, tileY, level) => {
      const tileColumns = 2 ** (level + 1);
      const tileRows = 2 ** level;
      const heights = new Float32Array(TERRAIN_SIZE * TERRAIN_SIZE);

      for (let row = 0; row < TERRAIN_SIZE; row += 1) {
        for (let column = 0; column < TERRAIN_SIZE; column += 1) {
          const normalizedX = (tileX + column / (TERRAIN_SIZE - 1)) / tileColumns;
          const normalizedY = (tileY + row / (TERRAIN_SIZE - 1)) / tileRows;
          const longitude = -180 + normalizedX * 360;
          const latitude = 90 - normalizedY * 180;
          heights[row * TERRAIN_SIZE + column] = syntheticHeight(longitude, latitude);
        }
      }

      return heights;
    },
  });
}

type PolygonRenderStyle = {
  fill: ColorMaterialProperty | StripeMaterialProperty;
  outline: {
    material: ColorMaterialProperty | PolylineDashMaterialProperty;
    width: number;
  } | null;
};

type PolygonOutlineStyle = NonNullable<PolygonRenderStyle["outline"]>;

function color(cssColor: string, alpha: number): Color {
  return Color.fromCssColorString(cssColor).withAlpha(alpha);
}

function solidMaterial(cssColor: string, alpha: number): ColorMaterialProperty {
  return new ColorMaterialProperty(color(cssColor, alpha));
}

function stripe(
  evenCssColor: string,
  oddCssColor: string,
  orientation: StripeOrientation,
  repeat: number,
): StripeMaterialProperty {
  return new StripeMaterialProperty({
    evenColor: color(evenCssColor, 0.5),
    oddColor: color(oddCssColor, 0.12),
    orientation,
    repeat,
  });
}

function dashedOutline(cssColor: string, dashPattern = 0xff00): PolylineDashMaterialProperty {
  return new PolylineDashMaterialProperty({
    color: color(cssColor, 0.96),
    dashLength: 18,
    dashPattern,
    gapColor: Color.TRANSPARENT,
  });
}

function styleForKind(kind: DisplayPolygonKind): PolygonRenderStyle {
  switch (kind) {
    case "resource":
      return { fill: solidMaterial("#59c9ff", 0.38), outline: null };
    case "hard":
      return { fill: solidMaterial("#ff4568", 0.58), outline: null };
    case "soft":
      return { fill: solidMaterial("#ffb84a", 0.5), outline: null };
    case "included":
      return { fill: solidMaterial("#4ee59a", 0.62), outline: null };
    case "excluded":
      return { fill: solidMaterial("#f53f65", 0.72), outline: null };
    case "penalized":
      return { fill: solidMaterial("#ffc15c", 0.7), outline: null };
    case "unknown":
      return { fill: solidMaterial("#a8b0c2", 0.66), outline: null };
    case "wa_state":
      return {
        fill: solidMaterial("#d9fbff", 0.09),
        outline: { material: solidMaterial("#d9fbff", 0.95), width: 2.5 },
      };
    case "wa_technical_buffer":
      return {
        fill: stripe("#79b5ca", "#07131d", StripeOrientation.VERTICAL, 36),
        outline: null,
      };
    case "border_context":
      return {
        fill: stripe("#a8b0c2", "#273342", StripeOrientation.HORIZONTAL, 24),
        outline: null,
      };
    case "federal_reservation_exterior":
      return {
        fill: solidMaterial("#43d9a3", 0.5),
        outline: null,
      };
    case "off_reservation_trust_land":
      return {
        fill: stripe("#ffca68", "#483918", StripeOrientation.HORIZONTAL, 28),
        outline: null,
      };
    case "tdsa_statistical_area":
      return {
        fill: stripe("#b995ff", "#392c59", StripeOrientation.VERTICAL, 30),
        outline: null,
      };
    case "bia_land_area_representation":
      return {
        fill: stripe("#66c7dc", "#153c4b", StripeOrientation.HORIZONTAL, 22),
        outline: { material: solidMaterial("#bdeef7", 0.95), width: 2 },
      };
    case "authorized_tract_parcel_land_status":
      return {
        fill: solidMaterial("#f39a68", 0.43),
        outline: { material: dashedOutline("#ffd2b8", 0x3333), width: 2 },
      };
    case "treaty_area":
      return {
        fill: stripe("#ef7da6", "#53263a", StripeOrientation.VERTICAL, 20),
        outline: { material: solidMaterial("#ffd0df", 0.96), width: 3 },
      };
    case "ceded_land_area":
      return {
        fill: stripe("#dc87e8", "#492754", StripeOrientation.HORIZONTAL, 18),
        outline: { material: dashedOutline("#f7d2fc"), width: 3 },
      };
    case "tribe_approved_usual_and_accustomed_area":
      return {
        fill: stripe("#82b3ff", "#243c68", StripeOrientation.VERTICAL, 16),
        outline: { material: dashedOutline("#d7e6ff", 0x5555), width: 3 },
      };
    case "agreement_specific_co_management":
      return {
        fill: stripe("#8ed889", "#294b31", StripeOrientation.HORIZONTAL, 14),
        outline: { material: dashedOutline("#d9ffd5", 0x3f3f), width: 3 },
      };
  }
}

function isWaTribalDisplayKind(kind: DisplayPolygonKind): kind is WaTribalDisplayKind {
  switch (kind) {
    case "resource":
    case "hard":
    case "soft":
    case "included":
    case "excluded":
    case "penalized":
    case "unknown":
      return false;
    case "wa_state":
    case "wa_technical_buffer":
    case "border_context":
    case "federal_reservation_exterior":
    case "off_reservation_trust_land":
    case "tdsa_statistical_area":
    case "bia_land_area_representation":
    case "authorized_tract_parcel_land_status":
    case "treaty_area":
    case "ceded_land_area":
    case "tribe_approved_usual_and_accustomed_area":
    case "agreement_specific_co_management":
      return true;
  }
}

function flattened(coordinates: readonly LongitudeLatitude[]): number[] {
  return coordinates.flat();
}

function hierarchyForRings(rings: readonly DisplayRing[]): PolygonHierarchy {
  const exterior = rings[0];
  if (exterior === undefined || exterior.length < 3) {
    throw new TypeError("display polygon must contain an exterior ring with at least three positions");
  }
  return new PolygonHierarchy(
    Cartesian3.fromDegreesArray(flattened(exterior)),
    rings.slice(1).map((hole) => new PolygonHierarchy(Cartesian3.fromDegreesArray(flattened(hole)))),
  );
}

function exactDisplayRingsKey(rings: readonly DisplayRing[]): string {
  return JSON.stringify(rings);
}

export class CesiumScene {
  readonly viewer: CesiumWidget;

  readonly syntheticTerrain = createSyntheticTerrain();

  readonly ellipsoidTerrain = new EllipsoidTerrainProvider();

  #terrainEnabled = true;
  #baseline: LocalDemMesh | null = null;

  #drawingEnabled = false;

  #drawHandler: ScreenSpaceEventHandler;

  #displayEntities = new Map<string, Entity>();

  #displayEntityKinds = new Map<string, DisplayPolygonKind>();

  #displayEntityRings = new Map<string, string>();

  #displayOutlineEntities = new Map<string, Entity[]>();

  #displayOutlineEnabled = new Map<string, boolean>();

  #candidateEntities = new Map<string, Entity>();

  #previewEntities: Entity[] = [];

  #options: CesiumSceneOptions;

  #container: HTMLElement;

  constructor(container: HTMLElement, options: CesiumSceneOptions) {
    this.#options = options;
    this.#container = container;
    CreditDisplay.cesiumCredit = new Credit("CesiumJS 1.144.0 • bundled locally", true);
    this.viewer = new CesiumWidget(container, {
      baseLayer: false,
      maximumRenderTimeChange: Number.POSITIVE_INFINITY,
      requestRenderMode: true,
      shouldAnimate: false,
      skyAtmosphere: false,
      skyBox: false,
      terrainProvider: this.syntheticTerrain,
    });

    this.viewer.imageryLayers.add(
      new ImageryLayer(
        new GridImageryProvider({
          cells: 8,
          color: Color.fromCssColorString("#70abc0").withAlpha(0.48),
          glowColor: Color.fromCssColorString("#9fe8dc").withAlpha(0.12),
          glowWidth: 2,
          backgroundColor: Color.fromCssColorString("#102b39").withAlpha(1),
          canvasSize: 256,
        }),
      ),
    );

    this.viewer.scene.globe.baseColor = Color.fromCssColorString("#102b39");
    this.viewer.scene.globe.enableLighting = true;
    this.viewer.scene.globe.depthTestAgainstTerrain = true;
    this.viewer.scene.requestRenderMode = true;
    this.viewer.scene.maximumRenderTimeChange = Number.POSITIVE_INFINITY;
    this.viewer.scene.verticalExaggeration = 4;
    this.viewer.scene.fog.enabled = false;
    if (this.viewer.scene.skyAtmosphere !== undefined) this.viewer.scene.skyAtmosphere.show = false;
    if (this.viewer.scene.skyBox !== undefined) this.viewer.scene.skyBox.show = false;
    this.viewer.scene.backgroundColor = Color.fromCssColorString("#07131d");

    this.#addReferenceFrame();
    this.resetCamera();

    this.#drawHandler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);
    this.#drawHandler.setInputAction(
      (event: ScreenSpaceEventHandler.PositionedEvent) => this.#handleDrawClick(event.position),
      ScreenSpaceEventType.LEFT_CLICK,
    );
  }

  get terrainEnabled(): boolean {
    return this.#terrainEnabled;
  }

  setTerrainEnabled(enabled: boolean): void {
    this.#terrainEnabled = enabled;
    this.viewer.terrainProvider =
      enabled && this.#baseline === null ? this.syntheticTerrain : this.ellipsoidTerrain;
    if (this.#baseline !== null) this.#baseline.primitive.show = enabled;
    this.viewer.scene.requestRender();
  }

  resetCamera(): void {
    if (this.#baseline !== null) {
      this.#baseline.focus();
      return;
    }
    this.viewer.camera.setView({
      destination: Cartesian3.fromDegrees(-122.25, 46.65, 120_000),
      orientation: {
        heading: 0,
        pitch: CesiumMath.toRadians(-57),
        roll: 0,
      },
    });
    this.viewer.scene.requestRender();
  }

  setBaseline(display: BaselineDisplay | null): void {
    this.commitPreparedBaseline(this.prepareBaseline(display));
  }

  prepareBaseline(display: BaselineDisplay | null): LocalDemMesh | null {
    return display === null ? null : new LocalDemMesh(this.viewer, display);
  }

  commitPreparedBaseline(next: LocalDemMesh | null): void {
    this.#baseline?.destroy();
    this.#baseline = next;
    this.viewer.scene.globe.show = next === null;
    this.viewer.scene.verticalExaggeration = next === null ? 4 : 1;
    this.setTerrainEnabled(this.#terrainEnabled);
    this.#container.dataset.demTriangles = String(next?.triangleCount ?? 0);
    this.#container.dataset.demGlobeUnderlay = next === null ? "procedural" : "absent";
    this.viewer.scene.requestRender();
  }

  focusBaselineCoverage(): void {
    this.#baseline?.focus(true);
  }

  focusWashingtonContext(): void {
    this.focusLongitudeLatitudeBounds(WASHINGTON_CONTEXT_BOUNDS);
  }

  focusLongitudeLatitudeBounds(
    bounds: readonly [west: number, south: number, east: number, north: number],
    minimumDistanceMetres = MINIMUM_BOUNDS_CAMERA_DISTANCE_METRES,
  ): void {
    if (bounds.length !== 4) {
      throw new TypeError("longitude/latitude bounds must contain exactly west, south, east, and north");
    }
    const [west, south, east, north] = bounds;
    if (![west, south, east, north].every(Number.isFinite)) {
      throw new TypeError("longitude/latitude bounds must contain only finite numbers");
    }
    if (west < -180 || west > 180 || east < -180 || east > 180) {
      throw new RangeError("longitude bounds must remain within -180 through 180 degrees");
    }
    if (south < -90 || south > 90 || north < -90 || north > 90) {
      throw new RangeError("latitude bounds must remain within -90 through 90 degrees");
    }
    if (west >= east) {
      throw new RangeError("longitude bounds must be strictly ordered west before east");
    }
    if (south >= north) {
      throw new RangeError("latitude bounds must be strictly ordered south before north");
    }
    if (
      !Number.isFinite(minimumDistanceMetres) ||
      minimumDistanceMetres <= 0 ||
      minimumDistanceMetres > MAXIMUM_BOUNDS_CAMERA_DISTANCE_METRES
    ) {
      throw new RangeError("minimum camera distance must be positive and within the supported bounds frame");
    }

    const centerLongitude = (west + east) / 2;
    const centerLatitude = (south + north) / 2;
    const latitudeSpanMetres = (north - south) * MEAN_METRES_PER_DEGREE_LATITUDE;
    const longitudeSpanMetres =
      (east - west) * MEAN_METRES_PER_DEGREE_LATITUDE * Math.cos(CesiumMath.toRadians(centerLatitude));
    const paddedSpanMetres = Math.max(latitudeSpanMetres, longitudeSpanMetres) * BOUNDS_CAMERA_PADDING;
    const cameraDistanceMetres = Math.min(
      MAXIMUM_BOUNDS_CAMERA_DISTANCE_METRES,
      Math.max(minimumDistanceMetres, paddedSpanMetres),
    );

    this.viewer.camera.setView({
      destination: Cartesian3.fromDegrees(centerLongitude, centerLatitude, cameraDistanceMetres),
      orientation: {
        heading: 0,
        pitch: CesiumMath.toRadians(-90),
        roll: 0,
      },
    });
    this.viewer.scene.requestRender();
  }

  focusLongitudeLatitudePoint(coordinate: LongitudeLatitude, clearanceMetres: number): void {
    const [longitude, latitude] = coordinate;
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new RangeError("focus longitude must remain within -180 through 180 degrees");
    }
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new RangeError("focus latitude must remain within -90 through 90 degrees");
    }
    if (!Number.isFinite(clearanceMetres) || clearanceMetres <= 0) {
      throw new RangeError("focus clearance must be a positive finite metre value");
    }
    const cameraDistanceMetres = Math.min(
      MAXIMUM_POINT_CAMERA_DISTANCE_METRES,
      Math.max(MINIMUM_POINT_CAMERA_DISTANCE_METRES, clearanceMetres * POINT_CAMERA_CLEARANCE_MULTIPLIER),
    );
    this.viewer.camera.setView({
      destination: Cartesian3.fromDegrees(longitude, latitude, cameraDistanceMetres),
      orientation: {
        heading: 0,
        pitch: CesiumMath.toRadians(-90),
        roll: 0,
      },
    });
    this.viewer.scene.requestRender();
  }

  setDrawingEnabled(enabled: boolean): void {
    this.#drawingEnabled = enabled;
    this.viewer.scene.screenSpaceCameraController.enableInputs = !enabled;
    this.viewer.scene.canvas.classList.toggle("is-drawing", enabled);
    this.viewer.scene.requestRender();
  }

  setDraftVertices(vertices: readonly LongitudeLatitude[]): void {
    for (const entity of this.#previewEntities) this.viewer.entities.remove(entity);
    this.#previewEntities = [];

    for (const [index, coordinate] of vertices.entries()) {
      this.#previewEntities.push(
        this.viewer.entities.add({
          id: `draft-vertex-${index}`,
          position: Cartesian3.fromDegrees(coordinate[0], coordinate[1]),
          point: {
            color: Color.fromCssColorString("#ffffff"),
            heightReference: HeightReference.CLAMP_TO_GROUND,
            outlineColor: Color.fromCssColorString("#152130"),
            outlineWidth: 2,
            pixelSize: 10,
          },
        }),
      );
    }

    if (vertices.length >= 2) {
      this.#previewEntities.push(
        this.viewer.entities.add({
          id: "draft-outline",
          polyline: {
            clampToGround: true,
            material: Color.WHITE,
            positions: Cartesian3.fromDegreesArray(flattened(vertices)),
            width: 3,
          },
        }),
      );
    }
    this.viewer.scene.requestRender();
  }

  renderPolygons(polygons: readonly DisplayPolygon[]): void {
    let configuredInteriorHoleCount = 0;
    let renderedResultEntityCount = 0;
    let renderedWaTribalEntityCount = 0;
    const incoming = new Set(polygons.map((polygon) => polygon.id));
    for (const [id, entity] of this.#displayEntities) {
      if (!incoming.has(id)) {
        this.viewer.entities.remove(entity);
        this.#displayEntities.delete(id);
        this.#displayEntityKinds.delete(id);
        this.#displayEntityRings.delete(id);
        this.#removeDisplayOutlines(id);
      }
    }

    for (const polygon of polygons) {
      const exterior = polygon.rings[0];
      const visible = polygon.visible && exterior !== undefined && exterior.length >= 3;
      if (visible) {
        configuredInteriorHoleCount += Math.max(0, polygon.rings.length - 1);
        if (polygon.id.startsWith("result-")) renderedResultEntityCount += 1;
        if (isWaTribalDisplayKind(polygon.kind)) renderedWaTribalEntityCount += 1;
      }

      const existing = this.#displayEntities.get(polygon.id);
      if (existing !== undefined) {
        const ringsKey = exactDisplayRingsKey(polygon.rings);
        const ringsChanged = this.#displayEntityRings.get(polygon.id) !== ringsKey;
        existing.name = polygon.label;
        existing.show = visible;
        if (ringsChanged) {
          const graphics = existing.polygon;
          if (graphics === undefined) {
            throw new TypeError(`display entity ${polygon.id} has no polygon graphics`);
          }
          graphics.hierarchy = new ConstantProperty(hierarchyForRings(polygon.rings));
          this.#displayEntityRings.set(polygon.id, ringsKey);
        }
        if (this.#displayEntityKinds.get(polygon.id) !== polygon.kind) {
          this.#applyDisplayStyle(existing, polygon);
        } else if (ringsChanged) {
          const outline = styleForKind(polygon.kind).outline;
          if (outline !== null) this.#syncDisplayOutlines(polygon, outline);
        }
        this.#setDisplayOutlineLabels(polygon.id, polygon.label);
        this.#setDisplayOutlinesVisible(polygon.id, visible);
        continue;
      }
      if (!visible) {
        continue;
      }

      const style = styleForKind(polygon.kind);
      const entity = this.viewer.entities.add({
        id: `display-${polygon.id}`,
        name: polygon.label,
        show: true,
        polygon: {
          hierarchy: hierarchyForRings(polygon.rings),
          material: style.fill,
          perPositionHeight: false,
        },
      });
      this.#displayEntities.set(polygon.id, entity);
      this.#displayEntityKinds.set(polygon.id, polygon.kind);
      this.#displayEntityRings.set(polygon.id, exactDisplayRingsKey(polygon.rings));
      const outline = style.outline;
      this.#displayOutlineEnabled.set(polygon.id, outline !== null);
      if (outline !== null) {
        this.#displayOutlineEntities.set(polygon.id, this.#createDisplayOutlines(polygon, outline));
      }
    }
    this.#container.dataset.cesiumResultEntities = String(renderedResultEntityCount);
    this.#container.dataset.cesiumWaTribalEntities = String(renderedWaTribalEntityCount);
    this.#container.dataset.cesiumConfiguredInteriorHoles = String(configuredInteriorHoleCount);
    this.viewer.scene.requestRender();
  }

  renderCandidates(candidates: readonly DisplayCandidate[]): void {
    const incoming = new Set(candidates.map((candidate) => candidate.id));
    for (const [id, entity] of this.#candidateEntities) {
      if (!incoming.has(id)) {
        this.viewer.entities.remove(entity);
        this.#candidateEntities.delete(id);
      }
    }

    for (const candidate of candidates) {
      const existing = this.#candidateEntities.get(candidate.id);
      if (existing !== undefined) this.viewer.entities.remove(existing);
      const exterior = candidate.rings[0];
      if (exterior === undefined || exterior.length < 3) {
        this.#candidateEntities.delete(candidate.id);
        continue;
      }

      const fill = candidate.selected
        ? Color.fromCssColorString("#8a7dff").withAlpha(0.7)
        : Color.fromCssColorString("#b5aaff").withAlpha(0.48);
      const entity = this.viewer.entities.add({
        id: `candidate-${candidate.id}`,
        name: candidate.name,
        polygon: {
          hierarchy: hierarchyForRings(candidate.rings),
          material: fill,
          perPositionHeight: false,
        },
      });
      this.#candidateEntities.set(candidate.id, entity);
    }
    this.viewer.scene.requestRender();
  }

  destroy(): void {
    this.#drawHandler.destroy();
    this.viewer.destroy();
  }

  #applyDisplayStyle(entity: Entity, polygon: DisplayPolygon): void {
    const graphics = entity.polygon;
    if (graphics === undefined) throw new TypeError(`display entity ${polygon.id} has no polygon graphics`);
    const style = styleForKind(polygon.kind);
    graphics.material = style.fill;
    this.#displayEntityKinds.set(polygon.id, polygon.kind);

    const outline = style.outline;
    this.#displayOutlineEnabled.set(polygon.id, outline !== null);
    if (outline === null) {
      this.#removeDisplayOutlines(polygon.id);
      return;
    }
    this.#syncDisplayOutlines(polygon, outline);
  }

  #syncDisplayOutlines(polygon: DisplayPolygon, outline: PolygonOutlineStyle): void {
    const existingOutlines = this.#displayOutlineEntities.get(polygon.id) ?? [];
    const synchronized: Entity[] = [];
    for (const [ringIndex, ring] of polygon.rings.entries()) {
      const outlineEntity = existingOutlines[ringIndex];
      if (outlineEntity === undefined) {
        synchronized.push(this.#createDisplayOutline(polygon, ring, ringIndex, outline));
        continue;
      }
      const polyline = outlineEntity.polyline;
      if (polyline === undefined) {
        throw new TypeError(`display outline entity ${outlineEntity.id} has no polyline graphics`);
      }
      outlineEntity.name = `${polygon.label} outline`;
      polyline.material = outline.material;
      polyline.positions = new ConstantProperty(Cartesian3.fromDegreesArray(flattened(ring)));
      polyline.width = new ConstantProperty(outline.width);
      synchronized.push(outlineEntity);
    }
    for (const staleOutline of existingOutlines.slice(polygon.rings.length)) {
      this.viewer.entities.remove(staleOutline);
    }
    this.#displayOutlineEnabled.set(polygon.id, true);
    this.#displayOutlineEntities.set(polygon.id, synchronized);
  }

  #createDisplayOutlines(polygon: DisplayPolygon, outline: PolygonOutlineStyle): Entity[] {
    return polygon.rings.map((ring, ringIndex) =>
      this.#createDisplayOutline(polygon, ring, ringIndex, outline),
    );
  }

  #createDisplayOutline(
    polygon: DisplayPolygon,
    ring: DisplayRing,
    ringIndex: number,
    outline: PolygonOutlineStyle,
  ): Entity {
    return this.viewer.entities.add({
      id: `display-outline-${polygon.id}-${ringIndex}`,
      name: `${polygon.label} outline`,
      show: true,
      polyline: {
        clampToGround: true,
        material: outline.material,
        positions: Cartesian3.fromDegreesArray(flattened(ring)),
        width: outline.width,
      },
    });
  }

  #removeDisplayOutlines(id: string): void {
    const outlines = this.#displayOutlineEntities.get(id);
    this.#displayOutlineEnabled.delete(id);
    if (outlines === undefined) return;
    for (const outline of outlines) this.viewer.entities.remove(outline);
    this.#displayOutlineEntities.delete(id);
  }

  #setDisplayOutlinesVisible(id: string, visible: boolean): void {
    const outlines = this.#displayOutlineEntities.get(id);
    if (outlines === undefined) return;
    const show = visible && (this.#displayOutlineEnabled.get(id) ?? false);
    for (const outline of outlines) outline.show = show;
  }

  #setDisplayOutlineLabels(id: string, label: string): void {
    const outlines = this.#displayOutlineEntities.get(id);
    if (outlines === undefined) return;
    for (const outline of outlines) outline.name = `${label} outline`;
  }

  #handleDrawClick(position: Cartesian2): void {
    if (!this.#drawingEnabled) return;
    const ray = this.viewer.camera.getPickRay(position);
    if (ray === undefined) return;
    const cartesian = this.viewer.scene.globe.pick(ray, this.viewer.scene);
    if (cartesian === undefined) return;
    const cartographic = Cartographic.fromCartesian(cartesian);
    this.#options.onDrawVertex([
      Number(CesiumMath.toDegrees(cartographic.longitude).toFixed(6)),
      Number(CesiumMath.toDegrees(cartographic.latitude).toFixed(6)),
    ]);
  }

  #addReferenceFrame(): void {
    this.viewer.entities.add({
      id: "synthetic-reference-frame",
      name: "Synthetic WA-region reference frame (not a boundary)",
      polyline: {
        clampToGround: true,
        material: Color.fromCssColorString("#d9fbff").withAlpha(0.9),
        positions: Cartesian3.fromDegreesArray(flattened(WASHINGTON_FRAME)),
        width: 2,
      },
    });

    for (let longitude = -124; longitude <= -117; longitude += 1) {
      this.viewer.entities.add({
        id: `reference-longitude-${longitude}`,
        polyline: {
          clampToGround: true,
          material: Color.fromCssColorString("#c0dce4").withAlpha(0.22),
          positions: Cartesian3.fromDegreesArray([longitude, 45.6, longitude, 49]),
          width: 1,
        },
      });
    }

    for (let latitude = 46; latitude <= 49; latitude += 1) {
      this.viewer.entities.add({
        id: `reference-latitude-${latitude}`,
        polyline: {
          clampToGround: true,
          material: Color.fromCssColorString("#c0dce4").withAlpha(0.22),
          positions: Cartesian3.fromDegreesArray([-124.8, latitude, -116.8, latitude]),
          width: 1,
        },
      });
    }
  }
}
