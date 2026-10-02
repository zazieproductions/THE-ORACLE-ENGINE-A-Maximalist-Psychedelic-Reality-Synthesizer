// ------------------------------------------------------------------
// Web Audio engine — fully generative electroacoustic sound design.
// No samples. Everything synthesized: layered drones, a 16-step
// sequencer, FM bells, detuned chorus, filtered noise, sub fulcrum,
// plus a mic input routed through a formant-ish filter for the
// "oracle speaks" effect.
// ------------------------------------------------------------------

export type LayerId = 'drones' | 'seq' | 'plinks' | 'chorus' | 'noise' | 'sub';

interface SynthLayer {
  id: LayerId;
  gain: GainNode;
  on: boolean;
  stop?: () => void;
}

class OracleAudio {
  ctx: AudioContext | null = null;
  master!: GainNode;
  comp!: DynamicsCompressorNode;
  analyser!: AnalyserNode;
  wet!: GainNode;
  wetDelay!: DelayNode;

  mic: MediaStreamAudioSourceNode | null = null;
  micGain!: GainNode;
  micFilter!: BiquadFilterNode;
  micActive = false;
  micAnalyser: AnalyserNode | null = null;
  private micData: Uint8Array | null = null;

  layers: Record<LayerId, SynthLayer> = {} as Record<LayerId, SynthLayer>;
  layerOn: Record<LayerId, boolean> = {
    drones: true, seq: true, plinks: true, chorus: false, noise: true, sub: true,
  };

  private seq = {
    step: 0,
    timer: null as number | null,
    nextTime: 0,
    bpm: 62,
  };

  private droneNodes: OscillatorNode[] = [];
  private chorusNodes: OscillatorNode[] = [];
  private chorusLFO: OscillatorNode | null = null;
  private subOsc: OscillatorNode | null = null;
  private subLFO: OscillatorNode | null = null;
  private noiseSrc: AudioBufferSourceNode | null = null;
  private plinkTimer: number | null = null;
  private bellCount = 0;

  // ------------------------------------------------------------------
  private ensure() {
    if (this.ctx) return;
    const AC: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AC();
    const c = this.ctx;

    this.master = c.createGain();
    this.master.gain.value = 0.72;
    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -18;
    this.comp.knee.value = 24;
    this.comp.ratio.value = 5;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.24;
    this.analyser = c.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.78;

    // wet send: delay network for plinks / space
    this.wet = c.createGain();
    this.wet.gain.value = 0.55;
    this.wetDelay = c.createDelay(2);
    this.wetDelay.delayTime.value = 0.34;
    const fb = c.createGain(); fb.gain.value = 0.42;
    const dampF = c.createBiquadFilter(); dampF.type = 'lowpass'; dampF.frequency.value = 2400;
    const wetLp = c.createBiquadFilter(); wetLp.type = 'lowpass'; wetLp.frequency.value = 4800;

    this.master.connect(this.comp);
    this.analyser.connect(this.comp);
    this.comp.connect(c.destination);
    // wet bus: nodes -> wet -> delay -> fb -> delay ; delay -> wetLp -> master
    this.wet.connect(this.wetDelay);
    this.wetDelay.connect(dampF); dampF.connect(fb); fb.connect(this.wetDelay);
    this.wetDelay.connect(wetLp); wetLp.connect(this.master);

    // mic pre-chain
    this.micGain = c.createGain(); this.micGain.gain.value = 0.0;
    this.micFilter = c.createBiquadFilter();
    this.micFilter.type = 'bandpass';
    this.micFilter.frequency.value = 800;
    this.micFilter.Q.value = 1.6;

    // create layer slots
    (['drones', 'seq', 'plinks', 'chorus', 'noise', 'sub'] as LayerId[]).forEach((id) => {
      const g = c.createGain();
      g.gain.value = this.layerOn[id] ? this.layerGain(id) : 0;
      g.connect(this.master);
      this.layers[id] = { id, gain: g, on: this.layerOn[id] };
    });
  }

  private layerGain(id: LayerId) {
    switch (id) {
      case 'drones': return 0.16;
      case 'seq': return 0.2;
      case 'plinks': return 0.22;
      case 'chorus': return 0.14;
      case 'noise': return 0.045;
      case 'sub': return 0.3;
    }
  }

  // ------------------------------------------------------------------
  start() {
    this.ensure();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.startDrones();
    this.startNoise();
    this.startSub();
    this.startSeq();
    this.startPlinks();
    if (this.layerOn.chorus) this.startChorus();
  }

