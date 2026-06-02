# Prompt para Claude Code: Audio-Reactive Topographic Map Visualizer

## Visión del proyecto

Construye una **visualización geoespacial audio-reactiva** que muestre el mundo como un mapa topográfico estilo *contour-line wireframe* sobre fondo negro, con paleta **magenta → púrpura → azul eléctrico → cyan**. El usuario navega libremente por el mapa (pan/zoom/pitch/bearing) y el relieve, edificios y calles se recolorean dinámicamente según la zona visible. El audio del micrófono (o un archivo) modula la **altura del relieve, intensidad de las líneas, y movimiento sutil de la cámara**.

**Referencia visual exacta**:
- Fondo: negro puro (`#000000`)
- Zonas bajas: magenta (`#a020f0` → `#d000ff`)
- Zonas medias: púrpura profundo (`#6a00b8`)
- Zonas altas: azul eléctrico (`#3030ff` → `#00d4ff` cyan en picos)
- Líneas de contorno isohipsas brillantes, superficies internas casi negras
- Edificios extruídos como prismas wireframe finos con el mismo gradiente vertical

## Stack técnico definido

- **MapLibre GL JS v4+** — motor base, pan/zoom/pitch nativo
- **Three.js r170+** — render del relieve + edificios mediante `CustomLayerInterface` de MapLibre (comparte el WebGL context)
- **Vite + TypeScript estricto** — build tool, sin `any`
- **Web Audio API** — `AnalyserNode` para FFT en tiempo real
- **Fuentes de datos**:
  - Terreno DEM: `https://demotiles.maplibre.org/terrain-tiles/{z}/{x}/{y}.png` (libre, sin token) o AWS Terrarium como fallback
  - Edificios 3D + calles: OSM vía **Protomaps** (`https://api.protomaps.com/`) o **OpenMapTiles** público — usaremos un style JSON custom apuntando a tiles vectoriales abiertos
- Sin frameworks UI pesados — HTML/CSS plano

## Arquitectura del repositorio

```
audio-topo-visualizer/
├── index.html
├── vite.config.ts
├── tsconfig.json
├── package.json
├── .env.example
├── public/
│   └── style.json                # MapLibre style custom (oscuro, sin labels excepto opcionales)
├── src/
│   ├── main.ts                   # Bootstrap, conecta todo
│   ├── map/
│   │   ├── MapManager.ts         # Setup MapLibre, terrain source, controles
│   │   ├── TerrainStyle.ts       # Override del color del raster-dem via shader hook
│   │   └── styleConfig.ts        # Helpers para construir el style.json en runtime
│   ├── layers/
│   │   ├── ThreeLayer.ts         # CustomLayerInterface de MapLibre que monta Three.js
│   │   ├── BuildingsLayer.ts     # Extrusión de edificios OSM como wireframe Three.js
│   │   └── StreetsLayer.ts       # Líneas de calles como Line2 con brillo
│   ├── audio/
│   │   ├── AudioAnalyzer.ts      # FFT, bandas log, bass/mid/treble
│   │   └── AudioSource.ts        # Mic / file switch
│   ├── shaders/
│   │   ├── contour.frag.glsl     # Líneas isohipsas + paleta magenta-cyan
│   │   ├── building.vert.glsl    # Desplazamiento + audio
│   │   └── building.frag.glsl    # Gradiente vertical
│   ├── palette/
│   │   └── colorRamp.ts          # Paleta GLSL exportable + JS para UI
│   └── ui/
│       ├── Controls.ts           # Botones, sliders
│       └── overlay.css
└── README.md
```

## Especificación detallada

### 1. MapLibre como base

- Inicializa el mapa centrado en coordenadas configurables (default: Villahermosa `[−92.9281, 17.9892]`, zoom 14, pitch 60°, bearing −20°)
- Habilita terreno 3D nativo de MapLibre:
  ```ts
  map.addSource('terrain-dem', {
    type: 'raster-dem',
    tiles: ['https://demotiles.maplibre.org/terrain-tiles/{z}/{x}/{y}.png'],
    tileSize: 256,
    encoding: 'terrarium'
  });
  map.setTerrain({ source: 'terrain-dem', exaggeration: 2.5 });
  ```
