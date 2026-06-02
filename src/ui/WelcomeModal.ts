// Welcome modal — asks for a starting location (city name or "lat,lng") before mounting the map.
// Uses MapLibre's free Nominatim-compatible geocoder via demotiles. No keys required.

export interface StartLocation {
  lat: number;
  lng: number;
  zoom?: number;
  label?: string;
}

const RANDOM_PRESETS: ReadonlyArray<StartLocation> = [
  { lat: 17.9892, lng: -92.9281, zoom: 14, label: 'Villahermosa' },
  { lat: 19.4326, lng: -99.1332, zoom: 13, label: 'Ciudad de México' },
  { lat: 35.6762, lng: 139.6503, zoom: 13, label: 'Tokyo' },
  { lat: 40.7128, lng: -74.006, zoom: 14, label: 'New York' },
  { lat: 37.7749, lng: -122.4194, zoom: 13, label: 'San Francisco' },
  { lat: -33.4489, lng: -70.6693, zoom: 12, label: 'Santiago (Andes nearby)' },
  { lat: 27.9881, lng: 86.925, zoom: 12, label: 'Everest base' },
  { lat: 46.5197, lng: 6.6323, zoom: 12, label: 'Lausanne (Alps)' },
  { lat: 64.1466, lng: -21.9426, zoom: 12, label: 'Reykjavík' }
];

function pickRandom(): StartLocation {
  const idx = Math.floor(Math.random() * RANDOM_PRESETS.length);
  return RANDOM_PRESETS[idx] ?? RANDOM_PRESETS[0]!;
}

function parseLatLng(text: string): StartLocation | null {
  // Accepts "17.99, -92.93" or "17.99 -92.93" or "17.99/-92.93".
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)[\s,/]+(-?\d+(?:\.\d+)?)$/);
  if (!m || !m[1] || !m[2]) return null;
  const lat = Number.parseFloat(m[1]);
  const lng = Number.parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng, zoom: 14, label: `${lat.toFixed(4)}, ${lng.toFixed(4)}` };
}

interface NominatimHit {
  lat: string;
  lon: string;
  display_name: string;
}

async function geocodeCity(query: string): Promise<StartLocation | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, {
    headers: { Accept: 'application/json' }
  });
  if (!resp.ok) throw new Error(`geocode failed: ${resp.status}`);
  const data = (await resp.json()) as NominatimHit[];
  const hit = data[0];
  if (!hit) return null;
  const lat = Number.parseFloat(hit.lat);
  const lng = Number.parseFloat(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, zoom: 13, label: hit.display_name };
}

export function showWelcomeModal(): Promise<StartLocation> {
  return new Promise((resolve, reject) => {
    const modal = document.getElementById('welcome-modal');
    const input = document.getElementById('welcome-input') as HTMLInputElement | null;
    const goBtn = document.getElementById('welcome-go') as HTMLButtonElement | null;
    const randBtn = document.getElementById('welcome-random') as HTMLButtonElement | null;
    const errEl = document.getElementById('welcome-err');

    if (!modal || !input || !goBtn || !randBtn || !errEl) {
      reject(new Error('welcome modal markup missing from index.html'));
      return;
    }

    modal.classList.remove('hidden');
    input.focus();

    const setErr = (msg: string): void => {
      errEl.textContent = msg;
    };

    const finish = (loc: StartLocation): void => {
      modal.classList.add('hidden');
      resolve(loc);
    };

    const handleGo = async (): Promise<void> => {
      setErr('');
      const raw = input.value.trim();
      if (!raw) {
        setErr('type a place or lat,lng');
        return;
      }
      const parsed = parseLatLng(raw);
      if (parsed) {
        finish(parsed);
        return;
      }
      goBtn.disabled = true;
      goBtn.textContent = 'LOOKING…';
      try {
        const hit = await geocodeCity(raw);
        if (!hit) {
          setErr(`no match for "${raw}"`);
          return;
        }
        finish(hit);
      } catch (err) {
        setErr(err instanceof Error ? err.message : 'geocode error');
      } finally {
        goBtn.disabled = false;
        goBtn.textContent = 'FLY IN';
      }
    };

    goBtn.addEventListener('click', () => {
      void handleGo();
    });
    randBtn.addEventListener('click', () => {
      finish(pickRandom());
    });
    input.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void handleGo();
      }
    });
  });
}