  stop() {
    if (!this.ctx) return;
    // keep oscillators, just take master down? no — stop scheduled sources
    this.setLayer('drones', false);
    this.setLayer('seq', false);
    this.setLayer('plinks', false);
    this.setLayer('chorus', false);
    this.setLayer('noise', false);
    this.setLayer('sub', false);
  }

  // ------------------------------------------------------------------
  // DRONES — 3 detuned sines + slow LFO, minor stack
  private startDrones() {
    const c = this.ctx!;
    const g = this.layers.drones.gain;
    // kill old
    this.droneNodes.forEach((o) => { try { o.stop(); } catch {} });
    this.droneNodes = [];
    const freqs = [55, 82.4, 110.6]; // A1 E2 A#2 — eerie minor
    freqs.forEach((f, i) => {
      const o = c.createOscillator();
      o.type = i === 2 ? 'triangle' : 'sine';
      o.frequency.value = f;
      o.detune.value = (i - 1) * 6;
      const og = c.createGain();
      og.gain.value = i === 2 ? 0.32 : 0.5;
      const lfo = c.createOscillator();
      lfo.frequency.value = 0.05 + i * 0.03;
      const lfoG = c.createGain(); lfoG.gain.value = 0.18;
      lfo.connect(lfoG); lfoG.connect(og.gain);
      o.connect(og); og.connect(g);
      o.start(); lfo.start();
      this.droneNodes.push(o, lfo);
    });
  }

  // ------------------------------------------------------------------
  // SEQUENCER — 16-step gate with occasional off-grid ghost hits
  private startSeq() {
    if (this.seq.timer) return;
    this.seq.nextTime = this.ctx!.currentTime + 0.1;
    this.seq.step = 0;
    const tick = () => {
      if (!this.ctx) return;
      const stepDur = 60 / this.seq.bpm / 4; // 16th
      while (this.seq.nextTime < this.ctx.currentTime + 0.15) {
        this.playStep(this.seq.step, this.seq.nextTime, stepDur);
        this.seq.step = (this.seq.step + 1) % 16;
        this.seq.nextTime += stepDur;
      }
      this.seq.timer = window.setTimeout(tick, 30);
    };
    tick();
  }

  private playStep(step: number, time: number, stepDur: number) {
    if (!this.ctx || !this.layerOn.seq) return;
    const c = this.ctx;
    const out = this.layers.seq.gain;
    // kick-ish (sine drop) on 0,4,8,12 + occasional ghost
    if (step % 4 === 0) {
      const o = c.createOscillator();
      o.frequency.setValueAtTime(140, time);
      o.frequency.exponentialRampToValueAtTime(38, time + 0.11);
      const og = c.createGain();
      og.gain.setValueAtTime(0.9, time);
      og.gain.exponentialRampToValueAtTime(0.001, time + 0.16);
      o.connect(og); og.connect(out);
      o.start(time); o.stop(time + 0.2);
    }
    // hats (short noise burst) — need shared noise buffer
    if (step % 2 === 1) {
      const src = c.createBufferSource();
      src.buffer = this.getNoiseBuffer();
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 8000;
      const ng = c.createGain();
      ng.gain.setValueAtTime(step % 4 === 3 ? 0.16 : 0.08, time);
      ng.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
      src.connect(hp); hp.connect(ng); ng.connect(out);
      src.start(time, Math.random() * 0.5, 0.06);
    }
    // bass note on off-steps, minor pentatonic wander
    if (step === 3 || step === 7 || step === 11 || step === 14) {
      const scale = [55, 65.4, 73.4, 82.4, 98];
      const note = scale[Math.floor(Math.random() * scale.length)];
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = note;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 340; lp.Q.value = 6;
      const bg = c.createGain();
      bg.gain.setValueAtTime(0.0, time);
      bg.gain.linearRampToValueAtTime(0.24, time + 0.01);
      bg.gain.exponentialRampToValueAtTime(0.001, time + stepDur * 1.6);
      o.connect(lp); lp.connect(bg); bg.connect(out);
      o.start(time); o.stop(time + stepDur * 2);
    }
  }

  private noiseBuffer: AudioBuffer | null = null;
  private getNoiseBuffer() {
    if (this.noiseBuffer) return this.noiseBuffer;
    const c = this.ctx!;
    const len = c.sampleRate * 2;
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;
    return buf;
  }

  // ------------------------------------------------------------------
  // PLINKS — FM bell, random minor pentatonic, long tails through wet bus
  private startPlinks() {
    if (this.plinkTimer) return;
    const schedule = () => {
      if (!this.ctx) return;
      if (this.layerOn.plinks) this.plink();
      this.plinkTimer = window.setTimeout(schedule, 900 + Math.random() * 2400);
    };
    this.plinkTimer = window.setTimeout(schedule, 1200);
  }

