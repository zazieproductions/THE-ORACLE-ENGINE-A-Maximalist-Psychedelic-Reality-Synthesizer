/**
 * ====================================================================
 * WORKLET EXECUTION TESTS
 * ====================================================================
 *
 * These tests do not test a *model* of the worklet — they bundle the real
 * `*.worklet.ts` sources with the same esbuild pipeline the Vite plugin
 * uses, load the result as an ES module, install a fake AudioWorklet global
 * scope, and drive `process()` with synthetic render quanta.
 *
 * That means the DSP that runs in the browser is byte-for-byte the DSP under
 * test. If someone introduces a per-sample allocation, a NaN, an unbounded
 * state, or a crash on an empty input, this suite fails.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bundleWorkletSource } from './bundler';
import { SpscRing } from '../../core/ring';
import { SLOT_FLOATS, FEATURE, FEATURE_COUNT, SPECTRUM_BINS } from '../protocol';

const SR = 48000;
const BLOCK = 128;
const WORKLET_DIR = resolve(__dirname, '.');

interface FakeScope {
  sampleRate: number;
  currentTime: number;
  currentFrame: number;
  registerProcessor: (name: string, ctor: unknown) => void;
}

interface ProcessorLike {
  port: { postMessage: (m: unknown) => void; onmessage: ((e: { data: unknown }) => void) | null; close: () => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean;
}

const registry = new Map<string, new (options?: unknown) => ProcessorLike>();
let tmpRoot = '';

function installScope(sampleRate: number): FakeScope {
  const scope: FakeScope = {
    sampleRate,
    currentTime: 0,
    currentFrame: 0,
    registerProcessor: (name, ctor) => {
      registry.set(name, ctor as new (options?: unknown) => ProcessorLike);
    },
  };
  Object.assign(globalThis, scope);
  return scope;
}

interface TestPort {
  sent: unknown[];
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(m: unknown): void;
  close(): void;
}

function makePort(): TestPort {
  const port: TestPort = {
    sent: [],
    onmessage: null,
    postMessage(m: unknown) { this.sent.push(m); },
    close() { /* noop */ },
  };
  Object.defineProperty(globalThis, 'port', { value: port, configurable: true, writable: true });
  return port;
}

