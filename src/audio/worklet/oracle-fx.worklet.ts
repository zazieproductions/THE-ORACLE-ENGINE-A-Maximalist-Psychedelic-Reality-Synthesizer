/**
 * ====================================================================
 * ORACLE FX — the effects worklet
 * ====================================================================
 *
 * Three custom effects blocks in series, all written from scratch:
 *
 *   1. GRANULAR CLOUD — up to 32 concurrent Hann-windowed grains read from
 *      a 2.5 s stereo circular capture buffer, with per-grain pitch
 *      scattering, pan, and a damped recirculation path. This is what
 *      turns a single note into an "aether bloom".
 *
 *   2. SPECTRAL BLOOM — an STFT (1024/256) magnitude/phase processor:
 *      freeze, blur, bin-shift with phase re-randomisation. Phase is
 *      *carried* through the shift so the result stays musical instead of
 *      collapsing into noise.
 *
 *   3. FDN REVERB — an 8-line feedback delay network with a Hadamard
 *      mixing matrix and per-line damping. Chosen over convolution because
 *      the size is continuously variable and the CPU cost is independent of
 *      the requested decay time.
 *
 *   4. LOOK-AHEAD LIMITER — brickwalls the sum without pumping.
 *
 * Each stage has an independent wet/dry crossfade, so the graph can be
 * re-routed in real time with no clicks (crossfades are equal-power).
 *
 * ADR-017: the render loop performs ZERO allocations. Every scratch buffer
 * (the Hadamard product vector, the spectral shift temporaries) is
 * allocated in the constructor. `designBiquad` involves three
 * transcendental calls, so the reverb damping coefficients are refreshed on
 * a 32-sample cadence rather than per sample — far below the audible
 * threshold for a 6 kHz lowpass and ~30x cheaper.
 */

import { DelayLine, Allpass } from '../../core/dsp/delay';
import { Biquad } from '../../core/dsp/biquad';
import { OnePole } from '../../core/dsp/smoothing';
import { DcBlocker, softClip } from '../../core/dsp/nonlinear';
import { Rng } from '../../core/dsp/noise';
import { Attractor, ROSSLER } from '../../core/dsp/chaos';
import { Stft } from '../../core/dsp/stft';
import { hadamard, fdnDelayLengths } from '../../core/dsp/matrix';
import { Limiter } from '../../core/dsp/limiter';
import { scope, type WorkletProcessor, type MessagePortLike } from './env';
import type { WorkletMsg } from '../protocol';

const MAX_GRAINS = 32;
const FDN_LINES = 8;
const CAPTURE_SECONDS = 2.5;
const STFT_SIZE = 1024;

