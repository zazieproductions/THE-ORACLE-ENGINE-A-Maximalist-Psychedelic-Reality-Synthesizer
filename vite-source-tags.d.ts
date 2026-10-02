// ADR-049: `.vite-source-tags.js` is an *optional* Vite plugin shipped as a
// dotfile by the Arena workspace generator. It may be absent from a clean
// checkout, so `vite.config.ts` imports it inside a try/catch — which means
// TypeScript still needs a declaration for it. Declaring the one export the
// config uses keeps `tsc -b` green without weakening the optionality.
declare module '*.vite-source-tags.js' {
  import type { Plugin } from 'vite';
  export function sourceTags(): Plugin;
}
