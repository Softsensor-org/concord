"use strict";

// COORD-938: shared file-mode rules for integrity comparisons.
//
// gitFileMode is the Git mode rule (100644/100755) used by engine-pin.js
// (COORD-901) and the builder; only the owner execute bit selects the class.
//
// umaskNote explains a raw mode finding that a group-writable umask (umask &
// 0o020, e.g. 0002) produces, so a verify or upgrade report can name the cause
// and the remedy instead of looking like an engine edit. Returns null otherwise.

function gitFileMode(mode) {
  return (mode & 0o100) ? 0o755 : 0o644;
}

// A umask CLEARS bits. Group-write is allowed for new files when the umask does
// NOT clear the group-write bit (0002 is group-writable; 0022 is not).
function isGroupWritableUmask(umask) {
  return Number.isInteger(umask) && (umask & 0o020) === 0;
}

// True when two raw modes differ only in the group-write bit and the process
// umask is group-writable, i.e. the difference is the umask, not a deliberate chmod.
function modeDifferenceIsUmask(before, expected, umask) {
  if (!isGroupWritableUmask(umask)) return false;
  if (before === expected) return false;
  return (before & ~0o020) === (expected & ~0o020);
}

function umaskNote(umask = process.umask()) {
  if (!isGroupWritableUmask(umask)) return null;
  const shown = umask.toString(8).padStart(4, "0");
  return (
    `group-writable umask ${shown} explains this mode difference (new and copied files get the group-write bit). ` +
    "Remedy: run under `umask 0022` (or set it in the shell before `coord upgrade` / install), then re-run verify."
  );
}

module.exports = { gitFileMode, isGroupWritableUmask, modeDifferenceIsUmask, umaskNote };
