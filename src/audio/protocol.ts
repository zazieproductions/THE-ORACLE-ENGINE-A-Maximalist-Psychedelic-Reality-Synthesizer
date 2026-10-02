/**
 * ====================================================================
 * THE CONTRACT
 * ====================================================================
 * Every message that crosses the boundary between the main thread (UI,
 * scheduler, visuals) and the AudioWorklet thread is declared here, once,
 * as a discriminated union. Nothing else in the codebase is allowed to
 * hand-roll a port message: the union is the API.
 *
 * ADR-002: the protocol is split into two channels by *timing class*:
 *
 *   TIMING-CRITICAL  -> AudioParam automation. These travel on the param
 *                       automation timeline, are sample-accurate, and can
 *                       never be dropped or reordered.
 *   TIMING-LOOSE     -> port messages. Note events, preset swaps, telemetry.
 *                       Cheap and ordered, but coalesced by the
 *                       implementation if the producer outruns the consumer.
 *
 * Keeping them separate is what lets the sequencer be sample-accurate
 * while the UI stays responsive.
 */

// --------------------------------------------------------------------
// analysis frame layout — must stay in lockstep with the analyzer worklet
// --------------------------------------------------------------------

/** FFT resolution of the analysis path (power of two). */
export const FFT_SIZE = 1024;
/** analysis hop: 25% overlap => 4x redundancy, ~10.7 ms at 48 kHz */
export const HOP_SIZE = FFT_SIZE / 4;
/** usable magnitude bins (DC + Nyquist excluded) */
export const SPECTRUM_BINS = FFT_SIZE / 2;
/** waveform ring written per frame (mono, for the oscilloscope) */
export const WAVEFORM_LEN = 512;
/** number of slots in the SPSC ring */
export const RING_SLOTS = 8;

export const FEATURE_COUNT = 12;

/**
 * Feature vector written by the analyzer. The visual layer reads these by
 * index; adding a feature is an append-only operation.
 */
export const FEATURE = {
  /** broadband RMS, linear */
  RMS: 0,
  /** sample peak, linear */
  PEAK: 1,
  /** spectral centroid normalised to 0..1 (0 = DC, 1 = Nyquist) */
  CENTROID: 2,
  /** spectral flatness (Wiener entropy) 0..1 — 1 = noise-like */
  FLATNESS: 3,
  /** positive spectral flux — the onset detector */
  FLUX: 4,
  /** 85%-energy rolloff normalised 0..1 */
  ROLLOFF: 5,
  /** crest factor peak/rms */
  CREST: 6,
  /** band energies, normalised 0..1 */
  SUB: 7,
  LOW_MID: 8,
  MID: 9,
  HIGH: 10,
  /** smoothed onset envelope (attack/release follower on FLUX) */
  ONSET: 11,
} as const;

/** total floats per ring slot */
export const SLOT_FLOATS = SPECTRUM_BINS + WAVEFORM_LEN + FEATURE_COUNT;

/** byte offset of each region inside a slot */
export const SLOT_OFFSET_SPECTRUM = 0;
export const SLOT_OFFSET_WAVEFORM = SPECTRUM_BINS;
export const SLOT_OFFSET_FEATURES = SPECTRUM_BINS + WAVEFORM_LEN;

// --------------------------------------------------------------------
// main -> worklet
// --------------------------------------------------------------------

export interface NoteOnMsg {
  type: 'noteOn';
  /** MIDI note number 0..127 */
  note: number;
  /** 0..1 */
  velocity: number;
  /** monotonic id so the matching noteOff is unambiguous */
  voiceId: number;
  /**
   * AudioContext time at which the note should sound. Optional: when present
   * the worklet defers the event until its own clock reaches it, which is how
   * the main-thread sequencer achieves sample-accurate-ish timing despite
   * `port.postMessage` having no scheduled-delivery guarantee.
   */
  when?: number;
  /** optional per-note parameter overrides (used by the sequencer) */
  mods?: Partial<NoteMods>;
}

export interface NoteOffMsg {
  type: 'noteOff';
  voiceId: number;
  when?: number;
}

export interface NoteMods {
  /** FM index (modulation depth) */
  fmIndex: number;
  /** modulator/carrier ratio */
  fmRatio: number;
  /** filter cutoff in Hz */
  cutoff: number;
  /** filter Q */
  resonance: number;
  /** waveshaper drive, linear 1..20 */
  drive: number;
  /** stereo position -1..1 */
  pan: number;
  /** amplitude 0..1 */
  amp: number;
  /** attack seconds */
  attack: number;
  /** decay seconds */
  decay: number;
  /** sustain 0..1 */
  sustain: number;
  /** release seconds */
  release: number;
}

export interface ParamMsg {
  type: 'param';
  key: string;
  value: number;
  /** seconds to glide to the value; 0 = snap */
  time?: number;
}

export interface PresetMsg {
  type: 'preset';
  preset: unknown;
}

export interface ChaosSeedMsg {
  type: 'chaosSeed';
  seed: number;
}

export interface PanicMsg {
  type: 'panic';
}

export interface TelemetryRequestMsg {
  type: 'telemetryRequest';
}

export type WorkletMsg =
  | NoteOnMsg
  | NoteOffMsg
  | ParamMsg
  | PresetMsg
  | ChaosSeedMsg
  | PanicMsg
  | TelemetryRequestMsg;

// --------------------------------------------------------------------
// worklet -> main
// --------------------------------------------------------------------

export interface TelemetryMsg {
  type: 'telemetry';
  /** average process() time in microseconds over the reporting window */
  avgProcessUs: number;
  /** worst process() time in microseconds */
  maxProcessUs: number;
  /** number of render quanta since start */
  quanta: number;
  /** voices currently sounding */
  activeVoices: number;
  /** grains currently active */
  activeGrains: number;
  /** true when a process() call overran the quantum budget */
  overrun: boolean;
}

export interface ReadyMsg {
  type: 'ready';
  sampleRate: number;
  /** true when the analyzer could allocate a SharedArrayBuffer */
  sharedMemory: boolean;
}

/**
 * Fallback analysis frame, used only when cross-origin isolation is absent
 * and SharedArrayBuffer cannot be allocated. The buffer is transferred, so
 * the worklet must allocate a fresh one each time.
 */
export interface FrameMsg {
  type: 'frame';
  frame: Float32Array;
}

export type WorkletToMainMsg = TelemetryMsg | ReadyMsg | FrameMsg;

// --------------------------------------------------------------------
// engine-level events (UI <-> engine, not crossing the audio boundary)
// --------------------------------------------------------------------

export type EngineEvent =
  | { type: 'started'; sampleRate: number; sharedMemory: boolean }
  | { type: 'failed'; reason: string; detail?: unknown }
  | { type: 'telemetry'; data: TelemetryMsg }
  | { type: 'state'; contextState: AudioContextState }
  | { type: 'disposed' };