  private plink() {
    const c = this.ctx!;
    const t = c.currentTime;
    const scale = [220, 261.6, 293.7, 329.6, 392, 440, 523.2];
    const base = scale[Math.floor(Math.random() * scale.length)] * (Math.random() < 0.25 ? 0.5 : 1);
    const carrier = c.createOscillator(); carrier.frequency.value = base;
    const mod = c.createOscillator(); mod.frequency.value = base * (2.4 + Math.random());
    const modG = c.createGain(); modG.gain.value = base * 1.8;
    mod.connect(modG); modG.connect(carrier.frequency);
    const g = c.createGain();
    const peak = 0.1 + Math.random() * 0.14;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
    carrier.connect(g); g.connect(this.layers.plinks.gain); g.connect(this.wet);
    carrier.start(t); carrier.stop(t + 3.4);
    mod.start(t); mod.stop(t + 3.4);
    this.bellCount++;
  }

  // ------------------------------------------------------------------
  // CHORUS — 4 detuned saws, slow beating, gentle HP
  private startChorus() {
    const c = this.ctx!;
    if (this.chorusNodes.length) {
      const g = this.layers.chorus.gain;
      g.gain.cancelScheduledValues(c.currentTime);
      g.gain.setTargetAtTime(this.layerGain('chorus'), c.currentTime, 0.5);
      return;
    }
    const g = this.layers.chorus.gain;
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 300;
    hp.connect(g);
    const base = 110;
    [1, 1.005, 0.997, 1.5].forEach((mult, i) => {
      const o = c.createOscillator();
      o.type = i === 3 ? 'triangle' : 'sawtooth';
      o.frequency.value = base * mult;
      const og = c.createGain(); og.gain.value = 0.22;
      const lfo = c.createOscillator();
      lfo.frequency.value = 0.11 + i * 0.07;
      const lg = c.createGain(); lg.gain.value = 0.12;
      lfo.connect(lg); lg.connect(og.gain);
      o.connect(og); og.connect(hp);
      o.start(); lfo.start();
      this.chorusNodes.push(o, lfo);
    });
  }

  private stopChorusInternal() {
    this.chorusNodes.forEach((o) => { try { o.stop(); } catch {} });
    this.chorusNodes = [];
  }

  // ------------------------------------------------------------------
  // NOISE — looping filtered tape hiss, slow wander
  private startNoise() {
    const c = this.ctx!;
    if (this.noiseSrc) return;
    const src = c.createBufferSource();
    src.buffer = this.getNoiseBuffer();
    src.loop = true;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1600; lp.Q.value = 0.6;
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 240;
    src.connect(lp); lp.connect(hp); hp.connect(this.layers.noise.gain);
    // slow LP wander
    const lfo = c.createOscillator(); lfo.frequency.value = 0.06;
    const lg = c.createGain(); lg.gain.value = 700;
    lfo.connect(lg); lg.connect(lp.frequency);
    lfo.start(); src.start();
    this.noiseSrc = src;
    this.droneNodes.push(lfo);
  }

