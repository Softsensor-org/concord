"use strict";
// ESLint flat config (FE-001 / QUALITY-001).
//
// Every repo generated from this template inherits lint enforcement by default.
// The frontend skeleton ships framework-agnostic JS seams under `src/` (zero
// dependency, `node --test`); a derived project mounts these under its renderer
// (Next/Vite/...). This config therefore lints the JS seams with the
// ESLint-recommended set and ALSO carries an opt-in TypeScript block so the
// derived project's `.ts`/`.tsx` sources are covered the moment it adds
// typescript-eslint — without re-wiring the gate.
//
// Formatting is delegated entirely to Prettier (see .prettierrc.json). The gate
// runner (scripts/gate.sh) runs `npm run lint` + `npm run format:check` on the
// full/ci lanes and skips-with-note until devDependencies are installed.
//
// Requires devDependencies: eslint, @eslint/js (declared in package.json).
// typescript-eslint is OPTIONAL — loaded lazily so the JS baseline works with
// the minimal dependency set; add it to lint .ts/.tsx in a derived project.

const js = require("@eslint/js");

// Shared rule baseline (kept identical to the backend skeleton on purpose so a
// generated monorepo gets one consistent low-friction standard).
const baseRules = {
  "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
  "no-console": "off",
  eqeqeq: ["error", "smart"],
  "no-var": "error",
  "prefer-const": "error",
};

// Browser + Node globals: the seams run under `node --test`, the derived UI runs
// in the browser. Declaring both keeps the skeleton lintable in either home.
const sharedGlobals = {
  process: "readonly",
  module: "writable",
  require: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  console: "readonly",
  window: "readonly",
  document: "readonly",
  fetch: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
};

const config = [
  {
    ignores: [
      "node_modules/**",
      "artifacts/**",
      "coverage/**",
      // The coord-ui reference app keeps its own typecheck lint (tsc) and build
      // output; it is not part of the framework-agnostic skeleton this config
      // governs. A derived project that adopts a single app removes this ignore.
      "apps/**",
      "**/.next/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js", "tests/**/*.js", "*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: sharedGlobals,
    },
    rules: baseRules,
  },
];

// Opt-in TypeScript coverage: only active if typescript-eslint is installed.
// This keeps the minimal JS-only dependency set working while giving derived
// TS projects lint coverage of .ts/.tsx with zero gate changes.
try {
  const tseslint = require("typescript-eslint");
  config.push(...tseslint.configs.recommended, {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: sharedGlobals,
    },
    rules: baseRules,
  });
} catch {
  // typescript-eslint not installed — JS-only baseline. A derived project that
  // wants .ts/.tsx linting adds typescript-eslint to devDependencies.
}

module.exports = config;
