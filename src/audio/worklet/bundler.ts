/**
 * Shared worklet bundler.
 *
 * Used by the Vite plugin (which injects the result into the app) and by the
 * Node test harness (which executes it against a fake AudioWorklet global
 * scope). Keeping it in one place is what makes the unit tests test the
 * *shipped* code rather than a lookalike.
 */

import { build as esbuild } from 'esbuild';

export interface BundleOptions {
  /** ES version target for the emitted worklet */
  target?: string;
  /** replacement definitions applied at bundle time */
  define?: Record<string, string>;
}

export async function bundleWorkletSource(entry: string, options: BundleOptions = {}): Promise<string> {
  const result = await esbuild({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    target: options.target ?? 'es2020',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
    charset: 'utf8',
    legalComments: 'none',
    define: {
      'process.env.NODE_ENV': '"production"',
      ...(options.define ?? {}),
    },
  });
  const file = result.outputFiles && result.outputFiles[0];
  if (!file) throw new Error(`worklet bundle produced no output for ${entry}`);
  return file.text;
}
