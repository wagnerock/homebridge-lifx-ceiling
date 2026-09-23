// ESLint flat config (v10). Node, CommonJS, no transpiler, no TypeScript.
//
// No `@eslint/js` import: in ESLint 10 that is not a resolvable package from a plugin
// directory, and a config that cannot load is worse than a config with fewer rules. The
// useful subset of `eslint:recommended` is spelled out below instead, so this file works
// with nothing installed but eslint itself.
//
// The bar is deliberate: catch the things that are actually wrong — an unused variable
// where a handler was meant to be wired, a redeclared identity, an unreachable return —
// and stay out of formatting's way. This plugin drives real lights; a wall of style
// complaints is how a linter gets switched off. Everything stylistic is a warn.
//
// Run:  npx eslint@10 .        or, once devDependencies are installed:  npm run lint

export default [
  {
    ignores: ['node_modules/**', 'tools/**', '*.tgz', 'data/**', 'out/**', 'coverage/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        global: 'readonly',
      },
    },
    rules: {
      /* Errors — a defect, or the fingerprint of one. */
      // An unused fixture/service variable has historically meant a handler was bound to
      // an object that then got thrown away: the dead-tile bug, in lint terms.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-undef': 'error',
      'no-const-assign': 'error',
      'no-redeclare': 'error',
      'no-dupe-args': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-class-members': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-func-assign': 'error',
      'no-class-assign': 'error',
      'no-self-assign': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-finally': 'error',
      'no-cond-assign': ['error', 'except-parens'],
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-compare-neg-zero': 'error',
      'no-debugger': 'error',
      'no-invalid-regexp': 'error',
      'no-irregular-whitespace': 'error',
      'no-obj-calls': 'error',
      'no-sparse-arrays': 'error',
      'no-setter-return': 'error',
      'require-yield': 'error',

      /* Warnings — worth seeing, not worth a red badge. */
      // Empty catch with a comment is documentation; this code swallows teardown and
      // diagnostic failures on purpose.
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-fallthrough': 'warn',
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-shadow': ['warn', { builtinGlobals: false }],
      'no-useless-catch': 'warn',
      'no-useless-escape': 'warn',
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'smart'],
      'no-var': 'error',
      'no-console': 'off',
      'no-await-in-loop': 'off',
      'require-atomic-updates': 'off',
    },
  },
  {
    // Tools and tests reach into private APIs (_lifxLanUdp) and fake objects as their
    // documented job — that is the point of those files, not a mistake to flag each run.
    files: ['bin/**/*.js', 'test/**/*.js'],
    rules: {
      'no-underscore-dangle': 'off',
    },
  },
  {
    // Each test block deliberately shadows `plat`, `calls` and `log` to build an isolated
    // harness. Shadowing there is the structure of the suite, not a mistake in it.
    files: ['test/**/*.js'],
    rules: {
      'no-shadow': 'off',
    },
  },
];
