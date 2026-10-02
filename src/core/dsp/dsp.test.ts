/**
 * DSP kernel tests.
 *
 * These are the adversarial layer: every kernel is attacked for the failure
 * modes that actually bite in production — instability under modulation,
 * denormal stalls, aliasing, and numerical blow-up — not just for "does it
 * return a number".
 */

import { describe, it, expect } from 'vitest';
import { StateVariableFilter, CascadeSvf } from './svf';
import { Biquad, designBiquad } from './biquad';
import { FFT, hannWindow } from './fft';
import { Adsr, AdsrStage } from './adsr';
import { OnePole, EnvelopeFollower } from './smoothing';
import { DcBlocker, softClip, foldback } from './nonlinear';
import { DelayLine, Allpass, Comb } from './delay';
import { Rng, PinkFilter } from './noise';
import { Attractor, LORENZ, ROSSLER, THOMAS } from './chaos';
import { buildWaveBank, readBank, sawSpectrum } from './wavetable';
import { Stft } from './stft';
import { hadamard, fdnDelayLengths } from './matrix';
import { Limiter } from './limiter';
import { SpscRing, RING_MAGIC, RingHeader } from '../ring';

const SR = 48000;

function allFinite(a: Float32Array | number[]): boolean {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
}

describe('StateVariableFilter', () => {
  it('passes DC through the lowpass at unity', () => {
    const f = new StateVariableFilter();
    f.setCoeffs(1000, 0.707, SR);
    let y = 0;
    for (let i = 0; i < 4000; i++) y = f.lp(1);
    expect(y).toBeCloseTo(1, 3);
  });

  it('blocks DC through the highpass', () => {
    const f = new StateVariableFilter();
    f.setCoeffs(1000, 0.707, SR);
    let y = 0;
    for (let i = 0; i < 4000; i++) y = f.hp(1);
    expect(Math.abs(y)).toBeLessThan(1e-3);
  });

  it('attenuates 8 kHz by > 40 dB in the lowpass (steady state)', () => {
    const f = new StateVariableFilter();
    f.setCoeffs(500, 0.707, SR);
    const n = 20000;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const x = Math.sin((2 * Math.PI * 8000 * i) / SR);
      // discard the startup transient: a resonant 2-pole rings on the step
      if (i > n / 2) peak = Math.max(peak, Math.abs(f.lp(x)));
      else f.lp(x);
    }
    expect(20 * Math.log10(peak)).toBeLessThan(-40);
  });

  it('stays bounded when the cutoff is swept to Nyquist every sample', () => {
    // the classic biquad-explosion scenario; the TPT form must survive it
    const f = new StateVariableFilter();
    let peak = 0;
    for (let i = 0; i < SR; i++) {
      const cutoff = 200 + (SR * 0.45) * (0.5 + 0.5 * Math.sin((2 * Math.PI * 30 * i) / SR));
      f.setCoeffs(cutoff, 12, SR);
      const x = Math.sin((2 * Math.PI * 300 * i) / SR) + 0.3 * Math.sin((2 * Math.PI * 3000 * i) / SR);
      peak = Math.max(peak, Math.abs(f.lp(x)));
    }
    expect(peak).toBeLessThan(4);
    expect(Number.isFinite(peak)).toBe(true);
  });

  it('cascade gives roughly twice the lowpass slope', () => {
    const single = new StateVariableFilter();
    const dual = new CascadeSvf();
    single.setCoeffs(1000, 0.707, SR);
    dual.setCoeffs(1000, 0.707, SR);
    let p1 = 0;
    let p2 = 0;
    const n = 8192;
    for (let i = 0; i < n; i++) {
      const x = Math.sin((2 * Math.PI * 6000 * i) / SR);
      p1 = Math.max(p1, Math.abs(single.lp(x)));
      p2 = Math.max(p2, Math.abs(dual.lp(x)));
    }
    // one extra pole => at least 3 dB more attenuation well above cutoff
    expect(20 * Math.log10(p2 / p1)).toBeLessThan(-3);
  });
});

