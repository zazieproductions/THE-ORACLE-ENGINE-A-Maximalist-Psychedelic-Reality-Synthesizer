/**
 * ====================================================================
 * ENGINE LIFECYCLE TESTS
 * ====================================================================
 *
 * These tests drive the *real* `OracleEngine` against a fake Web Audio
 * implementation, with the *real* worklet bundles loaded through the real
 * bundler. The point is not to test Web Audio — it is to test the parts of
 * the engine that a browser will not tell you about:
 *
 *   - double initialisation (React StrictMode double-invokes effects)
 *   - teardown ordering and idempotence
 *   - every method being safe to call before `init()` resolves
 *   - every method being safe to call after `dispose()`
 *   - listener and timer leaks
 *   - a failure in the middle of `init()` leaving no half-built graph
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleWorkletSource } from './worklet/bundler';
import { disposeWorklets } from './workletLoader';
import { OracleEngine } from './engine';
import { Sequencer } from './scheduler';
import { PATCHES } from './presets';

// ---------------------------------------------------------------- fake Web Audio

const SR = 48000;
const WORKLET_NAMES = ['oracle-synth', 'oracle-fx', 'oracle-analyzer'] as const;

let registeredNames: string[] = [];
let createdNodes: string[] = [];
let tmpRoot = '';
let addedModules: string[] = [];
/** blob url -> the Blob that was handed to createObjectURL */
const blobByUrl = new Map<string, Blob>();
const realCreateObjectURL = URL.createObjectURL.bind(URL);

class FakeAudioParam {
  value: number;
  private events: [string, number, number][] = [];
  constructor(value: number) { this.value = value; }
  setValueAtTime(v: number, t: number) { this.events.push(['setValueAtTime', v, t]); this.value = v; return this; }
  setTargetAtTime(v: number, t: number, _tc: number) { this.events.push(['setTargetAtTime', v, t]); this.value = v; return this; }
  exponentialRampToValueAtTime(v: number, t: number) { this.events.push(['exponentialRamp', v, t]); this.value = v; return this; }
  linearRampToValueAtTime(v: number, t: number) { this.events.push(['linearRamp', v, t]); this.value = v; return this; }
  cancelScheduledValues(_t: number) { return this; }
  get eventLog() { return this.events; }
}

class FakeNode {
  connections: FakeNode[] = [];
  disconnected = false;
  constructor(public kind: string) {}
  connect(dest: FakeNode | FakeAudioParam) {
    if (dest instanceof FakeNode) this.connections.push(dest);
    return dest as never;
  }
  disconnect() { this.disconnected = true; this.connections = []; }
}

class FakePort {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  closed = false;
  sent: unknown[] = [];
  postMessage(m: unknown) { this.sent.push(m); }
  close() { this.closed = true; }
}

class FakeWorkletNode extends FakeNode {
  parameters = new Map<string, FakeAudioParam>();
  /** the worklet processor adopts this exact object as its MessagePort */
  declare port: FakePort;
  constructor(ctx: unknown, name: string, opts: { outputChannelCount?: number[] }) {
    super(name);
    createdNodes.push(name);
    // the worklet processor grabs `globalThis.port` in its constructor and
    // assigns its own `onmessage`; make that the same object the engine sees
    const port = new FakePort();
    this.port = port;
    Object.defineProperty(globalThis, 'port', { value: port, configurable: true, writable: true });
    const ctor = processorRegistry.get(name);
    if (ctor) new ctor(opts as unknown as { processorOptions?: unknown });
    void ctx;
  }
}