- El `exaggeration` debe ser un uniform/variable global modificable por slider (rango 1–10) y reactivo al audio
- Controles de navegación nativos: drag para pan, scroll para zoom, ctrl+drag para pitch/bearing
- Color del background: `#000000` en el style JSON

### 2. Style.json oscuro

Construye un MapLibre style en `public/style.json` con estas características:

- `background` layer color `#0a0005` (negro levemente magenta para "warmth")
- `hillshade` layer usando el terrain-dem con `hillshade-accent-color` magenta y `hillshade-shadow-color` azul oscuro, baja opacidad (0.15)
- Sin `fill` de tierra (deja que se vea el background)
- Sin labels por defecto (toggle opcional)
- Línea de coastlines en magenta `#d000ff` con opacity 0.4

### 3. Three.js custom layer

Implementa `ThreeLayer` que cumpla con `CustomLayerInterface`:

```ts
interface CustomLayerInterface {
  id: string;
  type: 'custom';
  renderingMode?: '2d' | '3d';
  onAdd(map: Map, gl: WebGL2RenderingContext): void;
  render(gl: WebGL2RenderingContext, matrix: number[]): void;
  onRemove?(map: Map, gl: WebGL2RenderingContext): void;
}
```

Puntos críticos:
- En `onAdd`, instancia un `THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true })` **compartiendo el contexto**
- `renderer.autoClear = false` (MapLibre ya limpió)
- La cámara de Three.js debe sincronizarse con `matrix` de MapLibre frame a frame:
  ```ts
  const m = new THREE.Matrix4().fromArray(matrix);
  threeCam.projectionMatrix = m;
  threeCam.matrixWorldInverse.identity();
  ```
- Después de renderear, llama `map.triggerRepaint()` para mantener el loop activo cuando hay audio reactivo

### 4. Capa de edificios 3D wireframe

Usa el source de OpenMapTiles/Protomaps para obtener footprints OSM:

```ts
map.addSource('buildings', {
  type: 'vector',
  url: 'https://api.protomaps.com/tiles/v3.json?key=YOUR_KEY'
});
```

(Si no hay key, usa `https://demotiles.maplibre.org/tiles/tiles.json` como demo — los edificios estarán limitados pero funcionará)

En `BuildingsLayer`:
1. Lee features en el viewport actual cada vez que el mapa termina un `moveend`
2. Por cada feature tipo `building`:
   - Extrae el footprint (`geometry.coordinates`)
   - Lee `properties.height` (o `levels * 3.5` si solo hay levels, o `8` por defecto)
   - Crea una `ExtrudeGeometry` desde el footprint en coordenadas Mercator
   - Convierte a Mercator local del tile usando `maplibregl.MercatorCoordinate.fromLngLat()`
3. Usa **`LineSegmentsGeometry` + `LineMaterial` (de three/examples/jsm/lines)** para wireframe, no edges normales — permite controlar grosor de línea
4. Aplica el shader de gradiente vertical: el color del segmento depende de su altura Y normalizada al rango [0, maxHeightVisible]

Material para edificios:
```glsl
// building.frag.glsl (con LineMaterial custom uniforms)
uniform float uMinElev;
uniform float uMaxElev;
uniform float uAudioLevel;
uniform float uBassLevel;
varying float vWorldY;

vec3 paletteMagentaCyan(float t) {
    // t en [0, 1]
    vec3 c0 = vec3(0.85, 0.10, 0.95);   // magenta (bajo)
    vec3 c1 = vec3(0.55, 0.05, 0.75);   // púrpura
    vec3 c2 = vec3(0.20, 0.10, 0.85);   // azul-púrpura
    vec3 c3 = vec3(0.15, 0.40, 1.00);   // azul eléctrico
    vec3 c4 = vec3(0.00, 0.85, 1.00);   // cyan (alto)

    if (t < 0.25)      return mix(c0, c1, t / 0.25);
    else if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);
    else if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);
    else               return mix(c3, c4, (t - 0.75) / 0.25);
}

void main() {
    float t = (vWorldY - uMinElev) / max(uMaxElev - uMinElev, 0.001);
    t = clamp(t + uBassLevel * 0.15, 0.0, 1.0);  // bass empuja todo hacia el azul
    vec3 color = paletteMagentaCyan(t);
    float glow = 1.0 + uAudioLevel * 0.8;
    gl_FragColor = vec4(color * glow, 0.95);
}
```

### 5. Capa de calles (StreetsLayer)

