/**
 * ====================================================================
 * ORACLE ENGINE — the orchestrator
 * ====================================================================
 *
 * The single owner of the Web Audio graph. Everything above this file (UI,
 * store, visuals) talks to it through a narrow, typed surface; everything
 * below it (worklets, DSP kernels) knows nothing about React.
 *
 * Topology:
 *
 *   [synth worklet] ─┐
 *                    ├─► busIn ─► [fx worklet] ─► [analyzer worklet] ─► comp ─► master ─► out
 *   [mic] ───────────┘                                                       │
 *                                                                           └─► recorder
 *
 * ADR-023: the engine is a *service*, not a module of functions. It owns a
 * lifecycle (init -> run -> dispose) and refuses to be constructed twice.
 * Every resource it acquires (AudioContext, MediaStream, blob URLs, worklet
 * nodes, the analysis ring) is released in `dispose()`, which is called from
 * a `beforeunload`-equivalent in the React tree. Leaking an AudioContext is
 * the single most common way a web audio app degrades a machine over a
 * session, so teardown is treated as a first-class requirement.
 *
 * ADR-024: initialisation is a single-flight promise. Two rapid clicks on
 * "INITIALIZE DESCENT" must not create two contexts (browsers cap the number
 * of concurrent AudioContexts at ~6 and then silently fail), and a failure
 * must not leave a half-built graph behind.
 */

import { loadWorklets, disposeWorklets } from './workletLoader';
import { AnalysisClient } from './analysis/analysisClient';
import { Sequencer } from './scheduler';
import { Recorder } from './recorder';
import { DEFAULT_PATCH, type Patch } from './presets';
import type { NoteMods, TelemetryMsg, WorkletMsg, EngineEvent } from './protocol';

type Listener = (event: EngineEvent) => void;

const LOOKAHEAD_SECONDS = 0.09;
const SCHEDULER_INTERVAL_MS = 25;

export interface EngineOptions {
  onEvent?: Listener;
}

export class OracleEngine {
  private static instance: OracleEngine | null = null;

  private ctx: AudioContext | null = null;
  private synth: AudioWorkletNode | null = null;
  private fx: AudioWorkletNode | null = null;
  private analysis: AnalysisClient | null = null;
  private busIn: GainNode | null = null;
  private comp: DynamicsCompressorNode | null = null;
  private master: GainNode | null = null;
  private recorder: Recorder | null = null;

  private micFadeTimer: number | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micFilter: BiquadFilterNode | null = null;
  private micGain: GainNode | null = null;
  private micActive = false;

  private seq: Sequencer | null = null;
  private schedulerTimer: number | null = null;
  private nextNoteTime = 0;
  private voiceIdCounter = 0;
  private initPromise: Promise<void> | null = null;
  private listeners = new Set<Listener>();
  private telemetry: TelemetryMsg | null = null;
  private telemetryTimer: number | null = null;
  private disposed = false;
  private sharedMemory = false;
  private sampleRate = 48000;

  // ----------------------------------------------------------------
  static get shared(): OracleEngine | null { return OracleEngine.instance; }

  constructor(private options: EngineOptions = {}) {
    if (OracleEngine.instance) {
      throw new Error('OracleEngine is a singleton — use OracleEngine.acquire()');
    }
    OracleEngine.instance = this;
  }

  static acquire(options?: EngineOptions): OracleEngine {
    if (!OracleEngine.instance) new OracleEngine(options);
    // the constructor guarantees a non-null singleton
    return OracleEngine.instance as OracleEngine;
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: EngineEvent): void {
    this.options.onEvent?.(event);
    for (const l of this.listeners) l(event);
  }

  // ----------------------------------------------------------------
  get ready(): boolean { return this.ctx !== null && this.synth !== null; }
  get context(): AudioContext | null { return this.ctx; }
  get analyserNode(): AnalysisClient | null { return this.analysis; }
  get micEnabled(): boolean { return this.micActive; }
  get lastTelemetry(): TelemetryMsg | null { return this.telemetry; }
  get rate(): number { return this.sampleRate; }
  get isSharedMemory(): boolean { return this.sharedMemory; }

