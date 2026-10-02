/**
 * ====================================================================
 * ORACLE SYNTH — the instrument worklet
 * ====================================================================
 *
 * A complete polyphonic engine running entirely off the main thread:
 *
 *   - 8 voices, band-limited wavetable oscillators with mip selection,
 *     two-operator phase modulation with feedback, and a per-voice
 *     cascade state-variable filter + waveshaper.
 *   - A 6-partial drone bank with independent per-partial drift.
 *   - A pink-noise "tape hiss" layer with a wandering band-pass.
 *   - A Lorenz attractor as the global modulation source, routed to
 *     filter cutoff, FM index and stereo width.
 *   - Voice-envelope sidechain ducking of the sustained layers.
 *
 * Everything is preallocated in the constructor: the render loop performs
 * zero allocations and zero closures, which is what keeps this inside the
 * 2.67 ms quantum budget even with all 8 voices sounding.
 */

import { StateVariableFilter, CascadeSvf } from '../../core/dsp/svf';
import { Adsr } from '../../core/dsp/adsr';
import { OnePole } from '../../core/dsp/smoothing';
import { DcBlocker, softClip } from '../../core/dsp/nonlinear';
import { Rng, PinkFilter } from '../../core/dsp/noise';
import { Attractor, LORENZ } from '../../core/dsp/chaos';
import { buildWaveBank, readBank, sawSpectrum, pulseSpectrum } from '../../core/dsp/wavetable';
import { scope, type WorkletProcessor, type MessagePortLike } from './env';
import type { NoteMods, WorkletMsg } from '../protocol';

const MAX_VOICES = 8;
const DRONE_PARTIALS = 6;
const TABLE_SIZE = 2048;
const PHASE_MASK = TABLE_SIZE - 1;

/** Global modulation parameters exposed as AudioParams (sample-accurate). */
const PARAM_DESCRIPTORS = [
  { name: 'cutoff', defaultValue: 900, minValue: 40, maxValue: 16000, automationRate: 'a' },
  { name: 'resonance', defaultValue: 3.2, minValue: 0.4, maxValue: 24, automationRate: 'a' },
  { name: 'drive', defaultValue: 1.6, minValue: 0.2, maxValue: 24, automationRate: 'a' },
  { name: 'fmIndex', defaultValue: 0.6, minValue: 0, maxValue: 12, automationRate: 'a' },
  { name: 'fmRatio', defaultValue: 2.01, minValue: 0.25, maxValue: 8, automationRate: 'a' },
  { name: 'chaos', defaultValue: 0.35, minValue: 0, maxValue: 1, automationRate: 'a' },
  { name: 'width', defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: 'a' },
  { name: 'level', defaultValue: 0.85, minValue: 0, maxValue: 1.4, automationRate: 'a' },
  { name: 'droneLevel', defaultValue: 0.5, minValue: 0, maxValue: 1.4, automationRate: 'a' },
  { name: 'hissLevel', defaultValue: 0.28, minValue: 0, maxValue: 1.4, automationRate: 'a' },
  { name: 'duck', defaultValue: 0.55, minValue: 0, maxValue: 1, automationRate: 'a' },
] as const;

/** fixed inharmonic-ish drone ratios (A-minor-ish stack, slightly detuned) */
const DRONE_RATIOS = [0.5, 0.75, 1, 1.5, 2, 3.01];

interface Voice {
  active: boolean;
  voiceId: number;
  velocity: number;
  freq: number;
  carrierPhase: number;
  modPhase: number;
  fb: number;
  env: Adsr;
  filter: CascadeSvf;
  shaper: DcBlocker;
  amp: OnePole;
  mods: NoteMods;
  panL: number;
  panR: number;
}

function defaultMods(): NoteMods {
  return {
    fmIndex: 0.6, fmRatio: 2.01, cutoff: 900, resonance: 3.2, drive: 1.6,
    pan: 0, amp: 0.7, attack: 0.006, decay: 0.22, sustain: 0.5, release: 0.9,
  };
}

const noteToHz = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

/**
 * Wrap a wavetable phase into [0, TABLE_SIZE).
 *
 * ADR-040: the previous code only handled the positive overflow
 * (`if (p >= TABLE_SIZE) p -= TABLE_SIZE`). Phase modulation with
 * self-feedback makes the increment *negative* as often as positive, so a
 * negative phase survived into `readBank` — which indexes a Float32Array
 * out of bounds, and a typed-array OOB read returns `undefined`, so the
 * whole voice silently became NaN. One branch each way is the cheapest
 * correct wrap because |increment| is bounded far below TABLE_SIZE.
 */
