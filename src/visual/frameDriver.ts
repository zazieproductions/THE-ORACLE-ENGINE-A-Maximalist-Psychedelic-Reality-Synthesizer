/**
 * ====================================================================
 * FRAME DRIVER — the single render-clock bridge
 * ====================================================================
 *
 * Every consumer of audio analysis (the canvas instruments, the UI meters)
 * reads from here. There is exactly ONE requestAnimationFrame loop in the
 * whole application.
 *
 * ADR-029: one loop, not one per component. A naive implementation gives
 * each meter its own rAF, which at 6 instruments means 6 callbacks per frame
 * each polling the same ring buffer — and, worse, 6 different notions of
 * "now", so the waterfall and the oscilloscope disagree about which frame
 * they are showing. A single driver makes the whole UI sample-coherent.
 *
 * The driver also owns the *visual* smoothing that the audio thread must not
 * do: attack/release followers on energy, onset and centroid, evaluated at
 * frame rate rather than sample rate. That separation is deliberate — the
 * audio thread's smoothing budget is spent on parameters, not on cosmetics.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import type { AnalysisClient, AudioFrame } from '../audio/analysis/analysisClient';
import { FEATURE, FEATURE_COUNT, SPECTRUM_BINS, WAVEFORM_LEN } from '../audio/protocol';

export interface SmoothedFeatures {
  /** attack/release-followed broadband energy */
  energy: number;
  /** followed onset envelope (the note detector) */
  onset: number;
  /** followed spectral centroid */
  centroid: number;
  /** followed spectral flatness */
  flatness: number;
  /** followed peak */
  peak: number;
  /** followed band energies */
  bands: [number, number, number, number];
  /** raw feature vector, unsmoothed */
  raw: Float32Array;
}

export type FrameCallback = (frame: AudioFrame, dt: number, smoothed: SmoothedFeatures) => void;

const EMPTY_FRAME: AudioFrame = {
  spectrum: new Float32Array(SPECTRUM_BINS),
  waveform: new Float32Array(WAVEFORM_LEN),
  features: new Float32Array(FEATURE_COUNT),
};

/** asymmetric follower: fast attack, slow release — the visual "punch" */
class Follower {
  value = 0;

  constructor(
    private readonly attack: number,
    private readonly release: number,
  ) {}

  step(target: number, dt: number): number {
    const tau = target > this.value ? this.attack : this.release;
    const k = 1 - Math.exp(-dt / Math.max(1e-4, tau));
    this.value += (target - this.value) * k;
    return this.value;
  }
}

class FrameDriver {
  private client: AnalysisClient | null = null;
  private readonly callbacks = new Set<FrameCallback>();
  /** callbacks that have already thrown, so the console is not flooded */
  private readonly reported = new Set<FrameCallback>();
  private raf = 0;
  private last = 0;
  private running = false;

  /** most recent frame — read by the 3D scene inside its own render loop */
  latest: AudioFrame = EMPTY_FRAME;
  /** frames consumed since the last rAF tick */
  framesSinceLastTick = 0;

  private readonly fEnergy = new Follower(0.012, 0.16);
  private readonly fOnset = new Follower(0.002, 0.1);
  private readonly fCentroid = new Follower(0.05, 0.3);
  private readonly fFlatness = new Follower(0.06, 0.35);
  private readonly fPeak = new Follower(0.004, 0.12);
  private readonly fBands = [
    new Follower(0.01, 0.14), new Follower(0.01, 0.14),
    new Follower(0.01, 0.14), new Follower(0.01, 0.14),
  ];

  readonly smoothed: SmoothedFeatures = {
    energy: 0,
    onset: 0,
    centroid: 0,
    flatness: 0,
    peak: 0,
    bands: [0, 0, 0, 0],
    raw: new Float32Array(FEATURE_COUNT),
  };

  /** ring-buffer health, surfaced in the telemetry panel */
  stats = { framesRead: 0, overwritten: 0, dropped: 0 };

  /** audio context sample rate, kept in sync by the analyser */
  sampleRate = 48000;

  attach(client: AnalysisClient | null): void {
    this.client = client;
  }

  subscribe(cb: FrameCallback): () => void {
    this.callbacks.add(cb);
    this.reported.delete(cb);
    this.start();
    return () => {
      this.callbacks.delete(cb);
      this.reported.delete(cb);
      if (this.callbacks.size === 0) this.stop();
    };
  }

  private start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;

      if (this.client) {
        this.framesSinceLastTick = this.client.poll();
        if (this.framesSinceLastTick > 0) this.latest = this.client.current;
        this.stats = this.client.stats;
        const sr = this.client.sampleRate;
        if (sr > 0) this.sampleRate = sr;
      }

      const f = this.latest.features;
      const s = this.smoothed;
      s.energy = this.fEnergy.step(f[FEATURE.RMS], dt);
      s.onset = this.fOnset.step(f[FEATURE.ONSET], dt);
      s.centroid = this.fCentroid.step(f[FEATURE.CENTROID], dt);
      s.flatness = this.fFlatness.step(f[FEATURE.FLATNESS], dt);
      s.peak = this.fPeak.step(f[FEATURE.PEAK], dt);
      s.raw.set(f);
      for (let b = 0; b < 4; b++) {
        s.bands[b] = this.fBands[b].step(f[FEATURE.SUB + b], dt);
      }

      // ADR-050: a throwing subscriber must not take the whole visual layer
      // down. Without this guard the exception escapes `tick` *before* the
      // reschedule, so a single bad callback permanently kills the only rAF
      // loop in the app — the 3D scene keeps running but every meter,
      // waterfall and oscilloscope freezes on its last frame forever. The
      // error is reported (once per callback) and the loop continues.
      for (const cb of this.callbacks) {
        try {
          cb(this.latest, dt, s);
        } catch (err) {
          if (!this.reported.has(cb)) {
            this.reported.add(cb);
            console.error('[oracle] frame subscriber threw; it will not be reported again', err);
          }
        }
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  dispose(): void {
    this.stop();
    this.callbacks.clear();
    this.reported.clear();
    this.client = null;
    this.latest = EMPTY_FRAME;
    this.stats = { framesRead: 0, overwritten: 0, dropped: 0 };
    this.smoothed.raw.fill(0);
    this.smoothed.energy = 0;
    this.smoothed.onset = 0;
    this.smoothed.centroid = 0;
    this.smoothed.flatness = 0;
    this.smoothed.peak = 0;
    this.smoothed.bands = [0, 0, 0, 0];
    this.framesSinceLastTick = 0;
  }
}

export const frames = new FrameDriver();

/**
 * React binding. The callback is held in a ref so an inline arrow function
 * does not tear down and re-create the subscription on every render.
 */
export function useAudioFrame(cb: FrameCallback): void {
  const ref = useRef(cb);
  // ADR-046: writing `ref.current` during render is a React 19 lint error and
  // a genuine hazard — a render that is thrown away would leave the ref
  // pointing at a callback from a tree that no longer exists. The subscription
  // is established once and reads through the ref, so the only thing that
  // matters is that the ref is current *before the next frame*, which the
  // layout effect guarantees.
  useLayoutEffect(() => { ref.current = cb; }, [cb]);
  useEffect(() => frames.subscribe((f, dt, s) => ref.current(f, dt, s)), []);
}
