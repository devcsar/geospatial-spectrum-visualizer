// AudioSource — switches between mic, system (tab/screen) audio, file, and a synthetic
// oscillator fallback. Always pipes its output node into the analyzer. The synth fallback
// exists so the rest of the app has something to react to even when no input is granted.

import { AudioAnalyzer } from './AudioAnalyzer';

export type SourceMode = 'synth' | 'mic' | 'system' | 'file';

interface MicNodes {
  stream: MediaStream;
  src: MediaStreamAudioSourceNode;
}

interface SystemNodes {
  stream: MediaStream;
  src: MediaStreamAudioSourceNode;
  onEnd: () => void;
}

interface SynthNodes {
  osc: OscillatorNode;
  lfo: OscillatorNode;
  lfoGain: GainNode;
  gain: GainNode;
}

interface FileNodes {
  el: HTMLAudioElement;
  src: MediaElementAudioSourceNode;
}

export class AudioSource {
  private mode: SourceMode = 'synth';
  private mic: MicNodes | null = null;
  private system: SystemNodes | null = null;
  private synth: SynthNodes | null = null;
  private file: FileNodes | null = null;
  /** Called when an active capture ends on its own (e.g., user clicks "Stop sharing"). */
  onAutoStopped: ((prev: SourceMode) => void) | null = null;

  constructor(private analyzer: AudioAnalyzer) {}

  getMode(): SourceMode {
    return this.mode;
  }

  async ensureRunning(): Promise<void> {
    if (this.analyzer.ctx.state === 'suspended') {
      await this.analyzer.ctx.resume();
    }
  }

  async startSynth(): Promise<void> {
    await this.ensureRunning();
    this.stopAll();
    const ctx = this.analyzer.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 110;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.5;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 80;
    lfo.connect(lfoGain).connect(osc.frequency);
    const gain = ctx.createGain();
    gain.gain.value = 0.18; // audible but not loud; mainly for the analyzer
    osc.connect(gain);
    this.analyzer.connect(gain);
    osc.start();
    lfo.start();
    this.synth = { osc, lfo, lfoGain, gain };
    this.mode = 'synth';
  }

  async startMic(): Promise<void> {
    await this.ensureRunning();
    this.stopAll();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false
    });
    const src = this.analyzer.ctx.createMediaStreamSource(stream);
    this.analyzer.connect(src);
    this.mic = { stream, src };
    this.mode = 'mic';
  }

  /**
   * Capture system / tab audio via getDisplayMedia. The user picks a tab (e.g. Spotify Web),
   * window or entire screen and must enable the "Share audio" / "Share tab audio" checkbox.
   * Video tracks are immediately discarded — we only need the audio.
   */
  async startSystem(): Promise<void> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('System audio capture is not supported in this browser.');
    }
    await this.ensureRunning();

    // Request both audio and video — most browsers refuse to show the picker
    // (or omit the "share audio" checkbox) when video isn't requested.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: true
    });

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error(
        'No audio was shared. Re-try and tick the "Share audio" / "Share tab audio" checkbox.'
      );
    }

    // Drop video — we only react to sound.
    stream.getVideoTracks().forEach((t) => t.stop());

    this.stopAll();

    const src = this.analyzer.ctx.createMediaStreamSource(stream);
    this.analyzer.connect(src);

    const onEnd = (): void => {
      const prev = this.mode;
      if (this.system) {
        this.analyzer.disconnect(this.system.src);
        this.system.stream.getTracks().forEach((t) => t.stop());
        this.system = null;
      }
      // Fall back to synth so the visuals keep moving.
      this.startSynth().catch(() => undefined);
      this.onAutoStopped?.(prev);
    };
    audioTracks.forEach((t) => t.addEventListener('ended', onEnd, { once: true }));

    this.system = { stream, src, onEnd };
    this.mode = 'system';
  }

  async startFile(file: File): Promise<void> {
    await this.ensureRunning();
    this.stopAll();
    const el = new Audio();
    el.src = URL.createObjectURL(file);
    el.loop = true;
    el.crossOrigin = 'anonymous';
    await el.play().catch(() => {
      /* will retry on user gesture */
    });
    const src = this.analyzer.ctx.createMediaElementSource(el);
    src.connect(this.analyzer.ctx.destination);
    this.analyzer.connect(src);
    this.file = { el, src };
    this.mode = 'file';
  }

  private stopAll(): void {
    if (this.synth) {
      try {
        this.synth.osc.stop();
        this.synth.lfo.stop();
      } catch {
        /* already stopped */
      }
      this.analyzer.disconnect(this.synth.gain);
      this.synth = null;
    }
    if (this.mic) {
      this.analyzer.disconnect(this.mic.src);
      this.mic.stream.getTracks().forEach((t) => t.stop());
      this.mic = null;
    }
    if (this.system) {
      this.analyzer.disconnect(this.system.src);
      this.system.stream.getTracks().forEach((t) => t.stop());
      this.system = null;
    }
    if (this.file) {
      this.analyzer.disconnect(this.file.src);
      this.file.el.pause();
      URL.revokeObjectURL(this.file.el.src);
      this.file = null;
    }
  }
}
