/**
 * ====================================================================
 * PATCHES — the instrument's memory
 * ====================================================================
 *
 * A patch is a plain data object: a set of AudioParam values for each
 * worklet plus a chaos seed and a master level. Because it contains no
 * functions and no node references it is trivially serialisable, which is
 * what makes localStorage persistence and URL sharing possible without any
 * migration layer.
 *
 * ADR-026: patch morphing uses equal-power crossfades on the *parameter*
 * values rather than crossfading two audio graphs. Crossfading graphs needs
 * duplicate node trees and careful phase alignment; gliding the parameters
 * is mathematically equivalent for linear DSP and a fraction of the cost.
 */

export interface Patch {
  id: string;
  name: string;
  tagline: string;
  seed: number;
  master: number;
  synth: Record<string, number>;
  fx: Record<string, number>;
}

const baseSynth = {
  cutoff: 900,
  resonance: 3.2,
  drive: 1.6,
  fmIndex: 0.6,
  fmRatio: 2.01,
  chaos: 0.35,
  width: 0.7,
  level: 0.85,
  droneLevel: 0.5,
  hissLevel: 0.28,
  duck: 0.55,
};

const baseFx = {
  grainMix: 0.35,
  grainSize: 0.09,
  grainScatter: 0.5,
  grainPitch: 0.5,
  grainFeedback: 0.35,
  grainRate: 0.5,
  spectralMix: 0.25,
  spectralFreeze: 0,
  spectralShift: 0,
  reverbMix: 0.4,
  reverbSize: 0.55,
  reverbDamp: 0.45,
  reverbWidth: 0.8,
  outputLevel: 0.9,
};

export const PATCHES: Patch[] = [
  {
    id: 'rift',
    name: 'THE RIFT',
    tagline: 'raw geometry leaking through spacetime',
    seed: 0x5eed1234,
    master: 0.78,
    synth: { ...baseSynth, cutoff: 1100, resonance: 4.2, drive: 1.8, fmIndex: 0.85, chaos: 0.45, droneLevel: 0.55 },
    fx: { ...baseFx, grainMix: 0.42, grainScatter: 0.7, reverbMix: 0.45, reverbSize: 0.6 },
  },
  {
    id: 'bloom',
    name: 'THE BLOOM',
    tagline: 'organic self in full reproduction',
    seed: 0x8100b,
    master: 0.8,
    synth: { ...baseSynth, cutoff: 1500, resonance: 2.4, drive: 2.6, fmIndex: 1.4, fmRatio: 3.01, chaos: 0.25, width: 0.9, droneLevel: 0.6 },
    fx: { ...baseFx, grainMix: 0.55, grainSize: 0.16, grainScatter: 0.35, grainPitch: 0.7, spectralMix: 0.35, reverbMix: 0.5 },
  },
  {
    id: 'engine',
    name: 'THE ENGINE',
    tagline: 'ancient machine dreams of duty',
    seed: 0x3a9e77,
    master: 0.82,
    synth: { ...baseSynth, cutoff: 620, resonance: 7.5, drive: 4.2, fmIndex: 0.35, fmRatio: 1.01, chaos: 0.6, droneLevel: 0.7, hissLevel: 0.4 },
    fx: { ...baseFx, grainMix: 0.18, grainSize: 0.04, grainScatter: 0.9, reverbMix: 0.3, reverbDamp: 0.75, reverbSize: 0.4 },
  },
  {
    id: 'void',
    name: 'THE VOID',
    tagline: 'nothing, paused between frames',
    seed: 0x701d,
    master: 0.72,
    synth: { ...baseSynth, cutoff: 420, resonance: 9.5, drive: 6.5, fmIndex: 2.2, fmRatio: 0.51, chaos: 0.85, width: 1.0, droneLevel: 0.35, hissLevel: 0.6 },
    fx: { ...baseFx, grainMix: 0.7, grainSize: 0.4, grainScatter: 0.2, grainPitch: 0.2, grainFeedback: 0.72, spectralMix: 0.6, spectralFreeze: 0.25, reverbMix: 0.7, reverbSize: 0.95, reverbDamp: 0.15 },
  },
  {
    id: 'oracle',
    name: 'DEEP ORACLE',
    tagline: 'the full transmission, unfiltered',
    seed: 0x0a4c1e,
    master: 0.85,
    synth: { ...baseSynth, cutoff: 1800, resonance: 5.5, drive: 3.0, fmIndex: 1.6, fmRatio: 2.41, chaos: 0.55, width: 0.85, droneLevel: 0.65, hissLevel: 0.34, duck: 0.7 },
    fx: { ...baseFx, grainMix: 0.5, grainSize: 0.13, grainScatter: 0.55, grainPitch: 0.6, spectralMix: 0.4, reverbMix: 0.55, reverbSize: 0.72 },
  },
];

export const DEFAULT_PATCH: Patch = PATCHES[4];

/** deep clone — patches are plain data, so structural clone is safe */
export function clonePatch(p: Patch): Patch {
  return JSON.parse(JSON.stringify(p)) as Patch;
}

/** linear interpolation between two patches (used by the A/B morph) */
export function lerpPatch(a: Patch, b: Patch, t: number): Patch {
  const mix = (ra: Record<string, number>, rb: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const k of Object.keys(ra)) {
      out[k] = ra[k] + (rb[k] - ra[k]) * t;
    }
    return out;
  };
  return {
    id: 'morph',
    name: t < 0.5 ? a.name : b.name,
    tagline: `morph ${Math.round(t * 100)}%`,
    seed: t < 0.5 ? a.seed : b.seed,
    master: a.master + (b.master - a.master) * t,
    synth: mix(a.synth, b.synth),
    fx: mix(a.fx, b.fx),
  };
}
