/**
 * RBJ-cookbook biquad in transposed direct form II.
 *
 * ADR-005: biquads are used ONLY where the coefficient set is static
 * (reverb damping shelves, DC blockers, tape-deck fixed resonances). Any
 * parameter that moves per-sample goes through the TPT SVF instead — see
 * ADR-004. Mixing the two is deliberate: TDF2 has better numerical
 * conditioning for fixed poles, the SVF has better modulation behaviour.
 */

export type BiquadType =
  | 'lowpass' | 'highpass' | 'bandpass' | 'notch' | 'peak' | 'lowshelf' | 'highshelf';

export interface BiquadCoeffs {
  b0: number; b1: number; b2: number; a1: number; a2: number;
}

export function designBiquad(
  type: BiquadType,
  freqHz: number,
  q: number,
  gainDb: number,
  sampleRate: number,
): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * Math.min(freqHz, sampleRate * 0.495)) / sampleRate;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * Math.max(0.0001, q));

  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;

  switch (type) {
    case 'lowpass':
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'bandpass':
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'notch':
      b0 = 1; b1 = -2 * cw; b2 = 1;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'peak':
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
      break;
    case 'lowshelf': {
      const beta = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cw + beta);
      b1 = 2 * A * (A - 1 - (A + 1) * cw);
      b2 = A * (A + 1 - (A - 1) * cw - beta);
      a0 = A + 1 + (A - 1) * cw + beta;
      a1 = -2 * (A - 1 + (A + 1) * cw);
      a2 = A + 1 + (A - 1) * cw - beta;
      break;
    }
    case 'highshelf': {
      const beta = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cw + beta);
      b1 = -2 * A * (A - 1 + (A + 1) * cw);
      b2 = A * (A + 1 + (A - 1) * cw - beta);
      a0 = A + 1 - (A - 1) * cw + beta;
      a1 = 2 * (A - 1 - (A + 1) * cw);
      a2 = A + 1 - (A - 1) * cw - beta;
      break;
    }
  }

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export class Biquad {
  private c: BiquadCoeffs = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  private z1 = 0;
  private z2 = 0;

  design(type: BiquadType, freqHz: number, q: number, gainDb: number, sampleRate: number): void {
    this.c = designBiquad(type, freqHz, q, gainDb, sampleRate);
  }

  setCoeffs(c: BiquadCoeffs): void { this.c = c; }
  reset(): void { this.z1 = 0; this.z2 = 0; }

  process(x: number): number {
    const y = this.c.b0 * x + this.z1;
    this.z1 = this.c.b1 * x - this.c.a1 * y + this.z2;
    this.z2 = this.c.b2 * x - this.c.a2 * y;
    return y;
  }
}
