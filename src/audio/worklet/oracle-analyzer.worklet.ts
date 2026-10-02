/**
 * ====================================================================
 * ORACLE ANALYZER — the analysis worklet
 * ====================================================================
 *
 * A true real-time analyser: the FFT and every derived feature are computed
 * ON THE AUDIO THREAD and published through a SharedArrayBuffer ring, so the
 * render thread never touches an FFT and never blocks the audio thread.
 *
 * Per published frame (every 256 samples = 187.5 fps at 48 kHz) it writes:
 *   - 512 magnitude bins, normalised so 1.0 == a full-scale sine
 *   - 512 waveform samples (mono, for the oscilloscope / Lissajous)
 *   - 12 scalar features (RMS, peak, centroid, flatness, flux, rolloff,
 *     crest, four band energies, and a smoothed onset envelope)
 *
 * The onset detector is positive spectral flux passed through an
 * attack/release follower — the standard MIR approach, and the reason the
 * visuals react to *notes* rather than to loudness.
 *
 * ADR-018: the analyser is a pass-through. It adds no latency and no
 * processing to the signal path; its only cost is CPU. If the
 * `enabled` AudioParam is 0 it skips the transform entirely, which is how
 * the UI offers an "analysis off" mode for low-end devices.
 */

import { FFT, hannWindow } from '../../core/dsp/fft';
import { OnePole, EnvelopeFollower } from '../../core/dsp/smoothing';
import { SpscRing } from '../../core/ring';
import {
  SPECTRUM_BINS, WAVEFORM_LEN, FEATURE_COUNT, FEATURE, SLOT_FLOATS,
  SLOT_OFFSET_SPECTRUM, SLOT_OFFSET_WAVEFORM, SLOT_OFFSET_FEATURES,
} from '../protocol';
import { scope, type WorkletProcessor, type MessagePortLike } from './env';

const FFT_SIZE = SPECTRUM_BINS * 2;
const HOP = FFT_SIZE / 4;
/** coherent gain of a Hann window is 0.5, so a full-scale sine reads N/4 */
const MAG_NORM = FFT_SIZE * 0.25;

interface AnalyzerOptions {
  ringBuffer?: SharedArrayBuffer | ArrayBuffer;
}

