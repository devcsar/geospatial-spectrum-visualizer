// AutoFly — when enabled, rotates bearing, oscillates pitch, and "breathes" zoom
// reactive to audio. Pan stays under user control. Smoothed via per-frame lerp.

import type { Map as MlMap } from 'maplibre-gl';
import type { AudioSnapshot, AudioAnalyzer } from '../audio/AudioAnalyzer';

export class AutoFly {
  enabled = false;
  private baseZoom = 13;
  private basePitch = 55;
  private bearing = -20;
  private t = 0;

  constructor(private map: MlMap) {}

  setEnabled(v: boolean): void {
    this.enabled = v;
    if (v) {
      this.baseZoom = this.map.getZoom();
      this.basePitch = this.map.getPitch();
      this.bearing = this.map.getBearing();
    }
  }

  tick(dt: number, a: AudioAnalyzer | AudioSnapshot): void {
    if (!this.enabled) return;
    this.t += dt;
    const bass = 'bass' in a ? a.bass : 0;
    const mid = 'mid' in a ? a.mid : 0;
    const treble = 'treble' in a ? a.treble : 0;

    // Bearing: slow rotation + bass kick (deg per second)
    this.bearing += (6 + bass * 30) * dt;
    if (this.bearing > 360) this.bearing -= 360;
    if (this.bearing < -360) this.bearing += 360;

    const pitchTarget = this.basePitch + Math.sin(this.t * 0.3) * 8 + mid * 6;
    const zoomTarget = this.baseZoom + Math.sin(this.t * 0.17) * 0.15 + treble * 0.3;

    const curPitch = this.map.getPitch();
    const curZoom = this.map.getZoom();

    // Lerp factor — gentle smoothing
    const k = Math.min(1, dt * 2.5);
    this.map.jumpTo({
      bearing: this.bearing,
      pitch: curPitch + (pitchTarget - curPitch) * k,
      zoom: curZoom + (zoomTarget - curZoom) * k
    });
  }
}