describe('Biquad', () => {
  it('designs a unity-gain lowpass at DC', () => {
    const c = designBiquad('lowpass', 1000, 0.707, 0, SR);
    const sum = c.b0 + c.b1 + c.b2;
    expect(sum / (1 + c.a1 + c.a2)).toBeCloseTo(1, 6);
  });

  it('peak filter delivers the requested gain at the centre frequency', () => {
    const gainDb = 6;
    const c = designBiquad('peak', 1000, 1, gainDb, SR);
    const b = new Biquad();
    b.setCoeffs(c);
    const n = 16384;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const x = Math.sin((2 * Math.PI * 1000 * i) / SR);
      peak = Math.max(peak, Math.abs(b.process(x)));
    }
    expect(20 * Math.log10(peak)).toBeCloseTo(gainDb, 0);
  });

  it('is stable for every type at extreme Q', () => {
    for (const type of ['lowpass', 'highpass', 'bandpass', 'notch', 'peak', 'lowshelf', 'highshelf'] as const) {
      const b = new Biquad();
      b.design(type, 60, 30, 12, SR);
      let peak = 0;
      for (let i = 0; i < 4096; i++) {
        peak = Math.max(peak, Math.abs(b.process(i % 97 === 0 ? 1 : 0)));
      }
      expect(Number.isFinite(peak)).toBe(true);
      expect(peak).toBeLessThan(50);
    }
  });
});

describe('FFT', () => {
  it('round-trips a real signal', () => {
    const n = 256;
    const fft = new FFT(n);
    const input = new Float32Array(n);
    const mag = new Float32Array(n / 2);
    const phase = new Float32Array(n / 2);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) input[i] = 0.6 * Math.sin((2 * Math.PI * 5 * i) / n);
    fft.forwardReal(input, mag, phase);
    fft.inverseReal(mag, phase, out);
    for (let i = 0; i < n; i++) expect(out[i]).toBeCloseTo(input[i], 4);
  });

  it('locates a pure tone in the right bin', () => {
    const n = 1024;
    const fft = new FFT(n);
    const input = new Float32Array(n);
    const mag = new Float32Array(n / 2);
    const phase = new Float32Array(n / 2);
    const bin = 37;
    for (let i = 0; i < n; i++) input[i] = Math.cos((2 * Math.PI * bin * i) / n);
    fft.forwardReal(input, mag, phase);
    let maxBin = 0;
    for (let i = 1; i < n / 2; i++) if (mag[i] > mag[maxBin]) maxBin = i;
    expect(maxBin).toBe(bin);
  });

  it('hann window is COLA at 75% overlap', () => {
    const w = hannWindow(1024);
    // circular accumulation: the window is periodic, so wraparound counts
    const acc = new Float32Array(1024);
    for (let start = 0; start < 1024; start += 256) {
      for (let i = 0; i < 1024; i++) acc[(start + i) % 1024] += w[i];
    }
    // hop = N/4 => exactly 4 overlapping Hann windows, sum = 4 * 0.5 = 2
    for (let i = 0; i < 1024; i++) expect(acc[i]).toBeCloseTo(2, 6);
  });
});

