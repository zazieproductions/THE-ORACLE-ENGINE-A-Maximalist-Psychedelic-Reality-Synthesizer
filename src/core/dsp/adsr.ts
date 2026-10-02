/**
 * Sample-accurate ADSR with exponential decay/release segments.
 *
 * ADR-016: linear envelopes on a decaying quantity sound "clicky" because the
 * ear integrates logarithmically; exponential segments sound natural but can
 * never reach zero. The standard resolution is a two-stage release: an
 * exponential tail down to a small floor, then a linear snap to zero inside
 * the denormal-safe range. Coefficient changes happen only on state
 * transitions, so the per-sample cost is one multiply and one add.
 */

export const AdsrStage = {
  Idle: 0,
  Attack: 1,
  Decay: 2,
  Sustain: 3,
  Release: 4,
} as const;

export type AdsrStage = (typeof AdsrStage)[keyof typeof AdsrStage];

const FLOOR = 1e-4;

export class Adsr {
  private stage: AdsrStage = AdsrStage.Idle;
  private level = 0;
  private coef = 0;
  private sampleRate = 48000;

  attack = 0.005;
  decay = 0.18;
  sustain = 0.55;
  release = 0.9;

  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
  }

  setSampleRate(sr: number): void { this.sampleRate = sr; }

  get active(): boolean { return this.stage !== AdsrStage.Idle; }
  get value(): number { return this.level; }
  get currentStage(): AdsrStage { return this.stage; }

  /** start from the current level so retriggering does not click */
  gate(): void {
    this.stage = AdsrStage.Attack;
    this.coef = Math.exp(-1 / Math.max(1, this.attack * this.sampleRate));
  }

  release_(): void {
    if (this.stage === AdsrStage.Idle) return;
    this.stage = AdsrStage.Release;
    this.coef = Math.exp(-1 / Math.max(1, this.release * this.sampleRate));
  }

  kill(): void {
    this.stage = AdsrStage.Idle;
    this.level = 0;
  }

  process(): number {
    switch (this.stage) {
      case AdsrStage.Idle:
        return 0;
      case AdsrStage.Attack: {
        this.level = 1 - (1 - this.level) * this.coef;
        if (this.level >= 0.9995) {
          this.level = 1;
          this.stage = AdsrStage.Decay;
          this.coef = Math.exp(-1 / Math.max(1, this.decay * this.sampleRate));
        }
        return this.level;
      }
      case AdsrStage.Decay: {
        this.level = this.sustain + (this.level - this.sustain) * this.coef;
        if (this.level <= this.sustain + FLOOR) {
          this.level = this.sustain;
          this.stage = AdsrStage.Sustain;
        }
        return this.level;
      }
      case AdsrStage.Sustain:
        return this.sustain;
      case AdsrStage.Release: {
        this.level *= this.coef;
        if (this.level <= FLOOR) {
          this.level = 0;
          this.stage = AdsrStage.Idle;
        }
        return this.level;
      }
    }
  }
}