function wrapPhase(p: number): number {
  if (p >= TABLE_SIZE) return p & PHASE_MASK;
  if (p < 0) return p + TABLE_SIZE;
  return p;
}

class OracleSynthProcessor implements WorkletProcessor {
  static get parameterDescriptors(): unknown { return PARAM_DESCRIPTORS; }

  readonly port: MessagePortLike;

  private readonly sampleRate: number;
  private readonly voices: Voice[] = [];
  private readonly rng = new Rng(0x5eed1234);

  // wavetable banks (built once — band-limited, alias-free under any pitch)
  private readonly sawBank = buildWaveBank(sawSpectrum(48), TABLE_SIZE);
  private readonly pulseBank = buildWaveBank(pulseSpectrum(48, 0.38), TABLE_SIZE);

  // drone bank
  private readonly dronePhase = new Float64Array(DRONE_PARTIALS);
  private readonly droneFilter: StateVariableFilter[] = [];
  private readonly droneEnv: OnePole[] = [];
  private readonly droneShaper = new DcBlocker(10);

  // hiss layer
  private readonly pink = new PinkFilter();
  private readonly hissFilter = new StateVariableFilter();
  private hissLfo = 0;

  // global modulation
  private readonly attractor = new Attractor(LORENZ);
  private readonly chaosA = new OnePole(0.25);
  private readonly chaosB = new OnePole(0.35);
  private readonly chaosC = new OnePole(0.5);
  private readonly duckEnv = new OnePole(0.02);
  private readonly widthSm = new OnePole(0.05);

  // smoothed globals so parameter jumps stay inaudible
  private readonly smLevel = new OnePole(0.02);
  private readonly smDrone = new OnePole(0.05);
  private readonly smHiss = new OnePole(0.05);
  private readonly smChaos = new OnePole(0.08);

  private voicesSounding = 0;
  private chaosCounter = 0;
  /** events scheduled for a future context time (see ADR-021) */
  private pending: { msg: WorkletMsg; when: number }[] = [];

  constructor() {
    this.sampleRate = scope().sampleRate;
    this.port = (globalThis as unknown as { port: MessagePortLike }).port;

    for (let i = 0; i < MAX_VOICES; i++) {
      this.voices.push({
        active: false,
        voiceId: -1,
        velocity: 0,
        freq: 220,
        carrierPhase: 0,
        modPhase: 0,
        fb: 0,
        env: new Adsr(this.sampleRate),
        filter: new CascadeSvf(),
        shaper: new DcBlocker(14),
        amp: new OnePole(0.004),
        mods: defaultMods(),
        panL: 0.7,
        panR: 0.7,
      });
    }

    for (let i = 0; i < DRONE_PARTIALS; i++) {
      this.droneFilter.push(new StateVariableFilter());
      this.droneEnv.push(new OnePole(0.4));
      this.dronePhase[i] = this.rng.next() * TABLE_SIZE;
    }
    this.droneShaper.setCutoff(10, this.sampleRate);
    this.hissFilter.setCoeffs(1200, 1.4, this.sampleRate);

    this.port.onmessage = (event: { data: unknown }) => {
      const msg = event.data as WorkletMsg;
      const when = 'when' in msg ? msg.when : undefined;
      if (typeof when === 'number' && when > scope().currentTime + 1e-4) {
        this.pending.push({ msg, when });
      } else {
        this.onMessage(msg);
      }
    };
  }

  // ----------------------------------------------------------------
  private onMessage(msg: WorkletMsg): void {
    switch (msg.type) {
      case 'noteOn':
        this.noteOn(msg.note, msg.velocity, msg.voiceId, msg.mods);
        break;
      case 'noteOff':
        for (const v of this.voices) {
          if (v.voiceId === msg.voiceId) { v.env.release_(); break; }
        }
        break;
      case 'param':
      case 'preset':
        // continuous macros arrive as AudioParams; discrete state arrives here
        break;
      case 'chaosSeed':
        this.rng.reseed(msg.seed);
        this.attractor.reset();
        break;
      case 'panic':
        for (const v of this.voices) { v.active = false; v.env.kill(); }
        this.voicesSounding = 0;
        break;
      case 'telemetryRequest':
        break;
    }
  }

