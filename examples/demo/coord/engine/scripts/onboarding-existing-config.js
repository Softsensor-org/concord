"use strict";

const path = require("node:path");

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, label) {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`onboard: existing project.config.js has invalid ${label}; correct the declaration before onboarding`);
  }
  return value;
}

function stringList(value, label) {
  if (!Array.isArray(value)) throw new Error(`onboard: existing project.config.js requires an array for ${label}`);
  return value.map((entry) => text(entry, label));
}

// The caller supplies its workspace and existing static reader. Never load an
// adopter module or retain unprojected source text in the public plan.
function readOnboardConfigDeclaration(root, { fs, readDeclaredConfig }) {
  // A genuinely absent config needs no platform-specific secure file open.
  // Inspect the lexical parent first so a dangling symlink is not absence.
  try {
    if (!fs.lstatSync(path.join(root, "coord")).isDirectory()) {
      throw new Error("onboard: coord must be a real directory, not a symlink or special file");
    }
    if (!fs.lstatSync(path.join(root, "coord/project.config.js")).isFile()) {
      throw new Error("onboard: existing project.config.js must be a regular file");
    }
  } catch (error) {
    if (error.code === "ENOENT") return { status: "absent", path: null };
    throw error;
  }
  return readDeclaredConfig(path.join(root, "coord/project.config.js"), {
    fs, containmentRoot: root, displayPath: "coord/project.config.js",
  });
}

function readExistingOnboardConfig(root, { fs, readDeclaredConfig, discoveredPaths }) {
  const result = readOnboardConfigDeclaration(root, { fs, readDeclaredConfig });
  if (result.status === "absent") return null;
  if (result.status !== "declared") throw new Error(`onboard: ${result.message}`);
  const config = result.declared;
  if (!object(config.repos)) {
    throw new Error("onboard: existing project.config.js requires a repository map object");
  }
  if (Object.keys(config.repos).length === 0) {
    // COORD-891: an EMPTY map is the installer's unmapped workspace starter
    // (coord/project.config.workspace.js -> coord/project.config.js, "Populated
    // by `concord onboard`"). It records no repository to preserve, so
    // onboarding maps the discovered siblings into a regenerated config instead
    // of refusing the very file the installer just wrote. Its other declared
    // settings are still validated and carried forward.
    return { answers: projectSettings(config), repositoryPaths: [], digest: result.source_digest, unmapped: true };
  }
  const repositoryPaths = [];
  const repos = Object.entries(config.repos).map(([code, repo]) => {
    if (!/^[A-WY-Z]$/.test(code) || !object(repo)) {
      throw new Error("onboard: existing project.config.js requires single uppercase product repo codes other than X");
    }
    const declaredPath = text(repo.path, "repo path");
    const absolute = path.resolve(root, declaredPath);
    const name = path.basename(absolute);
    if (path.isAbsolute(declaredPath) || declaredPath.includes("\\") || declaredPath.split("/").includes("..") ||
        path.dirname(absolute) !== root || !discoveredPaths.includes(name) || repositoryPaths.includes(name)) {
      throw new Error("onboard: configured repos must name distinct existing sibling product repositories; configuration was preserved");
    }
    repositoryPaths.push(name);
    return {
      code, path: declaredPath,
      integrationBranch: repo.integrationBranch === undefined ? "main" : text(repo.integrationBranch, "integration branch"),
      testCommand: repo.testCommand === undefined ? "npm test" : text(repo.testCommand, "test command"),
      ticketPrefixes: repo.ticketPrefixes === undefined ? [] : stringList(repo.ticketPrefixes, "ticket prefixes"),
    };
  });
  return { answers: { repos, ...projectSettings(config) }, repositoryPaths, digest: result.source_digest };
}

function projectSettings(config) {
  const answers = {};
  if (config.coordTicketPrefix !== undefined) answers.coordTicketPrefix = text(config.coordTicketPrefix, "ticket prefix");
  if (config.governance !== undefined) {
    if (!object(config.governance)) throw new Error("onboard: existing governance settings must be an object");
    if (config.governance.tier !== undefined) answers.tier = text(config.governance.tier, "governance tier");
  }
  if (config.adoption !== undefined) {
    if (!object(config.adoption)) throw new Error("onboard: existing adoption settings must be an object");
    for (const name of ["profile", "phase"]) {
      if (config.adoption[name] !== undefined && config.adoption[name] !== null) answers[name] = text(config.adoption[name], name);
    }
    for (const name of ["tracks", "gates"]) {
      if (config.adoption[name] !== undefined) answers[name] = stringList(config.adoption[name], name);
    }
  }
  return answers;
}

module.exports = { readExistingOnboardConfig, readOnboardConfigDeclaration };
