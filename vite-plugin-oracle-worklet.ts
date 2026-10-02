/**
 * ====================================================================
 * ORACLE WORKLET PLUGIN
 * ====================================================================
 *
 * Turns `*.worklet.ts` sources into self-contained JavaScript *strings*
 * that the app loads into the AudioWorklet global scope.
 *
 * ADR-019: why not Vite's `?worker&url`?
 *   - it depends on `worker.format` being compatible with `addModule`,
 *   - it emits into a hashed chunk whose URL is only knowable after the
 *     build, and
 *   - in dev it round-trips through the transform middleware, which makes
 *     the AudioWorklet's fetch path an extra failure mode.
 * Bundling with esbuild and injecting the result as a Blob module is
 * deterministic, works identically in dev and prod, adds no network request,
 * and lets the worklet import the *same* TypeScript DSP kernels the unit
 * tests exercise — which is the whole point.
 *
 * A secondary route is also exposed so the bundle can be fetched from a
 * stable same-origin URL if `blob:` module loading is ever blocked:
 *   dev     -> GET /__oracle_worklet__/<name>.js   (middleware)
 *   build   -> public/__worklets__/<name>.js       (emitted, copied verbatim)
 */

import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { bundleWorkletSource } from './src/audio/worklet/bundler';

const QUERY = '?oracle-worklet';
const VIRTUAL_PREFIX = '\0oracle-worklet:';
const ROUTE = '/__oracle_worklet__/';
const OUT_DIR = 'public/__worklets__';

interface Bundle {
  /** module basename without query, e.g. "oracle-fx.worklet.ts" */
  name: string;
  /** public route, e.g. "__worklets__/oracle-fx.worklet.js" */
  route: string;
  code: string;
}

function listWorkletFiles(root: string): string[] {
  const dir = resolve(root, 'src/audio/worklet');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.worklet.ts'))
    .map((f) => join(dir, f));
}

const bundleFile = (entry: string): Promise<string> => bundleWorkletSource(entry);

function routeFor(entry: string, root: string): string {
  const dir = resolve(root, 'src/audio/worklet');
  return `__worklets__/${relative(dir, entry).replace(/\.ts$/, '.js')}`;
}

/**
 * Resolve a `?oracle-worklet` specifier to a canonical absolute entry path.
 *
 * ADR-036: the naive `resolve(dirname(importer), spec)` is not enough.
 *   - in dev, Vite hands the plugin an importer that is itself root-relative
 *     (`/src/audio/workletLoader.ts`), so the specifier resolves to `/src/…`
 *     which is a *filesystem* absolute path outside the project;
 *   - Vite may prefix the importer with `/@fs/` when the module lives outside
 *     the root;
 *   - the specifier itself can be root-relative, `./`-relative, or bare.
 * Rather than guess, we try every plausible base and pick the one that
 * actually exists on disk. The result is always canonicalised, so the same
 * worklet can never be loaded twice under two different ids.
 */
function resolveWorkletEntry(spec: string, root: string, importer?: string): string {
  const cleaned = spec.replace(/^(?:\/)?(?:@fs|@id)\//, '').replace(/^\/src\//, 'src/');
  const bases: string[] = [];
  if (importer) {
    const dir = dirname(importer.replace(/^(?:\/)?(?:@fs|@id)\//, ''));
    bases.push(dir);
    bases.push(join(root, dir));
  }
  bases.push(root, resolve(root, 'src/audio'), resolve(root, 'src/audio/worklet'));

  const tried: string[] = [];
  for (const base of bases) {
    for (const candidate of [resolve(base, cleaned), resolve(base, resolve(root, cleaned))]) {
      if (candidate.endsWith('.worklet.ts') && existsSync(candidate)) return candidate;
      tried.push(candidate);
    }
    if (isAbsolute(cleaned)) break;
  }
  // nothing on disk matched — return the most plausible id so the error names it
  return tried[0] ?? resolve(root, cleaned);
}

export function oracleWorklet(): Plugin {
  const bundles = new Map<string, Bundle>();
  let root = process.cwd();

  const buildAll = async (): Promise<void> => {
    bundles.clear();
    for (const entry of listWorkletFiles(root)) {
      const code = await bundleFile(entry);
      bundles.set(entry, { name: entry, route: routeFor(entry, root), code });
    }
    // materialise the fallback copies for the production build
    const outDir = resolve(root, OUT_DIR);
    mkdirSync(outDir, { recursive: true });
    for (const b of bundles.values()) {
      writeFileSync(join(outDir, b.route.slice('__worklets__/'.length)), b.code);
    }
  };

  return {
    name: 'oracle-worklet-inline',
    enforce: 'pre',

    configResolved(config) {
      root = config.root;
    },

    async buildStart() {
      await buildAll();
    },

    resolveId(source: string, importer?: string) {
      if (!source.endsWith(QUERY)) return null;
      return VIRTUAL_PREFIX + resolveWorkletEntry(source.slice(0, -QUERY.length), root, importer);
    },

    async load(id: string) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;
      const entry = id.slice(VIRTUAL_PREFIX.length);
      let bundle = bundles.get(entry);
      if (!bundle) {
        bundle = { name: entry, route: routeFor(entry, root), code: await bundleFile(entry) };
        bundles.set(entry, bundle);
      }
      this.addWatchFile(entry);
      // The module exports the source as a string. It is *not* imported by
      // anything at runtime except the worklet loader, so tree-shaking the
      // default export away would silently break audio — hence the marker.
      return [
        `const source = ${JSON.stringify(bundle.code)};`,
        `export const route = ${JSON.stringify(bundle.route)};`,
        `export default source;`,
      ].join('\n');
    },

    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || '';
        if (!url.startsWith(ROUTE)) { next(); return; }
        const name = decodeURIComponent(url.slice(ROUTE.length).split('?')[0]);
        const entry = resolveWorkletEntry(name.replace(/\.js$/, '.ts'), root);
        void bundleFile(entry)
          .then((code) => {
            res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(code);
          })
          .catch((err: unknown) => {
            res.statusCode = 500;
            res.end(String(err));
          });
      });
    },

    handleHotUpdate(ctx) {
      const rel = relative(root, ctx.file);
      // any change inside the worklet or DSP sources invalidates the bundles;
      // a full reload is the honest response — an audio engine cannot be
      // hot-swapped mid-render without risking torn voice state.
      if (rel.includes('src/audio/worklet') || rel.includes('src/core/dsp')) {
        ctx.server.ws.send({ type: 'full-reload' });
      }
    },
  };
}