- Lee features tipo `transportation` del mismo source vectorial
- Renderea como `Line2` (de three/examples) con grosor constante en pixels
- Color: magenta uniforme con opacidad 0.6, levemente brillante en zonas donde haya energía de audio
- Las calles **no se extruyen** — quedan a nivel de suelo siguiendo el terreno (sample del DEM para Y)

### 6. Contour lines sobre terreno

El truco visual clave de tu referencia son las **líneas de contorno cada N metros**. MapLibre no genera contornos nativamente, así que las implementaremos en un fragment shader que post-procesa el terreno:

**Opción elegida (más simple)**: usa un raster overlay generado por el style con expresión de color basada en elevación. Construye un layer tipo `hillshade` con un colormap custom y otro layer `raster` con `raster-opacity` modulada por una función que detecte cambios bruscos de elevación.

**Opción avanzada (mejor resultado)**: en el `ThreeLayer`, después de renderear edificios, dibuja un plano grande que cubra el viewport con un shader que lea el DEM vía MapLibre's `queryTerrainElevation()` API (sampleado por vértice) y aplique:

```glsl
// contour.frag.glsl
uniform float uContourInterval;  // ej: 10.0 metros
uniform float uLineWidth;        // ej: 1.5
uniform float uAudioLevel;
varying float vElevation;
varying vec2 vUv;

void main() {
    float interval = uContourInterval;
    float mod_e = mod(vElevation, interval);
    float dist_to_line = min(mod_e, interval - mod_e);
    float line = 1.0 - smoothstep(0.0, uLineWidth, dist_to_line);

    float t = clamp(vElevation / 100.0, 0.0, 1.0);
    vec3 color = paletteMagentaCyan(t);

    // boost por audio
    line *= (1.0 + uAudioLevel * 1.5);

    gl_FragColor = vec4(color, line * 0.85);
}
```

Empieza por la opción simple, deja la avanzada para iteración 2.

### 7. Paleta — `colorRamp.ts`

Exporta dos cosas:
1. Función GLSL como string (inyectable en shaders)
2. Función JS `sampleColor(t: number): [number, number, number]` para usar en UI (barras del overlay)

Stops exactos:
```ts
export const PALETTE_STOPS: Array<[number, [number, number, number]]> = [
  [0.00, [0.85, 0.10, 0.95]],  // magenta
  [0.25, [0.55, 0.05, 0.75]],  // púrpura
  [0.50, [0.20, 0.10, 0.85]],  // azul-púrpura
  [0.75, [0.15, 0.40, 1.00]],  // azul eléctrico
  [1.00, [0.00, 0.85, 1.00]],  // cyan
];
```

### 8. Audio reactivo — doble modo

**A. Modulación del relieve y colores** (`audio → visual`):
- `bass` (0–250 Hz) → empuja la paleta hacia el azul (suma a `t` en el shader)
- `mid` (250–4000 Hz) → modula `terrain exaggeration` de MapLibre (`baseExag + mid * 4`)
- `treble` (4000–20000 Hz) → intensifica brillo de líneas de contorno
- `overallLevel` → glow general (bloom strength si se agrega post-processing)

**B. Movimiento de cámara** (`audio → cámara`):
- Modo "auto-fly" activable con botón **"AUTO"** en UI
- Cuando está activo:
  - Bearing rota lentamente: `bearing += 0.1 + bass * 0.5` (deg/frame)
  - Pitch oscila: `pitch = 55 + sin(time * 0.3) * 10 + mid * 5`
  - Zoom respira: `zoom = baseZoom + treble * 0.3`
  - El pan no se mueve automáticamente (el usuario sigue controlando posición)
- Usar `map.jumpTo()` con valores interpolados suavemente (lerp con factor 0.05)

### 9. UI overlay

Esquina superior izquierda, panel oscuro semi-transparente:

```
┌─────────────────────────────┐
│  TOPO.AUDIO                 │
│  ─────────────────          │
│  18.0125°N, 92.9456°W       │
│  zoom 14.3  pitch 62°       │
│  bearing −18°               │
│                             │
│  ⚡ AUDIO                   │
│  [● MIC]  [📁 FILE]  [AUTO] │
│  BASS  ▓▓▓▓▓▓░░░░  0.62    │
│  MID   ▓▓▓░░░░░░░  0.31    │
│  HIGH  ▓▓░░░░░░░░  0.18    │
│                             │
│  ⚙ TUNE                     │
│  Exag    ──●───── 2.5       │
│  Contour ───●──── 10m       │
│  Glow    ────●─── 0.8       │
└─────────────────────────────┘
```