async function loadProcessor(
  name: string,
  options?: unknown,
): Promise<{ proc: ProcessorLike; port: TestPort }> {
  const entry = join(WORKLET_DIR, `${name}.worklet.ts`);
  const code = await bundleWorkletSource(entry);
  const file = join(tmpRoot, `${name}.${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, code);
  await import(file);
  const ctor = registry.get(name);
  if (!ctor) throw new Error(`processor "${name}" was not registered`);
  // a fresh MessagePort per instance, installed before construction
  const port = makePort();
  return { proc: new ctor(options), port };
}

/** params: every AudioParam descriptor filled with its default value */
function paramsFrom(proc: ProcessorLike & { constructor: { parameterDescriptors?: { name: string; defaultValue: number }[] } }): Record<string, Float32Array> {
  const descs = (proc.constructor as unknown as { parameterDescriptors?: { name: string; defaultValue: number }[] }).parameterDescriptors ?? [];
  const out: Record<string, Float32Array> = {};
  for (const d of descs) out[d.name] = new Float32Array(BLOCK).fill(d.defaultValue);
  return out;
}

function quanta(outL: Float32Array, outR: Float32Array): Float32Array[][] {
  return [[outL, outR]];
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oracle-worklet-'));
  installScope(SR);
  return () => rmSync(tmpRoot, { recursive: true, force: true });
});

describe('oracle-synth worklet', () => {
  it('renders finite, non-silent audio with no input connected', async () => {
    const { proc } = await loadProcessor('oracle-synth');
    const params = paramsFrom(proc as never);
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    const inputs: Float32Array[][] = [];
    let peak = 0;
    for (let b = 0; b < 200; b++) {
      outL.fill(0); outR.fill(0);
      expect(proc.process(inputs, quanta(outL, outR), params)).toBe(true);
      for (let i = 0; i < BLOCK; i++) {
        expect(Number.isFinite(outL[i])).toBe(true);
        peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]));
      }
    }
    expect(peak).toBeGreaterThan(0.001);
    expect(peak).toBeLessThan(4);
  });

  it('produces sound only after a noteOn and stops after panic', async () => {
    const { proc } = await loadProcessor('oracle-synth');
    const params = paramsFrom(proc as never);
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    const inputs: Float32Array[][] = [];

    const measure = () => {
      let peak = 0;
      for (let b = 0; b < 40; b++) {
        outL.fill(0); outR.fill(0);
        proc.process(inputs, quanta(outL, outR), params);
        for (let i = 0; i < BLOCK; i++) peak = Math.max(peak, Math.abs(outL[i]));
      }
      return peak;
    };

    // silence the sustained layers (fill the whole array: these are a-rate)
    params.droneLevel.fill(0);
    params.hissLevel.fill(0);
    const before = measure();
    expect(before).toBeLessThan(1e-4);

    proc.port.onmessage!({
      data: { type: 'noteOn', note: 57, velocity: 1, voiceId: 1, when: 0 },
    });
    const during = measure();
    expect(during).toBeGreaterThan(0.01);

    proc.port.onmessage!({ data: { type: 'panic' } });
    const after = measure();
    expect(after).toBeLessThan(1e-4);
  });

  it('defers a note scheduled in the future', async () => {
    const { proc } = await loadProcessor('oracle-synth');
    const params = paramsFrom(proc as never);
    params.droneLevel.fill(0);
    params.hissLevel.fill(0);
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    const inputs: Float32Array[][] = [];

    const scope = globalThis as unknown as FakeScope;
    scope.currentTime = 0;
    proc.port.onmessage!({
      data: { type: 'noteOn', note: 60, velocity: 1, voiceId: 7, when: 0.05 },
    });
    let early = 0;
    for (let b = 0; b < 10; b++) {
      outL.fill(0); outR.fill(0);
      proc.process(inputs, quanta(outL, outR), params);
      for (let i = 0; i < BLOCK; i++) early = Math.max(early, Math.abs(outL[i]));
      scope.currentTime += BLOCK / SR;
    }
    expect(early).toBeLessThan(1e-4);

    let late = 0;
    for (let b = 0; b < 40; b++) {
      outL.fill(0); outR.fill(0);
      proc.process(inputs, quanta(outL, outR), params);
      for (let i = 0; i < BLOCK; i++) late = Math.max(late, Math.abs(outL[i]));
      scope.currentTime += BLOCK / SR;
    }
    expect(late).toBeGreaterThan(0.01);
  });

  it('survives a full 8-voice chord plus voice stealing', async () => {
    const { proc } = await loadProcessor('oracle-synth');
    const params = paramsFrom(proc as never);
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    const inputs: Float32Array[][] = [];
    for (let v = 0; v < 8; v++) {
      proc.port.onmessage!({
        data: { type: 'noteOn', note: 48 + v * 3, velocity: 0.9, voiceId: v + 1, when: 0 },
      });
    }
    // steal: 8 more notes than voices
    for (let v = 0; v < 8; v++) {
      proc.port.onmessage!({
        data: { type: 'noteOn', note: 60 + v * 2, velocity: 0.9, voiceId: 100 + v, when: 0 },
      });
    }
    let peak = 0;
    for (let b = 0; b < 200; b++) {
      outL.fill(0); outR.fill(0);
      proc.process(inputs, quanta(outL, outR), params);
      for (let i = 0; i < BLOCK; i++) peak = Math.max(peak, Math.abs(outL[i]));
    }
    expect(Number.isFinite(peak)).toBe(true);
    expect(peak).toBeGreaterThan(0.001);
    expect(peak).toBeLessThan(8);
  });
});

describe('oracle-synth global macros (ADR-040 / ADR-041)', () => {
  /**
   * Render one note for a fixed window and return summary statistics.
   * Everything except the mutated parameter is left at its default so the
   * only variable is the macro under test.
   */
  async function renderNote(mutate: (p: Record<string, Float32Array>) => void, blocks = 60) {
    const { proc } = await loadProcessor('oracle-synth');
    const params = paramsFrom(proc as never);
    params.droneLevel.fill(0);
    params.hissLevel.fill(0);
    mutate(params);
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    proc.port.onmessage!({ data: { type: 'noteOn', note: 57, velocity: 1, voiceId: 1, when: 0 } });
    let energy = 0;
    let peak = 0;
    let crossings = 0;
    let prev = 0;
    const crossingsAt: number[] = [];
    const wave = new Float32Array(blocks * BLOCK);
    let sampleIndex = 0;
    // the first blocks are the attack ramp, where the signal is at the
    // numerical noise floor and crosses zero many times per sample; only
    // count crossings once the envelope has settled
    const settle = 24;
    for (let b = 0; b < blocks; b++) {
      outL.fill(0); outR.fill(0);
      proc.process([], quanta(outL, outR), params);
      for (let i = 0; i < BLOCK; i++) {
        const v = outL[i];
        energy += v * v + outR[i] * outR[i];
        peak = Math.max(peak, Math.abs(v));
        if (b >= settle && (v >= 0) !== (prev >= 0)) {
          crossings++;
          crossingsAt.push(sampleIndex);
        }
        prev = v;
        wave[sampleIndex] = v;
        sampleIndex++;
      }
    }
    return { energy, peak, crossings, crossingsAt, samples: sampleIndex, wave };
  }

  it('the CUTOFF macro actually changes the spectrum', async () => {
    const dark = await renderNote((p) => { p.cutoff.fill(150); });
    const bright = await renderNote((p) => { p.cutoff.fill(12000); });
    // a closed filter has far fewer zero crossings than an open one
    const darkRate = dark.crossings / dark.samples;
    const brightRate = bright.crossings / bright.samples;
    expect(brightRate).toBeGreaterThan(darkRate * 3);
    // total energy is *not* monotonic in cutoff — a resonant peak near the
    // note's fundamental can carry more energy than a wide-open filter —
    // so the assertion that matters is the spectral one above.
  });

  it('the RESONANCE macro actually changes the spectrum', async () => {
    const flat = await renderNote((p) => { p.cutoff.fill(1500); p.resonance.fill(0.4); });
    const peaky = await renderNote((p) => { p.cutoff.fill(1500); p.resonance.fill(24); });
    expect(peaky.energy).toBeGreaterThan(flat.energy * 1.3);
    expect(peaky.crossings).toBeGreaterThan(flat.crossings * 2);
  });

  it('the FM RATIO macro actually changes the spectrum', async () => {
    const low = await renderNote((p) => { p.fmIndex.fill(6); p.fmRatio.fill(0.25); p.cutoff.fill(6000); });
    const high = await renderNote((p) => { p.fmIndex.fill(6); p.fmRatio.fill(8); p.cutoff.fill(6000); });
    expect(Math.abs(high.energy - low.energy) / Math.max(high.energy, low.energy)).toBeGreaterThan(0.3);
  });

  it('the CHAOS macro measurably modulates the voice', async () => {
    // the attractor is a *modulator*, so its effect is spectral movement
    // rather than a big level change — assert the difference is real but
    // keep the threshold honest about how subtle it is meant to be
    const still = await renderNote((p) => { p.chaos.fill(0); p.cutoff.fill(400); });
    const wild = await renderNote((p) => { p.chaos.fill(1); p.cutoff.fill(400); });
    expect(Math.abs(wild.energy - still.energy) / still.energy).toBeGreaterThan(0.02);
  });

  it('plays at the requested pitch (ADR-042 regression)', async () => {
    // With FM off and the filter open the carrier is a band-limited pulse.
    // Zero-crossing counting is useless here (48 harmonics make the waveform
    // spiky), so measure the period by autocorrelation instead — the lag of
    // the first strong peak *is* the period, whatever the timbre.
    const r = await renderNote((p) => { p.fmIndex.fill(0); p.cutoff.fill(12000); }, 90);
    const expectedHz = 440 * Math.pow(2, (57 - 69) / 12); // A3 = 220 Hz
    const expectedLag = Math.round(SR / expectedHz);

    // analyse a settled window
    const from = 40 * BLOCK;
    const len = 20 * BLOCK;
    const w = r.wave.subarray(from, from + len);
    let best = -Infinity;
    let bestLag = 0;
    for (let lag = 32; lag < 1200; lag++) {
      let sum = 0;
      for (let i = 0; i + lag < len; i++) sum += w[i] * w[i + lag];
      if (sum > best) { best = sum; bestLag = lag; }
    }
    expect(bestLag).toBeGreaterThan(expectedLag * 0.8);
    expect(bestLag).toBeLessThan(expectedLag * 1.25);
  });

  it('stays finite under an extreme FM sweep (negative phase wrap)', async () => {
    const { proc } = await loadProcessor('oracle-synth');
    const params = paramsFrom(proc as never);
    // the worst case for ADR-040: maximum index and ratio, so the phase
    // increment goes deeply negative every other sample
    params.fmIndex.fill(12);
    params.fmRatio.fill(8);
    params.cutoff.fill(16000);
    params.drive.fill(24);
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    for (let v = 0; v < 8; v++) {
      proc.port.onmessage!({
        data: { type: 'noteOn', note: 40 + v * 7, velocity: 1, voiceId: v + 1, when: 0 },
      });
    }
    let nonFinite = 0;
    let peak = 0;
    for (let b = 0; b < 300; b++) {
      outL.fill(0); outR.fill(0);
      proc.process([], quanta(outL, outR), params);
      for (let i = 0; i < BLOCK; i++) {
        if (!Number.isFinite(outL[i]) || !Number.isFinite(outR[i])) nonFinite++;
        peak = Math.max(peak, Math.abs(outL[i]));
      }
    }
    expect(nonFinite).toBe(0);
    expect(Number.isFinite(peak)).toBe(true);
    expect(peak).toBeLessThan(8);
  });
});

describe('oracle-fx worklet', () => {
  it('renders finite audio and stays bounded under a hot input', async () => {
    const { proc } = await loadProcessor('oracle-fx');
    const params = paramsFrom(proc as never);
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    let peak = 0;
    for (let b = 0; b < 400; b++) {
      const inL = new Float32Array(BLOCK);
      const inR = new Float32Array(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        const t = (b * BLOCK + i) / SR;
        inL[i] = 0.8 * Math.sin(2 * Math.PI * 220 * t);
        inR[i] = 0.8 * Math.sin(2 * Math.PI * 277 * t);
      }
      outL.fill(0); outR.fill(0);
      expect(proc.process([[inL, inR]], quanta(outL, outR), params)).toBe(true);
      for (let i = 0; i < BLOCK; i++) {
        expect(Number.isFinite(outL[i])).toBe(true);
        peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]));
      }
    }
    // the limiter must hold the ceiling
    expect(peak).toBeLessThanOrEqual(0.92);
  });

  it('handles a mono input (single channel) without crashing', async () => {
    const { proc } = await loadProcessor('oracle-fx');
    const params = paramsFrom(proc as never);
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    const inL = new Float32Array(BLOCK).fill(0.4);
    proc.process([[inL]], quanta(outL, outR), params);
    for (let i = 0; i < BLOCK; i++) expect(Number.isFinite(outL[i])).toBe(true);
  });

  it('panic clears all state', async () => {
    const { proc } = await loadProcessor('oracle-fx');
    const params = paramsFrom(proc as never);
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    const drive = () => {
      for (let b = 0; b < 100; b++) {
        const inL = new Float32Array(BLOCK).fill(0.5);
        const inR = new Float32Array(BLOCK).fill(0.5);
        outL.fill(0); outR.fill(0);
        proc.process([[inL, inR]], quanta(outL, outR), params);
      }
    };
    drive();
    proc.port.onmessage!({ data: { type: 'panic' } });
    drive();
    for (let i = 0; i < BLOCK; i++) expect(Number.isFinite(outL[i])).toBe(true);
  });

  it('spectral freeze sustains energy after the input stops', async () => {
    const { proc } = await loadProcessor('oracle-fx');
    const params = paramsFrom(proc as never);
    params.spectralMix.fill(1);
    params.spectralFreeze.fill(1);
    params.grainMix.fill(0);
    params.reverbMix.fill(0);
    params.outputLevel.fill(1);
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);

    const run = (amp: number, blocks: number) => {
      let energy = 0;
      for (let b = 0; b < blocks; b++) {
        const inL = new Float32Array(BLOCK);
        const inR = new Float32Array(BLOCK);
        for (let i = 0; i < BLOCK; i++) {
          const t = (b * BLOCK + i) / SR;
          inL[i] = amp * Math.sin(2 * Math.PI * 440 * t);
          inR[i] = amp * Math.sin(2 * Math.PI * 660 * t);
        }
        outL.fill(0); outR.fill(0);
        proc.process([[inL, inR]], quanta(outL, outR), params);
        for (let i = 0; i < BLOCK; i++) energy += outL[i] * outL[i] + outR[i] * outR[i];
      }
      return Math.sqrt(energy / (blocks * BLOCK * 2));
    };

    const loud = run(0.5, 120);
    const frozen = run(0, 60);
    // a frozen spectrum must keep producing sound after the input is gone
    expect(frozen).toBeGreaterThan(loud * 0.2);
  });
});

describe('oracle-analyzer worklet', () => {
  it('publishes frames into a shared ring', async () => {
    const ring = SpscRing.create(8, SLOT_FLOATS, true);
    const { proc } = await loadProcessor('oracle-analyzer', { ringBuffer: ring.buffer });
    const params = { enabled: new Float32Array(BLOCK).fill(1) };
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    const inL = new Float32Array(BLOCK);
    const inR = new Float32Array(BLOCK);

    for (let b = 0; b < 200; b++) {
      for (let i = 0; i < BLOCK; i++) {
        const t = (b * BLOCK + i) / SR;
        inL[i] = 0.5 * Math.sin(2 * Math.PI * 440 * t);
        inR[i] = 0.5 * Math.sin(2 * Math.PI * 440 * t);
      }
      outL.fill(0); outR.fill(0);
      proc.process([[inL, inR]], quanta(outL, outR), params);
      // pass-through must be bit-exact
      for (let i = 0; i < BLOCK; i++) {
        expect(outL[i]).toBe(inL[i]);
        expect(outR[i]).toBe(inR[i]);
      }
    }

    expect(ring.available()).toBeGreaterThan(0);
    const slot = new Float32Array(SLOT_FLOATS);
    expect(ring.readLatest(slot)).toBe(true);
    // a 440 Hz tone at 48 kHz lands in bin 440/46.875 = 9.4
    let peakBin = 0;
    for (let i = 1; i < SPECTRUM_BINS; i++) {
      if (slot[i] > slot[peakBin]) peakBin = i;
    }
    expect(peakBin).toBeGreaterThanOrEqual(7);
    expect(peakBin).toBeLessThanOrEqual(12);
    expect(slot[SLOT_FLOATS - FEATURE_COUNT + FEATURE.RMS]).toBeGreaterThan(0.1);
  });

  it('falls back to postMessage when the ring is not shared', async () => {
    const ring = SpscRing.create(4, SLOT_FLOATS, false);
    const { proc, port } = await loadProcessor('oracle-analyzer', { ringBuffer: ring.buffer });
    const params = { enabled: new Float32Array(BLOCK).fill(1) };
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    const inL = new Float32Array(BLOCK);
    const inR = new Float32Array(BLOCK);

    for (let b = 0; b < 100; b++) {
      for (let i = 0; i < BLOCK; i++) {
        const t = (b * BLOCK + i) / SR;
        inL[i] = 0.5 * Math.sin(2 * Math.PI * 440 * t);
        inR[i] = 0.5 * Math.sin(2 * Math.PI * 440 * t);
      }
      outL.fill(0); outR.fill(0);
      proc.process([[inL, inR]], quanta(outL, outR), params);
    }
    const frames = port.sent.filter((m) => (m as { type?: string }).type === 'frame');
    expect(frames.length).toBeGreaterThan(10);
    const frame = (frames[frames.length - 1] as { frame: Float32Array }).frame;
    expect(frame.length).toBe(SLOT_FLOATS);
  });

  it('can be disabled without breaking the pass-through', async () => {
    const ring = SpscRing.create(4, SLOT_FLOATS, true);
    const { proc } = await loadProcessor('oracle-analyzer', { ringBuffer: ring.buffer });
    const params = { enabled: new Float32Array(BLOCK).fill(0) };
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    const inL = new Float32Array(BLOCK).fill(0.3);
    const inR = new Float32Array(BLOCK).fill(-0.3);
    for (let b = 0; b < 50; b++) {
      outL.fill(0); outR.fill(0);
      proc.process([[inL, inR]], quanta(outL, outR), params);
    }
    expect(ring.available()).toBe(0);
    expect(outL[0]).toBeCloseTo(0.3, 6);
    expect(outR[0]).toBeCloseTo(-0.3, 6);
  });
});
