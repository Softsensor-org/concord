"use strict";

// COORD-635 / ADR-0008 — the three explicit roots of an adopter workspace.
//
// Before this module the engine had exactly one name for "up one level from
// coord/" (`ROOT_DIR` / `path.dirname(COORD_DIR)`) and used it for two
// unrelated jobs: locating sibling PRODUCT repositories, and running
// CONTROL-PLANE git. Under ADR-0008 those are different directories, so the
// second job was resolving against the wrong repository.
//
// The three concepts, named once:
//
//   workspaceRoot   the container that holds coord/ and the sibling product
//                   repositories. Under ADR-0008 it is NEVER a Git repository
//                   in an adopter workspace. Product-repo resolution keeps
//                   using it; control-plane Git must never touch it.
//   coordDir        the coord/ governance directory itself (COORD_DIR).
//   coordRepoRoot   the Git repository that OWNS control-plane content. This
//                   is the only root a Repo-X git operation may use.
//
// coordRepoRoot is DERIVED, never configured, so the donor and an adopter
// resolve by the same rule instead of by a hand-maintained list:
//
//   coord/.git exists                  -> coordRepoRoot = coordDir      ("coord_repository")
//   toplevel-from-coord == workspaceRoot -> coordRepoRoot = workspaceRoot ("ancestor_repository")
//   toplevel-from-coord is higher up   -> coordRepoRoot = null          ("foreign_ancestor")
//   coord/ is not in any repository    -> coordRepoRoot = null          ("none")
//
// The `foreign_ancestor` case is the important hardening. An adopter workspace
// under some unrelated enclosing repository (a home directory that happens to
// be versioned, a monorepo checkout) would otherwise make `rev-parse
// --show-toplevel` hand back a repository that has nothing to do with
// governance — precisely the "resolved against the wrong repository" defect
// this ticket exists to remove. We refuse it rather than adopt it.
//
// `coordPathPrefix` reconciles the two path namespaces that COORD-635 defect
// (5) is about: the coord repository reports changes relative to
// coordRepoRoot (`scripts/worktree-ops.js` in an adopter, where the prefix is
// ""), while the engine manifest names the same file relative to the
// workspace (`coord/scripts/worktree-ops.js`). Translation is explicit and
// bidirectional; nothing infers it from a leading-"coord/" string test.

const fs = require("fs");
const path = require("path");
const { gitTry: defaultGitTry } = require("./git-ops.js");

const CONTROL_PLANE_TOPOLOGY = Object.freeze({
  COORD_REPOSITORY: "coord_repository",
  ANCESTOR_REPOSITORY: "ancestor_repository",
  FOREIGN_ANCESTOR: "foreign_ancestor",
  NONE: "none",
});

const DEFAULT_CONTROL_PLANE_BRANCH = "main";

