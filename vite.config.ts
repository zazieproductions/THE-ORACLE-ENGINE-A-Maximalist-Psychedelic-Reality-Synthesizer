import { defineConfig, loadEnv, type UserConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { oracleWorklet } from './vite-plugin-oracle-worklet'

// https://vite.dev/config/
export default defineConfig(async ({ mode }): Promise<UserConfig> => {
  const plugins = [react(), tailwindcss(), oracleWorklet()];
  try {
    // optional source-map tagging helper; absent in a clean checkout
    const m = await import('./.vite-source-tags.js');
    plugins.push(m.sourceTags());
  } catch {
    // the helper is optional — nothing to do when it is not installed
  }

  const env = loadEnv(mode, process.cwd(), ['VITE_', 'NEXT_PUBLIC_']);
  const processEnvDefines: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    processEnvDefines[`process.env.${key}`] = JSON.stringify(value);
  }

  return {
    plugins,
    envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
    define: processEnvDefines,
    worker: {
      // the worklet bundles are ES modules; keep the same shape in dev
      format: 'es' as const,
    },
    server: {
      host: true,
      // the preview host is a reverse proxy in front of this dev server, so
      // its Host header will never match a local pattern. Vite's host-check
      // is a DNS-rebinding guard for local dev only; the engine has no
      // same-origin-only backend to protect, so an open allowlist is correct
      // here (and required for the Arena preview to load at all).
      allowedHosts: true,
      port: 5173,
      headers: {
        // ADR-027: `credentialless` rather than `require-corp` for COEP.
        // require-corp would block the cross-origin rrweb recording script
        // that the host page injects, while credentialless grants
        // SharedArrayBuffer (and therefore the zero-copy analysis ring)
        // without breaking it. Browsers that do not understand
        // `credentialless` simply ignore it and the engine falls back to
        // the postMessage transport.
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      },
    },
    preview: {
      host: true,
      allowedHosts: true,
      port: 4173,
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      },
    },
    build: {
      target: 'es2022',
      sourcemap: false,
    },
  };
})
