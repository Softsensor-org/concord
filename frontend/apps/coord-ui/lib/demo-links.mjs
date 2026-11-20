// COORD-990: the directories a source checkout links into the bundled demo coord
// (examples/demo/coord) so the cockpit can load the engine from COORD_DIR. The
// links are untracked symlinks created by scripts/run-demo.mjs; a release cut
// carries generated copies instead (release/materialize-demo-coord.js).
// lib/demo-links.test.js fails if the cockpit loads an unlinked COORD_DIR module.
export const DEMO_LINKS = Object.freeze([
  Object.freeze({ name: 'scripts', target: '../../../coord/scripts' }),
  Object.freeze({ name: 'engine', target: '../../../coord/engine' }),
]);
