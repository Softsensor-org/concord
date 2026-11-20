import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(appDir, "package.json"), "utf8"));
const readme = readFileSync(resolve(appDir, "README.md"), "utf8");

test("bundled coord-ui launchers explicitly bind to loopback", () => {
  assert.match(pkg.scripts.dev, /-H 127\.0\.0\.1/);
  assert.match(pkg.scripts.start, /-H 127\.0\.0\.1/);
  assert.match(readme, /bind to loopback \(`127\.0\.0\.1`\) only/);
});
