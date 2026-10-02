/**
 * ====================================================================
 * STORE — the application's single source of truth
 * ====================================================================
 *
 * ADR-033: the store owns *intent*, never *audio state*. It never holds a
 * reference to an AudioNode, never reads an AnalyserNode, and never runs a
 * timer that the audio thread depends on. It forwards intent to the engine
 * service and mirrors back only what the UI must render.
 *
 * This is the boundary that keeps React's render cycle out of the audio
 * thread's way: a state update can never stall a render quantum, and a
 * render quantum can never invalidate React state.
 */

import { create } from 'zustand';
import { OracleEngine } from './audio/engine';
import { Sequencer } from './audio/scheduler';
import {
  PATCHES, DEFAULT_PATCH, clonePatch, lerpPatch, type Patch,
} from './audio/presets';
import { frames } from './visual/frameDriver';
import { REALITIES, CODEX } from './lib/content';
import { Rng } from './core/dsp/noise';
import { bus } from './lib/engineBus';
import type { TelemetryMsg } from './audio/protocol';

export type LayerId = 'drones' | 'seq' | 'plinks' | 'chorus' | 'noise' | 'sub';

export interface LogLine { id: number; tag: string; text: string }

export type EngineStatus = 'idle' | 'booting' | 'running' | 'failed';

interface StoreState {
  status: EngineStatus;
  error: string | null;
  sampleRate: number;
  sharedMemory: boolean;

  realityIdx: number;
  shiftNonce: number;
  layers: Record<LayerId, boolean>;
  micOn: boolean;
  master: number;

  patch: Patch;
  patchIndex: number;
  /** A/B morph position 0..1 (0 = patch A, 1 = patch B) */
  morph: number;

  seqOn: boolean;
  bpm: number;
  recording: boolean;
  recordingSupported: boolean;

  telemetry: TelemetryMsg | null;
  ringStats: { framesRead: number; overwritten: number; dropped: number };

  log: LogLine[];
  codex: { entryIndex: number; result: string | null } | null;

  begin: () => Promise<void>;
  setReality: (i: number) => void;
  toggleLayer: (id: LayerId) => void;
  toggleMic: () => Promise<void>;
  setMaster: (v: number) => void;

  selectPatch: (i: number) => void;
  setMorph: (t: number) => void;
  randomizePatch: () => void;
  setSynthParam: (key: string, value: number) => void;
  setFxParam: (key: string, value: number) => void;

  toggleSeq: () => void;
  setBpm: (v: number) => void;
  discharge: () => void;
  panic: () => void;

  toggleRecording: () => Promise<void>;
  downloadRecording: () => Promise<void>;

  /** returns the allocated voice id, which the caller must keep for noteOff */
  noteOn: (note: number, velocity?: number) => number;
  noteOff: (voiceId: number) => void;

  openCodex: (i?: number) => void;
  codexAct: () => void;
  codexNext: () => void;
  codexClose: () => void;
  pushLog: (tag: string, text: string) => void;
}

let logId = 0;
let lastRecording: Blob | null = null;

/** layer -> engine parameter mapping (the single place this is defined) */
const LAYER_PARAM: Record<LayerId, { target: 'synth' | 'fx'; key: string; on: number; off: number }> = {
  drones: { target: 'synth', key: 'droneLevel', on: 0.55, off: 0 },
  seq: { target: 'synth', key: 'level', on: 0.85, off: 0.85 },
  plinks: { target: 'fx', key: 'grainMix', on: 0.5, off: 0 },
  chorus: { target: 'synth', key: 'chaos', on: 0.6, off: 0.06 },
  noise: { target: 'synth', key: 'hissLevel', on: 0.3, off: 0 },
  sub: { target: 'fx', key: 'spectralMix', on: 0.35, off: 0 },
};

const initialLayers: Record<LayerId, boolean> = {
  drones: true, seq: true, plinks: true, chorus: false, noise: true, sub: true,
};

