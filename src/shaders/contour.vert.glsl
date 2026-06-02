// Pass-through vertex shader that forwards `aElevation` (per-vertex meters) to the fragment.

attribute float aElevation;

varying float vElevation;
varying vec2 vUv;

void main() {
  vElevation = aElevation;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
