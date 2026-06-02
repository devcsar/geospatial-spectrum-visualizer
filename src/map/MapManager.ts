// MapManager — owns the MapLibre Map instance, configures terrain, and exposes a tiny
// reactive surface (exaggeration setter, ready promise) used by main.ts and the audio loop.

import maplibregl, { Map as MlMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { buildDarkStyle } from './styleConfig';

export interface MapManagerOptions {
  container: string;
  center: [number, number];
  zoom: number;
  pitch?: number;
  bearing?: number;
}

export class MapManager {
  readonly map: MlMap;
  readonly hasProtomaps: boolean;
  private baseExaggeration = 2.5;
  private readyPromise: Promise<void>;

  constructor(opts: MapManagerOptions) {
    const key = import.meta.env.VITE_PROTOMAPS_KEY?.trim();
    this.hasProtomaps = Boolean(key);

    const style: StyleSpecification = buildDarkStyle({
      protomapsKey: key || undefined
    });

    this.map = new maplibregl.Map({
      container: opts.container,
      style,
      center: opts.center,
      zoom: opts.zoom,
      pitch: opts.pitch ?? 60,
      bearing: opts.bearing ?? -20,
      antialias: true,
      maxPitch: 85,
      hash: false,
      attributionControl: { compact: true }
    });

    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    this.readyPromise = new Promise((resolve) => {
      const onLoad = (): void => {
        // Some MapLibre versions don't carry `terrain` through reliably if set in style — re-apply.
        this.map.setTerrain({ source: 'terrain-dem', exaggeration: this.baseExaggeration });
        resolve();
      };
      if (this.map.loaded()) onLoad();
      else this.map.once('load', onLoad);
    });

    if (!this.hasProtomaps) {
      // eslint-disable-next-line no-console
      console.warn(
        '[rohan.spectral] VITE_PROTOMAPS_KEY not set — running in terrain-only mode (no buildings/roads).'
      );
    }
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  setBaseExaggeration(v: number): void {
    this.baseExaggeration = v;
    this.applyExaggeration(0);
  }

  /** Apply base + audio-modulated exaggeration. Called per frame from the render loop. */
  applyExaggeration(audioBoost: number): void {
    this.map.setTerrain({
      source: 'terrain-dem',
      exaggeration: this.baseExaggeration + audioBoost
    });
  }

  destroy(): void {
    this.map.remove();
  }
}
