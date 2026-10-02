import { create } from 'zustand';
import { audio, LayerId } from './lib/audioEngine';
import { CODEX, REALITIES, REALITY_GLITCH } from './lib/content';
import { bus } from './lib/engineBus';

export interface LogLine { id: number; tag: string; text: string }
interface CodexState { entryIndex: number; result: string | null }

interface StoreState {
  started: boolean;
  realityIdx: number;
  shiftNonce: number;
  dischargeNonce: number;
  layers: Record<LayerId, boolean>;
  micOn: boolean;
  master: number;
  codex: CodexState | null;
  log: LogLine[];
  begin: () => void;
  setReality: (i: number) => void;
  toggleLayer: (id: LayerId) => void;
  toggleMic: () => void;
  setMaster: (v: number) => void;
  discharge: () => void;
  openCodex: (i?: number) => void;
  codexAct: () => void;
  codexNext: () => void;
  codexClose: () => void;
  pushLog: (tag: string, text: string) => void;
}

let logId = 0;
const initialLayers: Record<LayerId, boolean> = {
  drones: true, seq: true, plinks: true, chorus: false, noise: true, sub: true,
};

function applyCssVars(i: number) {
  const pal = REALITIES[i];
  const r = document.documentElement;
  r.style.setProperty('--p', pal.p);
  r.style.setProperty('--s', pal.s);
  r.style.setProperty('--a', pal.a);
  r.style.setProperty('--h', pal.h);
  r.style.setProperty('--fog', pal.fog);
  document.body.style.backgroundColor = pal.fog;
}
applyCssVars(0);

export const useStore = create<StoreState>((set, get) => ({
  started: false,
  realityIdx: 0,
  shiftNonce: 0,
  dischargeNonce: 0,
  layers: { ...initialLayers },
  micOn: false,
  master: 0.75,
  codex: null,
  log: [{ id: ++logId, tag: 'SYS', text: 'oracle engine standby — awaiting operator' }],

  begin: () => {
    if (get().started) return;
    set({ started: true });
    audio.setMasterVolume(get().master);
    audio.sting('boot');
    get().pushLog('SYS', 'operator jacked in — the engine is listening');
    window.setTimeout(() => get().pushLog('SEAM', 'reality stabilized :: THE RIFT'), 1100);
    window.setTimeout(() => { if (!get().codex) get().openCodex(0); }, 2600);
  },

  setReality: (i: number) => {
    const cur = get();
    if (i === cur.realityIdx) return;
    const pal = REALITIES[i];
    applyCssVars(i);
    set((s) => ({ realityIdx: i, shiftNonce: s.shiftNonce + 1 }));
    audio.sting('switch');
    get().pushLog('SEAM', `${REALITY_GLITCH[pal.id]} :: ${pal.name.toUpperCase()}`);
  },

  toggleLayer: (id) => {
    const on = !get().layers[id];
    audio.setLayer(id, on);
    bus.pulse = Math.max(bus.pulse, 0.35);
    set((s) => ({ layers: { ...s.layers, [id]: on } }));
  },

  toggleMic: async () => {
    if (!get().started) return;
    if (get().micOn) {
      audio.disableMic();
      set({ micOn: false });
      get().pushLog('ORACLE', 'the god goes quiet. for now.');
    } else {
      const ok = await audio.enableMic();
      if (ok) {
        set({ micOn: true });
        bus.pulse = Math.max(bus.pulse, 0.8);
        audio.sting('action');
        get().pushLog('ORACLE', 'it speaks through your voice — pitch follows your hand');
      } else {
        get().pushLog('ORACLE', 'the microphone refused the summons');
        audio.sting('denied');
      }
    }
  },

  setMaster: (v) => { set({ master: v }); audio.setMasterVolume(v); },

  discharge: () => {
    if (!get().started) return;
    set((s) => ({ dischargeNonce: s.dischargeNonce + 1 }));
    audio.sting('discharge');
    const pal = REALITIES[get().realityIdx];
    get().pushLog('PROTOCOL', `discharge executed :: ${pal.name.toLowerCase()} rinsed of spores`);
  },

  openCodex: (i) => set(() => ({ codex: { entryIndex: i ?? Math.floor(Math.random() * CODEX.length), result: null } })),
  codexAct: () => {
    const c = get().codex; if (!c || c.result) return;
    const entry = CODEX[c.entryIndex];
    set({ codex: { ...c, result: entry.result } });
    audio.sting('action');
    bus.pulse = Math.max(bus.pulse, 0.9);
    get().pushLog(entry.kind, entry.result);
    if (entry.id === 'c4') get().discharge();
  },
  codexNext: () => set((s) => ({ codex: { entryIndex: (((s.codex?.entryIndex ?? -1) + 1) % CODEX.length), result: null } })),
  codexClose: () => set({ codex: null }),

  pushLog: (tag, text) => set((s) => ({ log: [...s.log.slice(-4), { id: ++logId, tag, text }] })),
}));
