/**
 * Short-time Fourier transform with weighted overlap-add.
 *
 * ADR-014: the "spectral bloom" effect needs phase-continuous resynthesis,
 * which rules out a naive frame-by-frame inverse (that produces the classic
 * buzzing artefact). This implementation:
 *   - uses a periodic Hann analysis/synthesis window pair,
 *   - keeps a sliding history ring so the hop is genuinely `fftSize/4`
 *     rather than `fftSize` (the difference is 4x the time resolution and
 *     the difference between a usable effect and a stutter),
 *   - accumulates into an OLA buffer sized `fftSize + 2*hop` so a full
 *     window of latency is always available for the next frame,
 *   - normalises by the *measured* COLA sum rather than the analytic one,
 *     which absorbs any window/hop mismatch automatically.
 *
 * The same class instance can be used as a pure analyser (skip
 * `synthesize`) or as a full modifier (mutate `magnitude`/`phases` between
 * the two calls).
 */

import { FFT, hannWindow } from './fft';

export class Stft {
  readonly fftSize: number;
  readonly hop: number;
  private readonly fft: FFT;
  private readonly window: Float32Array;
  private readonly mag: Float32Array;
  private readonly phase: Float32Array;
  private readonly frame: Float32Array;
  private readonly history: Float32Array;
  private readonly ola: Float32Array;
  private readonly cola: Float32Array;
  private histPos = 0;
  private collected = 0;
  private olaPos = 0;

  constructor(fftSize = 1024, hopFactor = 4) {
    if (fftSize < 16 || (fftSize & (fftSize - 1)) !== 0) throw new Error('fftSize must be power of two');
    this.fftSize = fftSize;
    this.hop = Math.max(1, Math.floor(fftSize / hopFactor));
    this.fft = new FFT(fftSize);
    this.window = hannWindow(fftSize);
    this.mag = new Float32Array(fftSize / 2);
    this.phase = new Float32Array(fftSize / 2);
    this.frame = new Float32Array(fftSize);
    // history holds the most recent fftSize samples plus a hop of slack so a
    // ring read never has to wrap mid-frame
    this.history = new Float32Array(fftSize + this.hop);
    // The OLA buffer length MUST be an exact multiple of `hop` and >= fftSize.
    // fftSize (= 4*hop) is the smallest such value; anything else desynchronises
    // the circular write position from the COLA normalisation pattern and the
    // resynthesis explodes. This is the single most fragile invariant in the
    // spectral path, hence the explicit comment.
    this.ola = new Float32Array(fftSize);
    this.cola = new Float32Array(fftSize);
    // WOLA normalisation uses the *product* of the analysis and synthesis
    // windows (w^2 here). Dividing by the sum of w instead of w^2 leaves a
    // permanent gain error of sum(w^2)/sum(w) = 0.75 — a silent 2.5 dB loss
    // that only shows up in an amplitude-accurate round-trip test.
    for (let start = 0; start < fftSize; start += this.hop) {
      for (let i = 0; i < fftSize; i++) {
        this.cola[(start + i) % fftSize] += this.window[i] * this.window[i];
      }
    }
  }

  get bins(): number { return this.fftSize / 2; }
  get magnitude(): Float32Array { return this.mag; }
  get phases(): Float32Array { return this.phase; }

  /** append samples; returns how many complete hops are now pending */
  push(input: Float32Array, count: number): number {
    const hl = this.history.length;
    for (let i = 0; i < count; i++) {
      this.history[this.histPos] = input[i];
      this.histPos = (this.histPos + 1) % hl;
    }
    this.collected += count;
    const hops = Math.floor(this.collected / this.hop);
    this.collected -= hops * this.hop;
    return hops;
  }

  /** analyse the most recent fftSize samples of history */
  analyze(): void {
    const hl = this.history.length;
    const start = (this.histPos - this.fftSize + hl) % hl;
    for (let i = 0; i < this.fftSize; i++) {
      this.frame[i] = this.history[(start + i) % hl] * this.window[i];
    }
    this.fft.forwardReal(this.frame, this.mag, this.phase);
  }

  /** resynthesise the (possibly modified) spectrum, emitting `count` samples */
  synthesize(output: Float32Array, count: number): void {
    this.fft.inverseReal(this.mag, this.phase, this.frame);
    for (let i = 0; i < this.fftSize; i++) this.frame[i] *= this.window[i];
    const olaLen = this.ola.length;
    for (let i = 0; i < this.fftSize; i++) {
      const idx = (this.olaPos + i) % olaLen;
      this.ola[idx] += this.frame[i];
    }
    for (let i = 0; i < count; i++) {
      const idx = (this.olaPos + i) % olaLen;
      const c = this.cola[idx];
      output[i] = c > 1e-6 ? this.ola[idx] / c : 0;
      this.ola[idx] = 0;
    }
    this.olaPos = (this.olaPos + this.hop) % olaLen;
  }

  reset(): void {
    this.history.fill(0);
    this.ola.fill(0);
    this.mag.fill(0);
    this.phase.fill(0);
    this.histPos = 0;
    this.collected = 0;
    this.olaPos = 0;
  }
}