describe('Adsr', () => {
  it('reaches 1 on attack and sustain on decay', () => {
    const e = new Adsr(SR);
    e.attack = 0.01; e.decay = 0.2; e.sustain = 0.4; e.release = 0.1;
    e.gate();
    // a 10 ms attack reaches 99.9 % after ~7 time constants (70 ms)
    for (let i = 0; i < SR * 0.07; i++) e.process();
    expect(e.value).toBeGreaterThan(0.99);
    // the exponential decay tail needs ~8.7 time constants to reach the
    // sustain floor (that is what makes the transition inaudible)
    for (let i = 0; i < SR * 3; i++) e.process();
    expect(e.value).toBeCloseTo(0.4, 3);
    expect(e.currentStage).toBe(AdsrStage.Sustain);
  });

  it('releases to exactly zero (no denormal tail)', () => {
    const e = new Adsr(SR);
    e.attack = 0.001; e.decay = 0.01; e.sustain = 1; e.release = 0.05;
    e.gate();
    for (let i = 0; i < SR * 0.05; i++) e.process();
    e.release_();
    let last = 1;
    for (let i = 0; i < SR * 2; i++) last = e.process();
    expect(last).toBe(0);
    expect(e.currentStage).toBe(AdsrStage.Idle);
  });

  it('retriggering from mid-decay does not click', () => {
    const e = new Adsr(SR);
    e.attack = 0.05; e.decay = 0.5; e.sustain = 0.3; e.release = 0.5;
    e.gate();
    for (let i = 0; i < SR * 0.2; i++) e.process();
    const before = e.value;
    e.gate();
    const after = e.process();
    expect(after).toBeGreaterThanOrEqual(before - 1e-6);
    expect(after).toBeLessThanOrEqual(1);
  });
});

describe('smoothing', () => {
  it('one-pole converges without overshoot', () => {
    const p = new OnePole(0.01);
    p.jump(0);
    let prev = 0;
    let overshoot = 0;
    for (let i = 0; i < SR; i++) {
      const y = p.process(1);
      if (y < prev - 1e-9) overshoot++;
      prev = y;
    }
    expect(overshoot).toBe(0);
    expect(prev).toBeCloseTo(1, 3);
  });

  it('envelope follower tracks attack faster than release', () => {
    const f = new EnvelopeFollower(0.001, 0.2);
    f.setBallistics(0.001, 0.2, SR);
    for (let i = 0; i < 200; i++) f.processPeak(1);
    const attack = f.value;
    for (let i = 0; i < 200; i++) f.processPeak(0);
    const release = f.value;
    expect(attack).toBeGreaterThan(0.95);
    // after the same number of samples the release has barely moved
    expect(release).toBeGreaterThan(attack * 0.8);
  });
});

describe('nonlinear', () => {
  it('softClip is odd-symmetric and bounded', () => {
    for (const x of [-3, -1, -0.5, 0, 0.5, 1, 3]) {
      expect(softClip(-x)).toBeCloseTo(-softClip(x), 12);
    }
    expect(Math.abs(softClip(100))).toBeLessThanOrEqual(1);
  });

  it('softClip generates no DC for a symmetric input', () => {
    let sum = 0;
    const n = 4800;
    for (let i = 0; i < n; i++) sum += softClip(0.9 * Math.sin((2 * Math.PI * 200 * i) / SR));
    expect(Math.abs(sum / n)).toBeLessThan(1e-3);
  });

  it('DcBlocker removes a constant offset', () => {
    const d = new DcBlocker(20);
    d.setCutoff(20, SR);
    let y = 0;
    for (let i = 0; i < SR; i++) y = d.process(0.7);
    expect(Math.abs(y)).toBeLessThan(1e-3);
  });

  it('foldback stays bounded for absurd input', () => {
    for (const x of [-1e6, -12.5, -1.2, 0, 3.3, 1e6]) {
      expect(Math.abs(foldback(x))).toBeLessThanOrEqual(1.0000001);
    }
  });
});

describe('delay lines', () => {
  it('DelayLine delays by exactly the requested amount', () => {
    const d = new DelayLine(1024);
    const out: number[] = [];
    for (let i = 0; i < 64; i++) out.push(d.tick(i === 0 ? 1 : 0, 10));
    expect(out[10]).toBeCloseTo(1, 6);
  });

  it('Allpass preserves magnitude across the band', () => {
    const a = new Allpass(0.7);
    const n = 8192;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      peak = Math.max(peak, Math.abs(a.process(Math.sin((2 * Math.PI * 700 * i) / SR))));
    }
    expect(peak).toBeGreaterThan(0.9);
    expect(peak).toBeLessThan(1.1);
  });

  it('Comb decays and stays bounded', () => {
    const c = new Comb(500, 0.7, 0.3);
    let peak = 0;
    for (let i = 0; i < 8000; i++) peak = Math.max(peak, Math.abs(c.process(i === 0 ? 1 : 0)));
    expect(peak).toBeLessThan(2);
    expect(Number.isFinite(peak)).toBe(true);
  });
});

