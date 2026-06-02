// StreetsLayer — reads OSM road centerlines from Protomaps and renders them as a
// flat network of glowing lines. Color is driven by two layered effects:
//   1. A slow radial palette sweep (center → edges), drifting with audio.
//   2. "Raindrop" ripples: every BEAT (broadband onset / spectral flux spike)
//      seeds a new wavefront that propagates OUTWARD from the view center. Each
//      drop captures its own palette position at trigger time and "paints" a
//      colored, soft trail behind its leading edge — there is no contribution
//      ahead of the front and no inward motion, so a wave never returns to the
//      origin. Consecutive waves blend through the long trailing wake, so the
//      color hand-off between one beat and the next is smooth and elegant.
//
// Performance notes:
//   - No terrain elevation queries during rebuild (queryTerrainElevation is the
//     single slowest call we had — sampling raster tiles on the CPU).
//   - Streets render flat at a small lift; depthTest disabled so they always show.
//   - One merged BufferGeometry, one ShaderMaterial, one draw call.
//   - Ripples are computed entirely on the GPU from small uniform arrays.

import * as THREE from 'three';
import type { Map as MlMap, MapGeoJSONFeature } from 'maplibre-gl';
import type { AudioAnalyzer } from '../audio/AudioAnalyzer';
import { ThreeLayer } from './ThreeLayer';
import { PALETTE_GLSL, audioPaletteT } from '../palette/colorRamp';

const REBUILD_DEBOUNCE_MS = 220;
const MAX_FEATURES = 8000;
const STREET_LIFT_M = 1.5;

// How many simultaneous ripples we can carry. Older drops fade out naturally as
// their age exceeds uDropLifetime, so the ring buffer wraps cleanly.
const MAX_DROPS = 8;

// Wavefront timing. Lifetime is generous so two consecutive beats overlap in
// their painted trails — that overlap is what produces the soft color hand-off.
const DROP_LIFETIME_S = 3.4; // seconds for the wavefront to travel r=0 → r=1
const DROP_MIN_COOLDOWN = 0.12; // seconds between successive drops (beat debounce)

// Beat detection thresholds, driven by spectral flux (broadband onset function).
const FLUX_FLOOR = 0.035;
const FLUX_RATIO = 1.6;
// Amplitude carried by each ripple is flux × this multiplier (raw flux is small,
// typically 0.03–0.15 on strong beats — scale into the visible 0..1 range).
const FLUX_AMP_GAIN = 7.0;

// Each new drop advances the palette cursor by this fraction of a full cycle
// (in addition to whatever offset the audio centroid contributes). With ~9
// beats for a full cycle, consecutive waves land on visibly distinct hues even
// when the audio centroid is steady, which is what makes the color hand-off
// "elegant" rather than monotonous.
const PALETTE_STEP_PER_BEAT = 0.11;

type Props = Record<string, unknown>;

function readKind(props: Props): string {
  const k = props['pmap:kind'];
  return typeof k === 'string' ? k : 'other';
}

const KIND_WEIGHT: Record<string, number> = {
  highway: 1.0,
  major_road: 0.9,
  medium_road: 0.8,
  minor_road: 0.7,
  other: 0.5,
  path: 0.35,
  rail: 0.5,
  transit: 0.5
};

