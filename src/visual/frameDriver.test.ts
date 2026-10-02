/**
 * ====================================================================
 * FRAME DRIVER TESTS
 * ====================================================================
 *
 * ADR-029/030 say the visual core has exactly one rAF loop and that its
 * smoothing lives on the render thread. Both claims are falsifiable, and a
 * browser is the only place they can be broken in practice, so they are
 * pinned down here with a controllable rAF clock:
 *
 *   - one loop no matter how many subscribers
 *   - the loop stops when the last subscriber leaves
 *   - dispose() is total (loop, subscribers, client)
 *   - callbacks see a monotonically advancing dt and a stable `latest`
 *   - the followers are asymmetric (attack faster than release)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { frames } from './frameDriver';
import { FEATURE, FEATURE_COUNT, SPECTRUM_BINS, WAVEFORM_LEN } from '../audio/protocol';
import type { AnalysisClient, AudioFrame } from '../audio/analysis/analysisClient';

// ---------------------------------------------------------------- fake clock

let now = 0;
const pending: FrameRequestCallback[] = [];
let rafCalls = 0;

const realRaf = globalThis.requestAnimationFrame;
const realCancel = globalThis.cancelAnimationFrame;

/** advance the fake clock and run exactly one frame */
function step(ms: number): void {
  now += ms;
  const cb = pending.shift();
  if (cb) cb(now);
}

beforeEach(() => {
  now = 0;
  pending.length = 0;
  rafCalls = 0;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafCalls++;
    pending.push(cb);
    return rafCalls;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => { /* tracked via pending */ }) as typeof cancelAnimationFrame;
  (globalThis as unknown as { performance: unknown }).performance = { now: () => now };
  frames.dispose();
});

afterEach(() => {
  frames.dispose();
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCancel;
});

// ---------------------------------------------------------------- fake client

/**
 * A mutable fake client: the tests drive `set(...)` *between* frames, which
 * is what a live analyser does. (An earlier version snapshotted the features
 * at construction, so mutating the source array did nothing and every
 * "the macro changes the output" style assertion silently measured a
 * constant.)
 */
function makeClient(features: number[] = []): AnalysisClient & { set: (i: number, v: number) => void } {
  const frame: AudioFrame = {
    spectrum: new Float32Array(SPECTRUM_BINS),
    waveform: new Float32Array(WAVEFORM_LEN),
    features: new Float32Array(FEATURE_COUNT),
  };
  for (let i = 0; i < features.length; i++) frame.features[i] = features[i];
  const client = {
    ring: {} as never,
    node: {} as never,
    shared: true,
    poll: vi.fn(() => 1),
    get current() { return frame; },
    get energy() { return frame.features[FEATURE.RMS]; },
    get onset() { return frame.features[FEATURE.ONSET]; },
    get centroid() { return frame.features[FEATURE.CENTROID]; },
    get sampleRate() { return 44100; },
    get stats() { return { framesRead: 7, overwritten: 0, dropped: 0 }; },
    onTelemetry: () => undefined,
    requestTelemetry: () => undefined,
    dispose: () => undefined,
    set: (i: number, v: number) => { frame.features[i] = v; },
  };
  return client as unknown as AnalysisClient & { set: (i: number, v: number) => void };
}

// ---------------------------------------------------------------- tests

