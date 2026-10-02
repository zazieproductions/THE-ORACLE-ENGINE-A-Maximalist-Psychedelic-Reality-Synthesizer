/**
 * Iterative radix-2 complex FFT with precomputed twiddle tables.
 *
 * ADR-008: a hand-rolled FFT rather than an off-the-shelf one because the
 * engine needs (a) deterministic, allocation-free per-block transforms inside
 * the audio thread, and (b) a real-valued fast path. Twiddles are computed
 * once in the constructor and stored as interleaved real/imag pairs in a
 * single Float32Array to keep the working set inside L1 for N <= 2048.
 */

export class FFT {
  readonly size: number;
  private readonly levels: number;
  private readonly cosTable: Float32Array;
  private readonly sinTable: Float32Array;
  private readonly rev: Uint32Array;
  private readonly re: Float32Array;
  private readonly im: Float32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    this.size = size;
    this.levels = Math.log2(size) | 0;
    this.cosTable = new Float32Array(size / 2);
    this.sinTable = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cosTable[i] = Math.cos((2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((2 * Math.PI * i) / size);
    }
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      this.rev[i] = reverseBits(i, this.levels);
    }
    this.re = new Float32Array(size);
    this.im = new Float32Array(size);
  }

  /** In-place complex transform. im must be zeroed for real input. */
  transform(re: Float32Array, im: Float32Array): void {
    const n = this.size;
    // bit-reversal permutation
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    // butterflies
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const tablestep = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += tablestep) {
          const l = j + half;
          const tpre = re[l] * this.cosTable[k] + im[l] * this.sinTable[k];
          const tpim = -re[l] * this.sinTable[k] + im[l] * this.cosTable[k];
          re[l] = re[j] - tpre;
          im[l] = im[j] - tpim;
          re[j] += tpre;
          im[j] += tpim;
        }
      }
    }
  }

  /** Real-input forward transform: fills magnitude (N/2) and phase (N/2). */
  forwardReal(input: Float32Array, magnitude: Float32Array, phase: Float32Array): void {
    const re = this.re;
    const im = this.im;
    for (let i = 0; i < this.size; i++) {
      re[i] = input[i];
      im[i] = 0;
    }
    this.transform(re, im);
    const half = this.size / 2;
    for (let i = 0; i < half; i++) {
      const r = re[i];
      const ii = im[i];
      magnitude[i] = Math.sqrt(r * r + ii * ii);
      phase[i] = Math.atan2(ii, r);
    }
  }

  /**
   * Inverse transform assuming conjugate-symmetric input (real output).
   *
   * The butterfly network implements the *forward* DFT, and the inverse DFT is
   * conj(FFT(conj(X))). Conjugating the spectrum before the forward transform
   * is therefore both necessary and sufficient — without it the result is the
   * time-reversed signal, which is exactly the failure mode this guards
   * against (a unit test round-trip catches it immediately).
   */
  inverseReal(magnitude: Float32Array, phase: Float32Array, output: Float32Array): void {
    const re = this.re;
    const im = this.im;
    const half = this.size / 2;
    for (let i = 0; i < half; i++) {
      const m = magnitude[i];
      const p = phase[i];
      // conjugate: negate the imaginary part
      re[i] = m * Math.cos(p);
      im[i] = -m * Math.sin(p);
      if (i > 0) {
        re[this.size - i] = m * Math.cos(p);
        im[this.size - i] = m * Math.sin(p);
      }
    }
    this.transform(re, im);
    const inv = 1 / this.size;
    for (let i = 0; i < this.size; i++) output[i] = re[i] * inv;
  }
}

function reverseBits(x: number, bits: number): number {
  let y = 0;
  for (let i = 0; i < bits; i++) {
    y = (y << 1) | (x & 1);
    x >>>= 1;
  }
  return y >>> 0;
}

/** Periodic Hann — the only window that satisfies COLA at 75% overlap. */
export function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  }
  return w;
}

/** Sum-of-sines window for OLA normalisation at hop = size/4. */
export function colaNormalization(size: number, hop: number): number {
  const w = hannWindow(size);
  let max = 0;
  const acc = new Float32Array(size + hop);
  for (let start = 0; start < size; start += hop) {
    for (let i = 0; i < size; i++) acc[start + i] += w[i];
  }
  for (let i = 0; i < acc.length; i++) max = Math.max(max, acc[i]);
  return max || 1;
}