function toPosix(value) {
  return String(value || "").split(path.sep).join("/");
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Pure over an injected gitTry so it is unit-testable without a real repo.
function resolveControlPlaneLayout(options = {}) {
  if (!options.coordDir) {
    throw new Error("resolveControlPlaneLayout requires a coordDir.");
  }
  const coordDir = path.resolve(options.coordDir);
  const workspaceRoot = path.resolve(options.workspaceRoot || path.dirname(coordDir));
  const git = typeof options.gitTry === "function" ? options.gitTry : defaultGitTry;

  let coordRepoRoot = null;
  let topology = CONTROL_PLANE_TOPOLOGY.NONE;
  let foreignRoot = null;

  if (fs.existsSync(path.join(coordDir, ".git"))) {
    coordRepoRoot = coordDir;
    topology = CONTROL_PLANE_TOPOLOGY.COORD_REPOSITORY;
  } else {
    let probe = null;
    try {
      // Pinned with an explicit directory: a subprocess that inherits the
      // wrong cwd resolves the wrong repository (COORD-631).
      probe = git(coordDir, ["rev-parse", "--show-toplevel"]);
    } catch {
      probe = null;
    }
    const top = probe && probe.status === 0 ? String(probe.stdout || "").trim() : "";
    if (top) {
      const resolvedTop = path.resolve(top);
      if (resolvedTop === coordDir) {
        coordRepoRoot = coordDir;
        topology = CONTROL_PLANE_TOPOLOGY.COORD_REPOSITORY;
      } else if (resolvedTop === workspaceRoot) {
        // The donor layout: coord/ is a subdirectory of its own repository.
        coordRepoRoot = workspaceRoot;
        topology = CONTROL_PLANE_TOPOLOGY.ANCESTOR_REPOSITORY;
      } else {
        foreignRoot = resolvedTop;
        topology = CONTROL_PLANE_TOPOLOGY.FOREIGN_ANCESTOR;
      }
    }
  }

  const coordPathPrefix = coordRepoRoot ? toPosix(path.relative(coordRepoRoot, coordDir)) : null;

  return Object.freeze({
    workspaceRoot,
    coordDir,
    coordRepoRoot,
    coordPathPrefix,
    topology,
    foreign_root: foreignRoot,
    has_control_plane_repository: Boolean(coordRepoRoot),
  });
}

function describeControlPlaneTopology(layout) {
  if (!layout) {
    return "control-plane layout is unresolved";
  }
  switch (layout.topology) {
    case CONTROL_PLANE_TOPOLOGY.COORD_REPOSITORY:
      return `coord/ is the control-plane repository (${layout.coordRepoRoot})`;
    case CONTROL_PLANE_TOPOLOGY.ANCESTOR_REPOSITORY:
      return `coord/ is versioned by the workspace repository (${layout.coordRepoRoot}) — the donor layout`;
    case CONTROL_PLANE_TOPOLOGY.FOREIGN_ANCESTOR:
      return (
        `coord/ sits inside an unrelated enclosing Git repository (${layout.foreign_root}) ` +
        "which is NOT the workspace container and is refused as a control-plane repository"
      );
    default:
      return `coord/ (${layout.coordDir}) is not inside any Git repository`;
  }
}

// The single refusal used by every control-plane git verb, so the operator
// gets one message and one remediation instead of a per-callsite dialect.
function controlPlaneRepoUnavailableMessage(layout, action) {
  const what = action ? `${action} requires` : "Control-plane Git operations require";
  const lines = [
    `${what} a control-plane Git repository, but ${describeControlPlaneTopology(layout)}.`,
  ];
  if (layout && layout.topology === CONTROL_PLANE_TOPOLOGY.FOREIGN_ANCESTOR) {
    lines.push(
      "ADR-0008: control-plane Git resolves ONLY to coord/. Initialize the control-plane repository " +
      `explicitly (git -C ${layout.coordDir} init) so ownership is unambiguous; ` +
      "do not adopt the enclosing repository, and never initialize the workspace container."
    );
  } else if (layout) {
    lines.push(
      `Initialize the control-plane repository with the installer's consented bootstrap ` +
      `(npx create-concord <dir> --git-init, or the equivalent SEA flag), or manually: git -C ${layout.coordDir} init. ` +
      "The workspace container above coord/ is never a Git repository (ADR-0008)."
    );
  }
  return lines.join("\n");
}

function requireCoordRepoRoot(layout, fail, action) {
  if (layout && layout.coordRepoRoot) {
    return layout.coordRepoRoot;
  }
  const message = controlPlaneRepoUnavailableMessage(layout, action);
  if (typeof fail === "function") {
    fail(message);
  }
  throw new Error(message);
}

// The engine MANIFEST namespace is fixed: it always names control-plane files
// as "<coord-dir-name>/<path-under-coord>" (e.g. "coord/scripts/worktree-ops.js",
// "coord/engine-pin.json"), regardless of which directory owns the .git. The
// COORD REPOSITORY namespace, by contrast, depends on the topology:
//
//   donor    (coordRepoRoot = workspace, prefix "coord")
//              git reports "coord/scripts/worktree-ops.js"  — already manifest-shaped
//   adopter  (coordRepoRoot = coordDir,  prefix "")
//              git reports "scripts/worktree-ops.js"        — needs the coord/ prefix
//
// COORD-635 defect (5) is exactly that second row: without translation, an
// engine-integrity check comparing git output against manifest paths silently
// matches nothing in the adopter topology, so a control-plane engine change is
// never attributed and the integrity gate never fires.
function manifestCoordPrefix(layout) {
  return toPosix(path.basename(layout.coordDir));
}

// coord-repo-relative -> manifest path. Returns null for a path outside coord/,
// which in the donor layout is a real and normal case (a change to
// create-concord/ is not control-plane content).
function manifestPathForCoordRepoPath(layout, repoRelativePath) {
  const rel = toPosix(String(repoRelativePath || "").trim()).replace(/^\.\//, "");
  if (!rel || !layout || !layout.coordRepoRoot) {
    return null;
  }
  const manifestPrefix = manifestCoordPrefix(layout);
  const prefix = layout.coordPathPrefix;
  let underCoord;
  if (!prefix) {
    // coordRepoRoot === coordDir: every repo path is already coord-relative.
    underCoord = rel;
  } else if (rel === prefix) {
    underCoord = "";
  } else if (rel.startsWith(`${prefix}/`)) {
    underCoord = rel.slice(prefix.length + 1);
  } else {
    return null; // outside coord/ — not control-plane content
  }
  return underCoord ? `${manifestPrefix}/${underCoord}` : manifestPrefix;
}

// manifest path -> coord-repo-relative. Returns null when the manifest path is
// not inside this layout's coord directory.
function coordRepoPathForManifestPath(layout, manifestPath) {
  const rel = toPosix(String(manifestPath || "").trim()).replace(/^\.\//, "");
  if (!rel || !layout || !layout.coordRepoRoot) {
    return null;
  }
  const manifestPrefix = manifestCoordPrefix(layout);
  let underCoord;
  if (rel === manifestPrefix) {
    underCoord = "";
  } else if (rel.startsWith(`${manifestPrefix}/`)) {
    underCoord = rel.slice(manifestPrefix.length + 1);
  } else {
    return null;
  }
  const prefix = layout.coordPathPrefix;
  if (!prefix) {
    return underCoord;
  }
  return underCoord ? `${prefix}/${underCoord}` : prefix;
}

// A worktree OF the control-plane repository mirrors coordRepoRoot, not the
// workspace. In an adopter (prefix "") governance lives at <worktree>/...;
// in the donor (prefix "coord") it lives at <worktree>/coord/... . COORD-635
// defect (3): the old code hardcoded the donor shape.
function coordWorktreeCoordDir(layout, worktree) {
  const base = path.resolve(worktree);
  const prefix = layout && layout.coordPathPrefix ? layout.coordPathPrefix : "";
  return prefix ? path.join(base, ...prefix.split("/")) : base;
}

function coordWorktreeRuntimeDir(layout, worktree) {
  return path.join(coordWorktreeCoordDir(layout, worktree), ".runtime");
}

// COORD-635: what counts as "dirty"/"worked" in a governed worktree.
//
// Tracked modifications AND untracked new files both count — they are work.
// The ONE exclusion is the engine's own ephemeral runtime scaffolding, which
// `ensureCoordWorktreeRuntime` writes into every control-plane worktree at
// CREATION time. Depending on the adopter's .gitignore that scaffolding can
// surface as untracked, and counting it as work turns two guards into blanket
// refusals: cleanup would refuse every control-plane worktree, and `gov unstart`
// would refuse an untouched wrong start. The directory carries no authority —
// its own runtime-role.json declares `authority: non_authoritative_until_landed`
// (ADR-0002, canonical/ephemeral boundary).
//
// Single-sourced here so the cleanup guard and the unstart residue guard cannot
// drift apart on what "work" means.
function significantWorktreeStatusEntries(layout, worktree, porcelain) {
  const runtimeRel = toPosix(path.relative(
    path.resolve(worktree),
    coordWorktreeRuntimeDir(layout, worktree)
  ));
  return String(porcelain || "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => {
      // porcelain v1: XY<space>path (path may be quoted, or a "old -> new" rename pair).
      const filePath = line.slice(3).replace(/^"|"$/g, "").split(" -> ").pop();
      return !(runtimeRel && (filePath === runtimeRel || filePath.startsWith(`${runtimeRel}/`)));
    });
}

// The control-plane integration branch. Derived, not hand-maintained:
// an explicit config value wins, then the repository's own published default
// (origin/HEAD), then the canonical checkout's current branch, then the
// engine default. Deriving it means an adopter whose control plane lives on
// `main` and a donor on `dev` both work without a config edit.
function resolveControlPlaneIntegrationBranch(layout, options = {}) {
  const configured = String(options.configuredBranch || "").trim();
  if (configured) {
    return configured;
  }
  const coordRepoRoot = layout && layout.coordRepoRoot;
  if (!coordRepoRoot) {
    return String(options.fallback || DEFAULT_CONTROL_PLANE_BRANCH);
  }
  const git = typeof options.gitTry === "function" ? options.gitTry : defaultGitTry;
  const originHead = git(coordRepoRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead && originHead.status === 0) {
    const value = String(originHead.stdout || "").trim().replace(/^origin\//, "");
    if (value) {
      return value;
    }
  }
  const current = git(coordRepoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current && current.status === 0) {
    const value = String(current.stdout || "").trim();
    if (value && value !== "HEAD") {
      return value;
    }
  }
  return String(options.fallback || DEFAULT_CONTROL_PLANE_BRANCH);
}

// Memoized default layout for the running engine. Lazily requires
// governance-context so this module stays loadable from anywhere (and so a
// require cycle cannot form at load time).
let cachedLayout = null;

function defaultControlPlaneLayout() {
  if (cachedLayout) {
    return cachedLayout;
  }
  // eslint-disable-next-line global-require
  const { COORD_DIR, ROOT_DIR } = require("./governance-context.js");
  cachedLayout = resolveControlPlaneLayout({ coordDir: COORD_DIR, workspaceRoot: ROOT_DIR });
  return cachedLayout;
}

module.exports = {
  CONTROL_PLANE_TOPOLOGY,
  DEFAULT_CONTROL_PLANE_BRANCH,
  resolveControlPlaneLayout,
  defaultControlPlaneLayout,
  describeControlPlaneTopology,
  controlPlaneRepoUnavailableMessage,
  requireCoordRepoRoot,
  manifestPathForCoordRepoPath,
  coordRepoPathForManifestPath,
  coordWorktreeCoordDir,
  coordWorktreeRuntimeDir,
  significantWorktreeStatusEntries,
  resolveControlPlaneIntegrationBranch,
  __testing: {
    reset() {
      cachedLayout = null;
    },
    override(layout) {
      cachedLayout = layout;
    },
  },
};