describe('FrameDriver', () => {
  it('runs exactly one rAF loop for any number of subscribers', () => {
    const offs = [frames.subscribe(() => {}), frames.subscribe(() => {}), frames.subscribe(() => {})];
    expect(rafCalls).toBe(1); // started once, by the first subscriber
    step(16);
    expect(rafCalls).toBe(2); // one reschedule, not three
    step(16);
    expect(rafCalls).toBe(3);
    offs.forEach((o) => o());
  });

  it('stops the loop when the last subscriber leaves', () => {
    const a = frames.subscribe(() => {});
    const b = frames.subscribe(() => {});
    step(16);
    a();
    expect(rafCalls).toBe(2); // still running for b
    b();
    const before = rafCalls;
    step(16);
    step(16);
    expect(rafCalls).toBe(before); // nothing rescheduled
  });

  it('restarts cleanly after every subscriber has left', () => {
    const off = frames.subscribe(() => {});
    off();
    const off2 = frames.subscribe(() => {});
    step(16);
    expect(rafCalls).toBeGreaterThan(0);
    off2();
  });

  it('dispose() is total: loop, subscribers and client all go', () => {
    let calls = 0;
    frames.subscribe(() => { calls++; });
    frames.attach(makeClient([0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    step(16);
    expect(calls).toBe(1);
    frames.dispose();
    step(16);
    step(16);
    expect(calls).toBe(1);
  });

  it('publishes the client frame and its stats', () => {
    const features = new Array<number>(FEATURE_COUNT).fill(0);
    features[FEATURE.RMS] = 0.42;
    features[FEATURE.ONSET] = 0.9;
    features[FEATURE.CENTROID] = 0.3;
    frames.attach(makeClient(features));
    let seen: AudioFrame | null = null;
    const off = frames.subscribe((f) => { seen = f; });
    step(16);
    expect(seen).not.toBeNull();
    expect(seen!.features[FEATURE.RMS]).toBeCloseTo(0.42, 5);
    expect(frames.latest.features[FEATURE.RMS]).toBeCloseTo(0.42, 5);
    expect(frames.stats.framesRead).toBe(7);
    expect(frames.sampleRate).toBe(44100);
    off();
  });

  it('falls back to an empty frame when no client is attached', () => {
    let seen: AudioFrame | null = null;
    const off = frames.subscribe((f) => { seen = f; });
    step(16);
    expect(seen).not.toBeNull();
    expect(seen!.spectrum.length).toBe(SPECTRUM_BINS);
    expect(seen!.waveform.length).toBe(WAVEFORM_LEN);
    expect(seen!.features.length).toBe(FEATURE_COUNT);
    off();
  });

  it('gives every subscriber the same dt and the same frame', () => {
    const seen: Array<[AudioFrame, number]> = [];
    const offs = [
      frames.subscribe((f, dt) => seen.push([f, dt])),
      frames.subscribe((f, dt) => seen.push([f, dt])),
    ];
    step(16);
    step(33);
    expect(seen.length).toBe(4);
    expect(seen[0][1]).toBeCloseTo(0.016, 5);
    expect(seen[2][1]).toBeCloseTo(0.033, 5);
    // sample-coherent: the second subscriber of a tick sees the identical object
    expect(seen[0][0]).toBe(seen[1][0]);
    expect(seen[2][0]).toBe(seen[3][0]);
    offs.forEach((o) => o());
  });

  it('clamps a huge dt so a backgrounded tab cannot explode the followers', () => {
    const features = new Array<number>(FEATURE_COUNT).fill(0);
    features[FEATURE.RMS] = 1;
    frames.attach(makeClient(features));
    const off = frames.subscribe((_f, dt) => { expect(dt).toBeLessThanOrEqual(0.1); });
    step(5000);
    off();
  });

  it('attacks faster than it releases (asymmetric ballistics)', () => {
    const client = makeClient();
    frames.attach(client);
    const off = frames.subscribe(() => {});

    // rise: 30 frames of 16 ms with a full-scale target. The attack time
    // constant is 12 ms, so 30 frames is ~13 constants — it must be done.
    client.set(FEATURE.RMS, 1);
    let attacked = 0;
    for (let i = 0; i < 30; i++) { step(16); attacked = frames.smoothed.energy; }
    expect(attacked).toBeGreaterThan(0.99);

    // fall: the release time constant is 160 ms, i.e. 13x slower. Ten frames
    // is under one constant, so the level must still be high...
    // 10 frames x 16 ms is exactly one release time constant, so the level
    // must sit at 1/e. The attack over the same 10 frames is already at
    // 1 - (1/e)^13, i.e. indistinguishable from done.
    client.set(FEATURE.RMS, 0);
    let released = 0;
    for (let i = 0; i < 10; i++) { step(16); released = frames.smoothed.energy; }
    expect(released).toBeCloseTo(Math.exp(-1), 2);
    expect(released).toBeLessThan(attacked * 0.5);

    for (let i = 0; i < 30; i++) { step(16); released = frames.smoothed.energy; }
    expect(released).toBeLessThan(0.02);
    off();
  });

  it('exposes the raw (unsmoothed) feature vector alongside the smoothed one', () => {
    const client = makeClient();
    client.set(FEATURE.PEAK, 0.77);
    frames.attach(client);
    const off = frames.subscribe(() => {});
    step(16);
    expect(frames.smoothed.raw[FEATURE.PEAK]).toBeCloseTo(0.77, 5);
    // smoothed peak lags behind on the first frame
    expect(frames.smoothed.peak).toBeLessThan(0.77);
    off();
  });

  it('keeps four independent band followers', () => {
    const client = makeClient();
    client.set(FEATURE.SUB + 0, 0.2);
    client.set(FEATURE.SUB + 1, 0.4);
    client.set(FEATURE.SUB + 2, 0.6);
    client.set(FEATURE.SUB + 3, 0.8);
    frames.attach(client);
    const off = frames.subscribe(() => {});
    for (let i = 0; i < 200; i++) step(16);
    expect(frames.smoothed.bands[0]).toBeLessThan(frames.smoothed.bands[1]);
    expect(frames.smoothed.bands[1]).toBeLessThan(frames.smoothed.bands[2]);
    expect(frames.smoothed.bands[2]).toBeLessThan(frames.smoothed.bands[3]);
    expect(frames.smoothed.bands[3]).toBeCloseTo(0.8, 2);
    off();
  });

  it('a throwing subscriber cannot stall the loop for the others (ADR-050)', () => {
    const good: number[] = [];
    const bad = frames.subscribe(() => { throw new Error('boom'); });
    const ok = frames.subscribe(() => good.push(1));

    // the exception must NOT escape the tick
    expect(() => step(16)).not.toThrow();
    expect(good.length).toBe(1);
    expect(rafCalls).toBe(2); // the loop rescheduled anyway

    // and it keeps running for as long as the offender stays subscribed
    step(16);
    step(16);
    expect(good.length).toBe(3);

    bad();
    ok();
  });

  it('resets every piece of derived state on dispose', () => {
    const client = makeClient();
    client.set(FEATURE.RMS, 1);
    client.set(FEATURE.PEAK, 0.9);
    frames.attach(client);
    const off = frames.subscribe(() => {});
    for (let i = 0; i < 40; i++) step(16);
    expect(frames.smoothed.energy).toBeGreaterThan(0.9);

    off();
    frames.dispose();
    expect(frames.smoothed.energy).toBe(0);
    expect(frames.smoothed.peak).toBe(0);
    expect(frames.smoothed.bands).toEqual([0, 0, 0, 0]);
    expect(frames.smoothed.raw[FEATURE.PEAK]).toBe(0);
    expect(frames.stats.framesRead).toBe(0);
    expect(frames.latest.features[FEATURE.RMS]).toBe(0);
  });
});