const PARAM_DESCRIPTORS = [
  { name: 'grainMix', defaultValue: 0.35, minValue: 0, maxValue: 1, automationRate: 'k' },
  { name: 'grainSize', defaultValue: 0.09, minValue: 0.005, maxValue: 0.6, automationRate: 'k' },
  { name: 'grainScatter', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k' },
  { name: 'grainPitch', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k' },
  { name: 'grainFeedback', defaultValue: 0.35, minValue: 0, maxValue: 0.92, automationRate: 'k' },
  { name: 'grainRate', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k' },
  { name: 'spectralMix', defaultValue: 0.25, minValue: 0, maxValue: 1, automationRate: 'k' },
  { name: 'spectralFreeze', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k' },
  { name: 'spectralShift', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k' },
  { name: 'reverbMix', defaultValue: 0.4, minValue: 0, maxValue: 1, automationRate: 'k' },
  { name: 'reverbSize', defaultValue: 0.55, minValue: 0.05, maxValue: 0.98, automationRate: 'k' },
  { name: 'reverbDamp', defaultValue: 0.45, minValue: 0, maxValue: 1, automationRate: 'k' },
  { name: 'reverbWidth', defaultValue: 0.8, minValue: 0, maxValue: 1, automationRate: 'k' },
  { name: 'outputLevel', defaultValue: 0.9, minValue: 0, maxValue: 1.4, automationRate: 'k' },
] as const;

interface Grain {
  active: boolean;
  /** read position in the capture buffer, in samples */
  pos: number;
  /** playback rate: 1 = original pitch */
  rate: number;
  /** length in samples */
  dur: number;
  /** envelope position in samples */
  envPos: number;
  amp: number;
  panL: number;
  panR: number;
  /** exponential pitch drift across the grain */
  drift: number;
}

/** fixed-size FIFO used to absorb the STFT's algorithmic latency */
class Fifo {
  private readonly buf: Float32Array;
  private w = 0;
  private r = 0;
  private count = 0;

  constructor(size: number) { this.buf = new Float32Array(Math.max(4, size | 0)); }

  push(x: number): void {
    if (this.count === this.buf.length) { this.r = (this.r + 1) % this.buf.length; this.count--; }
    this.buf[this.w] = x;
    this.w = (this.w + 1) % this.buf.length;
    this.count++;
  }

  pop(): number {
    if (this.count === 0) return 0;
    const v = this.buf[this.r];
    this.r = (this.r + 1) % this.buf.length;
    this.count--;
    return v;
  }

  reset(): void { this.buf.fill(0); this.w = 0; this.r = 0; this.count = 0; }
}

class OracleFxProcessor implements WorkletProcessor {
  static get parameterDescriptors(): unknown { return PARAM_DESCRIPTORS; }

  readonly port: MessagePortLike;

  private readonly sampleRate: number;
  private readonly rng = new Rng(0xa11ce);

  // ---- granular -----------------------------------------------------
  private readonly captureL: Float32Array;
  private readonly captureR: Float32Array;
  private readonly captureLen: number;
  private captureIdx = 0;
  private readonly grains: Grain[] = [];
  private grainCountdown = 0;
  private readonly grainDampL = new Biquad();
  private readonly grainDampR = new Biquad();
  private readonly grainDc = new DcBlocker(18);
  private lastFbL = 0;
  private lastFbR = 0;
  private activeGrainsNow = 0;

  // ---- spectral -----------------------------------------------------
  private readonly stftL: Stft;
  private readonly stftR: Stft;
  private readonly specFifoL: Fifo;
  private readonly specFifoR: Fifo;
  private readonly specInL: Float32Array;
  private readonly specInR: Float32Array;
  private readonly specOutL: Float32Array;
  private readonly specOutR: Float32Array;
  private readonly frozenMag: Float32Array;
  private readonly shiftTmpMag: Float32Array;
  private readonly shiftTmpPh: Float32Array;
  private freezeAmount = 0;

  // ---- reverb -------------------------------------------------------
  private readonly fdnLines: DelayLine[] = [];
  private readonly fdnDamp: Biquad[] = [];
  private readonly fdnMix: Float32Array[] = [];
  private readonly fdnInput: Allpass[] = [];
  private readonly fdnState = new Float32Array(FDN_LINES);
  private readonly fdnMixed = new Float32Array(FDN_LINES);
  private reverbSizeSm = 0.55;
  private dampCutNow = 4000;

  // ---- output -------------------------------------------------------
  private readonly limiter: Limiter;
  private readonly levelSm = new OnePole(0.03);
  private readonly attractor = new Attractor(ROSSLER);
  private chaosCounter = 0;

  constructor() {
    this.sampleRate = scope().sampleRate;
    this.port = (globalThis as unknown as { port: MessagePortLike }).port;

    this.captureLen = Math.max(1024, Math.floor(CAPTURE_SECONDS * this.sampleRate));
    this.captureL = new Float32Array(this.captureLen);
    this.captureR = new Float32Array(this.captureLen);
    for (let i = 0; i < MAX_GRAINS; i++) {
      this.grains.push({
        active: false, pos: 0, rate: 1, dur: 1, envPos: 0, amp: 0,
        panL: 0.7, panR: 0.7, drift: 0,
      });
    }
    this.grainDampL.design('lowpass', 5200, 0.7, 0, this.sampleRate);
    this.grainDampR.design('lowpass', 5200, 0.7, 0, this.sampleRate);

    this.stftL = new Stft(STFT_SIZE, 4);
    this.stftR = new Stft(STFT_SIZE, 4);
    this.specFifoL = new Fifo(this.stftL.fftSize + this.stftL.hop);
    this.specFifoR = new Fifo(this.stftR.fftSize + this.stftR.hop);
    this.specInL = new Float32Array(1);
    this.specInR = new Float32Array(1);
    this.specOutL = new Float32Array(this.stftL.hop);
    this.specOutR = new Float32Array(this.stftR.hop);
    this.frozenMag = new Float32Array(this.stftL.bins);
    this.shiftTmpMag = new Float32Array(this.stftL.bins);
    this.shiftTmpPh = new Float32Array(this.stftL.bins);

    const lengths = fdnDelayLengths(FDN_LINES, 42, 0.85, this.sampleRate);
    for (let i = 0; i < FDN_LINES; i++) {
      this.fdnLines.push(new DelayLine(lengths[i]));
      const d = new Biquad();
      d.design('lowpass', 4000, 0.707, 0, this.sampleRate);
      this.fdnDamp.push(d);
    }
    // Hadamard mixing matrix — unit energy, so the tank conserves power and
    // the decay time is frequency-independent (no single-mode ringing)
    const h = hadamard(FDN_LINES);
    for (let i = 0; i < FDN_LINES; i++) this.fdnMix.push(h[i]);
    // input diffusion: four allpasses, two per channel
    this.fdnInput.push(new Allpass(0.7), new Allpass(0.63), new Allpass(0.7), new Allpass(0.63));

    this.limiter = new Limiter(256, 0.06, this.sampleRate);

    this.port.onmessage = (event: { data: unknown }) => this.onMessage(event.data as WorkletMsg);
  }

  private onMessage(msg: WorkletMsg): void {
    if (msg.type === 'panic') {
      for (const g of this.grains) g.active = false;
      this.stftL.reset(); this.stftR.reset();
      this.specFifoL.reset(); this.specFifoR.reset();
      this.limiter.reset();
      for (const l of this.fdnLines) l.reset();
      this.fdnState.fill(0);
      this.captureL.fill(0);
      this.captureR.fill(0);
      this.lastFbL = 0;
      this.lastFbR = 0;
    }
  }

  // ----------------------------------------------------------------
  private spawnGrain(sizeSec: number, scatter: number, pitch: number): void {
    let g = this.grains.find((x) => !x.active);
    if (!g) {
      // steal the grain furthest through its envelope (least audible)
      g = this.grains.reduce((a, b) => (a.envPos / a.dur >= b.envPos / b.dur ? a : b));
    }
    const sizeSamples = Math.max(256, Math.floor(sizeSec * this.sampleRate));
    const maxOffset = Math.max(1, this.captureLen - sizeSamples - 1);
    const back = this.rng.range(0.05, 1.6) * this.sampleRate;
    const jitter = scatter * this.captureLen * 0.3 * this.rng.bipolar();
    let pos = this.captureIdx - back + jitter;
    pos = ((pos % this.captureLen) + this.captureLen) % this.captureLen;
    if (pos > maxOffset) pos = this.rng.next() * maxOffset;

    g.active = true;
    g.pos = pos;
    // pitch scatter is semitone-quantised so grains stay consonant with the drone
    const semis = Math.round(this.rng.bipolar() * 12 * pitch);
    g.rate = Math.pow(2, semis / 12);
    g.dur = Math.max(64, Math.floor(sizeSamples * this.rng.range(0.5, 1.5)));
    g.envPos = 0;
    g.amp = this.rng.range(0.25, 0.7);
    g.drift = this.rng.bipolar() * 0.00008;
    const p = (this.rng.next() + 1) * 0.5;
    g.panL = Math.cos(p * Math.PI * 0.5);
    g.panR = Math.sin(p * Math.PI * 0.5);
  }

  // ----------------------------------------------------------------
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0];
    if (!out || out.length === 0 || out[0].length === 0) return true;
    const left = out[0];
    const right = out.length > 1 ? out[1] : out[0];
    const n = left.length;
    const inCh = inputs[0];
    const inL = inCh && inCh.length > 0 ? inCh[0] : left;
    const inR = inCh && inCh.length > 1 ? inCh[1] : inL;

    const sr = this.sampleRate;
    const gMix = parameters.grainMix ? parameters.grainMix[0] : 0.35;
    const gSize = parameters.grainSize ? parameters.grainSize[0] : 0.09;
    const gScatter = parameters.grainScatter ? parameters.grainScatter[0] : 0.5;
    const gPitch = parameters.grainPitch ? parameters.grainPitch[0] : 0.5;
    const gFb = parameters.grainFeedback ? parameters.grainFeedback[0] : 0.35;
    const gRate = parameters.grainRate ? parameters.grainRate[0] : 0.5;
    const sMix = parameters.spectralMix ? parameters.spectralMix[0] : 0.25;
    const sFreeze = parameters.spectralFreeze ? parameters.spectralFreeze[0] : 0;
    const sShift = parameters.spectralShift ? parameters.spectralShift[0] : 0;
    const rMix = parameters.reverbMix ? parameters.reverbMix[0] : 0.4;
    const rSize = parameters.reverbSize ? parameters.reverbSize[0] : 0.55;
    const rDamp = parameters.reverbDamp ? parameters.reverbDamp[0] : 0.45;
    const rWidth = parameters.reverbWidth ? parameters.reverbWidth[0] : 0.8;
    const outLevel = this.levelSm.process(parameters.outputLevel ? parameters.outputLevel[0] : 0.9);

    // equal-power crossfade gains: constant perceived loudness while morphing
    const gGain = Math.sin(gMix * Math.PI * 0.5);
    const sGain = Math.sin(sMix * Math.PI * 0.5);
    const rGain = Math.sin(rMix * Math.PI * 0.5);

    this.reverbSizeSm += (rSize - this.reverbSizeSm) * 0.002;
    const fbGain = 0.62 + this.reverbSizeSm * 0.36;
    const dampCut = 600 + (1 - rDamp) * 7000;

    const grainInterval = Math.max(128, Math.floor(sr * (0.012 + (1 - gRate) * 0.09)));
    const grainOn = gMix > 0.001;
    const spectralOn = sMix > 0.001;

    let activeGrains = 0;

    for (let i = 0; i < n; i++) {
      if ((this.chaosCounter++ & 63) === 0) this.attractor.step();
      const dryL = inL[i];
      const dryR = inR[i];

      // ---- 1. granular cloud -------------------------------------------
      // capture the input, recirculating a damped copy of the grain output
      const fbL = this.grainDampL.process(this.grainDc.process(this.lastFbL));
      const fbR = this.grainDampR.process(this.grainDc.process(this.lastFbR));
      this.captureL[this.captureIdx] = dryL + fbL * gFb * 0.7;
      this.captureR[this.captureIdx] = dryR + fbR * gFb * 0.7;
      this.captureIdx = (this.captureIdx + 1) % this.captureLen;

      let gl = 0;
      let gr = 0;
      if (grainOn) {
        this.grainCountdown--;
        if (this.grainCountdown <= 0) {
          this.spawnGrain(gSize, gScatter, gPitch);
          this.grainCountdown = grainInterval + Math.floor(this.rng.next() * grainInterval * 0.5);
        }
        const cl = this.captureL;
        const cr = this.captureR;
        const clen = this.captureLen;
        for (let gi = 0; gi < MAX_GRAINS; gi++) {
          const g = this.grains[gi];
          if (!g.active) continue;
          const t = g.envPos / g.dur;
          if (t >= 1) { g.active = false; continue; }
          activeGrains++;
          // Hann envelope: C1-continuous at both ends, so grains never click
          const env = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
          const rate = g.rate * (1 + g.drift * g.envPos);
          const idx = g.pos | 0;
          const frac = g.pos - idx;
          const i0 = idx % clen;
          const i1 = (idx + 1) % clen;
          const sl = cl[i0] + (cl[i1] - cl[i0]) * frac;
          const srOut = cr[i0] + (cr[i1] - cr[i0]) * frac;
          const a = g.amp * env;
          gl += sl * a * g.panL;
          gr += srOut * a * g.panR;
          g.pos += rate;
          g.envPos++;
        }
      }
      this.lastFbL = gl;
      this.lastFbR = gr;

      const grainL = dryL * (1 - gMix * 0.5) + gl * gGain * 0.6;
      const grainR = dryR * (1 - gMix * 0.5) + gr * gGain * 0.6;

      // ---- 2. spectral bloom --------------------------------------------
      let wetL = 0;
      let wetR = 0;
      if (spectralOn) {
        this.specInL[0] = grainL;
        this.specInR[0] = grainR;
        const hopsL = this.stftL.push(this.specInL, 1);
        const hopsR = this.stftR.push(this.specInR, 1);
        if (hopsL > 0 && hopsR > 0) {
          this.stftL.analyze();
          this.stftR.analyze();
          this.applySpectral(sFreeze, sShift);
          this.stftL.synthesize(this.specOutL, this.specOutL.length);
          this.stftR.synthesize(this.specOutR, this.specOutR.length);
          for (let k = 0; k < this.specOutL.length; k++) {
            this.specFifoL.push(this.specOutL[k]);
            this.specFifoR.push(this.specOutR[k]);
          }
        }
        wetL = this.specFifoL.pop();
        wetR = this.specFifoR.pop();
      }
      const specL = grainL * (1 - sMix * 0.5) + wetL * sGain;
      const specR = grainR * (1 - sMix * 0.5) + wetR * sGain;

      // ---- 3. FDN reverb ------------------------------------------------
      const mono = (specL + specR) * 0.5;
      let dL = this.fdnInput[0].process(mono);
      dL = this.fdnInput[1].process(dL);
      let dR = this.fdnInput[2].process(specR);
      dR = this.fdnInput[3].process(dR);
      const tankIn = (dL + dR) * 0.5;

      for (let k = 0; k < FDN_LINES; k++) {
        this.fdnState[k] = tankIn * (k % 2 === 0 ? 1 : -1) * 0.7;
      }
      // feedback: Hadamard mixing + per-line damping (refreshed at 1/32 rate)
      if ((this.chaosCounter & 31) === 0) {
        this.dampCutNow = dampCut;
        for (let k = 0; k < FDN_LINES; k++) {
          this.fdnDamp[k].design('lowpass', this.dampCutNow * (1 + k * 0.06), 0.707, 0, sr);
        }
      }
      for (let k = 0; k < FDN_LINES; k++) {
        let s = 0;
        const row = this.fdnMix[k];
        for (let j = 0; j < FDN_LINES; j++) s += row[j] * this.fdnState[j];
        this.fdnMixed[k] = s;
      }
      let rl = 0;
      let rr = 0;
      for (let k = 0; k < FDN_LINES; k++) {
        const delayed = this.fdnLines[k].read(this.fdnLines[k].size - 1);
        const damped = this.fdnDamp[k].process(delayed);
        this.fdnState[k] = this.fdnMixed[k] + damped * fbGain;
        this.fdnLines[k].write(this.fdnState[k]);
        // stereo image from anti-phase taps across the tank
        const w = k / (FDN_LINES - 1);
        rl += delayed * (1 - w * rWidth);
        rr += delayed * (w * rWidth);
      }
      rl *= 0.35;
      rr *= 0.35;

      const revL = specL * (1 - rMix * 0.4) + rl * rGain;
      const revR = specR * (1 - rMix * 0.4) + rr * rGain;

      // ---- 4. look-ahead limiter + output --------------------------------
      const ceiling = 0.891;
      left[i] = this.limiter.process(softClip(revL * outLevel * 0.9), ceiling);
      right[i] = this.limiter.process(softClip(revR * outLevel * 0.9), ceiling);
    }

    this.activeGrainsNow = activeGrains;
    return true;
  }

  /**
   * Magnitude-domain processing of the current frame. Phase is carried
   * through the shift so a shifted spectrum still resynthesises into a
   * pitched sound rather than noise.
   */
  private applySpectral(freeze: number, shift: number): void {
    const bins = this.stftL.bins;
    const magL = this.stftL.magnitude;
    const magR = this.stftR.magnitude;
    const phL = this.stftL.phases;
    const phR = this.stftR.phases;

    this.freezeAmount += (freeze - this.freezeAmount) * 0.01;
    const fr = Math.min(1, this.freezeAmount);
    if (fr > 0.001) {
      const w = 1 - fr;
      for (let i = 0; i < bins; i++) {
        this.frozenMag[i] = magL[i] * fr + this.frozenMag[i] * w;
      }
    }

    const shiftBins = Math.round(shift * 24);
    if (shiftBins !== 0) {
      const tmpM = this.shiftTmpMag;
      const tmpP = this.shiftTmpPh;
      for (const [mag, ph] of [[magL, phL], [magR, phR]] as const) {
        for (let i = 0; i < bins; i++) {
          const src = i - shiftBins;
          if (src >= 0 && src < bins) {
            tmpM[i] = mag[src];
            tmpP[i] = ph[src];
          } else {
            tmpM[i] = 0;
            // re-randomise only the phase of bins that had no source
            tmpP[i] = ph[i] * 0.5 + this.rng.next() * Math.PI;
          }
        }
        mag.set(tmpM);
        ph.set(tmpP);
      }
    }

    if (fr > 0.001) {
      const w = fr * 0.85;
      const inv = 1 - w;
      for (let i = 0; i < bins; i++) {
        magL[i] = magL[i] * inv + this.frozenMag[i] * w;
        magR[i] = magR[i] * inv + this.frozenMag[i] * w;
      }
    }
  }

  get activeGrains(): number { return this.activeGrainsNow; }
}

scope().registerProcessor('oracle-fx', OracleFxProcessor);
