/**
 * Deterministic PRNG + noise colours.
 *
 * ADR-009: xorshift128 rather than Math.random, because the noise layer must
 * be reproducible for the preset system (a patch is a seed + parameters, so
 * "the same patch" is literally the same noise) and because Math.random is
 * unspecified and can be slow in the audio thread.
 */

export class Rng {
  private s0 = 0x9e3779b9;
  private s1 = 0x243f6a88;
  private s2 = 0xb7e15162;
  private s3 = 0xdeadbeef;

  constructor(seed = 0x2545f491) {
    this.reseed(seed);
  }

  reseed(seed: number): void {
    // splitmix32 finaliser to spread a small integer across the state
    let z = (seed | 0) + 0x9e3779b9;
    const next = () => {
      z = (z + 0x9e3779b9) | 0;
      let t = z ^ (z >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t = t ^ (t >>> 15);
      t = Math.imul(t, 0x735a2d97);
      return (t = t ^ (t >>> 15)) >>> 0;
    };
    this.s0 = next(); this.s1 = next(); this.s2 = next(); this.s3 = next();
  }

  /** uniform in [0,1) */
  next(): number {
    let t = this.s3;
    const s = this.s0;
    this.s3 = this.s2;
    this.s2 = this.s1;
    this.s1 = s;
    t ^= t << 11;
    t ^= t >>> 8;
    this.s0 = (t ^ s ^ (s >>> 19)) >>> 0;
    return this.s0 / 4294967296;
  }

  /** uniform in [a,b) */
  range(a: number, b: number): number { return a + (b - a) * this.next(); }

  /** integer in [0,n) */
  int(n: number): number { return (this.next() * n) | 0; }

  /** bipolar in [-1,1) */
  bipolar(): number { return this.next() * 2 - 1; }

  /** approximately gaussian (sum of 3 uniforms, Irwin-Hall scaled) */
  gaussian(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 1.1547;
  }
}

/**
 * Paul Kellet's economy pink filter — -3 dB/oct with two zeros / two poles,
 * accurate to +-0.05 dB across the audio band. Used for the "Tape Hiss"
 * layer, which needs broadband texture without the harshness of white noise.
 */
export class PinkFilter {
  private b0 = 0; private b1 = 0; private b2 = 0;
  private b3 = 0; private b4 = 0; private b5 = 0; private b6 = 0;

  reset(): void {
    this.b0 = this.b1 = this.b2 = 0;
    this.b3 = this.b4 = this.b5 = this.b6 = 0;
  }

  process(white: number): number {
    this.b0 = 0.99886 * this.b0 + white * 0.0555179;
    this.b1 = 0.99332 * this.b1 + white * 0.0750759;
    this.b2 = 0.96900 * this.b2 + white * 0.1538520;
    this.b3 = 0.86650 * this.b3 + white * 0.3104856;
    this.b4 = 0.55000 * this.b4 + white * 0.5329522;
    this.b5 = -0.7616 * this.b5 - white * 0.0168980;
    const pink = this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + white * 0.5362;
    this.b6 = white * 0.115926;
    return pink * 0.11;
  }
}

/** Brown/red noise: integrated white with a leak, -6 dB/oct. */
export class BrownFilter {
  private last = 0;
  reset(): void { this.last = 0; }
  process(white: number): number {
    this.last = (this.last + 0.02 * white) / 1.02;
    return this.last * 3.5;
  }
}
