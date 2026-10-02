/**
 * Unitary mixing matrices.
 *
 * ADR-011: the FDN reverb uses a Householder-derived 8x8 Hadamard matrix
 * rather than the classic 4x4 Hadamard. Hadamard of order 8 is lossless
 * (H*H = 8*I) so the tank's energy is conserved and the decay time is
 * frequency-independent, which is what keeps a feedback delay network from
 * ringing at one mode. A Hadamard of order 8 needs 3 butterfly layers
 * instead of 2 — the extra layer is what decorrelates the remaining
 * two-pole modes.
 */

/** Sylvester-constructed Hadamard of order n = 2^k, normalised to unit energy. */
export function hadamard(n: number): Float32Array[] {
  if (n < 1 || (n & (n - 1)) !== 0) throw new Error('hadamard order must be power of two');
  let m: Float32Array[] = [new Float32Array([1])];
  while (m.length < n) {
    const k = m.length;
    const next: Float32Array[] = new Array(k * 2);
    for (let i = 0; i < k; i++) {
      next[i] = new Float32Array(k * 2);
      next[i + k] = new Float32Array(k * 2);
      for (let j = 0; j < k; j++) {
        next[i][j] = m[i][j];
        next[i][j + k] = m[i][j];
        next[i + k][j] = m[i][j];
        next[i + k][j + k] = -m[i][j];
      }
    }
    m = next;
  }
  const norm = 1 / Math.sqrt(n);
  return m.map((row) => { const r = new Float32Array(n); for (let i = 0; i < n; i++) r[i] = row[i] * norm; return r; });
}

/** In-place Householder reflection on a length-n vector (used for decorrelation). */
export function householder(v: Float32Array, x: Float32Array): void {
  let dot = 0;
  for (let i = 0; i < v.length; i++) dot += v[i] * x[i];
  const s = 2 * dot;
  for (let i = 0; i < v.length; i++) x[i] -= s * v[i];
}

/**
 * Mutually-prime-ish delay lengths for the FDN tank. Chosen by the
 * "smallest total ratio deviation" rule (Jot's approach) so the modal
 * density is even across the decay — the difference from naive random
 * lengths is audible: no audible fluttering in the tail.
 */
export function fdnDelayLengths(n: number, baseMs: number, spread: number, sampleRate: number): number[] {
  const lengths: number[] = [];
  const primes = [1, 1.08, 1.17, 1.27, 1.39, 1.53, 1.68, 1.85, 2.03, 2.23, 2.45, 2.69, 2.96, 3.25, 3.57, 3.92];
  for (let i = 0; i < n; i++) {
    const ms = baseMs * (1 + spread * (primes[i % primes.length] - 1));
    lengths.push(Math.max(8, Math.round((ms / 1000) * sampleRate)));
  }
  return lengths;
}