  // ----------------------------------------------------------------
  /**
   * Single-flight initialisation. Safe to call repeatedly; concurrent calls
   * await the same promise.
   */
  init(): Promise<void> {
    // ADR-038: a disposed engine must never appear to initialise again. The
    // old behaviour returned the *previous* (already resolved) init promise,
    // so `await engine.init()` after `dispose()` silently succeeded while
    // every node was gone — the worst kind of failure, because the UI would
    // report "running" and then produce no sound.
    if (this.disposed) {
      return Promise.reject(new Error('engine has been disposed — acquire a new instance'));
    }
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit().catch((err) => {
      // roll back so a retry is possible after a failure
      this.initPromise = null;
      this.teardownGraph();
      this.emit({ type: 'failed', reason: 'init', detail: err });
      throw err;
    });
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    if (this.disposed) throw new Error('engine has been disposed');
    const AC: typeof AudioContext =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) throw new Error('Web Audio is not available in this browser');

    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;

    const loaded = await loadWorklets(ctx);
    // a dispose() that landed while we were awaiting must abort the build
    if (this.disposed) { void ctx.close().catch(() => undefined); throw new Error('engine was disposed during init'); }
    if (!loaded.ok) throw new Error(loaded.error ?? 'worklet load failed');

    // ---- graph ------------------------------------------------------
    const busIn = ctx.createGain();
    busIn.gain.value = 1;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 26;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.22;

    const master = ctx.createGain();
    master.gain.value = 0.0001;

