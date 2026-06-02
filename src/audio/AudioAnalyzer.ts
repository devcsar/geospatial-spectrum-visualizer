// AudioAnalyzer — runs an FFT against any AudioNode and computes bass/mid/treble + 32 log-spaced bands.
// Used as the single source of audio data for both shader uniforms and UI bars.

export interface AudioSnapshot {
  overall: number;
  bass: number;
  mid: number;
  treble: number;
  /** Onset detection function (spectral flux). Spikes on rhythmic beats — drum
   *  hits, claps, accents — across the full spectrum. Roughly normalised to 0..1. */
  flux: number;
  bands: Float32Array;
}

const FFT_SIZE = 1024;
const NUM_BANDS = 32;

export class AudioAnalyzer {
  readonly ctx: AudioContext;
  readonly analyser: AnalyserNode;
  private freqData: Uint8Array<ArrayBuffer>;
  private prevFreqData: Uint8Array<ArrayBuffer>;
  private bands = new Float32Array(NUM_BANDS);
  // Smoothed values for stable visuals.
  overall = 0;
  bass = 0;
  mid = 0;
  treble = 0;
  /** Spectral flux (raw, not eased) — see AudioSnapshot.flux. */
  flux = 0;

  constructor(existingCtx?: AudioContext) {
    this.ctx = existingCtx ?? new AudioContext({ latencyHint: 'interactive' });
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    // Lower smoothing than before so transients (beats) actually punch through —
    // 0.78 was great for the bars UI but blunted the onset signal we need now.
    this.analyser.smoothingTimeConstant = 0.55;
    this.freqData = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    this.prevFreqData = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
  }

  /** Connect any AudioNode (MediaStreamSource, oscillator, MediaElementSource…). */
  connect(node: AudioNode): void {
    node.connect(this.analyser);
  }

  /** Disconnect a previously connected node. Best-effort. */
  disconnect(node: AudioNode): void {
    try {
      node.disconnect(this.analyser);
    } catch {
      // ignore — node may have already been disconnected
    }
  }

  update(): void {
    this.analyser.getByteFrequencyData(this.freqData);

    const binCount = this.freqData.length;
    const sampleRate = this.ctx.sampleRate;
    const nyquist = sampleRate / 2;

    // Spectral flux: sum of positive deltas across all bins between this frame
    // and the previous one. Classic broadband onset-detection function — it
    // spikes on every rhythmic hit (kick, snare, clap, hi-hat, accents) and
    // returns to ~0 between beats. We use it (not the bass channel) to drive
    // the ripple emission, so the animation follows the music's beat regardless
    // of which instruments carry the rhythm.
    let fluxSum = 0;
    for (let i = 0; i < binCount; i += 1) {
      const d = (this.freqData[i] ?? 0) - (this.prevFreqData[i] ?? 0);
      if (d > 0) fluxSum += d;
    }
    this.flux = fluxSum / binCount / 255;
    this.prevFreqData.set(this.freqData);

    // Aggregate into log-spaced bands.
    const minHz = 30;
    const maxHz = Math.min(nyquist, 18000);
    const lnMin = Math.log(minHz);
    const lnMax = Math.log(maxHz);
    for (let b = 0; b < NUM_BANDS; b += 1) {
      const lo = Math.exp(lnMin + ((lnMax - lnMin) * b) / NUM_BANDS);
      const hi = Math.exp(lnMin + ((lnMax - lnMin) * (b + 1)) / NUM_BANDS);
      const lowBin = Math.max(0, Math.floor((lo / nyquist) * binCount));
      const highBin = Math.min(binCount - 1, Math.ceil((hi / nyquist) * binCount));
      let sum = 0;
      let count = 0;
      for (let i = lowBin; i <= highBin; i += 1) {
        sum += this.freqData[i] ?? 0;
        count += 1;
      }
      this.bands[b] = count > 0 ? sum / count / 255 : 0;
    }

    // Bass: 30–250 Hz, Mid: 250–4k, Treble: 4k–18k.
    const energy = (loHz: number, hiHz: number): number => {
      const loBin = Math.max(0, Math.floor((loHz / nyquist) * binCount));
      const hiBin = Math.min(binCount - 1, Math.ceil((hiHz / nyquist) * binCount));
      let s = 0;
      let n = 0;
      for (let i = loBin; i <= hiBin; i += 1) {
        s += this.freqData[i] ?? 0;
        n += 1;
      }
      return n > 0 ? s / n / 255 : 0;
    };

    // Smoothing: ease towards new values for stable visuals.
    const ease = 0.35;
    this.bass = this.bass + (energy(30, 250) - this.bass) * ease;
    this.mid = this.mid + (energy(250, 4000) - this.mid) * ease;
    this.treble = this.treble + (energy(4000, 18000) - this.treble) * ease;
    const target = (this.bass + this.mid + this.treble) / 3;
    this.overall = this.overall + (target - this.overall) * ease;
  }

  snapshot(): AudioSnapshot {
    return {
      overall: this.overall,
      bass: this.bass,
      mid: this.mid,
      treble: this.treble,
      flux: this.flux,
      bands: this.bands
    };
  }
}