Esquina inferior derecha: barra de paleta horizontal mostrando el ramp de colores con marcador móvil indicando el rango de elevación visible.

### 10. Render loop

```ts
function loop() {
  requestAnimationFrame(loop);
  audioAnalyzer.update();

  // sync uniforms
  threeLayer.updateAudioUniforms({
    overall: audioAnalyzer.overall,
    bass: audioAnalyzer.bass,
    mid: audioAnalyzer.mid,
    treble: audioAnalyzer.treble,
    bands: audioAnalyzer.bands
  });

  // modular terrain exaggeration
  map.setTerrain({
    source: 'terrain-dem',
    exaggeration: baseExag + audioAnalyzer.mid * 4
  });

  // auto-fly mode
  if (autoFly) updateCameraFromAudio(audioAnalyzer);

  ui.updateBars(audioAnalyzer);
  map.triggerRepaint();
}
```

## Requisitos de calidad

- TypeScript estricto, sin `any`
- Manejo de error si `getUserMedia` falla
- Fallback con audio sintético (oscilador) si no se da permiso de mic
- Dispose de geometrías Three.js cuando los tiles salen del viewport (evitar memory leak en navegación larga)
- README con setup, fuentes de tiles alternativas, cómo cambiar la ubicación inicial
- `.env.example` con `VITE_PROTOMAPS_KEY=` (opcional, hay fallback público)

## Tareas para Claude Code (orden estricto)

1. **Setup**: `npm create vite@latest . -- --template vanilla-ts`, instala `maplibre-gl`, `three`, types
2. **MapLibre solo**: carga el mapa con terreno 3D y style oscuro, verifica pan/zoom/pitch funcionan en Villahermosa
3. **ThreeLayer mínimo**: agrega un cubo Three.js en lng/lat fijo para verificar que el custom layer renderea sobre el mapa con la matriz correcta
4. **Paleta + shaders**: crea `colorRamp.ts` y los .glsl, valida con un plane de prueba
5. **Edificios wireframe**: implementa `BuildingsLayer` con extrusión OSM y el shader de gradiente vertical
6. **Calles**: `StreetsLayer` con `Line2` siguiendo el terreno
7. **Contour lines**: opción simple primero (hillshade colorizado), luego shader si hay tiempo
8. **Audio**: `AudioAnalyzer` + `AudioSource`, prueba con tono sintético antes de mic
9. **Conexión audio→visual**: uniforms reactivos, exageración modulada
10. **Auto-fly**: movimiento de cámara reactivo
11. **UI**: overlay con todos los controles y barras
12. **Polish**: bloom/postproc si el FPS lo permite, README, dispose correcto

## Decisiones pendientes que Claude Code debe confirmar antes de codear

1. ¿Usar Protomaps con key gratis (mejor data de edificios) o demotiles público (limitado pero zero-config)?
2. ¿Empezar con la ubicación de Villahermosa o pedir input al iniciar?
3. ¿Post-processing con `EffectComposer` desde el inicio o solo si queda tiempo?

Empieza confirmando estas 3 preguntas y luego procede tarea por tarea, verificando visualmente cada paso antes de avanzar.

## Notas importantes

- MapLibre y Three.js comparten el WebGL context — **no llames `gl.useProgram(null)` en `render()`** o romperás MapLibre. Three.js maneja esto bien si usas `renderer.resetState()` al inicio del render.
- La matriz que MapLibre pasa a `render(gl, matrix)` es la projection matrix completa en coordenadas Mercator normalizadas (rango [0,1]). Para posicionar objetos Three.js, conviértelos con `MercatorCoordinate.fromLngLat([lng, lat], altitude)` y usa el `meterInMercatorCoordinateUnits()` como escala.
- Villahermosa es plano — para que se vean los contornos, baja el `contourInterval` a 5 metros y sube la exageración. Para zonas montañosas (CDMX, por ejemplo) usa 50–100 m de intervalo.
- Si Protomaps no entrega `height` en edificios, usa `render_height` o `min_height`/`max_height` — el campo varía por proveedor de tiles.