class OracleAnalyzerProcessor implements WorkletProcessor {
  static get parameterDescriptors(): unknown {
    return [{ name: 'enabled', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k' }];
  }

  readonly port: MessagePortLike;

  private readonly sampleRate: number;
  private readonly fft: FFT;
  private readonly window: Float32Array;
  private readonly mag: Float32Array;
  private readonly phase: Float32Array;
  private readonly prevMag: Float32Array;
  private readonly history: Float32Array;
  private readonly waveRing: Float32Array;
  private readonly scratch: Float32Array;
  private frameOut: Float32Array;

  private readonly onset = new EnvelopeFollower(0.002, 0.09);
  private readonly fluxSm = new OnePole(0.004);
  private readonly centroidSm = new OnePole(0.02);

  private ring: SpscRing | null = null;
  private histPos = 0;
  private collected = 0;
  private wavePos = 0;
  private enabled = 1;

  // telemetry
  private lastTime = 0;
  private accUs = 0;
  private maxUs = 0;
  private quanta = 0;
  private reportCountdown = 0;

  // band edges as bin indices at 48 kHz (recomputed for other rates)
  private readonly bandEdges: [number, number][] = [];

  constructor(options?: AnalyzerOptions) {
    this.sampleRate = scope().sampleRate;
    this.port = (globalThis as unknown as { port: MessagePortLike }).port;

    this.fft = new FFT(FFT_SIZE);
    this.window = hannWindow(FFT_SIZE);
    this.mag = new Float32Array(SPECTRUM_BINS);
    this.phase = new Float32Array(SPECTRUM_BINS);
    this.prevMag = new Float32Array(SPECTRUM_BINS);
    this.history = new Float32Array(FFT_SIZE + HOP);
    this.waveRing = new Float32Array(WAVEFORM_LEN);
    this.scratch = new Float32Array(FFT_SIZE);
    this.frameOut = new Float32Array(SPECTRUM_BINS + WAVEFORM_LEN + FEATURE_COUNT);

    if (options && options.ringBuffer) {
      try {
        this.ring = SpscRing.attach(options.ringBuffer);
      } catch {
        this.ring = null;
      }
    }

    const binHz = this.sampleRate / FFT_SIZE;
    const bands: [number, number][] = [[20, 120], [120, 500], [500, 2000], [2000, 16000]];
    for (const [lo, hi] of bands) {
      this.bandEdges.push([
        Math.max(1, Math.min(SPECTRUM_BINS - 1, Math.floor(lo / binHz))),
        Math.max(1, Math.min(SPECTRUM_BINS, Math.ceil(hi / binHz))),
      ]);
    }

    this.port.onmessage = (event: { data: unknown }) => {
      const msg = event.data as { type?: string };
      if (msg && msg.type === 'telemetryRequest') this.reportTelemetry(true);
      if (msg && msg.type === 'readyRequest') {
        this.port.postMessage({
          type: 'ready',
          sampleRate: this.sampleRate,
          sharedMemory: this.ring !== null && this.ring.shared,
        });
      }
    };
  }

  private reportTelemetry(force: boolean): void {
    if (!force && this.reportCountdown-- > 0) return;
    this.reportCountdown = 60;
    this.port.postMessage({
      type: 'telemetry',
      avgProcessUs: this.quanta > 0 ? this.accUs / this.quanta : 0,
      maxProcessUs: this.maxUs,
      quanta: this.quanta,
      activeVoices: 0,
      activeGrains: 0,
      overrun: this.maxUs > (this.sampleRate / 128) * 1e6,
    });
    this.accUs = 0;
    this.maxUs = 0;
  }

  // ----------------------------------------------------------------
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const t0 = performance.now();
    this.quanta++;

    const out = outputs[0];
    const inCh = inputs[0];
    const inL = inCh && inCh.length > 0 ? inCh[0] : null;
    const inR = inCh && inCh.length > 1 ? inCh[1] : null;
    const n = out && out.length > 0 ? out[0].length : 0;
    if (n === 0 || !inL) return true;

    this.enabled = parameters.enabled ? parameters.enabled[0] : 1;
    const analyze = this.enabled > 0.5 && this.ring !== null;

    const outL = out[0];
    const outR = out.length > 1 ? out[1] : outL;

    for (let i = 0; i < n; i++) {
      const l = inL[i];
      const r = inR ? inR[i] : l;
      outL[i] = l;
      outR[i] = r;
      const mono = (l + r) * 0.5;

      if (analyze) {
        this.history[this.histPos] = mono;
        this.histPos = (this.histPos + 1) % this.history.length;
        this.waveRing[this.wavePos] = mono;
        this.wavePos = (this.wavePos + 1) % WAVEFORM_LEN;
        this.collected++;
      }
    }

    if (analyze) {
      const hops = Math.floor(this.collected / HOP);
      this.collected -= hops * HOP;
      for (let h = 0; h < hops; h++) {
        this.publishFrame();
      }
    }

    this.reportTelemetry(false);
    const dt = performance.now() - t0;
    this.accUs += dt * 1000;
    if (dt * 1000 > this.maxUs) this.maxUs = dt * 1000;
    this.lastTime = t0;
    return true;
  }

  // ----------------------------------------------------------------
  private publishFrame(): void {
    const ring = this.ring;
    if (!ring) return;

    // ---- transform -------------------------------------------------
    const hl = this.history.length;
    const start = (this.histPos - FFT_SIZE + hl) % hl;
    for (let i = 0; i < FFT_SIZE; i++) {
      this.scratch[i] = this.history[(start + i) % hl] * this.window[i];
    }
    this.fft.forwardReal(this.scratch, this.mag, this.phase);

    // ---- features --------------------------------------------------
    let sum = 0;
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < WAVEFORM_LEN; i++) {
      const v = this.waveRing[i];
      sum += v;
      sumSq += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sumSq / WAVEFORM_LEN);
    void sum;

    let weighted = 0;
    let total = 0;
    let logSum = 0;
    let flux = 0;
    for (let i = 1; i < SPECTRUM_BINS; i++) {
      const m = this.mag[i] / MAG_NORM;
      this.mag[i] = m;
      const d = m - this.prevMag[i];
      if (d > 0) flux += d;
      this.prevMag[i] = m;
      weighted += m * i;
      total += m;
      logSum += Math.log(m + 1e-9);
    }
    const centroid = total > 1e-9 ? weighted / total / SPECTRUM_BINS : 0;
    const flatness = Math.exp(logSum / (SPECTRUM_BINS - 1)) / (total / (SPECTRUM_BINS - 1) + 1e-9);
    const crest = rms > 1e-9 ? peak / rms : 0;

    // 85% energy rolloff
    let acc = 0;
    let rolloff = 1;
    const target = total * 0.85;
    for (let i = 1; i < SPECTRUM_BINS; i++) {
      acc += this.mag[i];
      if (acc >= target) { rolloff = i / SPECTRUM_BINS; break; }
    }

    const onsetEnv = this.onset.processPeak(flux * 4);
    const fluxSmoothed = this.fluxSm.process(flux);

    // ---- assemble the frame ------------------------------------------
    const frame = this.frameOut;
    frame.set(this.mag, SLOT_OFFSET_SPECTRUM);
    // unwrap the waveform ring so index 0 is the oldest sample
    for (let i = 0; i < WAVEFORM_LEN; i++) {
      frame[SLOT_OFFSET_WAVEFORM + i] = this.waveRing[(this.wavePos + i) % WAVEFORM_LEN];
    }
    const f = SLOT_OFFSET_FEATURES;
    frame[f + FEATURE.RMS] = rms;
    frame[f + FEATURE.PEAK] = peak;
    frame[f + FEATURE.CENTROID] = this.centroidSm.process(Math.min(1, centroid));
    frame[f + FEATURE.FLATNESS] = Math.min(1, flatness);
    frame[f + FEATURE.FLUX] = fluxSmoothed;
    frame[f + FEATURE.ROLLOFF] = rolloff;
    frame[f + FEATURE.CREST] = Math.min(8, crest);
    for (let b = 0; b < 4; b++) {
      const [lo, hi] = this.bandEdges[b];
      let e = 0;
      for (let i = lo; i < hi; i++) e += this.mag[i];
      frame[f + FEATURE.SUB + b] = Math.min(1, e / (hi - lo) * 2);
    }
    frame[f + FEATURE.ONSET] = onsetEnv;

    // ---- publish ------------------------------------------------------
    if (ring.shared) {
      const slot = ring.beginWrite();
      slot.set(frame);
      ring.publish(this.sampleRate, 128);
    } else {
      // no cross-origin isolation: fall back to a zero-copy transfer.
      // The buffer is detached on transfer, so a fresh one is allocated.
      this.port.postMessage({ type: 'frame', frame }, [frame.buffer]);
      this.frameOut = new Float32Array(SLOT_FLOATS);
    }
  }

  get sharedMemory(): boolean { return this.ring !== null && this.ring.shared; }
}

scope().registerProcessor('oracle-analyzer', OracleAnalyzerProcessor);
