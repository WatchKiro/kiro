// Root ESLint config: lints repository-level files only. Every workspace in
// apps/* and packages/* has its own eslint.config.js built from @kiro/config.
import { base } from '@kiro/config/eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig(
  globalIgnores(['apps/', 'packages/', '.claude/']),
  base({ tsconfigRootDir: import.meta.dirname }),
);
