// Magenta → púrpura → azul eléctrico → cyan palette.
// Used by:
//   - JS UI (palette bar in the bottom-right overlay)
//   - Three.js shaders (injected as a GLSL function via PALETTE_GLSL)

export type RGB = readonly [number, number, number];

export const PALETTE_STOPS: ReadonlyArray<readonly [number, RGB]> = [
  [0.0, [0.85, 0.1, 0.95]], // magenta
  [0.25, [0.55, 0.05, 0.75]], // púrpura
  [0.5, [0.2, 0.1, 0.85]], // azul-púrpura
  [0.75, [0.15, 0.4, 1.0]], // azul eléctrico
  [1.0, [0.0, 0.85, 1.0]] // cyan
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRGB(a: RGB, b: RGB, t: number): RGB {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function sampleColor(t: number): RGB {
  const clamped = Math.min(1, Math.max(0, t));
  for (let i = 0; i < PALETTE_STOPS.length - 1; i += 1) {
    const cur = PALETTE_STOPS[i]!;
    const nxt = PALETTE_STOPS[i + 1]!;
    if (clamped <= nxt[0]) {
      const span = nxt[0] - cur[0];
      const local = span === 0 ? 0 : (clamped - cur[0]) / span;
      return lerpRGB(cur[1], nxt[1], local);
    }
  }
  return PALETTE_STOPS[PALETTE_STOPS.length - 1]![1];
}

/**
 * Map an audio snapshot to a position along the magenta→cyan ramp.
 * Bass dominance → magenta end; treble dominance → cyan end.
 * Shared by every reactive layer so contours, buildings and streets stay coherent.
 */
export function audioPaletteT(a: { bass: number; mid: number; treble: number }): number {
  const total = a.bass + a.mid + a.treble + 1e-4;
  // Weighted centroid: bass=0, mid=0.55, treble=1.
  const t = (a.bass * 0 + a.mid * 0.55 + a.treble * 1.0) / total;
  return Math.min(1, Math.max(0, t));
}

export function rgbToHex(rgb: RGB): string {
  const to = (v: number): string => {
    const n = Math.round(Math.min(1, Math.max(0, v)) * 255);
    return n.toString(16).padStart(2, '0');
  };
  return `#${to(rgb[0])}${to(rgb[1])}${to(rgb[2])}`;
}

export function cssGradient(): string {
  return `linear-gradient(90deg, ${PALETTE_STOPS.map(
    ([pos, rgb]) => `${rgbToHex(rgb)} ${(pos * 100).toFixed(0)}%`
  ).join(', ')})`;
}

/** GLSL snippet that exposes `vec3 paletteMagentaCyan(float t)`. Inject into shaders. */
export const PALETTE_GLSL = /* glsl */ `
vec3 paletteMagentaCyan(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.85, 0.10, 0.95);
  vec3 c1 = vec3(0.55, 0.05, 0.75);
  vec3 c2 = vec3(0.20, 0.10, 0.85);
  vec3 c3 = vec3(0.15, 0.40, 1.00);
  vec3 c4 = vec3(0.00, 0.85, 1.00);
  if (t < 0.25)      return mix(c0, c1, t / 0.25);
  else if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);
  else if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);
  else               return mix(c3, c4, (t - 0.75) / 0.25);
}
`;
