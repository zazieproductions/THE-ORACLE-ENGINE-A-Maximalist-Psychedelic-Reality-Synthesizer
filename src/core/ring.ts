/**
 * Single-producer / single-consumer lock-free ring over SharedArrayBuffer.
 *
 * ADR-001: the analysis bridge between the AudioWorklet thread and the render
 * thread is a classic Lamport SPSC ring. Rationale vs the alternatives:
 *
 *   - postMessage per block: costs a structured clone (or a transfer that
 *     then needs re-allocation on the producer). At 375 blocks/s x 4 KB that
 *     is ~1.5 MB/s of garbage and a serialisation tax on the audio thread.
 *   - SharedArrayBuffer + Mutex: `Atomics.wait` is illegal on the main
 *     thread's event loop in some browsers and would block rendering.
 *   - SharedArrayBuffer + Atomics publish/consume (this): the producer never
 *     blocks, the consumer never blocks, and the only shared word is a
 *     monotonically increasing sequence number. Seqlock-style reads make a
 *     torn frame impossible to observe as *valid* data.
 *
 * The consumer keeps its own read cursor, so the producer's write index is
 * the single synchronisation point. If the consumer falls behind, the
 * producer overwrites the oldest slot — the ring degrades to "latest N
 * frames", never to a stall or a crash.
 */

export const RING_HEADER_WORDS = 8;

export const RingHeader = {
  /** frames published by the producer (monotonic) */
  Published: 0,
  /** frames skipped because the consumer lagged */
  Overwritten: 1,
  SampleRate: 2,
  BlockSize: 3,
  SlotFloats: 4,
  Slots: 5,
  ProducerDropped: 6,
  Magic: 7,
} as const;

export const RING_MAGIC = 0x4f52434c; // "ORCL"

export class SpscRing {
  readonly header: Int32Array;
  readonly body: Float32Array;
  readonly slots: number;
  readonly slotFloats: number;

  /** consumer-side cursor; only ever touched by the reader */
  private readCursor = 0;
  /** producer-side cursor; only ever touched by the writer */
  private writeCursor = 0;

  private constructor(buffer: SharedArrayBuffer | ArrayBuffer, slots: number, slotFloats: number) {
    this.header = new Int32Array(buffer, 0, RING_HEADER_WORDS);
    this.body = new Float32Array(buffer, RING_HEADER_WORDS * 4, slots * slotFloats);
    this.slots = slots;
    this.slotFloats = slotFloats;
  }

  static create(slots: number, slotFloats: number, shared: boolean): SpscRing {
    if (slots < 2) throw new Error('ring needs at least 2 slots');
    const bytes = RING_HEADER_WORDS * 4 + slots * slotFloats * 4;
    const buffer = shared && typeof SharedArrayBuffer !== 'undefined'
      ? new SharedArrayBuffer(bytes)
      : new ArrayBuffer(bytes);
    const ring = new SpscRing(buffer, slots, slotFloats);
    ring.header[RingHeader.Magic] = RING_MAGIC;
    ring.header[RingHeader.Slots] = slots;
    ring.header[RingHeader.SlotFloats] = slotFloats;
    return ring;
  }

  static attach(buffer: SharedArrayBuffer | ArrayBuffer): SpscRing {
    const header = new Int32Array(buffer, 0, RING_HEADER_WORDS);
    if (header[RingHeader.Magic] !== RING_MAGIC) {
      throw new Error('ring magic mismatch — buffer was not produced by SpscRing');
    }
    return new SpscRing(buffer, header[RingHeader.Slots], header[RingHeader.SlotFloats]);
  }

  get shared(): boolean {
    return typeof SharedArrayBuffer !== 'undefined'
      && this.header.buffer instanceof SharedArrayBuffer;
  }

  get buffer(): SharedArrayBuffer | ArrayBuffer { return this.header.buffer; }

  /** producer: fill the next slot via `body` then publish */
  beginWrite(): Float32Array {
    const slot = this.writeCursor % this.slots;
    const off = slot * this.slotFloats;
    return this.body.subarray(off, off + this.slotFloats);
  }

  publish(sampleRate: number, blockSize: number): void {
    this.header[RingHeader.SampleRate] = sampleRate;
    this.header[RingHeader.BlockSize] = blockSize;
    this.writeCursor++;
    if (this.shared) {
      Atomics.store(this.header, RingHeader.Published, this.writeCursor);
      Atomics.notify(this.header, RingHeader.Published);
    } else {
      this.header[RingHeader.Published] = this.writeCursor;
    }
  }

  /** producer bookkeeping when it must skip a frame */
  noteDrop(): void {
    this.header[RingHeader.ProducerDropped]++;
  }

  /**
   * Consumer: frames published but not yet consumed.
   *
   * The producer may have overwritten slots we have not read yet. That is
   * legal (the ring degrades to "latest N frames") but it must be *counted*,
   * and the read cursor must be clamped, otherwise the consumer would read
   * stale slot contents and believe they are fresh frames — which shows up as
   * a spectrogram that appears to run backwards.
   */
  available(): number {
    const published = this.shared
      ? Atomics.load(this.header, RingHeader.Published)
      : this.header[RingHeader.Published];
    const lag = published - this.readCursor;
    if (lag > this.slots) {
      const lost = lag - this.slots;
      this.header[RingHeader.Overwritten] += lost;
      this.readCursor = published - this.slots;
      return this.slots;
    }
    return Math.max(0, lag);
  }

  /** consumer: copy the oldest unread frame into `out` (must be >= slotFloats) */
  read(out: Float32Array): boolean {
    if (this.available() === 0) return false;
    const slot = this.readCursor % this.slots;
    const off = slot * this.slotFloats;
    out.set(this.body.subarray(off, off + this.slotFloats));
    this.readCursor++;
    return true;
  }

  /** consumer: newest frame, discarding intermediate ones */
  readLatest(out: Float32Array): boolean {
    const published = this.shared
      ? Atomics.load(this.header, RingHeader.Published)
      : this.header[RingHeader.Published];
    const skipped = published - this.readCursor - 1;
    if (skipped > 0) {
      this.header[RingHeader.Overwritten] += skipped;
      this.readCursor = published - 1;
    }
    return this.read(out);
  }

  get overwritten(): number { return this.header[RingHeader.Overwritten]; }
  get dropped(): number { return this.header[RingHeader.ProducerDropped]; }
  get sampleRate(): number { return this.header[RingHeader.SampleRate]; }
  get blockSize(): number { return this.header[RingHeader.BlockSize]; }
  reset(): void {
    this.readCursor = 0;
    this.writeCursor = 0;
  }
}
