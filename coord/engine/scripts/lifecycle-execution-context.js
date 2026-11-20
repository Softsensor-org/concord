"use strict";

function withTemporaryExecutionContext(options, fn) {
  const envOverrides = options?.env && typeof options.env === "object" ? options.env : null;
  const nextCwd = options?.cwd ? require("path").resolve(options.cwd) : null;
  const previousCwd = nextCwd ? process.cwd() : null;
  const envRestore = [];

  if (envOverrides) {
    const keys = new Set([...Object.keys(process.env), ...Object.keys(envOverrides)]);
    for (const key of keys) {
      const hadValue = Object.prototype.hasOwnProperty.call(process.env, key);
      const previousValue = process.env[key];
      const nextValue = envOverrides[key];
      if (nextValue === undefined) {
        if (hadValue) {
          delete process.env[key];
          envRestore.push({ key, hadValue, previousValue });
        }
        continue;
      }
      const normalizedNextValue = String(nextValue);
      if (!hadValue || previousValue !== normalizedNextValue) {
        process.env[key] = normalizedNextValue;
        envRestore.push({ key, hadValue, previousValue });
      }
    }
  }

  if (nextCwd && previousCwd !== nextCwd) {
    process.chdir(nextCwd);
  }

  try {
    return fn();
  } finally {
    if (nextCwd && previousCwd !== nextCwd) {
      process.chdir(previousCwd);
    }
    for (let index = envRestore.length - 1; index >= 0; index -= 1) {
      const { key, hadValue, previousValue } = envRestore[index];
      if (hadValue) {
        process.env[key] = previousValue;
      } else {
        delete process.env[key];
      }
    }
  }
}

module.exports = {
  withTemporaryExecutionContext,
};
