/**
 * Analysis client — the render thread's view of the audio.
 *
 * ADR-022: the render thread must never do audio math. This client's only
 * jobs are (a) own the SharedArrayBuffer ring, (b) hand it to the analyzer
 * worklet, and (c) expose a copy-on-read frame. The copy is deliberate:
 * reading straight out of the ring would let a producer overwrite a slot
 * mid-read, and the 4 KB copy is cheaper than the branching required to
 * detect that.
 */

import { SpscRing } from '../../core/ring';
import {
  SLOT_FLOATS, SPECTRUM_BINS, WAVEFORM_LEN, FEATURE_COUNT, FEATURE,
  SLOT_OFFSET_SPECTRUM, SLOT_OFFSET_WAVEFORM, SLOT_OFFSET_FEATURES,
  RING_SLOTS,
} from '../protocol';
import type { TelemetryMsg, WorkletToMainMsg, FrameMsg } from '../protocol';

export interface AudioFrame {
  /** linear magnitudes, 1.0 == full-scale sine */
  readonly spectrum: Float32Array;
  /** mono time-domain ring, oldest first */
  readonly waveform: Float32Array;
  /** scalar feature vector, see FEATURE */
  readonly features: Float32Array;
}

const EMPTY_SPECTRUM = new Float32Array(SPECTRUM_BINS);
const EMPTY_WAVEFORM = new Float32Array(WAVEFORM_LEN);
const EMPTY_FEATURES = new Float32Array(FEATURE_COUNT);

const EMPTY_FRAME: AudioFrame = {
  spectrum: EMPTY_SPECTRUM,
  waveform: EMPTY_WAVEFORM,
  features: EMPTY_FEATURES,
};

export class AnalysisClient {
  readonly ring: SpscRing;
  readonly node: AudioWorkletNode;
  readonly shared: boolean;

  private readonly slot = new Float32Array(SLOT_FLOATS);
  private readonly frame: AudioFrame = {
    spectrum: new Float32Array(SPECTRUM_BINS),
    waveform: new Float32Array(WAVEFORM_LEN),
    features: new Float32Array(FEATURE_COUNT),
  };
  private hasFrame = false;
  private telemetryCb: ((t: TelemetryMsg) => void) | null = null;
  private framesRead = 0;

  constructor(ctx: AudioContext, workletName: string) {
    // `crossOriginIsolated` is not a declared binding, so a bare reference
    // throws a ReferenceError in any environment that lacks it (Node, some
    // embedded webviews, jsdom). `typeof` is the only safe probe.
    const canShare =
      typeof SharedArrayBuffer !== 'undefined' &&
      typeof crossOriginIsolated !== 'undefined' &&
      crossOriginIsolated === true;
    this.ring = SpscRing.create(RING_SLOTS, SLOT_FLOATS, canShare);
    this.shared = this.ring.shared;

    this.node = new AudioWorkletNode(ctx, workletName, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { ringBuffer: this.ring.buffer },
    });

    this.node.port.onmessage = (event: MessageEvent) => {
      const msg = event.data as WorkletToMainMsg;
      if (msg.type === 'telemetry') {
        this.telemetryCb?.(msg);
      } else if (msg.type === 'frame') {
        const frame = (msg as FrameMsg).frame;
        if (frame && frame.length === SLOT_FLOATS) {
          this.slot.set(frame);
          this.commitSlot();
        }
      }
    };
  }

  onTelemetry(cb: ((t: TelemetryMsg) => void) | null): void {
    this.telemetryCb = cb;
  }

  requestTelemetry(): void {
    this.node.port.postMessage({ type: 'telemetryRequest' });
  }

  private commitSlot(): void {
    this.frame.spectrum.set(this.slot.subarray(SLOT_OFFSET_SPECTRUM, SLOT_OFFSET_SPECTRUM + SPECTRUM_BINS));
    this.frame.waveform.set(this.slot.subarray(SLOT_OFFSET_WAVEFORM, SLOT_OFFSET_WAVEFORM + WAVEFORM_LEN));
    this.frame.features.set(this.slot.subarray(SLOT_OFFSET_FEATURES, SLOT_OFFSET_FEATURES + FEATURE_COUNT));
    this.hasFrame = true;
    this.framesRead++;
  }

  /**
   * Pull every frame the producer has written since the last call, leaving
   * `frame` holding the newest. Returns how many were consumed — the visual
   * layer uses that to advance its waterfall by the correct amount.
   */
  poll(): number {
    if (!this.shared) return this.hasFrame ? 1 : 0;
    let count = 0;
    while (this.ring.available() > 0) {
      if (!this.ring.read(this.slot)) break;
      this.commitSlot();
      count++;
    }
    return count;
  }

  get current(): AudioFrame {
    return this.hasFrame ? this.frame : EMPTY_FRAME;
  }

  /** convenience accessors for the hottest features */
  get energy(): number { return this.hasFrame ? this.frame.features[FEATURE.RMS] : 0; }
  get onset(): number { return this.hasFrame ? this.frame.features[FEATURE.ONSET] : 0; }
  get centroid(): number { return this.hasFrame ? this.frame.features[FEATURE.CENTROID] : 0; }

  /** the audio context's sample rate, published by the worklet */
  get sampleRate(): number { return this.ring.sampleRate || 48000; }

  get stats(): { framesRead: number; overwritten: number; dropped: number } {
    return {
      framesRead: this.framesRead,
      overwritten: this.ring.overwritten,
      dropped: this.ring.dropped,
    };
  }

  dispose(): void {
    this.telemetryCb = null;
    this.node.port.onmessage = null;
    this.node.port.close();
    this.node.disconnect();
  }
}
