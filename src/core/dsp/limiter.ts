/**
 * Look-ahead peak limiter.
 *
 * ADR-015: a brickwall limiter without lookahead cannot be transparent — the
 * gain reduction has to be instantaneous, which distorts the attack
 * transient. The correct structure is:
 *
 *     y[t] = g[t] * x[t - L]
 *     g[t] = ceiling / max(|x[s]| for s in [t-L, t])
 *
 * i.e. the gain is derived from a *sliding-window maximum* of the
 * undelayed signal, so by the time sample `t-L` reaches the output its own
 * peak is already inside the window that determined the gain.
 *
 * The window maximum is maintained with a monotonic deque, giving O(1)
 * amortised cost — a naive rescan of the window would cost `L` comparisons
 * per sample, which at 48 kHz and L=256 is ~12 M comparisons/s of pure
 * overhead on the audio thread.
 *
 * The gain itself is smoothed with asymmetric ballistics (instant attack,
 * exponential release) so sustained loudness does not pump.
 */

export class Limiter {
  private readonly delay: Float32Array;
  private readonly peakRing: Float32Array;
  /** circular monotonic deque of absolute sample indices, peak values decreasing */
  private readonly deque: Float64Array;
  private readonly dequeCap: number;
  private dHead = 0;
  private dSize = 0;
  private writeIdx = 0;
  private counter = 0;
  private gain = 1;
  private readonly releaseCoef: number;
  readonly lookahead: number;

  constructor(lookaheadSamples = 256, releaseSeconds = 0.06, sampleRate = 48000) {
    this.lookahead = Math.max(4, lookaheadSamples | 0);
    this.delay = new Float32Array(this.lookahead);
    this.peakRing = new Float32Array(this.lookahead);
    // a window of L samples can hold at most L+1 candidate indices
    this.dequeCap = this.lookahead + 2;
    this.deque = new Float64Array(this.dequeCap);
    this.releaseCoef = Math.exp(-1 / Math.max(1e-4, releaseSeconds * sampleRate));
  }

  reset(): void {
    this.delay.fill(0);
    this.peakRing.fill(0);
    this.deque.fill(0);
    this.dHead = 0;
    this.dSize = 0;
    this.writeIdx = 0;
    this.counter = 0;
    this.gain = 1;
  }

  /** ceiling in linear units, e.g. 0.891 (~-1 dBFS) */
  process(x: number, ceiling: number): number {
    const L = this.lookahead;
    const cap = this.dequeCap;

    // ---- sliding-window maximum of |x| via a monotonic deque -------------
    const p = Math.abs(x);
    this.peakRing[this.counter % L] = p;

    // pop every candidate the new peak dominates
    while (this.dSize > 0) {
      const back = this.deque[(this.dHead + this.dSize - 1) % cap];
      if (this.peakRing[back % L] <= p) this.dSize--;
      else break;
    }
    this.deque[(this.dHead + this.dSize) % cap] = this.counter;
    this.dSize++;
    this.counter++;

    // evict candidates that have fallen out of the window [counter-L, counter-1]
    while (this.dSize > 0 && this.deque[this.dHead % cap] < this.counter - L) {
      this.dHead = (this.dHead + 1) % cap;
      this.dSize--;
    }

    const front = this.deque[this.dHead % cap];
    const windowPeak = this.peakRing[front % L];
    const target = windowPeak > ceiling ? ceiling / windowPeak : 1;

    // asymmetric ballistics: instant attack, exponential release
    this.gain = target < this.gain ? target : target + this.releaseCoef * (this.gain - target);

    // ---- delayed output ---------------------------------------------------
    const delayed = this.delay[this.writeIdx];
    this.delay[this.writeIdx] = x;
    this.writeIdx = (this.writeIdx + 1) % L;
    return delayed * this.gain;
  }

  get currentGain(): number { return this.gain; }
}
