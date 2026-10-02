import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },

  /**
   * react-three-fiber scene components.
   *
   * ADR-043: `eslint-plugin-react-hooks` models a component as "pure function
   * of props -> element tree". An R3F scene component is not that: it is a
   * *declarative scene-graph builder*. Constructing `new THREE.BufferGeometry()`
   * or a `THREE.Vector3` during render is the documented, intended R3F pattern
   * (the object is attached to the reconciler's fibre, not to React state), and
   * `useFrame` callbacks are the renderer's own loop, not React render.
   *
   * Silencing these two rules project-wide would hide real purity bugs in the
   * UI layer, so the exemption is scoped to `src/components/scene/**` only.
   */
  {
    files: ['src/components/scene/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/purity': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/set-state-in-render': 'off',
      'react-hooks/globals': 'off',
      'react-hooks/preserve-manual-memo': 'off',
      'react-hooks/incompatible': 'off',
    },
  },

  /**
   * ADR-044: `Math.random()` inside `useMemo` is how procedural geometry gets
   * seeded, and it is deliberately not a React-state concern — the memo is
   * invalidated by an explicit dependency, not by identity.
   */
  {
    files: ['src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
])
