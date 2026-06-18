const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const scriptPath = path.join(__dirname, "check-template-sync.sh");

function writeFile(rootDir, relativePath, content) {
  const absPath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf8");
  return absPath;
}

function writeManifest(rootDir, items) {
  const manifestPath = path.join(rootDir, "coord", "TEMPLATE_SYNC_MANIFEST.json");
  writeFile(
    rootDir,
    "coord/TEMPLATE_SYNC_MANIFEST.json",
    `${JSON.stringify({
      schema_version: 1,
      manifest_version: "test-manifest",
      items,
    }, null, 2)}\n`,
  );
  return manifestPath;
}

function sha256(content) {
  return require("node:crypto").createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

function runChecker(rootDir, extraArgs = []) {
  const manifestPath = path.join(rootDir, "coord", "TEMPLATE_SYNC_MANIFEST.json");
  const outputPath = path.join(rootDir, "check-template-sync-output.json");
  const quotedArgs = [
    "bash",
    scriptPath,
    "--json",
    "--repo-root",
    rootDir,
    "--manifest",
    manifestPath,
    ...extraArgs,
  ].map((arg) => JSON.stringify(arg)).join(" ");
  const result = spawnSync(
    "bash",
    ["-lc", `${quotedArgs} > ${JSON.stringify(outputPath)}`],
    { encoding: "utf8" },
  );
  const output = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  return { result, output };
}

test("check-template-sync passes when exact-match files match the manifest", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-template-sync-pass-"));
  const fileContent = "exact file contents\n";
  writeFile(rootDir, "coord/example.txt", fileContent);
  writeManifest(rootDir, [
    {
      path: "coord/example.txt",
      match_policy: "exact",
      version_stamp: "sha256:test",
      checksum: {
        algo: "sha256",
        hex: sha256(fileContent),
        bytes: Buffer.byteLength(fileContent),
      },
    },
  ]);

  const { result, output } = runChecker(rootDir);
  const payload = JSON.parse(output);
  assert.equal(result.status, 0, output || result.stderr || result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.counts.passed, 1);
  assert.equal(payload.results[0].path, "coord/example.txt");
  assert.equal(payload.results[0].status, "ok");
});

test("check-template-sync fails when an exact-match file drifts", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-template-sync-fail-"));
  const expectedContent = "expected contents\n";
  writeFile(rootDir, "coord/example.txt", "different contents\n");
  writeManifest(rootDir, [
    {
      path: "coord/example.txt",
      match_policy: "exact",
      checksum: {
        algo: "sha256",
        hex: sha256(expectedContent),
        bytes: Buffer.byteLength(expectedContent),
      },
    },
  ]);

  const { result, output } = runChecker(rootDir);
  const payload = JSON.parse(output);
  assert.equal(result.status, 1, output || result.stderr || result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.failures[0].path, "coord/example.txt");
  assert.equal(payload.failures[0].status, "mismatch");
});

test("check-template-sync warns on advisory drift unless strict mode is enabled", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-template-sync-warn-"));
  const expectedContent = "expected contents\n";
  writeFile(rootDir, "coord/example.txt", "different contents\n");
  writeManifest(rootDir, [
    {
      path: "coord/example.txt",
      match_policy: "advisory",
      checksum: {
        algo: "sha256",
        hex: sha256(expectedContent),
        bytes: Buffer.byteLength(expectedContent),
      },
    },
  ]);

  const { result: warnResult, output: warnOutput } = runChecker(rootDir);
  const warnPayload = JSON.parse(warnOutput);
  assert.equal(warnResult.status, 0, warnOutput || warnResult.stderr || warnResult.stdout);
  assert.equal(warnPayload.ok, true);
  assert.equal(warnPayload.warnings[0].path, "coord/example.txt");
  assert.equal(warnPayload.warnings[0].status, "mismatch");

  const { result: strictResult, output: strictOutput } = runChecker(rootDir, ["--strict"]);
  const strictPayload = JSON.parse(strictOutput);
  assert.equal(strictResult.status, 1, strictOutput || strictResult.stderr || strictResult.stdout);
  assert.equal(strictPayload.ok, false);
  assert.equal(strictPayload.failures[0].path, "coord/example.txt");
  assert.equal(strictPayload.failures[0].status, "mismatch");
});