  // ----------------------------------------------------------------
  /** oldest-voice-first allocation with steal-on-exhaustion */
  private noteOn(note: number, velocity: number, voiceId: number, mods?: Partial<NoteMods>): void {
    let target = this.voices.find((v) => !v.active);
    if (!target) {
      // steal the quietest voice — least audible artefact
      target = this.voices.reduce((a, b) => (a.env.value <= b.env.value ? a : b));
      target.env.kill();
    }
    const m = defaultMods();
    if (mods) Object.assign(m, mods);
    target.active = true;
    target.voiceId = voiceId;
    target.velocity = velocity;
    target.freq = noteToHz(note);
    target.carrierPhase = this.rng.next() * TABLE_SIZE;
    target.modPhase = this.rng.next() * TABLE_SIZE;
    target.fb = 0;
    target.mods = m;
    target.env.attack = m.attack;
    target.env.decay = m.decay;
    target.env.sustain = m.sustain;
    target.env.release = m.release;
    target.env.gate();
    target.filter.reset();
    target.shaper.reset();
    target.amp.jump(0);
    // equal-power pan law: constant perceived loudness across the image
    const p = (m.pan + 1) * 0.5;
    target.panL = Math.cos(p * Math.PI * 0.5);
    target.panR = Math.sin(p * Math.PI * 0.5);
  }

