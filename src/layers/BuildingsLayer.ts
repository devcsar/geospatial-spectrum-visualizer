// BuildingsLayer — reads OSM building footprints from the Protomaps vector source
// and extrudes them as static dim wireframes. Building color is part of the dark
// map theme; only StreetsLayer reacts to audio.

import * as THREE from 'three';
import type { Map as MlMap, MapGeoJSONFeature } from 'maplibre-gl';
import type { AudioAnalyzer } from '../audio/AudioAnalyzer';
import { ThreeLayer } from './ThreeLayer';

const REBUILD_DEBOUNCE_MS = 280;
const MAX_BUILDINGS = 700;

// Protomaps v3 buildings schema exposes:
//   height (Number), layer (Number), pmap:kind (String), pmap:kind_detail (String)
// `pmap:kind` is one of: building, building_part. We treat both the same.
type Props = Record<string, unknown>;

function readNum(props: Props, key: string): number | null {
  const v = props[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function readHeight(props: Props): number {
  const h = readNum(props, 'height');
  if (h !== null && h > 0) return h;
  // No height tag — fall back to a reasonable default so tall structures still show up.
  return 8;
}

export class BuildingsLayer {
  private group = new THREE.Group();
  private material: THREE.LineBasicMaterial;
  private rebuildTimer: number | null = null;

  constructor(private map: MlMap, private layer: ThreeLayer) {
    this.material = new THREE.LineBasicMaterial({
      // Static dim wireframe — buildings stay in the dark theme; only streets react to audio.
      vertexColors: false,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      color: 0x2a2a2a
    });
    this.group.renderOrder = 2;
  }

  attach(): void {
    this.layer.addObject(this.group);
    const schedule = (): void => {
      if (this.rebuildTimer !== null) window.clearTimeout(this.rebuildTimer);
      this.rebuildTimer = window.setTimeout(() => this.rebuild(), REBUILD_DEBOUNCE_MS);
    };
    this.map.on('moveend', schedule);
    this.map.on('zoomend', schedule);
    this.map.on('sourcedata', (e) => {
      if (e.sourceId === 'protomaps' && e.isSourceLoaded) schedule();
    });
    schedule();
  }

  setGlow(_v: number): void {
    // No-op: buildings are static in the dark theme.
  }

  tick(_a: AudioAnalyzer): void {
    // Intentionally inert: buildings stay in the dark map theme.
    // Only StreetsLayer reacts to audio (color).
  }

  private rebuild(): void {
    if (!this.map.getSource('protomaps')) return;
    let features: MapGeoJSONFeature[] = [];
    try {
      features = this.map.querySourceFeatures('protomaps', {
        sourceLayer: 'buildings'
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[buildings] querySourceFeatures failed', err);
      return;
    }
    if (features.length === 0) return;

    // Sort by height desc and cap.
    features.sort(
      (a, b) => readHeight(b.properties as Props) - readHeight(a.properties as Props)
    );
    const sliced = features.slice(0, MAX_BUILDINGS);

    // Dispose previous group children.
    for (const child of this.group.children) {
      if (child instanceof THREE.LineSegments) {
        child.geometry.dispose();
      }
    }
    this.group.clear();

    let maxH = 1;
    let totalSegs = 0;

    // Merge into one big BufferGeometry to keep draw calls low.
    const posChunks: number[] = [];

    for (const f of sliced) {
      const props = f.properties as Props;
      const height = readHeight(props);
      const minH = 0; // Protomaps v3 does not expose min_height
      const extrudeH = Math.max(2, height - minH);
      if (height > maxH) maxH = height;

      const geom = f.geometry;
      if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') continue;
      const polys: number[][][][] = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;

      for (const poly of polys) {
        const outer = poly[0];
        if (!outer || outer.length < 3) continue;
        // Build a 2D shape from the outer ring (ignore holes for wireframe).
        const shape = new THREE.Shape();
        const baseElev = this.queryElevAt(outer[0]?.[0] ?? 0, outer[0]?.[1] ?? 0);
        for (let i = 0; i < outer.length; i += 1) {
          const pt = outer[i];
          if (!pt) continue;
          const v = this.layer.project(pt[0]!, pt[1]!, 0);
          if (i === 0) shape.moveTo(v.x, v.y);
          else shape.lineTo(v.x, v.y);
        }
        let extrude: THREE.ExtrudeGeometry;
        try {
          extrude = new THREE.ExtrudeGeometry(shape, { depth: extrudeH, bevelEnabled: false });
        } catch {
          continue;
        }
        // Lift to base elev + minH
        extrude.translate(0, 0, baseElev + minH);

        const edges = new THREE.EdgesGeometry(extrude, 15);
        extrude.dispose();
        const posAttr = edges.getAttribute('position');
        if (!posAttr) {
          edges.dispose();
          continue;
        }
        const count = posAttr.count;
        const arr = posAttr.array as Float32Array;
        const baseZ = baseElev + minH;
        for (let i = 0; i < count; i += 1) {
          const z = arr[i * 3 + 2] ?? baseZ;
          posChunks.push(arr[i * 3]!, arr[i * 3 + 1]!, z);
        }
        totalSegs += count / 2;
        edges.dispose();
      }
    }

    if (posChunks.length === 0) return;

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posChunks), 3));
    merged.computeBoundingSphere();

    const lines = new THREE.LineSegments(merged, this.material);
    this.group.add(lines);

    // eslint-disable-next-line no-console
    console.debug(`[buildings] ${sliced.length} features → ${totalSegs} segments, maxH ${maxH.toFixed(0)}m`);
  }

  private queryElevAt(lng: number, lat: number): number {
    return (this.map.queryTerrainElevation([lng, lat]) as number | null) ?? 0;
  }
}
