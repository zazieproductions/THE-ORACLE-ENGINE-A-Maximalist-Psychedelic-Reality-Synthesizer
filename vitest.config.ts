import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { bundleWorkletSource } from './src/audio/worklet/bundler';

/**
 * Resolve the `?oracle-worklet` virtual module in tests.
 *
 * ADR-037: the Vite plugin is what makes `*.worklet.ts?oracle-worklet` a real
 * module, so without this resolver any test that imports the engine — or the
 * store that drives it — fails to even collect. Reusing `bundleWorkletSource`
 * keeps the guarantee that a test sees the *same* bundle the browser sees,
 * rather than a hand-written stand-in.
 */
const oracleWorkletResolver = {
  name: 'oracle-worklet-resolve',
  enforce: 'pre' as const,
  resolveId(source: string, importer?: string) {
    if (!source.endsWith('?oracle-worklet')) return null;
    const spec = source.slice(0, -'?oracle-worklet'.length);
    const bases: string[] = [];
    if (importer) bases.push(dirname(importer));
    bases.push(resolve('src/audio'), resolve('src/audio/worklet'));
    for (const base of bases) {
      for (const cand of [resolve(base, spec), resolve(process.cwd(), spec)]) {
        if (existsSync(cand)) return cand;
      }
    }
    return resolve(importer ? dirname(importer) : process.cwd(), spec);
  },
  async load(id: string) {
    if (!id.endsWith('.worklet.ts')) return null;
    const code = await bundleWorkletSource(id);
    const route = `__worklets__/${id.split('/').pop()!.replace(/\.ts$/, '.js')}`;
    return [
      `const source = ${JSON.stringify(code)};`,
      `export const route = ${JSON.stringify(route)};`,
      `export default source;`,
    ].join('\n');
  },
};

export default defineConfig({
  plugins: [oracleWorkletResolver],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // the DSP kernels are pure math and must not need a DOM
    globals: false,
  },
});