  // ----------------------------------------------------------------
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0];
    if (!out || out.length === 0 || out[0].length === 0) return true;
    const left = out[0];
    const right = out.length > 1 ? out[1] : out[0];
    const n = left.length;
    void inputs;

    const sr = this.sampleRate;
    const pCutoff = parameters.cutoff;
    const pReso = parameters.resonance;
    const pDrive = parameters.drive;
    const pIndex = parameters.fmIndex;
    const pRatio = parameters.fmRatio;
    const pChaos = parameters.chaos;
    const pWidth = parameters.width;
    const pLevel = parameters.level;
    const pDrone = parameters.droneLevel;
    const pHiss = parameters.hissLevel;
    const pDuck = parameters.duck;

    // ADR-028: a k-rate AudioParam's value array MAY have length 1 depending
    // on the implementation, so k-rate values are read once per block from
    // index 0 and never from a per-sample index. `duck` is declared a-rate
    // because it is cheap, but the same rule is applied uniformly.
    const duckNow = pDuck ? pDuck[0] : 0.55;

    let sounding = 0;

    // ADR-021: drain scheduled events whose time has arrived. The queue is
    // tiny (bounded by the lookahead window) and scanned linearly, which is
    // far cheaper than maintaining a sorted structure for ~4 entries.
    const now = scope().currentTime;
    if (this.pending.length > 0) {
      for (let k = this.pending.length - 1; k >= 0; k--) {
        if (this.pending[k].when <= now) {
          this.onMessage(this.pending[k].msg);
          this.pending.splice(k, 1);
        }
      }
    }

    // indices per sample: see ADR-042
    const phaseScale = TABLE_SIZE / sr;

    for (let i = 0; i < n; i++) {
      // ---- global modulation --------------------------------------
      // ADR-041: the global macros *scale* the per-note mods rather than
      // replacing them. The MacroRack owns the instrument's character; each
      // voice keeps its own envelope-tracked timbre on top. Before this, the
      // CUTOFF / RESONANCE / FM RATIO / CHAOS sliders were read into locals
      // that nothing consumed — four dead controls on the UI.
      const cutoffScale = (pCutoff ? pCutoff[i] : 900) / 900;
      const resoScale = (pReso ? pReso[i] : 3.2) / 3.2;
      const drive = pDrive ? pDrive[i] : 1.6;
      const index = pIndex ? pIndex[i] : 0.6;
      const ratioScale = (pRatio ? pRatio[i] : 2.01) / 2.01;
      const chaosAmt = this.smChaos.process(pChaos ? pChaos[i] : 0.35);
      // the Lorenz attractor steps at 1/16 sample rate — it is a *modulator*,
      // not an oscillator, and full-rate integration would alias horribly
      if ((this.chaosCounter++ & 15) === 0) this.attractor.step();
      const ca = this.chaosA.process(this.attractor.a) * chaosAmt;
      const cb = this.chaosB.process(this.attractor.b) * chaosAmt;
      const width = this.widthSm.process(pWidth ? pWidth[i] : 0.7);
      const level = this.smLevel.process(pLevel ? pLevel[i] : 0.85);
      const droneLevel = this.smDrone.process(pDrone ? pDrone[i] : 0.5);
      const hissLevel = this.smHiss.process(pHiss ? pHiss[i] : 0.28);
      const duckAmt = duckNow;

      // ---- voices -------------------------------------------------
      let vl = 0;
      let vr = 0;
      let voicePeak = 0;
      for (let vi = 0; vi < MAX_VOICES; vi++) {
        const v = this.voices[vi];
        if (!v.active) continue;
        const e = v.env.process();
        if (e === 0 && !v.env.active) { v.active = false; continue; }
        sounding++;

        const m = v.mods;
        // phase modulation with self-feedback: feedback FM is what gives the
        // oracle its broad, unstable, "impossible organism" spectrum
        const modFreq = v.freq * (m.fmRatio * ratioScale + cb * 0.02);
        const mod = readBank(this.sawBank, v.modPhase, modFreq, sr);
        const modScaled = (mod + v.fb * 0.35) * index * v.freq * (1 + ca * 0.4);

        // ADR-042: the phase is in *table-index* units, not cycles. A
        // wavetable of TABLE_SIZE entries needs TABLE_SIZE indices per cycle,
        // so the per-sample increment is `hz * TABLE_SIZE / sampleRate`.
        // Without the factor every voice ran 2048x too slow — a 220 Hz note
        // became a 0.1 Hz sub-audio rumble, which still looked "finite and
        // non-silent" to the old tests. `phaseScale` is hoisted out of the
        // loop because it is a division, not a multiply.
        v.carrierPhase = wrapPhase(v.carrierPhase + (v.freq + modScaled) * phaseScale);
        v.modPhase = wrapPhase(v.modPhase + modFreq * phaseScale);

        const osc = readBank(this.pulseBank, v.carrierPhase, v.freq, sr);
        v.fb = osc;

        // envelope-tracked cutoff + attractor-warped resonance
        const cutoff = Math.min(
          sr * 0.45,
          m.cutoff * cutoffScale * (0.3 + e * 2.6) * (1 + ca * 0.9) + 60,
        );
        v.filter.setCoeffs(cutoff, m.resonance * resoScale * (1 + cb * 0.5), sr);
        const shaped = softClip(v.filter.lp(osc) * (m.drive * drive * 0.35)) * e;

        const amp = v.amp.process(m.amp * v.velocity * level);
        const s = v.shaper.process(shaped * amp);
        vl += s * v.panL;
        vr += s * v.panR;
      }
      voicePeak = Math.max(Math.abs(vl), Math.abs(vr));

      // sidechain: sustained layers duck under polyphony
      const duck = this.duckEnv.process(voicePeak) * duckAmt;
      const duckGain = 1 - duck * 0.75;

      // ---- drone bank ---------------------------------------------
      let dl = 0;
      let dr = 0;
      const droneCut = 320 + (ca * 0.5 + 0.5) * 900 + 140;
      for (let d = 0; d < DRONE_PARTIALS; d++) {
        const f = 55 * DRONE_RATIOS[d] * (1 + cb * 0.004);
        this.dronePhase[d] = wrapPhase(this.dronePhase[d] + f * phaseScale);
        const raw = readBank(this.sawBank, this.dronePhase[d], f, sr);
        this.droneFilter[d].setCoeffs(droneCut * (1 + d * 0.12), 0.9 + d * 0.15, sr);
        const filtered = this.droneFilter[d].lp(raw);
        const amp = this.droneEnv[d].process(droneLevel * (0.22 - d * 0.02) * duckGain);
        const s = filtered * amp;
        // partial-dependent stereo spread — the drone breathes across the image
        dl += s * (1 - width * 0.4 * (d / DRONE_PARTIALS));
        dr += s * (0.6 + width * 0.4 * (d / DRONE_PARTIALS));
      }
      const droneSum = this.droneShaper.process(dl + dr) * 0.5;
      dl += droneSum; dr += droneSum;

      // ---- hiss ---------------------------------------------------
      this.hissLfo += 0.07 / sr;
      const hissCut = 700 + Math.sin(this.hissLfo * 6.283) * 420 + ca * 300;
      this.hissFilter.setCoeffs(hissCut, 1.1, sr);
      const hiss = this.hissFilter.bp(this.pink.process(this.rng.bipolar())) * hissLevel * duckGain * 0.5;

      left[i] = vl + dl + hiss;
      right[i] = vr + dr + hiss;
    }

    this.voicesSounding = sounding;
    return true;
  }

  get activeVoices(): number { return this.voicesSounding; }
}

scope().registerProcessor('oracle-synth', OracleSynthProcessor);
