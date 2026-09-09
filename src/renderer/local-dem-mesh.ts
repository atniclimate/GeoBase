import BoundingSphere from "@cesium/engine/Source/Core/BoundingSphere.js";
import Cartesian3 from "@cesium/engine/Source/Core/Cartesian3.js";
import Color from "@cesium/engine/Source/Core/Color.js";
import ColorGeometryInstanceAttribute from "@cesium/engine/Source/Core/ColorGeometryInstanceAttribute.js";
import ComponentDatatype from "@cesium/engine/Source/Core/ComponentDatatype.js";
import Geometry from "@cesium/engine/Source/Core/Geometry.js";
import GeometryAttribute from "@cesium/engine/Source/Core/GeometryAttribute.js";
import GeometryAttributes from "@cesium/engine/Source/Core/GeometryAttributes.js";
import GeometryInstance from "@cesium/engine/Source/Core/GeometryInstance.js";
import GeometryPipeline from "@cesium/engine/Source/Core/GeometryPipeline.js";
import HeadingPitchRange from "@cesium/engine/Source/Core/HeadingPitchRange.js";
import PrimitiveType from "@cesium/engine/Source/Core/PrimitiveType.js";
import PerInstanceColorAppearance from "@cesium/engine/Source/Scene/PerInstanceColorAppearance.js";
import Primitive from "@cesium/engine/Source/Scene/Primitive.js";
import type CesiumWidget from "@cesium/engine/Source/Widget/CesiumWidget.js";
import type { BaselineDisplay } from "../core/baseline/manifest";

/** Display-only triangle geometry. The mesh never supplies scientific query values. */
export class LocalDemMesh {
  readonly primitive: Primitive;
  readonly bounds: BoundingSphere;
  readonly triangleCount: number;

  constructor(
    private readonly viewer: CesiumWidget,
    display: BaselineDisplay,
  ) {
    this.triangleCount = display.indices.length / 3;
    const coordinates = new Float64Array(display.positions.length * 3);
    for (const [index, [longitude, latitude, relativeHeight]] of display.positions.entries()) {
      // Explicit relative-relief convention: source reference subtracted by the compiler,
      // placed on the display ellipsoid at x1; this is not a vertical-datum conversion.
      const point = Cartesian3.fromDegrees(longitude, latitude, relativeHeight);
      coordinates.set([point.x, point.y, point.z], index * 3);
    }
    this.bounds = BoundingSphere.fromVertices(coordinates);
    const attributes = new GeometryAttributes();
    attributes.position = new GeometryAttribute({
      componentDatatype: ComponentDatatype.DOUBLE,
      componentsPerAttribute: 3,
      values: coordinates,
    });
    const geometry = new Geometry({
      attributes,
      indices: new Uint32Array(display.indices),
      primitiveType: PrimitiveType.TRIANGLES,
      boundingSphere: this.bounds,
    });
    GeometryPipeline.computeNormal(geometry);
    this.primitive = viewer.scene.primitives.add(
      new Primitive({
        geometryInstances: new GeometryInstance({
          geometry,
          attributes: {
            color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString("#d8b478")),
          },
        }),
        appearance: new PerInstanceColorAppearance({
          flat: false,
          translucent: false,
          closed: false,
          renderState: { cull: { enabled: false } },
        }),
        asynchronous: false,
        allowPicking: false,
        show: false,
      }),
    );
  }

  focus(overhead = false): void {
    this.viewer.camera.flyToBoundingSphere(this.bounds, {
      duration: 0,
      offset: new HeadingPitchRange(
        0,
        ((overhead ? -90 : -55) * Math.PI) / 180,
        Math.max(100, this.bounds.radius * 3.2),
      ),
    });
    this.viewer.scene.requestRender();
  }

  destroy(): void {
    this.viewer.scene.primitives.remove(this.primitive);
  }
}
