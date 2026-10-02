/**
 * Parameter smoothing primitives.
 *
 * ADR-006: every continuous parameter in the engine passes through a
 * one-pole smoother BEFORE it reaches DSP state. Two reasons:
 *   1. zipper noise — a raw UI-driven jump produces an audible step each
 *      control frame;
 *   2. numerical shock — a step into a recursive filter state creates a
 *      transient far larger than the signal.
 * The smoother is the "critically-damped" form `y += (t - y) * a` with
 * `a = 1 - exp(-1/(tau*sr))`, which is exact for a continuous RC network
 * and is sample-rate independent when expressed in seconds.
 */

export class OnePole {
  private a = 1;
  private y = 0;

  constructor(tauSeconds = 0.005) {
    this.setTau(tauSeconds, 48000);
    this.y = 0;
  }

  setTau(tauSeconds: number, sampleRate: number): void {
    this.a = 1 - Math.exp(-1 / Math.max(1e-6, tauSeconds * sampleRate));
  }

  set(y: number): void { this.y = y; }
  get value(): number { return this.y; }

  process(target: number): number {
    this.y += (target - this.y) * this.a;
    return this.y;
  }

  /** snap without smoothing (used on voice start to avoid silence ramps) */
  jump(target: number): void { this.y = target; }
}

/**
 * Two-stage smoother for "glide"-style portamento and for morphing between
 * presets: equal-power crossfade rather than linear, so perceived loudness
 * stays constant across the morph.
 */
export class EqualPowerCrossfade {
  private pos = 0;

  constructor(public tauSeconds = 0.08) {}

  set position(p: number) { this.pos = Math.max(0, Math.min(1, p)); }
  get position(): number { return this.pos; }

  advance(dt: number, target: number): number {
    const k = 1 - Math.exp(-dt / Math.max(1e-4, this.tauSeconds));
    this.pos += (target - this.pos) * k;
    return this.pos;
  }

  gains(): [number, number] {
    const s = Math.sin(this.pos * Math.PI * 0.5);
    const c = Math.cos(this.pos * Math.PI * 0.5);
    return [c, s];
  }
}

/**
 * Envelope follower with separate attack/release ballistics and optional RMS
 * windowing. Feeds the visual layer and the sidechain ducking path.
 */
export class EnvelopeFollower {
  private env = 0;
  private attackCoef = 0;
  private releaseCoef = 0;
  private rmsAcc = 0;
  private rmsN = 0;

  constructor(
    public attackSeconds = 0.005,
    public releaseSeconds = 0.12,
  ) {
    this.setBallistics(attackSeconds, releaseSeconds, 48000);
  }

  setBallistics(attack: number, release: number, sampleRate: number): void {
    this.attackCoef = Math.exp(-1 / Math.max(1e-6, attack * sampleRate));
    this.releaseCoef = Math.exp(-1 / Math.max(1e-6, release * sampleRate));
  }

  reset(): void { this.env = 0; this.rmsAcc = 0; this.rmsN = 0; }

  processPeak(x: number): number {
    const a = Math.abs(x);
    const coef = a > this.env ? this.attackCoef : this.releaseCoef;
    this.env = a + coef * (this.env - a);
    return this.env;
  }

  /** windowed RMS over `window` samples (used for true-RMS metering) */
  processRms(x: number, window: number): number {
    this.rmsAcc += x * x;
    this.rmsN++;
    if (this.rmsN >= window) {
      this.env = Math.sqrt(this.rmsAcc / this.rmsN);
      this.rmsAcc = 0;
      this.rmsN = 0;
    }
    return this.env;
  }

  get value(): number { return this.env; }
}