export const useStore = create<StoreState>((set, get) => {
  // ---- engine wiring (module scope: one engine per page) --------------
  const engine = OracleEngine.acquire({
    onEvent: (ev) => {
      switch (ev.type) {
        case 'started':
          set({ status: 'running', error: null, sampleRate: ev.sampleRate, sharedMemory: ev.sharedMemory });
          break;
        case 'failed':
          set({ status: 'failed', error: ev.reason });
          break;
        case 'telemetry':
          set({ telemetry: ev.data });
          break;
        case 'state':
          break;
        case 'disposed':
          set({ status: 'idle' });
          break;
      }
    },
  });

  const seq = new Sequencer(0x0a4c1e);

  const applyLayer = (id: LayerId, on: boolean) => {
    const m = LAYER_PARAM[id];
    engine.setParam(m.target, m.key, on ? m.on : m.off, 0.25);
    if (id === 'seq') seq.enabled = on;
  };

  const pushPatch = (patch: Patch, morphSeconds: number) => {
    engine.applyPatch(patch, morphSeconds);
  };

  return {
    status: 'idle',
    error: null,
    sampleRate: 48000,
    sharedMemory: false,

    realityIdx: 0,
    shiftNonce: 0,
    layers: { ...initialLayers },
    micOn: false,
    master: 0.78,

    patch: clonePatch(DEFAULT_PATCH),
    patchIndex: PATCHES.length - 1,
    morph: 0,

    seqOn: true,
    bpm: 62,
    recording: false,
    recordingSupported: false,

    telemetry: null,
    ringStats: { framesRead: 0, overwritten: 0, dropped: 0 },

    log: [{ id: ++logId, tag: 'SYS', text: 'oracle engine standby — awaiting operator' }],
    codex: null,

    // ------------------------------------------------------------------
    begin: async () => {
      if (get().status !== 'idle') return;
      set({ status: 'booting', error: null });
      try {
        await engine.init();
        engine.attachSequencer(seq);
        frames.attach(engine.analyserNode);
        set({
          recordingSupported: engine.recordingSupported,
          sampleRate: engine.rate,
          sharedMemory: engine.isSharedMemory,
        });
        get().pushLog('SYS', `operator jacked in — ${engine.rate} hz · ${engine.isSharedMemory ? 'shared memory' : 'postMessage'} analysis`);
        window.setTimeout(() => get().pushLog('SEAM', 'reality stabilized :: THE RIFT'), 1100);
        window.setTimeout(() => { if (!get().codex) get().openCodex(0); }, 2600);
      } catch (err) {
        set({ status: 'failed', error: String(err) });
        get().pushLog('ERR', 'the engine refused to wake: ' + String(err));
      }
    },

    setReality: (i: number) => {
      const cur = get();
      const idx = ((i % REALITIES.length) + REALITIES.length) % REALITIES.length;
      if (idx === cur.realityIdx) return;
      const pal = REALITIES[idx];
      const r = document.documentElement;
      r.style.setProperty('--p', pal.p);
      r.style.setProperty('--s', pal.s);
      r.style.setProperty('--a', pal.a);
      r.style.setProperty('--h', pal.h);
      r.style.setProperty('--fog', pal.fog);
      document.body.style.backgroundColor = pal.fog;
      r.dataset.realityIdx = String(idx);

      set((s) => ({ realityIdx: idx, shiftNonce: s.shiftNonce + 1 }));
      bus.pulse = Math.max(bus.pulse, 0.85);
      bus.shake = Math.min(0.4, bus.shake + 0.3);

      // a reality shift is also a patch shift — the sound and the world move together
      const patchIdx = Math.min(idx, PATCHES.length - 1);
      const patch = clonePatch(PATCHES[patchIdx]);
      set({ patch, patchIndex: patchIdx, morph: 0 });
      pushPatch(patch, 1.2);
      get().pushLog('SEAM', `reality.seam :: ${pal.name.toUpperCase()} — patch ${patch.name}`);
    },

    toggleLayer: (id) => {
      const on = !get().layers[id];
      applyLayer(id, on);
      bus.pulse = Math.max(bus.pulse, 0.35);
      set((s) => ({ layers: { ...s.layers, [id]: on } }));
      get().pushLog('MIX', `${id} ${on ? 'engaged' : 'muted'}`);
    },

    toggleMic: async () => {
      if (get().status !== 'running') return;
      if (get().micOn) {
        engine.disableMic();
        set({ micOn: false });
        get().pushLog('ORACLE', 'the god goes quiet. for now.');
      } else {
        const ok = await engine.enableMic();
        if (ok) {
          set({ micOn: true });
          bus.pulse = Math.max(bus.pulse, 0.8);
          get().pushLog('ORACLE', 'it speaks through your voice — the grains will eat it');
        } else {
          get().pushLog('ORACLE', 'the microphone refused the summons');
        }
      }
    },

    setMaster: (v) => {
      set({ master: v });
      engine.setMasterVolume(v);
    },

    // ------------------------------------------------------------------
    selectPatch: (i) => {
      const idx = ((i % PATCHES.length) + PATCHES.length) % PATCHES.length;
      const patch = clonePatch(PATCHES[idx]);
      set({ patch, patchIndex: idx, morph: 0 });
      pushPatch(patch, 0.6);
      get().pushLog('PATCH', `loaded :: ${patch.name} — ${patch.tagline}`);
      bus.pulse = Math.max(bus.pulse, 0.5);
    },

    setMorph: (t) => {
      const cur = get();
      const m = Math.max(0, Math.min(1, t));
      set({ morph: m });
      const a = clonePatch(PATCHES[cur.patchIndex]);
      const b = clonePatch(PATCHES[(cur.patchIndex + 1) % PATCHES.length]);
      pushPatch(lerpPatch(a, b, m), 0.05);
    },

    randomizePatch: () => {
      const cur = get();
      // a fresh attractor seed plus a mutation of every macro: the mutation is
      // drawn from the same xorshift the worklets use, so it is reproducible
      // from the printed seed.
      const seed = (Date.now() ^ 0x9e3779b9) >>> 0;
      const rng = new Rng(seed);
      const base = clonePatch(PATCHES[cur.patchIndex]);
      base.seed = seed;
      base.name = 'UNSTABLE';
      base.tagline = 'a patch that has not decided what it is';
      const jitter = (v: number, amount: number, lo: number, hi: number) =>
        Math.max(lo, Math.min(hi, v + rng.bipolar() * amount));
      base.synth = {
        cutoff: jitter(base.synth.cutoff, 700, 120, 9000),
        resonance: jitter(base.synth.resonance, 3, 0.6, 18),
        drive: jitter(base.synth.drive, 2.2, 0.4, 12),
        fmIndex: jitter(base.synth.fmIndex, 1.6, 0, 8),
        fmRatio: jitter(base.synth.fmRatio, 1.4, 0.3, 7),
        chaos: jitter(base.synth.chaos, 0.4, 0, 1),
        width: jitter(base.synth.width, 0.3, 0, 1),
        level: jitter(base.synth.level, 0.15, 0.3, 1.2),
        droneLevel: jitter(base.synth.droneLevel, 0.25, 0, 1.2),
        hissLevel: jitter(base.synth.hissLevel, 0.2, 0, 1),
        duck: jitter(base.synth.duck, 0.25, 0, 1),
      };
      base.fx = {
        grainMix: jitter(base.fx.grainMix, 0.3, 0, 1),
        grainSize: jitter(base.fx.grainSize, 0.1, 0.005, 0.5),
        grainScatter: jitter(base.fx.grainScatter, 0.3, 0, 1),
        grainPitch: jitter(base.fx.grainPitch, 0.3, 0, 1),
        grainFeedback: jitter(base.fx.grainFeedback, 0.2, 0, 0.9),
        grainRate: jitter(base.fx.grainRate, 0.3, 0, 1),
        spectralMix: jitter(base.fx.spectralMix, 0.3, 0, 1),
        spectralFreeze: jitter(base.fx.spectralFreeze, 0.25, 0, 1),
        spectralShift: jitter(base.fx.spectralShift, 0.4, -1, 1),
        reverbMix: jitter(base.fx.reverbMix, 0.25, 0, 1),
        reverbSize: jitter(base.fx.reverbSize, 0.25, 0.05, 0.98),
        reverbDamp: jitter(base.fx.reverbDamp, 0.3, 0, 1),
        reverbWidth: jitter(base.fx.reverbWidth, 0.25, 0, 1),
        outputLevel: jitter(base.fx.outputLevel, 0.12, 0.4, 1.2),
      };
      set({ patch: base, morph: 0 });
      engine.applyPatch(base, 0.5);
      seq.randomize(seed);
      get().pushLog('PATCH', `reseeded the attractor :: 0x${seed.toString(16)}`);
      bus.pulse = Math.max(bus.pulse, 0.6);
    },

    setSynthParam: (key, value) => {
      engine.setParam('synth', key, value, 0.06);
      set((s) => ({ patch: { ...s.patch, synth: { ...s.patch.synth, [key]: value } } }));
    },

    setFxParam: (key, value) => {
      engine.setParam('fx', key, value, 0.06);
      set((s) => ({ patch: { ...s.patch, fx: { ...s.patch.fx, [key]: value } } }));
    },

    // ------------------------------------------------------------------
    toggleSeq: () => {
      const on = !get().seqOn;
      seq.enabled = on;
      set({ seqOn: on });
      get().pushLog('SEQ', on ? 'chrono sequencer engaged' : 'chrono sequencer halted');
    },

    setBpm: (v) => {
      const bpm = Math.max(30, Math.min(200, v));
      seq.bpm = bpm;
      set({ bpm });
    },

    discharge: () => {
      if (get().status !== 'running') return;
      bus.shake = Math.min(0.5, bus.shake + 0.45);
      bus.pulse = Math.min(1.4, bus.pulse + 0.9);
      engine.panic();
      get().pushLog('PROTOCOL', 'discharge executed :: all voices dissipated, causality restored');
    },

    panic: () => {
      engine.panic();
      get().pushLog('PROTOCOL', 'panic — every voice silenced immediately');
    },

    // ------------------------------------------------------------------
    toggleRecording: async () => {
      if (get().status !== 'running') return;
      if (get().recording) {
        lastRecording = await engine.stopRecording();
        set({ recording: false });
        get().pushLog('REC', lastRecording ? 'capture stopped — ready to download' : 'capture stopped (empty)');
      } else {
        const ok = engine.startRecording();
        set({ recording: ok });
        get().pushLog('REC', ok ? 'capture armed — the engine is remembering' : 'recording unsupported in this browser');
      }
    },

    downloadRecording: async () => {
      if (!lastRecording) return;
      const url = URL.createObjectURL(lastRecording);
      const a = document.createElement('a');
      a.href = url;
      a.download = `oracle-engine-${Date.now()}.webm`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      get().pushLog('REC', 'capture committed to disk');
    },

    // ------------------------------------------------------------------
    noteOn: (note, velocity = 0.8) => {
      if (get().status !== 'running') return -1;
      return engine.noteOn(note, velocity);
    },

    noteOff: (voiceId) => {
      if (get().status !== 'running') return;
      engine.noteOff(voiceId);
    },

    // ------------------------------------------------------------------
    openCodex: (i) => set(() => ({
      codex: { entryIndex: i ?? Math.floor(Math.random() * CODEX.length), result: null },
    })),
    codexAct: () => {
      const c = get().codex;
      if (!c || c.result) return;
      set({ codex: { ...c, result: 'the archive answers in a language it has not finished inventing' } });
      bus.pulse = Math.max(bus.pulse, 0.9);
      get().pushLog('ORACLE', 'the memo was read. the margins have already annotated it.');
    },
    codexNext: () => set((s) => ({
      codex: { entryIndex: (((s.codex?.entryIndex ?? -1) + 1) % CODEX.length), result: null },
    })),
    codexClose: () => set({ codex: null }),

    pushLog: (tag, text) => set((s) => ({
      log: [...s.log.slice(-5), { id: ++logId, tag, text }],
    })),
  };
});

/** telemetry poll — the only interval in the app that touches the engine */
if (typeof window !== 'undefined') {
  window.setInterval(() => {
    const st = useStore.getState();
    if (st.status === 'running') {
      useStore.setState({ ringStats: { ...frames.stats } });
    }
  }, 500);
}
