"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CATALOG_PATH = path.join(__dirname, "..", "product", "adoption-profiles.json");
const REQUIRED_PROFILE_FIELDS = Object.freeze([
  "label",
  "intent",
  "default_lane",
  "recommended_tracks",
  "required_ticket_fields",
  "required_evidence",
  "closeout_expectations",
  "allowed_adapter_classes",
  "ui_labels",
]);

function loadCatalog(catalogPath = DEFAULT_CATALOG_PATH) {
  return JSON.parse(fs.readFileSync(catalogPath, "utf8"));
}

function validateCatalog(catalog) {
  const errors = [];
  if (!catalog || typeof catalog !== "object") {
    return ["catalog must be an object"];
  }
  if (catalog.schema_version !== 1) {
    errors.push("schema_version must be 1");
  }
  if (!catalog.default_profile || typeof catalog.default_profile !== "string") {
    errors.push("default_profile is required");
  }
  const profiles = catalog.profiles || {};
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    errors.push("profiles must be an object");
    return errors;
  }
  if (catalog.default_profile && !profiles[catalog.default_profile]) {
    errors.push(`default_profile ${catalog.default_profile} is not present in profiles`);
  }
  for (const [id, profile] of Object.entries(profiles)) {
    for (const field of REQUIRED_PROFILE_FIELDS) {
      if (!(field in profile)) {
        errors.push(`${id} missing ${field}`);
      }
    }
    for (const field of [
      "recommended_tracks",
      "required_ticket_fields",
      "required_evidence",
      "closeout_expectations",
      "allowed_adapter_classes",
      "ui_labels",
    ]) {
      if (field in profile && !Array.isArray(profile[field])) {
        errors.push(`${id}.${field} must be an array`);
      }
    }
    if (profile.default_lane && !["default", "full", "ci"].includes(profile.default_lane)) {
      errors.push(`${id}.default_lane must be default, full, or ci`);
    }
  }
  return errors;
}

function createAdoptionProfileRegistry(options = {}) {
  const catalog = options.catalog || loadCatalog(options.catalogPath);
  const errors = validateCatalog(catalog);
  if (errors.length > 0 && options.strict !== false) {
    throw new Error(`Invalid adoption profile catalog: ${errors.join("; ")}`);
  }
  const profiles = catalog.profiles || {};
  const fallback = catalog.default_profile || "solo-dev";

  function listProfiles() {
    return Object.keys(profiles)
      .sort()
      .map((id) => Object.assign({ id }, profiles[id]));
  }

  function getProfile(id) {
    return profiles[id] ? Object.assign({ id }, profiles[id]) : null;
  }

  function resolveProfile(id) {
    return getProfile(id) || getProfile(fallback);
  }

  function hasProfile(id) {
    return Boolean(profiles[id]);
  }

  return {
    catalog,
    errors,
    defaultProfile: fallback,
    listProfiles,
    getProfile,
    resolveProfile,
    hasProfile,
  };
}

module.exports = createAdoptionProfileRegistry;
module.exports.DEFAULT_CATALOG_PATH = DEFAULT_CATALOG_PATH;
module.exports.REQUIRED_PROFILE_FIELDS = REQUIRED_PROFILE_FIELDS;
module.exports.loadCatalog = loadCatalog;
module.exports.validateCatalog = validateCatalog;
