// ContourOverlay — samples MapLibre terrain elevation in a grid covering the current
// viewport, builds a triangulated plane in scene-meters coordinates, and renders
// magenta→cyan isohypses with a custom ShaderMaterial. Audio modulates line brightness.

import * as THREE from 'three';
import type { Map as MlMap, LngLatBounds } from 'maplibre-gl';
import type { AudioAnalyzer } from '../audio/AudioAnalyzer';
import { ThreeLayer } from './ThreeLayer';
import { PALETTE_GLSL } from '../palette/colorRamp';
import contourVert from '../shaders/contour.vert.glsl';
import contourFrag from '../shaders/contour.frag.glsl';

const GRID = 64; // GRID x GRID samples — balance between detail and FPS
const REBUILD_DEBOUNCE_MS = 220;

export class ContourOverlay {
  private mesh: THREE.Mesh | null = null;
  private material: THREE.ShaderMaterial;
  private rebuildTimer: number | null = null;
  private interval = 10;
  private opacity = 0.85;
  private lastMin = 0;
  private lastMax = 100;

  constructor(private map: MlMap, private layer: ThreeLayer) {
    // Append the palette function definition to satisfy the forward declaration in the shader.
    const frag = `${contourFrag}\n${PALETTE_GLSL}`;

    this.material = new THREE.ShaderMaterial({
      vertexShader: contourVert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      // Normal alpha blending — additive would brighten the dim gray into a glow
      // and break the "static dark theme" intent for the topography.
      blending: THREE.NormalBlending,
      uniforms: {
        uContourInterval: { value: this.interval },
        uLineWidth: { value: 1.4 },
        uMinElev: { value: 0 },
        uMaxElev: { value: 100 },
        uAudioLevel: { value: 0 },
        uBass: { value: 0 },
        uMid: { value: 0 },
        uTreble: { value: 0 },
        uAudioT: { value: 0 },
        uOpacity: { value: this.opacity }
      }
    });
  }

  attach(): void {
    const schedule = (): void => {
      if (this.rebuildTimer !== null) window.clearTimeout(this.rebuildTimer);
      this.rebuildTimer = window.setTimeout(() => this.rebuild(), REBUILD_DEBOUNCE_MS);
    };
    this.map.on('moveend', schedule);
    this.map.on('zoomend', schedule);
    this.map.on('load', schedule);
    // initial build (in case load already fired)
    schedule();
  }

  setInterval(meters: number): void {
    this.interval = Math.max(1, meters);
    this.material.uniforms['uContourInterval']!.value = this.interval;
  }

  tick(_a: AudioAnalyzer): void {
    // Intentionally inert: contour color is static in the dark theme.
    // Only StreetsLayer reacts to audio (color).
  }

  private rebuild(): void {
    const bounds: LngLatBounds = this.map.getBounds();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();

    // Re-anchor the layer origin near the current center to keep float precision good.
    const center = bounds.getCenter();
    this.layer.setOrigin([center.lng, center.lat]);

    // Sample elevation grid.
    const elevations = new Float32Array(GRID * GRID);
    let minE = Infinity;
    let maxE = -Infinity;
    let validCount = 0;
    for (let j = 0; j < GRID; j += 1) {
      const lat = sw.lat + ((ne.lat - sw.lat) * j) / (GRID - 1);
      for (let i = 0; i < GRID; i += 1) {
        const lng = sw.lng + ((ne.lng - sw.lng) * i) / (GRID - 1);
        // queryTerrainElevation returns meters, or null if no terrain coverage.
        const e = (this.map.queryTerrainElevation([lng, lat]) as number | null) ?? 0;
        elevations[j * GRID + i] = e;
        if (e < minE) minE = e;
        if (e > maxE) maxE = e;
        if (e !== 0) validCount += 1;
      }
    }
    if (!Number.isFinite(minE)) minE = 0;
    if (!Number.isFinite(maxE)) maxE = 1;
    if (maxE - minE < 1) maxE = minE + 1;
    this.lastMin = minE;
    this.lastMax = maxE;

    // If almost everything is 0, MapLibre hasn't loaded terrain yet — retry shortly.
    if (validCount < GRID) {
      window.setTimeout(() => this.rebuild(), 400);
    }

    // Build a position attribute in scene-meters coords.
    const positions = new Float32Array(GRID * GRID * 3);
    const elevAttr = new Float32Array(GRID * GRID);
    for (let j = 0; j < GRID; j += 1) {
      const lat = sw.lat + ((ne.lat - sw.lat) * j) / (GRID - 1);
      for (let i = 0; i < GRID; i += 1) {
        const lng = sw.lng + ((ne.lng - sw.lng) * i) / (GRID - 1);
        const idx = j * GRID + i;
        const e = elevations[idx]!;
        const p = this.layer.project(lng, lat, e + 1.5); // small lift to avoid Z-fighting with terrain
        positions[idx * 3] = p.x;
        positions[idx * 3 + 1] = p.y;
        positions[idx * 3 + 2] = p.z;
        elevAttr[idx] = e;
      }
    }

    const uvs = new Float32Array(GRID * GRID * 2);
    for (let j = 0; j < GRID; j += 1) {
      for (let i = 0; i < GRID; i += 1) {
        uvs[(j * GRID + i) * 2] = i / (GRID - 1);
        uvs[(j * GRID + i) * 2 + 1] = j / (GRID - 1);
      }
    }

    const indices: number[] = [];
    for (let j = 0; j < GRID - 1; j += 1) {
      for (let i = 0; i < GRID - 1; i += 1) {
        const a = j * GRID + i;
        const b = j * GRID + i + 1;
        const c = (j + 1) * GRID + i;
        const d = (j + 1) * GRID + i + 1;
        indices.push(a, b, d, a, d, c);
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geom.setAttribute('aElevation', new THREE.BufferAttribute(elevAttr, 1));
    geom.setIndex(indices);
    geom.computeBoundingSphere();

    if (this.mesh) {
      this.layer.removeObject(this.mesh);
      this.mesh.geometry.dispose();
    }
    this.mesh = new THREE.Mesh(geom, this.material);
    this.mesh.renderOrder = 1;
    this.layer.addObject(this.mesh);

    this.material.uniforms['uMinElev']!.value = minE;
    this.material.uniforms['uMaxElev']!.value = maxE;

    this.updatePaletteUI(minE, maxE);
  }

  private updatePaletteUI(minE: number, maxE: number): void {
    const marker = document.getElementById('palette-marker');
    if (!marker) return;
    marker.dataset['min'] = String(minE);
    marker.dataset['max'] = String(maxE);
    // For the contour, the visible range maps to [0,1] in the palette directly.
    marker.dataset['tmin'] = '0';
    marker.dataset['tmax'] = '1';
  }

  /** Expose last range to other modules if needed. */
  getElevationRange(): readonly [number, number] {
    return [this.lastMin, this.lastMax];
  }
}