  // ------------------------------------------------------------------
  // SUB — sine at 36hz with slow amplitude LFO & gentle saturation
  private startSub() {
    const c = this.ctx!;
    if (this.subOsc) return;
    const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = 36.7; // D1
    const o2 = c.createOscillator(); o2.type = 'sine'; o2.frequency.value = 36.7 * 1.007;
    const g = c.createGain(); g.gain.value = 0.8;
    const lfo = c.createOscillator(); lfo.frequency.value = 0.18;
    const lg = c.createGain(); lg.gain.value = 0.3;
    lfo.connect(lg); lg.connect(g.gain);
    const shaper = c.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const x = (i / 128) - 1; curve[i] = Math.tanh(x * 2.4) / 1.6; }
    shaper.curve = curve;
    o.connect(g); o2.connect(g); g.connect(shaper); shaper.connect(this.layers.sub.gain);
    o.start(); o2.start(); lfo.start();
    this.subOsc = o;
    this.droneNodes.push(o2, lfo);
  }

  // ------------------------------------------------------------------
  setLayer(id: LayerId, on: boolean) {
    this.layerOn[id] = on;
    if (!this.ctx) return;
    const layer = this.layers[id];
    layer.on = on;
    const target = on ? this.layerGain(id) : 0;
    layer.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    layer.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.25);
    if (id === 'chorus') {
      if (on) this.startChorus(); else this.stopChorusInternal();
    }
  }

  getLayer(id: LayerId): boolean { return this.layerOn[id]; }
  getLayerGain(id: LayerId) { return this.layerGain(id); }

  setMasterVolume(v: number) {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.15);
  }

  /** one-shot foley for UI events */
  sting(kind: 'boot' | 'switch' | 'action' | 'denied' | 'discharge') {
    this.ensure();
    const c = this.ctx!;
    if (c.state === 'suspended') c.resume();
    const t = c.currentTime;
    const mk = (f0: number, f1: number, dur: number, type: OscillatorType, vol: number, dest?: AudioNode) => {
      const o = c.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
      const g = c.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(dest ?? this.master);
      o.start(t); o.stop(t + dur + 0.05);
    };
    switch (kind) {
      case 'boot':
        mk(80, 440, 0.9, 'sine', 0.3);
        mk(1200, 200, 0.7, 'sawtooth', 0.06, this.wet);
        break;
      case 'switch':
        mk(1600, 90, 0.34, 'sawtooth', 0.12, this.wet);
        mk(70, 55, 0.5, 'sine', 0.4);
        break;
      case 'action':
        mk(660, 990, 0.14, 'sine', 0.16);
        mk(990, 1320, 0.12, 'sine', 0.1);
        break;
      case 'denied':
        mk(220, 160, 0.22, 'square', 0.08);
        mk(160, 110, 0.26, 'square', 0.07);
        break;
      case 'discharge': {
        // noise blast + falling sweep
        const src = c.createBufferSource(); src.buffer = this.getNoiseBuffer();
        const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.setValueAtTime(3000, t); bp.frequency.exponentialRampToValueAtTime(120, t + 0.7); bp.Q.value = 0.8;
        const g = c.createGain();
        g.gain.setValueAtTime(0.5, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
        src.connect(bp); bp.connect(g); g.connect(this.master); g.connect(this.wet);
        src.start(t, Math.random(), 0.9);
        mk(800, 40, 0.8, 'sine', 0.5);
        break;
      }
    }
  }

  // ------------------------------------------------------------------
  // MIC — request mic, route through formant filter into drone layer
  async enableMic(): Promise<boolean> {
    this.ensure();
    const c = this.ctx!;
    if (!navigator.mediaDevices?.getUserMedia) return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const src = c.createMediaStreamSource(stream);
      src.connect(this.micFilter);
      this.micFilter.connect(this.micGain);
      this.micGain.connect(this.layers.drones.gain); // morphing drones
      this.micFilter.connect(this.wet); // and into space
      this.mic = src;
      this.micAnalyser = c.createAnalyser();
      this.micAnalyser.fftSize = 256;
      this.micData = new Uint8Array(this.micAnalyser.frequencyBinCount);
      this.micGain.connect(this.micAnalyser);
      this.micActive = true;
      this.micGain.gain.setTargetAtTime(1.6, c.currentTime, 0.4);
      return true;
    } catch (e) {
      console.warn('mic access denied', e);
      return false;
    }
  }

  setMicPitch(value01: number) {
    if (!this.ctx || !this.micActive) return;
    this.micFilter.frequency.setTargetAtTime(300 + value01 * 2600, this.ctx.currentTime, 0.08);
    this.micFilter.Q.setTargetAtTime(1 + value01 * 9, this.ctx.currentTime, 0.08);
  }

  /** voice level 0..1 for visual + pitch feedback */
  getMicLevel(): number {
    if (!this.ctx || !this.micActive || !this.micAnalyser || !this.micData) return 0;
    this.micAnalyser.getByteTimeDomainData(this.micData as Uint8Array<ArrayBuffer>);
    let sum = 0;
    for (let i = 0; i < this.micData.length; i++) {
      const v = (this.micData[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.micData.length);
    return Math.min(1, rms * 2.6);
  }

  disableMic() {
    if (!this.ctx) return;
    this.micGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.25);
    if (this.mic) {
      setTimeout(() => { try { this.mic?.disconnect(); } catch {} }, 800);
      this.mic = null;
    }
    this.micActive = false;
  }

  // ------------------------------------------------------------------
  getAnalyser() { return this.analyser; }

  /** update analyser-driven params every frame */
  frame(energy: number, t: number) {
    if (!this.ctx) return;
    // breathe the drone filter via analyser would need another node; keep simple:
    if (this.wetDelay) {
      this.wetDelay.delayTime.setTargetAtTime(0.3 + Math.sin(t * 0.1) * 0.05 + energy * 0.06, this.ctx.currentTime, 0.4);
    }
  }
}

export const audio = new OracleAudio();
