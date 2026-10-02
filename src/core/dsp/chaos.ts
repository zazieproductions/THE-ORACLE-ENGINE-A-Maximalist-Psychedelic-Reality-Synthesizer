/**
 * Continuous-time chaotic systems as modulation sources.
 *
 * ADR-012: cross-disciplinary borrowing from nonlinear dynamics. A chaotic
 * trajectory is a bounded, never-repeating signal whose coordinates are
 * (approximately) statistically independent — exactly what a modulation
 * source should be. Compared to a bank of LFOs it has no period to hear;
 * compared to a random walk it never sits still; compared to noise it is
 * smooth, so it can drive a filter cutoff without needing its own smoother.
 *
 * Three systems are provided because they have genuinely different
 * *characters*, and the choice is audible:
 *
 *   LORENZ  — the classic. Two slow lobes with fast switching; gives the
 *             engine its "breathing, indecisive" quality.
 *   ROSSLER — a single folded band; much more periodic-feeling, good for
 *             slow spectral drift.
 *   THOMAS  — cyclically symmetric (dx = sin y - b x ...); the cheapest of
 *             the three (three sines per field evaluation) and the most
 *             "Lissajous", which suits the stereo width modulation.
 *
 * Integration is fixed-step RK4. The step is decoupled from the sample rate
 * via `rate` (fraction of a sample per integration step) so the same
 * trajectory is produced at 44.1 kHz and 96 kHz — a property the unit tests
 * rely on and that a variable-step integrator would not give.
 */

const clampUnit = (v: number): number => (v > 1 ? 1 : v < -1 ? -1 : v);

export type AttractorSystem = 'lorenz' | 'rossler' | 'thomas';

export interface AttractorConfig {
  system: AttractorSystem;
  /** system parameters (meaning depends on `system`) */
  a: number;
  b: number;
  c: number;
  /** integration steps per audio sample, e.g. 1/64 */
  rate: number;
}

export const LORENZ: AttractorConfig = {
  system: 'lorenz', a: 10, b: 28, c: 8 / 3, rate: 1 / 64,
};

export const ROSSLER: AttractorConfig = {
  system: 'rossler', a: 0.2, b: 0.2, c: 5.7, rate: 1 / 32,
};

export const THOMAS: AttractorConfig = {
  system: 'thomas', a: 0.19, b: 0.19, c: 0.19, rate: 1 / 24,
};

export class Attractor {
  x = 0.1;
  y = 0;
  z = 0;

  private readonly cfg: AttractorConfig;
  /** running peak per axis for auto-normalisation */
  private px = 1;
  private py = 1;
  private pz = 1;
  private nx = 0;
  private ny = 0;
  private nz = 0;
  /**
   * Peak-hold release rate. A leaky lowpass of |x| tracks the *mean* of the
   * oscillation, so a peak 2x the mean saturates the normalised output and
   * the modulator spends most of its time pinned at +-1 — useless as a
   * modulation source. A peak-hold with a slow release tracks the *envelope*
   * instead, which keeps the normalised trajectory inside its range without
   * clamping away the very dynamics we want.
   */
  private readonly holdRelease: number;

  constructor(cfg: AttractorConfig = LORENZ, holdRelease = 0.9995) {
    this.cfg = cfg;
    this.holdRelease = holdRelease;
  }

  reset(): void {
    this.x = 0.1 + Math.random() * 0.01;
    this.y = 0;
    this.z = 0;
    this.nx = this.ny = this.nz = 0;
    this.px = this.py = this.pz = 1;
  }

  /** the vector field, evaluated in place to avoid allocation */
  private field(x: number, y: number, z: number, out: [number, number, number]): void {
    const { system, a, b, c } = this.cfg;
    switch (system) {
      case 'lorenz':
        out[0] = a * (y - x);
        out[1] = x * (b - z) - y;
        out[2] = x * y - c * z;
        break;
      case 'rossler':
        out[0] = -y - z;
        out[1] = x + a * y;
        out[2] = b + z * (x - c);
        break;
      case 'thomas':
        out[0] = Math.sin(y) - b * x;
        out[1] = Math.sin(z) - b * y;
        out[2] = Math.sin(x) - b * z;
        break;
    }
  }

  /** advance one audio sample */
  step(): void {
    const { rate } = this.cfg;
    const h = rate;
    const k1: [number, number, number] = [0, 0, 0];
    const k2: [number, number, number] = [0, 0, 0];
    const k3: [number, number, number] = [0, 0, 0];
    const k4: [number, number, number] = [0, 0, 0];

    this.field(this.x, this.y, this.z, k1);
    this.field(
      this.x + 0.5 * h * k1[0], this.y + 0.5 * h * k1[1], this.z + 0.5 * h * k1[2], k2,
    );
    this.field(
      this.x + 0.5 * h * k2[0], this.y + 0.5 * h * k2[1], this.z + 0.5 * h * k2[2], k3,
    );
    this.field(
      this.x + h * k3[0], this.y + h * k3[1], this.z + h * k3[2], k4,
    );

    this.x += (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
    this.y += (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
    this.z += (h / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);

    // peak-hold normalisation: instant attack, slow release
    const ax = Math.abs(this.x);
    this.px = ax > this.px ? ax : this.px * this.holdRelease;
    const ay = Math.abs(this.y);
    this.py = ay > this.py ? ay : this.py * this.holdRelease;
    const az = Math.abs(this.z);
    this.pz = az > this.pz ? az : this.pz * this.holdRelease;

    this.nx = clampUnit(this.x / this.px);
    this.ny = clampUnit(this.y / this.py);
    this.nz = clampUnit((this.z / this.pz) * 2 - 1);
  }

  get a(): number { return this.nx; }
  get b(): number { return this.ny; }
  get c(): number { return this.nz; }
}
