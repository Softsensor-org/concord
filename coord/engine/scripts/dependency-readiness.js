"use strict";

function createDependencyReadiness(deps) {
  const {
    STATUS,
    allowsFollowupDependencyReadinessException,
    dedupeDependencyChains,
    splitDependsOn,
  } = deps;

  function traceDependencyReadiness(currentRow, depId, byId, board, path = []) {
    const dep = byId.get(depId);
    if (!dep) {
      return {
        blocked: false,
        blockerChains: [],
        cycles: [],
        transitiveBlockedBy: [],
      };
    }
    if (allowsFollowupDependencyReadinessException({ board, row: currentRow, depId, dep })) {
      return {
        blocked: false,
        blockerChains: [],
        cycles: [],
        transitiveBlockedBy: [],
      };
    }
    if (path.includes(depId)) {
      const cycleStart = path.indexOf(depId);
      return {
        blocked: true,
        blockerChains: [],
        cycles: [path.slice(cycleStart).concat(depId)],
        transitiveBlockedBy: [depId],
      };
    }
    if (dep.Status === STATUS.DONE) {
      return {
        blocked: false,
        blockerChains: [],
        cycles: [],
        transitiveBlockedBy: [],
      };
    }

    const transitiveBlockedBy = new Set([depId]);
    const blockerChains = [];
    const cycles = [];
    const nextPath = [...path, depId];
    for (const nestedDepId of splitDependsOn(dep["Depends On"])) {
      // This recursive function always returns all three arrays. Keeping them
      // explicit here documents the actual contract instead of masking a
      // malformed/impossible partial result from a local self-recursive call.
      const nested = traceDependencyReadiness(dep, nestedDepId, byId, board, nextPath);
      for (const blockedId of nested.transitiveBlockedBy) {
        transitiveBlockedBy.add(blockedId);
      }
      cycles.push(...nested.cycles);
      if (nested.blocked && nested.blockerChains.length > 0) {
        for (const chain of nested.blockerChains) {
          blockerChains.push([depId, ...chain]);
        }
      }
    }
    if (blockerChains.length === 0 && cycles.length === 0) {
      blockerChains.push([depId]);
    }
    return {
      blocked: true,
      blockerChains: dedupeDependencyChains(blockerChains),
      cycles: dedupeDependencyChains(cycles),
      transitiveBlockedBy: [...transitiveBlockedBy],
    };
  }

  function evaluateReadiness(row, byId, board = null) {
    const deps = splitDependsOn(row["Depends On"]);
    const blockedBy = [];
    const transitiveBlockedBy = new Set();
    const blockerChains = [];
    const cycles = [];

    for (const depId of deps) {
      const traced = traceDependencyReadiness(row, depId, byId, board, [row.ID]);
      if (!traced.blocked) {
        continue;
      }
      blockedBy.push(depId);
      for (const blockedId of traced.transitiveBlockedBy) {
        transitiveBlockedBy.add(blockedId);
      }
      blockerChains.push(...traced.blockerChains);
      cycles.push(...traced.cycles);
    }

    return {
      deps,
      blockerChains: dedupeDependencyChains(blockerChains),
      blockedBy,
      cycles: dedupeDependencyChains(cycles),
      transitiveBlockedBy: [...transitiveBlockedBy],
      ready: blockedBy.length === 0 && cycles.length === 0,
    };
  }

  return { traceDependencyReadiness, evaluateReadiness };
}

module.exports = { createDependencyReadiness };