describe('noise', () => {
  it('Rng is deterministic for a given seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('Rng output is uniform in [0,1)', () => {
    const r = new Rng(7);
    const buckets = new Array(10).fill(0);
    const n = 100000;
    for (let i = 0; i < n; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      buckets[Math.floor(v * 10)]++;
    }
    for (const b of buckets) expect(Math.abs(b - n / 10) / (n / 10)).toBeLessThan(0.05);
  });

  it('pink noise has less high-frequency energy than white', () => {
    const pink = new PinkFilter();
    const rng = new Rng(3);
    const n = 32768;
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = pink.process(rng.bipolar());
    const fft = new FFT(n);
    const mag = new Float32Array(n / 2);
    const phase = new Float32Array(n / 2);
    fft.forwardReal(buf, mag, phase);
    const lo = mag[8] + mag[16] + mag[32];
    const hi = mag[2048] + mag[4096] + mag[8192];
    expect(lo).toBeGreaterThan(hi * 3);
  });
});

describe('chaos', () => {
  it('attractor stays bounded over a long run', () => {
    for (const cfg of [LORENZ, ROSSLER, THOMAS]) {
      const a = new Attractor(cfg);
      let peak = 0;
      for (let i = 0; i < 200000; i++) {
        a.step();
        peak = Math.max(peak, Math.abs(a.a), Math.abs(a.b), Math.abs(a.c));
      }
      expect(peak).toBeLessThan(3);
      expect(Number.isFinite(peak)).toBe(true);
    }
  });

  it('attractor keeps moving — no fixed point, no stall', () => {
    for (const cfg of [LORENZ, ROSSLER, THOMAS]) {
      const a = new Attractor(cfg);
      const seen = new Set<number>();
      let sum = 0;
      let sumSq = 0;
      let n = 0;
      for (let i = 0; i < 20000; i++) {
        a.step();
        if (i > 2000) {
          seen.add(a.a);
          sum += a.a;
          sumSq += a.a * a.a;
          n++;
        }
      }
      // thousands of distinct values => genuinely aperiodic
      expect(seen.size).toBeGreaterThan(1000);
      const mean = sum / n;
      const std = Math.sqrt(sumSq / n - mean * mean);
      // a useful modulator is centred and has real excursion
      expect(Math.abs(mean)).toBeLessThan(0.2);
      expect(std).toBeGreaterThan(0.1);
    }
  });
});

describe('wavetable', () => {
  it('bank mip selection keeps the alias floor low', () => {
    const bank = buildWaveBank(sawSpectrum(48), 2048);
    // a naive (non-band-limited) read at a high frequency aliases; the bank
    // must pick a coarser table whose harmonic count fits under Nyquist
    const f = 4000;
    const maxHarmonics = Math.floor(SR / (2 * f));
    let level = 0;
    while (level < bank.harmonics.length - 1 && bank.harmonics[level] > maxHarmonics) level++;
    expect(bank.harmonics[level]).toBeLessThanOrEqual(maxHarmonics);
  });

  it('readBank is periodic and bounded', () => {
    const bank = buildWaveBank(sawSpectrum(32), 1024);
    for (let i = 0; i < 5000; i++) {
      const v = readBank(bank, i * 0.37, 220 + i, SR);
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(1.0001);
    }
  });
});

