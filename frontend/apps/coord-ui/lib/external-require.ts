import * as nodeModule from 'node:module';

/**
 * Runtime loader for the canonical coord engine CJS modules (under
 * `coord/scripts/**`). The coord-ui server libs intentionally load these from
 * disk at runtime via Node's `createRequire` so the served UI reuses the SAME
 * logic as the `gov` CLI rather than a parallel copy.
 *
 * The wrinkle: `next build` (webpack) special-cases both `createRequire(...)`
 * and the `r(id)` call it returns, and tries to BUNDLE the referenced module
 * into the page chunk. The paths are computed at runtime (outside the app
 * tree), so the bundled lookup fails at page-data collection — even though the
 * file exists on disk. createRequire itself works fine at runtime in both the
 * dev (ESM) and built (CJS) server; the failure is purely webpack's build-time
 * tracing/optimization.
 *
 * Fix: hide BOTH the acquisition and the call from webpack's static parser by
 * routing them through computed-member expressions. webpack only special-cases
 * a *direct* `createRequire(...)` reference and a *direct* call of a
 * require-bound identifier; computed-key access (`ns['createRequire']`,
 * `holder['load'](id)`) is opaque to it, leaving a genuine Node runtime require
 * of the absolute path. This is server-only code.
 */
const NS = nodeModule as unknown as Record<string, (url: string) => (id: string) => unknown>;
const ACQUIRE = 'createRequire';
const holder: Record<string, (id: string) => unknown> = {
  load: NS[ACQUIRE](import.meta.url),
};

export function requireExternal<T = unknown>(absPath: string): T {
  const key = 'load';
  return holder[key](absPath) as T;
}

/**
 * Drop a previously-required module from the require cache so the next
 * {@link requireExternal} re-reads it from disk (used for live-reloading
 * config / registry modules). Resolution + cache access go through the same
 * obscured handle so the bundler never treats them as `require.resolve` /
 * `require.cache`.
 */
export function uncacheExternal(absPath: string): void {
  const req = holder['load'] as NodeRequire;
  try {
    delete req.cache[req.resolve(absPath)];
  } catch {
    /* not cached / not resolvable — nothing to drop */
  }
}