const VERT_SHADER = /* glsl */ `
  precision highp float;
  uniform vec2 uCenter;
  uniform float uMaxRadius;
  varying float vRadial;
  void main() {
    vec2 d = position.xy - uCenter;
    vRadial = clamp(length(d) / max(uMaxRadius, 1.0), 0.0, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG_SHADER = /* glsl */ `
  precision highp float;
  uniform float uAudioT;
  uniform float uTreble;
  uniform float uTime;
  uniform float uSpread;
  uniform float uOpacity;
  uniform float uDropTimes[${MAX_DROPS}];
  uniform float uDropAmps[${MAX_DROPS}];
  uniform float uDropTs[${MAX_DROPS}];
  uniform float uDropLifetime;
  varying float vRadial;
  vec3 paletteMagentaCyan(float t);

  void main() {
    float r = vRadial;

    // ---- Base palette sweep ---------------------------------------------------
    // Slow radial gradient that's always alive, with a slight time drift and an
    // audio-tinted shift. This is what shows in silence.
    float baseT = uAudioT * 0.5 + uTime * 0.06 + r * uSpread;
    vec3 baseCol = paletteMagentaCyan(fract(baseT));

    // ---- Wave contributions ---------------------------------------------------
    // For each alive drop, the wavefront is at radius "front = age01". The wave
    // ONLY contributes for r <= front — i.e. it has already swept past this
    // radius. Behind the front, a soft trailing "paint" decays with time-since-
    // passage so consecutive waves blend their colors smoothly in the overlap.
    vec3 paintCol = vec3(0.0);
    float paintWeight = 0.0;
    float ringSum = 0.0;

    for (int i = 0; i < ${MAX_DROPS}; i++) {
      float age = uTime - uDropTimes[i];
      if (age > 0.0 && age < uDropLifetime) {
        float age01 = age / uDropLifetime;
        float front = age01;
        // Strict outward-only: skip everything ahead of the wavefront.
        if (r <= front) {
          // Time (in seconds) since the wavefront passed this radius.
          float dtPassed = (front - r) * uDropLifetime;

          // Soft trailing paint, ~1.3s tau — wide enough that successive waves
          // overlap in their colored regions and blend instead of cutting hard.
          float paint = exp(-dtPassed * 0.75);

          // Overall fade as the whole drop ages out toward the edge.
          float ageFade = 1.0 - age01;

          float amp = clamp(uDropAmps[i], 0.0, 1.5);
          float w = paint * ageFade * amp;
          paintCol += paletteMagentaCyan(uDropTs[i]) * w;
          paintWeight += w;

          // A separate sharp brightness ring sitting right at the wavefront,
          // so each beat reads as a crisp expanding pulse on top of the soft
          // colored wake.
          float ring = exp(-dtPassed * dtPassed * 60.0);
          ringSum += ring * ageFade * amp;
        }
      }
    }

    // ---- Compose --------------------------------------------------------------
    // The painted color (weighted average across overlapping waves) blends
    // smoothly with the base sweep through paintMix, eliminating any hard
    // boundary at the wavefront or between successive waves.
    vec3 paintAvg = paintWeight > 0.0001 ? paintCol / paintWeight : baseCol;
    float paintMix = clamp(paintWeight * 1.4, 0.0, 1.0);
    vec3 col = mix(baseCol, paintAvg, paintMix);

    float boost = 1.0 + ringSum * 1.5 + uTreble * 0.2;
    float alpha = clamp(uOpacity + ringSum * 0.35, 0.0, 1.0);
    gl_FragColor = vec4(col * boost, alpha);
  }