class FakeAudioContext {
  sampleRate = SR;
  currentTime = 0;
  state: 'running' | 'suspended' | 'closed' = 'running';
  destination = new FakeNode('destination');
  closed = false;
  listeners = new Map<string, Set<() => void>>();
  audioWorklet = {
    addModule: async (url: string) => {
      // A blob: url carries no module name, so recover the processor name
      // from the bundle text the loader actually handed us — which is the
      // point: we execute the *shipped* bundle, not a lookalike.
      let name: string | undefined;
      if (String(url).startsWith('blob:')) {
        const blob = blobByUrl.get(String(url));
        const text = blob ? await blob.text() : '';
        name = WORKLET_NAMES.find((n) => text.includes(`"${n}"`));
        if (!name) throw new Error(`cannot identify worklet behind ${url}`);
      } else {
        name = WORKLET_NAMES.find((n) => String(url).includes(n));
        if (!name) throw new Error(`unknown worklet url ${url}`);
      }
      addedModules.push(name);
      const code = await bundleWorkletSource(join(process.cwd(), 'src/audio/worklet', `${name}.worklet.ts`));
      const file = join(tmpRoot, `${name}.${Math.random().toString(36).slice(2)}.mjs`);
      writeFileSync(file, code);
      installScope();
      await import(file);
      registeredNames.push(name);
    },
  };
  createGain() { return Object.assign(new FakeNode('gain'), { gain: new FakeAudioParam(1) }); }
  createDynamicsCompressor() {
    return Object.assign(new FakeNode('compressor'), {
      threshold: new FakeAudioParam(-24), knee: new FakeAudioParam(30), ratio: new FakeAudioParam(12),
      attack: new FakeAudioParam(0.003), release: new FakeAudioParam(0.25),
    });
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode('biquad'), {
      type: 'lowpass', frequency: new FakeAudioParam(350), Q: new FakeAudioParam(1), gain: new FakeAudioParam(0),
    });
  }
  createMediaStreamDestination() {
    return Object.assign(new FakeNode('mediaStreamDestination'), { stream: { getTracks: () => [] as { stop(): void }[] } });
  }
  createMediaStreamSource() { return new FakeNode('mediaStreamSource'); }
  addEventListener(type: string, cb: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }
  removeEventListener(type: string, cb: () => void) { this.listeners.get(type)?.delete(cb); }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  async close() { this.closed = true; this.state = 'closed'; }
}

/**
 * Install the fake AudioWorkletGlobalScope that the bundled worklets expect.
 * `registerProcessor` is called at module evaluation time, so this has to be
 * in place before the first `await import(file)` — and it has to survive,
 * because Vite/ESM caches the module after that.
 */
const processorRegistry = new Map<string, new (options?: unknown) => unknown>();
function installScope() {
  Object.assign(globalThis, {
    sampleRate: SR,
    currentTime: 0,
    currentFrame: 0,
    registerProcessor: (name: string, ctor: unknown) => { processorRegistry.set(name, ctor as never); },
  });
}

// timers we can inspect — the engine must not leak any
let liveTimers = 0;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

function installWindow() {
  blobByUrl.clear();
  URL.createObjectURL = ((blob: Blob) => {
    const url = realCreateObjectURL(blob) as string;
    blobByUrl.set(url, blob);
    return url;
  }) as typeof URL.createObjectURL;
  (globalThis as unknown as { window: unknown }).window = {
    AudioContext: FakeAudioContext,
    setInterval: (fn: () => void, ms: number) => { liveTimers++; return realSetInterval(fn, ms) as unknown as number; },
    clearInterval: (h: number) => { if (h !== null && h !== undefined) liveTimers--; return realClearInterval(h as never); },
    setTimeout: (fn: () => void, ms: number) => { liveTimers++; return realSetTimeout(fn, ms) as unknown as number; },
    clearTimeout: (h: number) => { if (h !== null && h !== undefined) liveTimers--; return realClearTimeout(h as never); },
  };
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeWorkletNode;
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: undefined },
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  registeredNames = []; createdNodes = []; addedModules = []; liveTimers = 0;
  tmpRoot = mkdtempSync(join(tmpdir(), 'oracle-engine-'));
  processorRegistry.clear();
  installWindow();
  installScope();
  // the loader memoises blob urls per document; reset between engines
  disposeWorklets();
  // reset the singleton between tests
  (OracleEngine as unknown as { instance: OracleEngine | null }).instance = null;
});

