import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  // The backend, the scripts and the audits are .mjs, and until this block
  // existed the gate applied no rule to any of them: an undefined identifier
  // in backend/ passed, and so did one in the scripts that decide whether
  // everything else is correct (#64). Node globals; an audit that runs code
  // inside the browser names the browser globals it uses at the top of the
  // file, so a browser name reached from Node by mistake is still caught.
  {
    files: ['**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
])
