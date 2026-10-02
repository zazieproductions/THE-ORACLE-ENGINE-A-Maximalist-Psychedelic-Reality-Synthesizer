/**
 * AudioWorklet global-scope shim.
 *
 * ADR-003: TypeScript's DOM lib does not declare `AudioWorkletProcessor`,
 * `registerProcessor`, `sampleRate` or `currentTime`, and the WebWorker lib
 * (which does) conflicts with the DOM lib the React app needs. Rather than
 * fight the lib matrix, the worklet code addresses the global scope through
 * this one narrow, explicitly-typed interface. That keeps the DSP kernels
 * portable to a plain Node harness for testing (see src/core/dsp/*.test.ts)
 * and confines all "we are in a special thread" knowledge to this file.
 */

export interface WorkletGlobalScope {
  readonly sampleRate: number;
  readonly currentTime: number;
  readonly currentFrame: number;
  registerProcessor(name: string, processorConstructor: unknown): void;
}

export function scope(): WorkletGlobalScope {
  return globalThis as unknown as WorkletGlobalScope;
}

/** Abstract base mirroring the shape of AudioWorkletProcessor. */
export interface WorkletProcessor {
  readonly port: MessagePortLike;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

export interface MessagePortLike {
  postMessage(message: unknown, transfer?: unknown[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}
