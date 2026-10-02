/**
 * Memoryless nonlinearities + DC handling.
 *
 * ADR-007: the engine's saturation stages are odd-symmetric polynomial
 * approximations of tanh rather than table lookups, because the FM voice
 * stack applies them at audio-rate-modulated drive and a table would need
 * 2x oversampling to stay alias-free. The polynomial is C1-continuous and
 * odd-symmetric, which guarantees no even-order harmonic generation (i.e. no
 * DC shift), so no downstream DC blocker is needed after these specific
 * stages.
 */

/** Soft clip, unity gain at 0, hard-limited to +-1. 5th-order odd polynomial. */
export function softClip(x: number): number {
  const a = Math.abs(x);
  if (a >= 1) return x > 0 ? 1 : -1;
  // 1.5x - 0.5x^3 is the classic; the x^5 term flattens the top for a
  // more tube-like knee.
  const y = 1.5 * a - 0.5 * a * a * a + 0.0833333 * a * a * a * a * a;
  return x > 0 ? Math.min(1, y) : -Math.min(1, y);
}

/** Asymmetric tube-ish curve: even-order harmonics, generates DC (block after). */
export function asymClip(x: number, bias: number): number {
  const b = Math.max(-0.9, Math.min(0.9, bias));
  return softClip(x + b) - softClip(b);
}

/** Sine-shaped folder — extreme but bounded, used by the "VOID" reality. */
export function foldback(x: number): number {
  if (x > 1 || x < -1) {
    const t = x * 0.5 + 0.5;
    const f = t - Math.floor(t);
    return Math.abs(f * 2 - 1) * 2 - 1;
  }
  return x;
}

export function hardClip(x: number): number {
  return x > 1 ? 1 : x < -1 ? -1 : x;
}

/**
 * DC blocker: 1-pole highpass at ~8 Hz. Used after every stage that can
 * introduce offset (asymmetric clipping, FM feedback, granular scatter).
 */
export class DcBlocker {
  private x1 = 0;
  private y1 = 0;
  private r = 0;

  constructor(cutoffHz = 8) {
    this.setCutoff(cutoffHz, 48000);
  }

  setCutoff(cutoffHz: number, sampleRate: number): void {
    this.r = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  }

  reset(): void { this.x1 = 0; this.y1 = 0; }

  process(x: number): number {
    const y = x - this.x1 + this.r * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

/** Linear-interpolated wavetable reader with wraparound. */
export function readTable(table: Float32Array, phase: number): number {
  const n = table.length;
  const p = phase - Math.floor(phase / n) * n;
  const i = p | 0;
  const f = p - i;
  const a = table[i];
  const b = table[i + 1 === n ? 0 : i + 1];
  return a + (b - a) * f;
}