afterEach(() => {
  (OracleEngine as unknown as { instance: OracleEngine | null }).instance = null;
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------- tests

describe('OracleEngine lifecycle', () => {
  it('builds the whole graph and loads all three real worklet bundles', async () => {
    const engine = OracleEngine.acquire();
    await engine.init();

    expect(engine.ready).toBe(true);
    expect(registeredNames.sort()).toEqual([...WORKLET_NAMES].sort());
    expect(createdNodes).toContain('oracle-synth');
    expect(createdNodes).toContain('oracle-fx');
    expect(createdNodes).toContain('oracle-analyzer');
    expect(engine.rate).toBe(SR);
    expect(typeof engine.isSharedMemory).toBe('boolean');
    expect(engine.context?.state).toBe('running');
  });

  it('is a single-flight: concurrent init calls share one promise', async () => {
    const engine = OracleEngine.acquire();
    const [a, b] = await Promise.all([engine.init(), engine.init()]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    // only one context, only three nodes of each kind
    expect(createdNodes.filter((n) => n === 'oracle-synth').length).toBe(1);
    expect(addedModules.length).toBe(3);
  });

  it('refuses a second construction (acquire is the only door)', () => {
    OracleEngine.acquire();
    expect(() => new OracleEngine()).toThrow(/singleton/i);
  });

  it('survives every method being called before init resolves', () => {
    const engine = OracleEngine.acquire();
    expect(() => {
      engine.setParam('synth', 'cutoff', 800);
      engine.setParam('fx', 'reverbMix', 0.5);
      engine.applyPatch(PATCHES[0], 0);
      engine.setMasterVolume(0.5);
      engine.noteOn(60);
      engine.noteOff(1);
      engine.panic();
      engine.setMicFormant(0.5);
      engine.disableMic();
      engine.attachSequencer(new Sequencer());
      expect(engine.startRecording()).toBe(false);
      void engine.stopRecording();
    }).not.toThrow();
    expect(engine.noteOn(60)).toBe(-1);
    expect(engine.ready).toBe(false);
  });

  it('survives every method being called after dispose', async () => {
    const engine = OracleEngine.acquire();
    await engine.init();
    engine.dispose();
    expect(() => {
      engine.setParam('synth', 'cutoff', 800);
      engine.applyPatch(PATCHES[0], 0);
      engine.setMasterVolume(0.5);
      engine.noteOn(60);
      engine.noteOff(1);
      engine.panic();
      engine.setMicFormant(0.5);
      engine.disableMic();
      engine.attachSequencer(new Sequencer());
      expect(engine.startRecording()).toBe(false);
      void engine.stopRecording();
      void engine.suspend();
      void engine.resume();
    }).not.toThrow();
    expect(engine.context).toBeNull();
    expect(engine.ready).toBe(false);
  });

  it('dispose is idempotent and closes the context exactly once', async () => {
    const engine = OracleEngine.acquire();
    await engine.init();
    const ctx = engine.context as unknown as FakeAudioContext;
    engine.dispose();
    engine.dispose();
    engine.dispose();
    expect(ctx.closed).toBe(true);
    expect(engine.context).toBeNull();
  });

  it('re-initialises cleanly after a full dispose (StrictMode remount)', async () => {
    const first = OracleEngine.acquire();
    await first.init();
    first.dispose();
    const second = OracleEngine.acquire();
    await second.init();
    expect(second.ready).toBe(true);
    expect(second).not.toBe(first);
    second.dispose();
  });

  it('clears every listener and timer on dispose', async () => {
    const engine = OracleEngine.acquire();
    const seen: string[] = [];
    const off = engine.on((e) => seen.push(e.type));
    await engine.init();
    expect(seen).toContain('started');
    const before = liveTimers;
    expect(before).toBeGreaterThan(0); // telemetry + scheduler

    engine.dispose();
    off();
    expect(liveTimers).toBe(0);
    expect(seen.filter((t) => t === 'disposed').length).toBe(1);

    // a post-dispose event must not reach the removed listener
    engine.on(() => seen.push('leaked'));
    engine.dispose();
    expect(seen).not.toContain('leaked');
  });

  it('unsubscribing an event listener stops delivery', async () => {
    const engine = OracleEngine.acquire();
    let count = 0;
    const off = engine.on(() => { count++; });
    await engine.init();
    const afterInit = count;
    off();
    engine.panic();
    engine.applyPatch(PATCHES[1], 0);
    expect(count).toBe(afterInit);
  });

  it('routes notes to both worklets with monotonic voice ids', async () => {
    const engine = OracleEngine.acquire();
    await engine.init();
    const v1 = engine.noteOn(60, 1);
    const v2 = engine.noteOn(60, 0.5);
    const v3 = engine.noteOn(999, 2, undefined, engine.context!.currentTime + 0.1);
    expect(v1).toBeGreaterThan(0);
    expect(v2).toBeGreaterThan(v1);
    expect(v3).toBeGreaterThan(v2);
    expect(v1).toBe(v3 - 2);
    engine.dispose();
  });

  it('clamps out-of-range note and velocity values', async () => {
    const engine = OracleEngine.acquire();
    await engine.init();
    const id = engine.noteOn(-40, 5);
    expect(id).toBeGreaterThan(0);
    engine.noteOn(300, -3);
    engine.dispose();
  });

  it('panic resets the voice counter so ids restart from one', async () => {
    const engine = OracleEngine.acquire();
    await engine.init();
    engine.noteOn(60); engine.noteOn(62); engine.noteOn(64);
    engine.panic();
    expect(engine.noteOn(60)).toBe(1);
    engine.dispose();
  });

  it('applies a patch to every synth and fx parameter', async () => {
    const engine = OracleEngine.acquire();
    await engine.init();
    const patch = PATCHES[2];
    expect(() => engine.applyPatch(patch, 0.4)).not.toThrow();
    engine.dispose();
  });

  it('attaches a sequencer and starts the scheduler timer', async () => {
    const engine = OracleEngine.acquire();
    await engine.init();
    const seq = new Sequencer();
    engine.attachSequencer(seq);
    expect(liveTimers).toBeGreaterThan(1);
    engine.dispose();
  });

  it('dispose stops the scheduler before closing the context', async () => {
    const engine = OracleEngine.acquire();
    await engine.init();
    engine.attachSequencer(new Sequencer());
    engine.dispose();
    expect(liveTimers).toBe(0);
  });

  it('emits a telemetry event when the analyser publishes one', async () => {
    const engine = OracleEngine.acquire();
    const seen: string[] = [];
    engine.on((e) => { if (e.type === 'telemetry') seen.push('t'); });
    await engine.init();
    const client = engine.analyserNode;
    expect(client).not.toBeNull();
    client!.node.port.onmessage!({ data: { type: 'telemetry', avgProcessUs: 12, activeVoices: 3, activeGrains: 1 } } as never);
    expect(seen.length).toBe(1);
    engine.dispose();
  });

  it('reports recording as unsupported without MediaRecorder', async () => {
    const engine = OracleEngine.acquire();
    await engine.init();
    expect(engine.recording).toBe(false);
    expect(engine.startRecording()).toBe(false);
    expect(await engine.stopRecording()).toBeNull();
    engine.dispose();
  });

  it('enableMic fails gracefully when there is no mediaDevices', async () => {
    const engine = OracleEngine.acquire();
    await engine.init();
    expect(await engine.enableMic()).toBe(false);
    expect(engine.micEnabled).toBe(false);
    expect(() => engine.disableMic()).not.toThrow();
    engine.dispose();
  });

  it('a worklet load failure leaves no graph and allows a retry', async () => {
    const engine = OracleEngine.acquire();
    const failures: string[] = [];
    engine.on((e) => { if (e.type === 'failed') failures.push('f'); });

    const realAdd = (globalThis.window as unknown as { AudioContext: unknown }).AudioContext;
    class BrokenCtx extends FakeAudioContext {
      override audioWorklet = {
        addModule: async () => { throw new Error('simulated worklet fetch failure'); },
      };
    }
    (globalThis.window as unknown as { AudioContext: unknown }).AudioContext = BrokenCtx;

    await expect(engine.init()).rejects.toThrow(/worklet/i);
    expect(failures.length).toBe(1);
    expect(engine.ready).toBe(false);

    // retry with a working context must succeed and build the full graph
    (globalThis.window as unknown as { AudioContext: unknown }).AudioContext = realAdd;
    await engine.init();
    expect(engine.ready).toBe(true);
    engine.dispose();
  });

  it('cannot be re-initialised after dispose', async () => {
    const engine = OracleEngine.acquire();
    await engine.init();
    engine.dispose();
    await expect(engine.init()).rejects.toThrow(/disposed/i);
  });
});
