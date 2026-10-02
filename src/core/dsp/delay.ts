/**
 * Circular delay line with fractional (linear + allpass) interpolation.
 *
 * ADR-010: modulation depth in the granular cloud and the reverb tank is a
 * few milliseconds, so linear interpolation's magnitude error is inaudible,
 * but a pure linear read on a *recirculating* line is not — the interpolated
 * discontinuity shows up as a faint metallic edge. We therefore pair every
 * modulated read with a first-order allpass in the feedback path, which is
 * the standard "thiran allpass" trick for transparent fractional delay.
 */

export class DelayLine {
  readonly buffer: Float32Array;
  private writeIdx = 0;
  readonly size: number;

  constructor(sizeSamples: number) {
    this.size = Math.max(2, sizeSamples | 0);
    this.buffer = new Float32Array(this.size);
  }

  reset(): void { this.buffer.fill(0); this.writeIdx = 0; }

  write(x: number): void {
    this.buffer[this.writeIdx] = x;
    this.writeIdx = (this.writeIdx + 1) % this.size;
  }

  /** read at `delaySamples` behind the write head, linear interpolated */
  read(delaySamples: number): number {
    const d = Math.max(1, Math.min(this.size - 1, delaySamples));
    const readPos = this.writeIdx - d;
    const i = Math.floor(readPos);
    const f = readPos - i;
    const a = this.buffer[((i % this.size) + this.size) % this.size];
    const b = this.buffer[(((i + 1) % this.size) + this.size) % this.size];
    return a + (b - a) * f;
  }

  /** combined write+read (most DSP kernels want exactly this) */
  tick(x: number, delaySamples: number): number {
    const y = this.read(delaySamples);
    this.write(x);
    return y;
  }

  /** tap at an absolute sample offset from the head, no interpolation */
  readAt(offset: number): number {
    const i = (((this.writeIdx - 1 - offset) % this.size) + this.size) % this.size;
    return this.buffer[i];
  }
}

/**
 * First-order allpass with coefficient in (-1,1). Used both as a fractional
 * delay corrector and as the diffuse stage in the reverb input network.
 */
export class Allpass {
  private x1 = 0;
  private y1 = 0;
  private g = 0.5;

  constructor(g = 0.5) { this.setG(g); }

  setG(g: number): void { this.g = Math.max(-0.999, Math.min(0.999, g)); }
  reset(): void { this.x1 = 0; this.y1 = 0; }

  process(x: number): number {
    const y = -this.g * x + this.x1 + this.g * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

/** Schroeder comb: delay + one-pole lowpass damping in the loop. */
export class Comb {
  private buf: Float32Array;
  private idx = 0;
  private filterStore = 0;
  private feedback = 0.5;
  private damp = 0.3;

  constructor(size: number, feedback = 0.5, damp = 0.3) {
    this.buf = new Float32Array(Math.max(1, size | 0));
    this.feedback = feedback;
    this.damp = damp;
  }

  setFeedback(f: number): void { this.feedback = f; }
  setDamp(d: number): void { this.damp = Math.max(0, Math.min(1, d)); }
  reset(): void { this.buf.fill(0); this.idx = 0; this.filterStore = 0; }

  process(x: number): number {
    const y = this.buf[this.idx];
    this.filterStore = y * (1 - this.damp) + this.filterStore * this.damp;
    this.buf[this.idx] = x + this.filterStore * this.feedback;
    this.idx = (this.idx + 1) % this.buf.length;
    return y;
  }
}
