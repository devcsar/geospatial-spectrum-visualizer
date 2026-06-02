// Entry point — bootstraps the welcome modal, then the map + Three.js layer + audio + UI.
// In this build only StreetsLayer renders on top of the dark map; buildings and
// topographic contours are intentionally omitted so the street network can stay
// fast and the radial audio-reactive color sweep is what the user sees.
import { MapManager } from './map/MapManager';
import { showWelcomeModal, type StartLocation } from './ui/WelcomeModal';
import { ThreeLayer, debugCube } from './layers/ThreeLayer';
import { StreetsLayer } from './layers/StreetsLayer';
import { AudioAnalyzer } from './audio/AudioAnalyzer';
import { AudioSource } from './audio/AudioSource';
import { mountControls, type ControlsHandle } from './ui/Controls';
import { AutoFly } from './camera/AutoFly';

const DEBUG_CUBE = false; // flip to true to drop a wireframe cube at the start location

async function bootstrap(): Promise<void> {
  const start: StartLocation = await showWelcomeModal();

  const map = new MapManager({
    container: 'map',
    center: [start.lng, start.lat],
    zoom: start.zoom ?? 14,
    pitch: 60,
    bearing: -20
  });

  await map.ready();
  // eslint-disable-next-line no-console
  console.info('[rohan.spectral] map ready at', start);

  // Three.js custom layer on top.
  const threeLayer = new ThreeLayer([start.lng, start.lat]);
  map.map.addLayer(threeLayer);

  if (DEBUG_CUBE) {
    threeLayer.addObject(debugCube(threeLayer, [start.lng, start.lat], 200));
  }

  // Only the streets — skip if no Protomaps key (they need vector tiles).
  let streets: StreetsLayer | null = null;
  if (map.hasProtomaps) {
    streets = new StreetsLayer(map.map, threeLayer);
    streets.attach();
  }

  // Audio
  const analyzer = new AudioAnalyzer();
  const source = new AudioSource(analyzer);
  await source.startSynth(); // safe default; switched by UI

  // Auto-fly
  const autoFly = new AutoFly(map.map);

  // UI controls
  const controls: ControlsHandle = mountControls({
    map: map.map,
    audioSource: source,
    autoFly,
    onExaggerationChange: (v) => map.setBaseExaggeration(v),
    // Contour layer was removed; slider has no effect now (kept in UI for layout parity).
    onContourIntervalChange: () => undefined,
    onGlowChange: (v) => {
      streets?.setGlow(v);
    }
  });

  // Render loop — drives audio analysis + reactive uniforms.
  let last = performance.now();
  const loop = (now: number): void => {
    const dt = (now - last) / 1000;
    last = now;
    analyzer.update();
    threeLayer.setAudio(analyzer.snapshot());
    streets?.tick(analyzer);
    autoFly.tick(dt, analyzer);
    controls.tick(analyzer);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[rohan.spectral] fatal bootstrap error', err);
  const root = document.getElementById('ui-root');
  if (root) {
    root.textContent = `bootstrap failed: ${err instanceof Error ? err.message : String(err)}`;
    root.style.color = '#ff5cd8';
    root.style.padding = '24px';
    root.style.fontFamily = 'monospace';
  }
});
