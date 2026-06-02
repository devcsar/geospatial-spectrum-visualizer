// ThreeLayer — a MapLibre CustomLayerInterface that renders a Three.js scene on top of
// the map using MapLibre's WebGL context. Sub-layers (Buildings, Streets, Contour) attach
// their own meshes to `this.scene` via addObject().

import {
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map as MlMap,
  MercatorCoordinate
} from 'maplibre-gl';
import type { mat4 } from 'gl-matrix';
import * as THREE from 'three';

export interface AudioUniforms {
  overall: number;
  bass: number;
  mid: number;
  treble: number;
}

export interface ThreeLayerHooks {
  onAdd?: (layer: ThreeLayer) => void;
  beforeRender?: (layer: ThreeLayer, audio: AudioUniforms) => void;
}

export class ThreeLayer implements CustomLayerInterface {
  readonly id = 'three-topo';
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  scene = new THREE.Scene();
  camera = new THREE.Camera();
  renderer!: THREE.WebGLRenderer;
  map!: MlMap;
  origin!: MercatorCoordinate;
  /** mercator units per meter at the origin latitude (uniform across X/Y for our origin). */
  metersPerUnit = 1;

  audio: AudioUniforms = { overall: 0, bass: 0, mid: 0, treble: 0 };
  private hooks: ThreeLayerHooks;

  constructor(originLngLat: [number, number], hooks: ThreeLayerHooks = {}) {
    this.hooks = hooks;
    this.origin = MercatorCoordinate.fromLngLat(originLngLat, 0);
    this.metersPerUnit = 1 / this.origin.meterInMercatorCoordinateUnits();
  }

  /** Move the world origin (used when the user pans far from initial center). */
  setOrigin(lngLat: [number, number]): void {
    this.origin = MercatorCoordinate.fromLngLat(lngLat, 0);
    this.metersPerUnit = 1 / this.origin.meterInMercatorCoordinateUnits();
  }

  /** Convert a [lng, lat, altitudeMeters] into local scene coordinates (meters from origin). */
  project(lng: number, lat: number, altitude = 0): THREE.Vector3 {
    const mc = MercatorCoordinate.fromLngLat([lng, lat], altitude);
    const mPerUnit = this.origin.meterInMercatorCoordinateUnits();
    // delta in mercator units, scaled into meters
    return new THREE.Vector3(
      (mc.x - this.origin.x) / mPerUnit,
      (this.origin.y - mc.y) / mPerUnit, // flip Y so North is +Y in scene space (we rotate below)
      altitude
    );
  }

  addObject(obj: THREE.Object3D): void {
    this.scene.add(obj);
  }

  removeObject(obj: THREE.Object3D): void {
    this.scene.remove(obj);
  }

  onAdd(map: MlMap, gl: WebGL2RenderingContext | WebGLRenderingContext): void {
    this.map = map;

    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl as WebGLRenderingContext,
      antialias: true,
      premultipliedAlpha: true
    });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.hooks.onAdd?.(this);
  }

  render(
    _gl: WebGLRenderingContext | WebGL2RenderingContext,
    matrix: mat4,
    _opts: CustomRenderMethodInput
  ): void {
    // Build the model-to-clip matrix that MapLibre expects for our origin.
    // We anchor the scene at `this.origin` in mercator units, undo Y flip, and scale meters → mercator.
    const m = new THREE.Matrix4().fromArray(matrix as unknown as number[]);
    const mPerUnit = this.origin.meterInMercatorCoordinateUnits();

    // Translate to origin in mercator, scale meters→mercator. MapLibre's mercator Y axis points
    // down (north is smaller Y), so we negate Y scale to match our +Y = north convention from project().
    const l = new THREE.Matrix4()
      .makeTranslation(this.origin.x, this.origin.y, 0)
      .scale(new THREE.Vector3(mPerUnit, -mPerUnit, mPerUnit));

    this.camera.projectionMatrix = m.multiply(l);
    // Three doesn't auto-update matrixWorldInverse when we set projectionMatrix directly;
    // since our scene lives in world coords already, identity world inverse is correct.
    this.camera.matrixWorldInverse.identity();
    this.camera.matrixWorld.identity();

    this.hooks.beforeRender?.(this, this.audio);

    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);

    // Keep the loop running while audio is being analyzed.
    this.map.triggerRepaint();
  }

  setAudio(a: AudioUniforms): void {
    this.audio = a;
  }
}

/** Convenience: drop a small magenta wireframe cube at the given lng/lat to visually
 *  verify the layer is wired up correctly. Useful during bring-up. */
export function debugCube(layer: ThreeLayer, lngLat: [number, number], sizeM = 200): THREE.LineSegments {
  const geom = new THREE.BoxGeometry(sizeM, sizeM, sizeM);
  const edges = new THREE.EdgesGeometry(geom);
  const mat = new THREE.LineBasicMaterial({ color: 0xd000ff, linewidth: 1 });
  const cube = new THREE.LineSegments(edges, mat);
  const p = layer.project(lngLat[0], lngLat[1], sizeM * 0.5);
  cube.position.copy(p);
  return cube;
}
