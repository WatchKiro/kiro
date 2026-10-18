// Shared ESLint flat-config presets.
//
// Each preset is a function so the consuming workspace can pass its own
// `tsconfigRootDir` (required for type-aware linting) and then append its own
// overrides:
//
//   export default defineConfig(react({ tsconfigRootDir: import.meta.dirname }), { rules: {} });

import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * @typedef {object} PresetOptions
 * @property {string} tsconfigRootDir Directory containing the workspace tsconfig.json.
 */

const ignores = globalIgnores([
  '**/node_modules/**',
  '**/dist/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/coverage/**',
  '**/src-tauri/**',
  // Sources downloaded by apps/desktop/scripts/build-libmpv.sh and
  // build-libmpv-windows.sh.
  '**/.libmpv/**',
  '**/.libmpv-windows/**',
  '**/next-env.d.ts',
]);

/**
 * Environment-neutral TypeScript rules. Suitable for shared packages that must
 * not assume a browser or Node.js runtime.
 *
 * @param {PresetOptions & { neutral?: boolean }} options
 *   `neutral: true` forbids Node.js built-in imports outside test files, for
 *   packages that must run in Node, browsers and the Tauri webview alike.
 */
export function base({ tsconfigRootDir, neutral = false }) {
  return defineConfig(
    ignores,
    js.configs.recommended,
    tseslint.configs.recommendedTypeChecked,
    {
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      linterOptions: { reportUnusedDisableDirectives: 'error' },
      rules: {
        eqeqeq: ['error', 'smart'],
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { fixStyle: 'inline-type-imports' },
        ],
        '@typescript-eslint/no-import-type-side-effects': 'error',
        '@typescript-eslint/no-floating-promises': [
          'error',
          {
            // node:test's describe()/it() return promises the runner tracks itself.
            allowForKnownSafeCalls: [
              { from: 'package', package: 'node:test', name: ['describe', 'it', 'test', 'suite'] },
            ],
          },
        ],
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
      },
    },
    neutral
      ? {
          files: ['src/**/*.ts'],
          ignores: ['src/**/*.test.ts'],
          rules: {
            'no-restricted-imports': [
              'error',
              {
                patterns: [
                  { group: ['node:*'], message: 'This package must stay runtime-neutral.' },
                ],
              },
            ],
          },
        }
      : {},
    {
      // Plain JS files (configs, scripts) are not part of a TS project.
      files: ['**/*.{js,mjs,cjs}'],
      extends: [tseslint.configs.disableTypeChecked],
      languageOptions: { globals: globals.node },
    },
  );
}

/**
 * Node.js services and tooling.
 *
 * @param {PresetOptions} options
 */
export function node(options) {
  return defineConfig(base(options), {
    languageOptions: { globals: globals.node },
  });
}

/**
 * React code rendered in a browser-like environment (Vite, Tauri webview).
 *
 * @param {PresetOptions & { vite?: boolean }} options
 */
export function react({ vite = false, ...options }) {
  return defineConfig(base(options), {
    files: ['**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, ...(vite ? [reactRefresh.configs.vite] : [])],
    languageOptions: { globals: globals.browser },
  });
}

/**
 * Next.js App Router applications.
 *
 * @param {PresetOptions} options
 */
export function next(options) {
  return defineConfig(react(options), {
    files: ['**/*.{ts,tsx}'],
    extends: [nextPlugin.configs['core-web-vitals']],
  });
}