`;

export class StreetsLayer {
  private group = new THREE.Group();
  private material: THREE.ShaderMaterial;
  private mesh: THREE.LineSegments | null = null;
  private rebuildTimer: number | null = null;
  private timeStart = performance.now();

  // Ring buffers of drop birth times, amplitudes and palette positions
  // (one slot per simultaneous wave). Time slots initialised far in the past
  // so they read as "dead" until overwritten.
  private drops = new Float32Array(MAX_DROPS);
  private dropAmps = new Float32Array(MAX_DROPS);
  private dropTs = new Float32Array(MAX_DROPS);
  private fluxEnvelope = 0;
  private lastDrop = -1000;
  // Cursor advanced by PALETTE_STEP_PER_BEAT on every emitted drop. Together
  // with the audio centroid this gives each successive wave a distinct hue.
  private paletteCursor = 0;

  constructor(private map: MlMap, private layer: ThreeLayer) {
    this.drops.fill(-1000);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT_SHADER,
      fragmentShader: `${FRAG_SHADER}\n${PALETTE_GLSL}`,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      // Additive over the near-black map base — colors really pop.
      blending: THREE.AdditiveBlending,
      uniforms: {
        uCenter: { value: new THREE.Vector2(0, 0) },
        uMaxRadius: { value: 4000 },
        uAudioT: { value: 0 },
        uTreble: { value: 0 },
        uTime: { value: 0 },
        uSpread: { value: 0.7 },
        uOpacity: { value: 0.9 },
        uDropTimes: { value: this.drops },
        uDropAmps: { value: this.dropAmps },
        uDropTs: { value: this.dropTs },
        uDropLifetime: { value: DROP_LIFETIME_S }
      }
    });
    this.group.renderOrder = 3;
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

  setGlow(v: number): void {
    this.material.uniforms['uOpacity']!.value = Math.min(1, 0.55 + v * 0.35);
  }

  tick(a: AudioAnalyzer): void {
    const u = this.material.uniforms;
    const t = (performance.now() - this.timeStart) / 1000;
    u['uTime']!.value = t;
    u['uAudioT']!.value = audioPaletteT(a);
    u['uTreble']!.value = a.treble;

    // Track the gradient anchor every frame so ripples follow the camera smoothly
    // between rebuilds (rebuilds happen on moveend, which can lag).
    const c = this.map.getCenter();
    const cVec = this.layer.project(c.lng, c.lat, 0);
    (u['uCenter']!.value as THREE.Vector2).set(cVec.x, cVec.y);
    const bounds = this.map.getBounds();
    const ne = bounds.getNorthEast();
    const neVec = this.layer.project(ne.lng, ne.lat, 0);
    const dx = neVec.x - cVec.x;
    const dy = neVec.y - cVec.y;
    u['uMaxRadius']!.value = Math.max(500, Math.hypot(dx, dy));

    // Beat detection via spectral flux. Envelope decays fast enough that beats
    // at 100–160 BPM clearly stand out against the running level.
    this.fluxEnvelope = this.fluxEnvelope * 0.85 + a.flux * 0.15;
    if (
      t - this.lastDrop >= DROP_MIN_COOLDOWN &&
      a.flux > FLUX_FLOOR &&
      a.flux > this.fluxEnvelope * FLUX_RATIO
    ) {
      const amp = Math.min(1.2, a.flux * FLUX_AMP_GAIN);
      // Palette position for this beat: audio centroid + per-beat cursor drift.
      // The fract wraps so the palette cycles smoothly across many beats.
      this.paletteCursor = (this.paletteCursor + PALETTE_STEP_PER_BEAT) % 1;
      const paletteT = (audioPaletteT(a) * 0.55 + this.paletteCursor) % 1;
      this.emitDrop(t, amp, paletteT);
    }
  }

  private emitDrop(t: number, amp: number, paletteT: number): void {
    // Shift the ring buffer right; freshest drop lands at slot 0.
    for (let i = this.drops.length - 1; i > 0; i -= 1) {
      this.drops[i] = this.drops[i - 1]!;
      this.dropAmps[i] = this.dropAmps[i - 1]!;
      this.dropTs[i] = this.dropTs[i - 1]!;
    }
    this.drops[0] = t;
    this.dropAmps[0] = amp;
    this.dropTs[0] = paletteT;
    this.lastDrop = t;
  }

  private rebuild(): void {
    if (!this.map.getSource('protomaps')) return;
    let features: MapGeoJSONFeature[] = [];
    try {
      features = this.map.querySourceFeatures('protomaps', { sourceLayer: 'roads' });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[streets] querySourceFeatures failed', err);
      return;
    }
    if (features.length === 0) return;

    // Prefer larger roads first so the cap keeps the most visually meaningful network.
    features.sort((a, b) => {
      const wa = KIND_WEIGHT[readKind(a.properties as Props)] ?? 0.2;
      const wb = KIND_WEIGHT[readKind(b.properties as Props)] ?? 0.2;
      return wb - wa;
    });
    const sliced = features.slice(0, MAX_FEATURES);

    // Dispose previous mesh.
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.group.remove(this.mesh);
      this.mesh = null;
    }

    const positions: number[] = [];
    const z = STREET_LIFT_M;

    for (const f of sliced) {
      const geom = f.geometry;
      if (geom.type !== 'LineString' && geom.type !== 'MultiLineString') continue;
      const lines: number[][][] =
        geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;
      for (const line of lines) {
        if (line.length < 2) continue;
        for (let i = 0; i < line.length - 1; i += 1) {
          const a = line[i];
          const b = line[i + 1];
          if (!a || !b) continue;
          const va = this.layer.project(a[0]!, a[1]!, z);
          const vb = this.layer.project(b[0]!, b[1]!, z);
          positions.push(va.x, va.y, va.z, vb.x, vb.y, vb.z);
        }
      }
    }

    if (positions.length === 0) return;

    const merged = new THREE.BufferGeometry();
    merged.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(positions), 3)
    );
    merged.computeBoundingSphere();

    this.mesh = new THREE.LineSegments(merged, this.material);
    this.group.add(this.mesh);

    // eslint-disable-next-line no-console
    console.debug(
      `[streets] ${sliced.length} features → ${positions.length / 6} segments`
    );
  }
}
