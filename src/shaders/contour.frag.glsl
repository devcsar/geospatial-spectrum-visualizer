// Contour line fragment shader — draws topographic isohypses on a plane sampled
// against MapLibre terrain. Color is intentionally static (dark theme); only the
// StreetsLayer is audio-reactive in this build.

precision highp float;

uniform float uContourInterval;  // metros entre líneas
uniform float uLineWidth;        // grosor en metros
uniform float uMinElev;
uniform float uMaxElev;
uniform float uAudioLevel;
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uAudioT;
uniform float uOpacity;

varying float vElevation;
varying vec2 vUv;

vec3 paletteMagentaCyan(float t);

void main() {
  float interval = max(uContourInterval, 0.5);
  float mod_e = mod(vElevation, interval);
  float dist_to_line = min(mod_e, interval - mod_e);
  float w = max(uLineWidth, 0.1);
  float line = 1.0 - smoothstep(0.0, w, dist_to_line);

  // Static dim gray for the contours — they belong to the dark map theme.
  vec3 color = vec3(0.22);

  float alpha = line * uOpacity * 0.6;
  gl_FragColor = vec4(color, alpha);
}
