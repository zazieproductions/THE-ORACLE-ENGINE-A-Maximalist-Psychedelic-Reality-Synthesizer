/**
 * Worklet module loader.
 *
 * ADR-020: `AudioWorkletGlobalScope.registerProcessor` must be reached from
 * a module whose URL the browser can fetch. We prefer a `blob:` module built
 * from the esbuild bundle the Vite plugin inlines (no request, no CORS, no
 * hashed-chunk indirection) and fall back to the stable same-origin route
 * the plugin also materialises. Both paths are tried before we declare the
 * engine unusable, and the failure reason is surfaced to the UI rather than
 * swallowed.
 */

import synthSource, { route as synthRoute } from './worklet/oracle-synth.worklet.ts?oracle-worklet';
import fxSource, { route as fxRoute } from './worklet/oracle-fx.worklet.ts?oracle-worklet';
import analyzerSource, { route as analyzerRoute } from './worklet/oracle-analyzer.worklet.ts?oracle-worklet';

export type WorkletName = 'oracle-synth' | 'oracle-fx' | 'oracle-analyzer';

interface WorkletEntry {
  source: string;
  route: string;
  url: string | null;
}

const ENTRIES: Record<WorkletName, WorkletEntry> = {
  'oracle-synth': { source: synthSource, route: synthRoute, url: null },
  'oracle-fx': { source: fxSource, route: fxRoute, url: null },
  'oracle-analyzer': { source: analyzerSource, route: analyzerRoute, url: null },
};

export interface LoadResult {
  ok: boolean;
  /** how the module was finally loaded */
  strategy: 'blob' | 'route' | 'none';
  error?: string;
}

function blobUrl(source: string): string {
  const blob = new Blob([source], { type: 'text/javascript; charset=utf-8' });
  return URL.createObjectURL(blob);
}

function baseUrl(): string {
  const b = import.meta.env.BASE_URL || '/';
  return b.endsWith('/') ? b : `${b}/`;
}

/**
 * Load every processor module into the context. Idempotent per context:
 * calling twice is a no-op because the entries remember their URLs and
 * `addModule` on an already-registered name is harmless.
 */
export async function loadWorklets(ctx: AudioContext): Promise<LoadResult> {
  if (!ctx.audioWorklet) {
    return { ok: false, strategy: 'none', error: 'AudioWorklet is not available in this browser' };
  }
  let lastError: unknown = null;
  let usedBlob = false;

  for (const name of Object.keys(ENTRIES) as WorkletName[]) {
    const entry = ENTRIES[name];
    if (entry.url) continue;

    const blob = blobUrl(entry.source);
    try {
      await ctx.audioWorklet.addModule(blob, { credentials: 'omit' });
      entry.url = blob;
      usedBlob = true;
      continue;
    } catch (err) {
      lastError = err;
    }
    // blob: rejected (strict CSP). Try the stable same-origin route.
    try {
      const url = `${baseUrl()}${entry.route}`;
      await ctx.audioWorklet.addModule(url, { credentials: 'omit' });
      entry.url = url;
    } catch (err2) {
      lastError = err2;
      return {
        ok: false,
        strategy: 'none',
        error: `failed to load worklet "${name}": ${String(err2)} (first attempt: ${String(lastError)})`,
      };
    }
  }

  return { ok: true, strategy: usedBlob ? 'blob' : 'route', error: lastError ? String(lastError) : undefined };
}

/** release the blob URLs — only safe after the context is closed */
export function disposeWorklets(): void {
  for (const entry of Object.values(ENTRIES)) {
    if (entry.url && entry.url.startsWith('blob:')) URL.revokeObjectURL(entry.url);
    entry.url = null;
  }
}

export function workletRoutes(): Record<WorkletName, string> {
  const out = {} as Record<WorkletName, string>;
  for (const [k, v] of Object.entries(ENTRIES)) {
    out[k as WorkletName] = `${baseUrl()}${v.route}`;
  }
  return out;
}
