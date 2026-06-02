// Controls — builds the top-left info panel + the bottom-right palette bar.
// All state is reactive: ticked from the render loop, mutates via callbacks.

import type { Map as MlMap } from 'maplibre-gl';
import type { AudioAnalyzer } from '../audio/AudioAnalyzer';
import type { AudioSource } from '../audio/AudioSource';
import type { AutoFly } from '../camera/AutoFly';
import { cssGradient } from '../palette/colorRamp';

export interface MountControlsOpts {
  map: MlMap;
  audioSource: AudioSource;
  autoFly: AutoFly;
  onExaggerationChange: (v: number) => void;
  onContourIntervalChange: (v: number) => void;
  onGlowChange: (v: number) => void;
}

export interface ControlsHandle {
  tick: (a: AudioAnalyzer) => void;
}

export function mountControls(opts: MountControlsOpts): ControlsHandle {
  const root = document.getElementById('ui-root');
  if (!root) throw new Error('#ui-root missing in index.html');

  // ----- INFO PANEL (top-left) -----
  const panel = document.createElement('div');
  panel.className = 'info-panel';
  panel.innerHTML = `
    <h2>ROHAN SPECTRAL ALERTS</h2>
    <div class="rule"></div>
    <div class="stats">
      <div><span id="stat-coords">—</span></div>
      <div>zoom <span id="stat-zoom">—</span>  pitch <span id="stat-pitch">—</span></div>
      <div>bearing <span id="stat-bearing">—</span></div>
    </div>
    <div class="section-title">⚡ AUDIO</div>
    <div class="btn-row" id="audio-btns">
      <button data-mode="mic" type="button">● MIC</button>
      <button data-mode="system" type="button" title="Capture system / tab audio (e.g. Spotify)">🔊 SYS</button>
      <button data-mode="file" type="button">📁 FILE</button>
      <button data-mode="auto" type="button">⤿ AUTO</button>
    </div>
    <div class="audio-hint" id="audio-hint"></div>
    <input type="file" id="audio-file-picker" accept="audio/*" style="display:none" />
    <div class="bar-row"><span class="label">BASS</span><div class="bar"><div class="bar-fill" id="bar-bass"></div></div><span class="val" id="val-bass">0.00</span></div>
    <div class="bar-row"><span class="label">MID</span><div class="bar"><div class="bar-fill" id="bar-mid"></div></div><span class="val" id="val-mid">0.00</span></div>
    <div class="bar-row"><span class="label">HIGH</span><div class="bar"><div class="bar-fill" id="bar-treble"></div></div><span class="val" id="val-treble">0.00</span></div>
    <div class="section-title">⚙ TUNE</div>
    <div class="slider-row"><span class="label">Exag</span><input type="range" id="sl-exag" min="1" max="10" step="0.1" value="2.5" /><span class="val" id="val-exag">2.5</span></div>
    <div class="slider-row"><span class="label">Contour</span><input type="range" id="sl-contour" min="2" max="100" step="1" value="10" /><span class="val" id="val-contour">10m</span></div>
    <div class="slider-row"><span class="label">Glow</span><input type="range" id="sl-glow" min="0" max="2" step="0.01" value="0.8" /><span class="val" id="val-glow">0.80</span></div>
  `;
  root.appendChild(panel);

  // ----- PALETTE BAR (bottom-right) -----
  const palette = document.createElement('div');
  palette.className = 'palette-bar';
  palette.innerHTML = `
    <div class="palette-grad" style="background:${cssGradient()}">
      <div class="palette-marker" id="palette-marker" style="left:10%;width:25%"></div>
    </div>
    <div class="palette-labels"><span id="palette-min">— m</span><span>elevation</span><span id="palette-max">— m</span></div>
  `;
  root.appendChild(palette);

  // ----- Wiring -----
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`#${id} missing`);
    return el as T;
  };
  const coordsEl = $('stat-coords');
  const zoomEl = $('stat-zoom');
  const pitchEl = $('stat-pitch');
  const bearEl = $('stat-bearing');
  const bbass = $('bar-bass');
  const bmid = $('bar-mid');
  const btreb = $('bar-treble');
  const vbass = $('val-bass');
  const vmid = $('val-mid');
  const vtreb = $('val-treble');
  const valExag = $('val-exag');
  const valCont = $('val-contour');
  const valGlow = $('val-glow');
  const filePicker = $<HTMLInputElement>('audio-file-picker');
  const hintEl = $('audio-hint');

  let hintTimer: number | undefined;
  const showHint = (msg: string, tone: 'info' | 'err' = 'info', sticky = false): void => {
    hintEl.textContent = msg;
    hintEl.dataset['tone'] = tone;
    window.clearTimeout(hintTimer);
    if (!sticky) {
      hintTimer = window.setTimeout(() => {
        hintEl.textContent = '';
        delete hintEl.dataset['tone'];
      }, 6000);
    }
  };

  const audioBtns = panel.querySelectorAll<HTMLButtonElement>('#audio-btns button');
  const setActive = (mode: 'mic' | 'system' | 'file' | null, auto: boolean): void => {
    audioBtns.forEach((b) => {
      const m = b.dataset['mode'];
      let on = false;
      if (m === 'auto') on = auto;
      else if (m === mode) on = true;
      b.classList.toggle('active', on);
    });
  };

  // If system capture ends on its own (user clicks "Stop sharing"), reflect it in the UI.
  opts.audioSource.onAutoStopped = (prev): void => {
    if (prev === 'system') {
      setActive(null, opts.autoFly.enabled);
      showHint('System audio sharing stopped — back on synth fallback.', 'info');
    }
  };

  audioBtns.forEach((b) => {
    b.addEventListener('click', () => {
      const mode = b.dataset['mode'];
      if (mode === 'mic') {
        opts.audioSource
          .startMic()
          .then(() => setActive('mic', opts.autoFly.enabled))
          .catch((err: unknown) => {
            // eslint-disable-next-line no-console
            console.warn('[rohan.spectral] mic denied, staying on synth', err);
            opts.audioSource.startSynth().catch(() => undefined);
            setActive(null, opts.autoFly.enabled);
            showHint('Microphone denied — using synth fallback.', 'err');
          });
      } else if (mode === 'system') {
        showHint('Pick a tab/window/screen and tick "Share audio".', 'info', true);
        opts.audioSource
          .startSystem()
          .then(() => {
            setActive('system', opts.autoFly.enabled);
            showHint('Capturing system audio. Play something in Spotify ♪', 'info');
          })
          .catch((err: unknown) => {
            // eslint-disable-next-line no-console
            console.warn('[rohan.spectral] system audio failed', err);
            opts.audioSource.startSynth().catch(() => undefined);
            setActive(null, opts.autoFly.enabled);
            const msg = err instanceof Error ? err.message : 'System audio capture failed.';
            showHint(msg, 'err');
          });
      } else if (mode === 'file') {
        filePicker.click();
      } else if (mode === 'auto') {
        const next = !opts.autoFly.enabled;
        opts.autoFly.setEnabled(next);
        const curMode = opts.audioSource.getMode();
        const active = curMode === 'mic' || curMode === 'system' || curMode === 'file' ? curMode : null;
        setActive(active, next);
      }
    });
  });

  filePicker.addEventListener('change', () => {
    const file = filePicker.files?.[0];
    if (!file) return;
    opts.audioSource
      .startFile(file)
      .then(() => setActive('file', opts.autoFly.enabled))
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[rohan.spectral] file source failed', err);
      });
  });

  const slExag = $<HTMLInputElement>('sl-exag');
  slExag.addEventListener('input', () => {
    const v = Number.parseFloat(slExag.value);
    opts.onExaggerationChange(v);
    valExag.textContent = v.toFixed(1);
  });

  const slCont = $<HTMLInputElement>('sl-contour');
  slCont.addEventListener('input', () => {
    const v = Number.parseFloat(slCont.value);
    opts.onContourIntervalChange(v);
    valCont.textContent = `${v.toFixed(0)}m`;
  });

  const slGlow = $<HTMLInputElement>('sl-glow');
  slGlow.addEventListener('input', () => {
    const v = Number.parseFloat(slGlow.value);
    opts.onGlowChange(v);
    valGlow.textContent = v.toFixed(2);
  });

  // ----- tick (per frame) -----
  const marker = $('palette-marker');
  const palMin = $('palette-min');
  const palMax = $('palette-max');

  let frame = 0;
  const tick = (a: AudioAnalyzer): void => {
    frame += 1;

    // Bars — update every frame for smoothness
    bbass.style.right = `${(1 - a.bass) * 100}%`;
    bmid.style.right = `${(1 - a.mid) * 100}%`;
    btreb.style.right = `${(1 - a.treble) * 100}%`;
    vbass.textContent = a.bass.toFixed(2);
    vmid.textContent = a.mid.toFixed(2);
    vtreb.textContent = a.treble.toFixed(2);

    // Stats — throttled (~6 Hz)
    if (frame % 10 === 0) {
      const c = opts.map.getCenter();
      const ns = c.lat >= 0 ? 'N' : 'S';
      const ew = c.lng >= 0 ? 'E' : 'W';
      coordsEl.textContent = `${Math.abs(c.lat).toFixed(4)}°${ns}, ${Math.abs(c.lng).toFixed(4)}°${ew}`;
      zoomEl.textContent = opts.map.getZoom().toFixed(2);
      pitchEl.textContent = `${opts.map.getPitch().toFixed(0)}°`;
      bearEl.textContent = `${opts.map.getBearing().toFixed(0)}°`;
    }

    // Palette marker — moves based on current visible elevation range
    // (BuildingsLayer / ContourOverlay update DOM directly with their ranges via data-attrs)
    if (frame % 30 === 0) {
      const min = Number.parseFloat(marker.dataset['min'] ?? 'NaN');
      const max = Number.parseFloat(marker.dataset['max'] ?? 'NaN');
      const tmin = Number.parseFloat(marker.dataset['tmin'] ?? 'NaN');
      const tmax = Number.parseFloat(marker.dataset['tmax'] ?? 'NaN');
      if (Number.isFinite(tmin) && Number.isFinite(tmax)) {
        marker.style.left = `${Math.max(0, tmin * 100)}%`;
        marker.style.width = `${Math.max(2, (tmax - tmin) * 100)}%`;
      }
      if (Number.isFinite(min)) palMin.textContent = `${Math.round(min)} m`;
      if (Number.isFinite(max)) palMax.textContent = `${Math.round(max)} m`;
    }
  };

  return { tick };
}
