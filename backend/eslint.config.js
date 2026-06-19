"use strict";
// ESLint flat config (BE-001 / QUALITY-001).
//
// Every repo generated from this template inherits lint enforcement by default.
// This is a deliberately low-friction baseline: the ESLint-recommended rule set
// plus a few Node-hygiene rules, with formatting delegated entirely to Prettier
// (see .prettierrc.json). The gate runner (scripts/gate.sh) runs `npm run lint`
// and `npm run format:check` on the full/ci lanes; a derived project tightens
// these rules as its codebase matures.
//
// Flat config (eslint.config.js) is the modern, version-9+ default. Requires
// devDependencies: eslint, @eslint/js (declared in package.json). Until deps are
// installed the gate step skips-with-note rather than failing.

const js = require("@eslint/js");

module.exports = [
  {
    ignores: ["node_modules/**", "artifacts/**", "coverage/**"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js", "tests/**/*.js", "*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: {
        // Node.js runtime globals used by the zero-dependency skeleton.
        process: "readonly",
        module: "writable",
        require: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: {
      // Catch the drift this gate exists to prevent. Allow an underscore prefix
      // for intentionally-unused args (the skeleton uses `_req`, `_request`).
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
];
