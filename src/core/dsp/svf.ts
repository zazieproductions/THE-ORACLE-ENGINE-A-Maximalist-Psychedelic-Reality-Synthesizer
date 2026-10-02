/**
 * Zero-delay-feedback state variable filter (Zavalishin / Cytomic TPT form).
 *
 * ADR-004: the TPT SVF is chosen over RBJ biquads for every audio-rate
 * modulated cutoff in the engine. Reason: a biquad's implicit feedback loop
 * becomes unstable when its coefficients are swept faster than the block
 * rate (the classic "biquad explosion" under LFO), whereas the TPT
 * formulation's trapezoidal integration keeps the loop linear and stable for
 * arbitrary modulation rates. This is the single most important robustness
 * property for an instrument whose filters are driven by chaotic attractors.
 *
 * Pure math only — no DOM, no AudioContext — so the identical kernel runs in
 * the worklet thread and in the Node test harness.
 */

export type SvfMode = 'lp' | 'bp' | 'hp' | 'notch' | 'peak';

const TAN_LIMIT = 0.999;

/**
 * Precomputed coefficient set. Recomputing per-sample is wasteful, so the
 * filter exposes `setCoeffs` for the (much rarer) parameter change and a
 * per-sample path that only touches state.
 */
export class StateVariableFilter {
  private ic1eq = 0;
  private ic2eq = 0;

  private g = 0;
  private k = 1;
  private a1 = 1;
  private a2 = 0;
  private a3 = 0;

  /** cutoff in Hz, Q (0.5 = critically damped-ish, higher = resonant) */
  setCoeffs(cutoffHz: number, q: number, sampleRate: number): void {
    const fc = Math.max(1, Math.min(cutoffHz, sampleRate * 0.49));
    const g = Math.tan((Math.PI * fc) / sampleRate);
    this.g = Math.min(g, TAN_LIMIT);
    const kk = 1 / Math.max(0.05, q);
    this.k = kk;
    this.a1 = 1 / (1 + this.g * (this.g + kk));
    this.a2 = this.g * this.a1;
    this.a3 = this.g * this.a2;
  }

  reset(): void {
    this.ic1eq = 0;
    this.ic2eq = 0;
  }

  /** single state advance; returns [bandpass, lowpass, highpass] */
  private tick(x: number): [number, number, number] {
    const v3 = x - this.ic2eq;
    const v1 = this.a1 * this.ic1eq + this.a2 * v3;
    const v2 = this.ic2eq + this.a2 * this.ic1eq + this.a3 * v3;
    this.ic1eq = 2 * v1 - this.ic1eq;
    this.ic2eq = 2 * v2 - this.ic2eq;
    return [v1, v2, x - this.k * v1 - v2];
  }

  lp(x: number): number { return this.tick(x)[1]; }
  bp(x: number): number { return this.tick(x)[0]; }
  hp(x: number): number { return this.tick(x)[2]; }
  notch(x: number): number { const t = this.tick(x); return t[1] + t[2]; }

  /** Resonance-swept "peak" output: bandpass scaled by Q (bell-ish) */
  peak(x: number): number {
    return this.bp(x) * (0.5 + this.k * 0.5);
  }

  process(x: number, mode: SvfMode): number {
    switch (mode) {
      case 'lp': return this.lp(x);
      case 'bp': return this.bp(x);
      case 'hp': return this.hp(x);
      case 'notch': return this.notch(x);
      case 'peak': return this.peak(x);
    }
  }
}

/**
 * Two cascaded SVFs = 12 dB/oct with a shared coefficient set.
 * Used for the voice's main tonal shaping (a 4-pole ladder emulation would
 * cost a nonlinear solve per sample; cascading two linear SVFs gives the
 * musical 24 dB/oct rolloff at a fraction of the cost and stays unconditionally
 * stable under modulation).
 */
export class CascadeSvf {
  private a = new StateVariableFilter();
  private b = new StateVariableFilter();

  setCoeffs(cutoffHz: number, q: number, sampleRate: number): void {
    this.a.setCoeffs(cutoffHz, q, sampleRate);
    this.b.setCoeffs(cutoffHz, q, sampleRate);
  }

  reset(): void {
    this.a.reset();
    this.b.reset();
  }

  lp(x: number): number { return this.b.lp(this.a.lp(x)); }
  bp(x: number): number { return this.b.bp(this.a.bp(x)); }
  hp(x: number): number { return this.b.hp(this.a.hp(x)); }
}
