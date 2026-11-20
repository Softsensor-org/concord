// COORD-952 / COORD-670: fail-loud precondition for the coord-ui test dependencies.
//
// The lib tests import typescript and react-dom at module load. Without `npm ci` in
// frontend/apps/coord-ui, Node reports a bare ERR_MODULE_NOT_FOUND that does not say what
// to run. This helper turns the missing dependency into an explicit error that names the
// fix. It never skips: a test file that cannot load its dependencies fails, so the gate
// counts it as a failure, not a pass.

const REQUIRED = [
  ['typescript', 'typescript'],
  ['react', 'react'],
  ['react-dom/server', 'react-dom'],
];

export async function loadCoordUiDeps() {
  const loaded = {};
  for (const [specifier, packageName] of REQUIRED) {
    try {
      loaded[specifier] = await import(specifier);
    } catch (error) {
      if (error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')) {
        throw new Error(
          `coord-ui test dependency "${packageName}" is not installed (required by frontend/apps/coord-ui/lib tests). ` +
          'Run: cd frontend/apps/coord-ui && npm ci',
          { cause: error },
        );
      }
      throw error;
    }
  }
  return {
    ts: loaded['typescript'].default,
    React: loaded['react'].default,
    renderToStaticMarkup: loaded['react-dom/server'].renderToStaticMarkup,
  };
}
