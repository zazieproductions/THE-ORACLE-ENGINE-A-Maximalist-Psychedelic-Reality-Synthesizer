/**
 * ====================================================================
 * SEQUENCER — lookahead event source
 * ====================================================================
 *
 * The classic Web Audio timing pattern (Alessandro Stute / Chris Wilson):
 * a timer wakes up every 25 ms and schedules every event that falls inside
 * the next 90 ms. Events carry absolute AudioContext times, and the worklet
 * defers them until its own clock arrives — see ADR-021.
 *
 * Why 90 ms of lookahead and not 500: the lookahead is exactly the amount of
 * latency a UI interaction suffers before it is audible, and it is also the
 * window in which a tempo change can be re-planned without an audible jump.
 *
 * The pattern generator is a deterministic Euclidean rhythm over an A-minor
 * pentatonic field, seeded per bar, so "the same patch" really does produce
 * the same phrase.
 */

import { Rng } from '../core/dsp/noise';
import type { NoteMods } from './protocol';

export interface SeqEvent {
  /** absolute AudioContext time */
  when: number;
  kind: 'on' | 'off';
  note: number;
  velocity: number;
  voiceId: number;
  mods?: Partial<NoteMods>;
}

/** A-minor pentatonic across four octaves */
const SCALE = [33, 45, 52, 57, 60, 64, 69, 72, 76, 81, 84];

const BASS_MODS: Partial<NoteMods> = {
  amp: 0.85, attack: 0.004, decay: 0.16, sustain: 0.0, release: 0.12,
  cutoff: 420, resonance: 5.5, drive: 3.4, fmIndex: 1.4, fmRatio: 1.0, pan: 0,
};

const PLUCK_MODS: Partial<NoteMods> = {
  amp: 0.5, attack: 0.002, decay: 0.5, sustain: 0.05, release: 0.9,
  cutoff: 2600, resonance: 2.2, drive: 1.2, fmIndex: 2.6, fmRatio: 3.01,
};

const SHIMMER_MODS: Partial<NoteMods> = {
  amp: 0.22, attack: 0.35, decay: 0.6, sustain: 0.4, release: 2.2,
  cutoff: 5200, resonance: 1.1, drive: 0.8, fmIndex: 0.35, fmRatio: 7.01,
};

/** Bjorklund-style Euclidean rhythm: `pulses` hits across `steps`. */
export function euclid(pulses: number, steps: number): boolean[] {
  const out = new Array<boolean>(steps).fill(false);
  if (pulses <= 0) return out;
  if (pulses >= steps) return out.fill(true);
  let bucket = 0;
  for (let i = 0; i < steps; i++) {
    bucket += pulses;
    if (bucket >= steps) {
      bucket -= steps;
      out[i] = true;
    }
  }
  return out;
}

export class Sequencer {
  bpm = 62;
  enabled = true;
  /** 0..1 — how often an extra "ghost" note is injected off-grid */
  density = 0.45;

  private step = 0;
  private nextStepTime = 0;
  private voiceSeq = 0;
  private rng = new Rng(0x0a4c1e);
  private bassPattern = euclid(3, 16);
  private pluckPattern = euclid(7, 16);
  private shimmerPattern = euclid(2, 16);
  private lastNote = 69;

  constructor(seed = 0x0a4c1e) {
    this.rng.reseed(seed);
  }

  reset(now: number): void {
    this.step = 0;
    this.nextStepTime = now + 0.05;
  }

  /** re-roll the pattern deterministically from a seed */
  randomize(seed: number): void {
    this.rng.reseed(seed);
    this.bassPattern = euclid(2 + this.rng.int(3), 16);
    this.pluckPattern = euclid(4 + this.rng.int(6), 16);
    this.shimmerPattern = euclid(1 + this.rng.int(3), 16);
  }

  get stepDuration(): number { return 60 / this.bpm / 4; }

  /**
   * Emit every event in the half-open interval (now, horizon].
   * The caller must post these with their own `when` values.
   */
  advance(now: number, horizon: number): SeqEvent[] {
    const out: SeqEvent[] = [];
    if (this.nextStepTime === 0) this.reset(now);
    if (!this.enabled) return out;

    const stepDur = this.stepDuration;
    let guard = 0;
    while (this.nextStepTime < horizon && guard++ < 128) {
      const when = this.nextStepTime;
      const step = this.step;

      if (this.bassPattern[step]) {
        const note = SCALE[this.rng.int(3)];
        out.push({
          when, kind: 'on', note, velocity: 0.9,
          voiceId: ++this.voiceSeq, mods: BASS_MODS,
        });
        out.push({
          when: when + stepDur * 2, kind: 'off', note, velocity: 0,
          voiceId: this.voiceSeq,
        });
      }

      if (this.pluckPattern[step]) {
        // random walk through the scale keeps phrases coherent but never looped
        let idx = SCALE.indexOf(this.lastNote);
        if (idx < 0) idx = 5;
        idx += this.rng.int(3) - 1;
        idx = Math.max(2, Math.min(SCALE.length - 1, idx));
        this.lastNote = SCALE[idx];
        out.push({
          when, kind: 'on', note: this.lastNote,
          velocity: 0.45 + this.rng.next() * 0.5,
          voiceId: ++this.voiceSeq, mods: PLUCK_MODS,
        });
        out.push({
          when: when + stepDur * 6, kind: 'off', note: this.lastNote,
          velocity: 0, voiceId: this.voiceSeq,
        });
      }

      if (this.shimmerPattern[step]) {
        const note = SCALE[SCALE.length - 1 - this.rng.int(2)];
        out.push({
          when, kind: 'on', note, velocity: 0.5 + this.rng.next() * 0.4,
          voiceId: ++this.voiceSeq, mods: SHIMMER_MODS,
        });
        out.push({
          when: when + stepDur * 14, kind: 'off', note, velocity: 0,
          voiceId: this.voiceSeq,
        });
      }

      // ghost notes: an off-grid flurry when the density gate passes
      if (this.rng.next() < this.density * 0.12) {
        const note = SCALE[4 + this.rng.int(4)];
        const whenGhost = when + stepDur * this.rng.next() * 0.9;
        out.push({
          when: whenGhost, kind: 'on', note, velocity: 0.3,
          voiceId: ++this.voiceSeq, mods: PLUCK_MODS,
        });
        out.push({
          when: whenGhost + stepDur * 3, kind: 'off', note, velocity: 0,
          voiceId: this.voiceSeq,
        });
      }

      this.step = (this.step + 1) % 16;
      this.nextStepTime += stepDur;
    }
    return out;
  }

  /** current step index, for the UI's playhead */
  get currentStep(): number { return this.step; }
}
