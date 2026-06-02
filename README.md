# ROHAN SPECTRAL ALERTS — audio-reactive topographic visualizer

A magenta → cyan wireframe map of the world that breathes to your microphone, a music
file, or a synthetic oscillator. Built with MapLibre GL JS for navigation + terrain,
Three.js for the wireframe overlay, and the Web Audio API for the FFT.

## Quick start

```bash
cp .env.example .env
# (optional) paste a free Protomaps key into .env to enable buildings + roads
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. A modal will ask you for a starting location.
Type a city (`tokyo`, `villahermosa`, `lausanne`) or `lat,lng` (`19.43, -99.13`).
Hit **SURPRISE ME** to drop into one of nine handpicked spots.

## Controls

- **drag** — pan
- **scroll** — zoom
- **ctrl+drag** (or right-drag) — pitch / bearing
- **MIC** — pipe your microphone into the FFT (asks permission)
- **FILE** — pick a local audio file
- **AUTO** — auto-fly: bearing rotates with bass, pitch & zoom breathe with mid/treble
- **Exag** slider — terrain exaggeration (1× → 10×)
- **Contour** slider — meters between isohypses (2 → 100m)
- **Glow** slider — multiplier for building + street brightness

## What you see

- **Terrain hillshade** colored magenta → purple → cyan via MapLibre's `hillshade` paint
- **Contour mesh** — a 64×64 plane sampled from `queryTerrainElevation()`, rendered with
  a custom `ShaderMaterial` (`src/shaders/contour.frag.glsl`) that draws isohypses
- **Buildings** (needs Protomaps key) — extruded OSM footprints with `EdgesGeometry`,
  vertex-colored by Y-height. Audio bass + treble modulate opacity.
- **Streets** (needs Protomaps key) — `LineSegments` glowing additively over the terrain,
  Z sampled per-vertex from the DEM

## Data sources

- Terrain DEM — <https://demotiles.maplibre.org/terrain-tiles/{z}/{x}/{y}.png> (terrarium encoding, free, no key)
- Vector tiles — <https://api.protomaps.com/tiles/v3.json?key=…> (free key at <https://protomaps.com/dashboard>)
- Geocoding (welcome modal) — <https://nominatim.openstreetmap.org> (no key)

### Swapping the DEM

`src/map/styleConfig.ts` → `TERRAIN_TILES`. Common alternatives:

- AWS Open Data Terrarium: `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png`
- Mapbox (needs token, mapbox encoding): `https://api.mapbox.com/v4/mapbox.terrain-rgb/{z}/{x}/{y}.pngraw?access_token=…`

### Running without a Protomaps key

The app still works — you just get terrain + contour overlay, no buildings or roads.
A warning is printed to the console.

## Architecture

```
src/
  main.ts                    bootstrap, render loop
  map/
    MapManager.ts            MapLibre setup, terrain, exaggeration setter
    styleConfig.ts           dark style builder (background + hillshade + protomaps layers)
  layers/
    ThreeLayer.ts            CustomLayerInterface — shares MapLibre's WebGL ctx
    BuildingsLayer.ts        OSM extruded wireframes, audio-modulated opacity
    StreetsLayer.ts          OSM road centerlines, terrain-following, additive blend
    ContourOverlay.ts        elevation grid + isohypse shader
  audio/
    AudioAnalyzer.ts         FFT, bass/mid/treble + 32 log bands, smoothed
    AudioSource.ts           mic / file / synth switch
  palette/
    colorRamp.ts             5-stop magenta→cyan palette (JS sampler + GLSL function)
  shaders/
    contour.vert.glsl        passes per-vertex elevation to fragment
    contour.frag.glsl        isohypses + palette + audio-driven glow
    building.frag.glsl       reference snippet (current build uses vertex colors)
  ui/
    WelcomeModal.ts          location picker (city + lat,lng + random)
    Controls.ts              info panel + bars + sliders + palette bar
    overlay.css              dark theme, magenta/cyan glow
  camera/
    AutoFly.ts               audio-driven bearing/pitch/zoom oscillation
```

## Notes

- Three.js shares the MapLibre WebGL context — never call `gl.useProgram(null)` in your
  render path. `renderer.resetState()` at the top of each render keeps both libs happy.
- The contour mesh re-samples elevation on every `moveend` (debounced 220ms). If the
  terrain tiles haven't loaded yet (most samples = 0), it self-schedules a retry.
- Buildings and streets are capped at 700 / 3000 features for FPS. Increase
  `MAX_BUILDINGS` / `MAX_FEATURES` in those layer files if you have a strong GPU.
- Bloom / post-processing is intentionally not enabled. Adding `EffectComposer` while
  sharing the MapLibre context requires careful state management — try it last.

## Type-check

```bash
npm run typecheck
```