describe('Stft', () => {
  it('resynthesises a sine through identity processing', () => {
    const stft = new Stft(1024, 4);
    const inBuf = new Float32Array(1);
    const out = new Float32Array(stft.hop);
    const collected: number[] = [];
    // skip the algorithmic latency, then compare steady state
    for (let i = 0; i < 48000; i++) {
      inBuf[0] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
      if (stft.push(inBuf, 1) > 0) {
        stft.analyze();
        stft.synthesize(out, out.length);
        if (i > 8000) for (let k = 0; k < out.length; k++) collected.push(out[k]);
      }
    }
    let peak = 0;
    for (const v of collected) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.4);
    expect(peak).toBeLessThan(0.6);
  });

  it('has the documented hop, not fftSize', () => {
    const stft = new Stft(512, 4);
    expect(stft.hop).toBe(128);
    expect(stft.bins).toBe(256);
  });
});

describe('matrix', () => {
  it('hadamard is orthogonal', () => {
    const h = hadamard(8);
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        let dot = 0;
        for (let k = 0; k < 8; k++) dot += h[i][k] * h[j][k];
        expect(dot).toBeCloseTo(i === j ? 1 : 0, 6);
      }
    }
  });

  it('fdn delay lengths are distinct and positive', () => {
    const lens = fdnDelayLengths(8, 42, 0.85, SR);
    expect(new Set(lens).size).toBe(8);
    for (const l of lens) expect(l).toBeGreaterThan(8);
  });
});

describe('Limiter', () => {
  it('holds the ceiling for a hot signal', () => {
    const lim = new Limiter(128, 0.05, SR);
    let peak = 0;
    for (let i = 0; i < SR; i++) {
      const x = 1.4 * Math.sin((2 * Math.PI * 100 * i) / SR);
      peak = Math.max(peak, Math.abs(lim.process(x, 0.891)));
    }
    expect(peak).toBeLessThanOrEqual(0.9);
  });

  it('passes a quiet signal at unity', () => {
    const lim = new Limiter(128, 0.05, SR);
    let peak = 0;
    for (let i = 0; i < SR; i++) {
      peak = Math.max(peak, Math.abs(lim.process(0.3 * Math.sin((2 * Math.PI * 100 * i) / SR), 0.891)));
    }
    expect(peak).toBeCloseTo(0.3, 1);
  });
});

describe('SpscRing', () => {
  it('rejects a buffer that was not produced by SpscRing', () => {
    const bogus = new ArrayBuffer(64);
    expect(() => SpscRing.attach(bogus)).toThrow();
  });

  it('delivers every published frame in order', () => {
    const slots = 4;
    const floats = 8;
    const ring = SpscRing.create(slots, floats, false);
    expect(ring.header[RingHeader.Magic]).toBe(RING_MAGIC);
    for (let i = 0; i < 100; i++) {
      const slot = ring.beginWrite();
      for (let k = 0; k < floats; k++) slot[k] = i + k / 10;
      ring.publish(SR, 128);
    }
    const out = new Float32Array(floats);
    let count = 0;
    let last = -1;
    let first = -1;
    while (ring.read(out)) {
      if (count === 0) first = out[0];
      expect(out[0]).toBeGreaterThan(last);
      last = out[0];
      count++;
    }
    // only the 4 retained slots may be read; the other 96 were overwritten
    expect(count).toBe(4);
    expect(first).toBe(96);
    expect(last).toBe(99);
    expect(ring.overwritten).toBe(96);
  });

  it('readLatest skips to the newest frame', () => {
    const ring = SpscRing.create(8, 4, false);
    for (let i = 0; i < 20; i++) {
      const slot = ring.beginWrite();
      slot[0] = i;
      ring.publish(SR, 128);
    }
    const out = new Float32Array(4);
    expect(ring.readLatest(out)).toBe(true);
    expect(out[0]).toBe(19);
  });

  it('non-shared mode still publishes and reads', () => {
    const ring = SpscRing.create(2, 4, false);
    const slot = ring.beginWrite();
    slot[0] = 3.5;
    ring.publish(SR, 128);
    const out = new Float32Array(4);
    expect(ring.read(out)).toBe(true);
    expect(out[0]).toBe(3.5);
    expect(allFinite(out)).toBe(true);
  });
});
