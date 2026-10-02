/**
 * Band-limited wavetable bank with mip selection.
 *
 * ADR-013: naive wavetable playback aliases above ~1/3 of the table length
 * in harmonics. A mip-mapped bank (one table per octave, each with half the
 * harmonic count of the one below) makes playback alias-free for any
 * frequency by selecting the coarsest table whose Nyquist still covers the
 * requested partial count. This is the standard "precomputed band-limited
 * wavetable" technique and it is what lets the drone layer play a
 * sawtooth-ish stack at 200 Hz with zero audible aliasing at 0 CPU cost.
 */

export interface WaveBank {
  /** tables[0] = fullest spectrum, tables[k] = 2^k times fewer harmonics */
  tables: Float32Array[];
  /** number of harmonics actually present in each table */
  harmonics: number[];
  readonly tableSize: number;
}

/**
 * Build a bank from a harmonic amplitude spectrum.
 * @param harmonicAmps amps[0] = fundamental ... amps[n-1] = nth harmonic
 * @param tableSize power of two
 */
export function buildWaveBank(harmonicAmps: Float32Array, tableSize = 2048): WaveBank {
  if (tableSize < 8 || (tableSize & (tableSize - 1)) !== 0) {
    throw new Error('tableSize must be a power of two');
  }
  const tables: Float32Array[] = [];
  const harmonics: number[] = [];
  let count = harmonicAmps.length;
  while (count >= 1) {
    const t = new Float32Array(tableSize);
    const twoPiOverN = (2 * Math.PI) / tableSize;
    for (let k = 1; k <= count; k++) {
      const amp = harmonicAmps[k - 1];
      if (amp === 0) continue;
      const phase = k * 0.7; // fixed per-harmonic phase gives a stable shape
      const w = k * twoPiOverN;
      for (let i = 0; i < tableSize; i++) {
        t[i] += amp * Math.sin(w * i + phase);
      }
    }
    // normalise to peak 1 so bank switching is gain-invariant
    let peak = 0;
    for (let i = 0; i < tableSize; i++) peak = Math.max(peak, Math.abs(t[i]));
    if (peak > 0) {
      const inv = 1 / peak;
      for (let i = 0; i < tableSize; i++) t[i] *= inv;
    }
    tables.push(t);
    harmonics.push(count);
    count = Math.floor(count / 2);
  }
  return { tables, harmonics, tableSize };
}

/** Canonical sawtooth spectrum 1/k (the classic "bright but musical"). */
export function sawSpectrum(n: number): Float32Array {
  const a = new Float32Array(n);
  for (let k = 0; k < n; k++) a[k] = 1 / (k + 1);
  return a;
}

/** Square spectrum: odd harmonics only, 1/k. */
export function squareSpectrum(n: number): Float32Array {
  const a = new Float32Array(n);
  for (let k = 0; k < n; k++) a[k] = (k + 1) % 2 === 1 ? 1 / (k + 1) : 0;
  return a;
}

/** Pulse-ish spectrum with a controllable duty cycle. */
export function pulseSpectrum(n: number, duty: number): Float32Array {
  const a = new Float32Array(n);
  const d = Math.max(0.05, Math.min(0.95, duty));
  for (let k = 0; k < n; k++) {
    const h = k + 1;
    a[k] = Math.abs(Math.sin(Math.PI * h * d)) / h;
  }
  return a;
}

/**
 * Mip reader. `freq` selects the table: a table is valid while its harmonic
 * count still fits under Nyquist, i.e. count <= sampleRate / (2 * freq).
 */
export function readBank(bank: WaveBank, phase: number, freq: number, sampleRate: number): number {
  const maxHarmonics = Math.max(1, Math.floor(sampleRate / (2 * Math.max(1, freq))));
  let level = 0;
  while (level < bank.harmonics.length - 1 && bank.harmonics[level] > maxHarmonics) level++;
  const table = bank.tables[level];
  const n = table.length;
  const p = phase - Math.floor(phase / n) * n;
  const i = p | 0;
  const f = p - i;
  const a = table[i];
  const b = table[i + 1 === n ? 0 : i + 1];
  return a + (b - a) * f;
}