    this.synth = new AudioWorkletNode(ctx, 'oracle-synth', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.fx = new AudioWorkletNode(ctx, 'oracle-fx', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.analysis = new AnalysisClient(ctx, 'oracle-analyzer');

    this.synth.connect(busIn);
    busIn.connect(this.fx);
    this.fx.connect(this.analysis.node);
    this.analysis.node.connect(comp);
    comp.connect(master);
    master.connect(ctx.destination);

    this.busIn = busIn;
    this.comp = comp;
    this.master = master;
    this.recorder = new Recorder(ctx, master);

    this.analysis.onTelemetry((t) => {
      this.telemetry = t;
      this.emit({ type: 'telemetry', data: t });
    });

    this.applyPatch(DEFAULT_PATCH, 0);

    ctx.addEventListener('statechange', () => {
      this.emit({ type: 'state', contextState: ctx.state });
    });

    if (ctx.state === 'suspended') await ctx.resume();
    if (this.disposed) { void ctx.close().catch(() => undefined); throw new Error('engine was disposed during init'); }

    // ramp the master in from silence — a hard 0 -> 0.75 step clicks
    master.gain.setValueAtTime(0.0001, ctx.currentTime);
    master.gain.exponentialRampToValueAtTime(0.8, ctx.currentTime + 0.6);

    this.sharedMemory = this.analysis.shared;
    this.startTelemetry();
    this.emit({
      type: 'started',
      sampleRate: ctx.sampleRate,
      sharedMemory: this.analysis.shared,
    });
  }

  private teardownGraph(): void {
    for (const n of [this.synth, this.fx]) n?.disconnect();
    this.analysis?.dispose();
    this.analysis = null;
    this.busIn?.disconnect();
    this.comp?.disconnect();
    this.master?.disconnect();
    this.synth = null;
    this.fx = null;
    this.busIn = null;
    this.comp = null;
    this.master = null;
    this.recorder = null;
    this.stopScheduler();
  }

  // ----------------------------------------------------------------
  private startTelemetry(): void {
    this.stopTelemetry();
    this.telemetryTimer = window.setInterval(() => {
      this.analysis?.requestTelemetry();
    }, 1000);
  }

  private stopTelemetry(): void {
    if (this.telemetryTimer !== null) {
      window.clearInterval(this.telemetryTimer);
      this.telemetryTimer = null;
    }
  }

  // ----------------------------------------------------------------
  // parameter surface
  // ----------------------------------------------------------------

  private paramOf(node: AudioWorkletNode | null, name: string): AudioParam | null {
    if (!node) return null;
    const p = node.parameters.get(name);
    return p ?? null;
  }

  /** glide a worklet parameter; `time` 0 snaps (still click-free via k-rate) */
  setParam(target: 'synth' | 'fx', name: string, value: number, time = 0.08): void {
    const node = target === 'synth' ? this.synth : this.fx;
    const p = this.paramOf(node, name);
    if (!p || !this.ctx) return;
    const now = this.ctx.currentTime;
    if (time <= 0.001) {
      p.cancelScheduledValues(now);
      p.setValueAtTime(value, now);
    } else {
      p.cancelScheduledValues(now);
      p.setTargetAtTime(value, now, time * 0.35);
    }
  }

  /** batch-apply a patch with a morph time (seconds) */
  applyPatch(patch: Patch, morphSeconds: number): void {
    if (!this.ctx) return;
    for (const [key, value] of Object.entries(patch.synth)) {
      this.setParam('synth', key, value, morphSeconds);
    }
    for (const [key, value] of Object.entries(patch.fx)) {
      this.setParam('fx', key, value, morphSeconds);
    }
    this.setMasterVolume(patch.master);
    if (patch.seed !== undefined) {
      this.post({ type: 'chaosSeed', seed: patch.seed });
    }
  }

  setMasterVolume(v: number): void {
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(Math.max(0.0001, v), now, 0.08);
  }

  // ----------------------------------------------------------------
  // note surface
  // ----------------------------------------------------------------

  /**
   * Fire a note. `when` is an AudioContext time; omitting it means "now".
   * Voice ids are monotonic so a noteOff can never be mis-attributed even
   * if the same pitch is retriggered.
   */
  noteOn(note: number, velocity = 0.8, mods?: Partial<NoteMods>, when?: number): number {
    if (!this.ctx) return -1;
    const voiceId = ++this.voiceIdCounter;
    this.post({
      type: 'noteOn',
      note: Math.max(0, Math.min(127, Math.round(note))),
      velocity: Math.max(0, Math.min(1, velocity)),
      voiceId,
      when: when ?? this.ctx.currentTime + 0.02,
      mods,
    });
    return voiceId;
  }

  noteOff(voiceId: number, when?: number): void {
    if (!this.ctx || voiceId < 0) return;
    this.post({
      type: 'noteOff',
      voiceId,
      when: when ?? this.ctx.currentTime + 0.02,
    });
  }

  panic(): void {
    this.post({ type: 'panic' });
    this.voiceIdCounter = 0;
  }

  private post(msg: WorkletMsg): void {
    this.synth?.port.postMessage(msg);
    this.fx?.port.postMessage(msg);
  }

  // ----------------------------------------------------------------
  // sequencer
  // ----------------------------------------------------------------

  attachSequencer(seq: Sequencer): void {
    this.seq = seq;
    this.startScheduler();
  }

  private startScheduler(): void {
    if (this.schedulerTimer !== null || !this.ctx) return;
    this.nextNoteTime = this.ctx.currentTime + 0.06;
    this.seq?.reset(this.nextNoteTime);
    const tick = () => {
      if (!this.ctx || !this.seq || this.disposed) return;
      const now = this.ctx.currentTime;
      const horizon = now + LOOKAHEAD_SECONDS;
      const events = this.seq.advance(now, horizon);
      for (const ev of events) {
        if (ev.kind === 'on') this.noteOn(ev.note, ev.velocity, ev.mods, ev.when);
        else this.noteOff(ev.voiceId, ev.when);
      }
      this.nextNoteTime = horizon;
      this.schedulerTimer = window.setTimeout(tick, SCHEDULER_INTERVAL_MS);
    };
    tick();
  }

  private stopScheduler(): void {
    if (this.schedulerTimer !== null) {
      window.clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  // ----------------------------------------------------------------
  // microphone — "the oracle speaks through your voice"
  // ----------------------------------------------------------------

  async enableMic(): Promise<boolean> {
    if (!this.ctx || !this.busIn) return false;
    if (this.micActive) return true;
    if (!navigator.mediaDevices?.getUserMedia) return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const ctx = this.ctx;
      const src = ctx.createMediaStreamSource(stream);
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 900;
      filter.Q.value = 1.4;
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      src.connect(filter);
      filter.connect(gain);
      gain.connect(this.busIn);
      gain.gain.setTargetAtTime(1.1, ctx.currentTime, 0.4);

      this.micStream = stream;
      this.micSource = src;
      this.micFilter = filter;
      this.micGain = gain;
      this.micActive = true;
      return true;
    } catch {
      return false;
    }
  }

  disableMic(): void {
    if (!this.ctx) return;
    this.micActive = false;
    const fade = () => {
      try { this.micGain?.disconnect(); } catch { /* already gone */ }
      try { this.micFilter?.disconnect(); } catch { /* already gone */ }
      try { this.micSource?.disconnect(); } catch { /* already gone */ }
      for (const t of this.micStream?.getTracks() ?? []) t.stop();
      this.micGain = null;
      this.micFilter = null;
      this.micSource = null;
      this.micStream = null;
    };
    if (this.micGain) {
      this.micGain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.12);
      // ADR-039: this timer is the only thing in the engine that outlives a
      // synchronous call, so it has to be tracked and cancelled on dispose —
      // otherwise a dispose() mid-fade leaves a closure holding node refs
      // (and a live timer) for another 600 ms.
      this.clearMicFade();
      this.micFadeTimer = window.setTimeout(fade, 600);
    } else {
      fade();
    }
  }

  private clearMicFade(): void {
    if (this.micFadeTimer !== null) {
      window.clearTimeout(this.micFadeTimer);
      this.micFadeTimer = null;
    }
  }

  /** pointer-driven formant sweep on the live mic path */
  setMicFormant(v01: number): void {
    if (!this.ctx || !this.micActive || !this.micFilter) return;
    const t = this.ctx.currentTime;
    this.micFilter.frequency.setTargetAtTime(280 + v01 * 2600, t, 0.06);
    this.micFilter.Q.setTargetAtTime(0.8 + v01 * 8, t, 0.06);
  }

  // ----------------------------------------------------------------
  // recording
  // ----------------------------------------------------------------

  get recording(): boolean { return this.recorder?.recording ?? false; }

  /**
   * Whether this browser can capture at all (MediaRecorder with a supported
   * mime type). Distinct from `recording`, which is the *current* state — the
   * UI needs both: one to disable the button, one to show the tally light.
   */
  get recordingSupported(): boolean { return this.recorder?.supported ?? false; }

  startRecording(): boolean {
    return this.recorder?.start() ?? false;
  }

  async stopRecording(): Promise<Blob | null> {
    return this.recorder ? this.recorder.stop() : null;
  }

  // ----------------------------------------------------------------
  // lifecycle
  // ----------------------------------------------------------------

  async suspend(): Promise<void> {
    if (this.ctx && this.ctx.state === 'running') await this.ctx.suspend();
  }

  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // drop the single-flight handle so no future init() can resurrect us
    this.initPromise = null;
    this.stopTelemetry();
    this.stopScheduler();
    this.clearMicFade();
    this.disableMic();
    this.recorder?.dispose();
    this.teardownGraph();
    disposeWorklets();
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) {
      void ctx.close().catch(() => undefined);
    }
    OracleEngine.instance = null;
    // emit BEFORE clearing: a subscriber that only ever sees 'disposed' is
    // the one that most needs to hear it
    this.emit({ type: 'disposed' });
    this.listeners.clear();
  }
}
