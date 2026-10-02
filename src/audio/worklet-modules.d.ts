/**
 * Ambient declaration for the Vite plugin's virtual worklet modules.
 * The plugin (`vite-plugin-oracle-worklet.ts`) resolves
 * `<name>.worklet.ts?oracle-worklet` to a module whose default export is
 * the bundled JavaScript *source* of the processor. Keeping the shape
 * declared here means the loader stays fully type-checked.
 */
declare module '*.worklet.ts?oracle-worklet' {
  const source: string;
  /** stable same-origin fallback route, e.g. "__worklets__/oracle-fx.worklet.js" */
  export const route: string;
  export default source;
}
