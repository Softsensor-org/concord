"use strict";


const { state: governanceState, DEFAULT_PATHS: governanceDefaultPaths } = require("./governance-context.js");
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const commandRegistry = require("./command-registry.js");
const { buildRegistry, dispatch } = require("./coord-cli.js");
const lifecycle = require("./lifecycle.js");
const { withGovernedSurfaceSandbox } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));

function capture() {
  const lines = [];
  return { log: (line) => lines.push(String(line)), text: () => lines.join("\n") };
}

test("product metadata includes current stable coord commands", () => {
  const names = commandRegistry.PRODUCT_COMMANDS.map((command) => command.name);
  for (const name of ["init", "conformance", "upgrade"]) {
    assert.ok(names.includes(name), `${name} should be registered`);
  }
});

test("product CLI registry and command metadata do not drift", () => {
  const runtime = buildRegistry({ log: () => {} });
  const metadata = commandRegistry.productCommandMetadataByName();
  assert.deepEqual(Object.keys(runtime).sort(), Array.from(metadata.keys()).sort());
  for (const [name, entry] of Object.entries(runtime)) {
    assert.equal(entry.summary, metadata.get(name).summary, `summary drift for ${name}`);
  }
});

test("registry rejects a command that has no explicit discovery role", () => {
  const unclassified = {
    name: "test-unclassified-command", namespace: "product", maturity: "alpha", safety: "read_only",
    summary: "Fixture only", docs: "fixture.md", ui_palette: false,
  };
  commandRegistry.PRODUCT_COMMANDS.push(unclassified);
  try {
    assert.throws(
      () => commandRegistry.listCommandMetadata({ includeAdvanced: true }),
      /Command test-unclassified-command must have exactly one discovery role/
    );
  } finally {
    commandRegistry.PRODUCT_COMMANDS.pop();
  }
});

test("coord help is backed by command metadata summaries", () => {
  const cap = capture();
  const result = dispatch(["help"], { log: cap.log });
  assert.equal(result.code, 0);
  assert.match(cap.text(), new RegExp(commandRegistry.productSummary("init").replace(/[()]/g, "\\$&")));
  assert.doesNotMatch(cap.text(), /requirements-walking-skeleton|\[alpha; advanced\]|Planned surfaces/);
  const advanced = capture();
  assert.equal(dispatch(["help", "--all"], { log: advanced.log }).code, 0);
  assert.match(advanced.text(), /requirements-walking-skeleton/);
  assert.match(advanced.text(), /Planned surfaces \(not runnable\)/);
});

test("commands defaults to stable operator metadata and --all preserves the complete registry", () => {
  const cap = capture();
  const result = commandRegistry.run(["--json"], { log: cap.log });
  assert.equal(result.code, 0);
  const report = JSON.parse(cap.text());
  assert.equal(report.kind, "concord.command_registry");
  assert.ok(report.commands.length > 0);
  assert.ok(report.commands.every((command) => command.maturity === "stable" && command.role === "operator"));
  const all = capture();
  const full = commandRegistry.run(["--all", "--json"], { log: all.log });
  assert.equal(full.code, 0);
  const fullReport = JSON.parse(all.text());
  assert.equal(fullReport.commands.length, commandRegistry.PRODUCT_COMMANDS.length + commandRegistry.GOVERNANCE_COMMANDS.length);
  assert.ok(fullReport.commands.some((command) => command.namespace === "governance" && command.name === "start"));
  assert.ok(fullReport.commands.every((command) => command.summary && command.safety && command.maturity && command.role && command.entrypoint));
  assert.deepEqual([...new Set(fullReport.commands.map((command) => command.role))].sort(), ["admin", "maintainer", "operator"]);
});

test("commands supports maturity, namespace, role, and safety filters", () => {
  for (const [flag, value, key] of [
    ["--maturity", "alpha", "maturity"],
    ["--namespace", "governance", "namespace"],
    ["--role", "admin", "role"],
    ["--safety", "governance_mutation", "safety"],
  ]) {
    const cap = capture();
    assert.equal(commandRegistry.run([flag, value, "--json"], { log: cap.log }).code, 0);
    const report = JSON.parse(cap.text());
    assert.ok(report.commands.length > 0, `${flag} should match commands`);
    assert.ok(report.commands.every((command) => command[key] === value));
  }
  const invalid = capture();
  assert.equal(commandRegistry.run(["--role"], { log: invalid.log }).code, 1);
  assert.match(invalid.text(), /--role requires a value/);
  const unknown = capture();
  assert.equal(commandRegistry.run(["--maturity", "imaginary"], { log: unknown.log }).code, 1);
  assert.match(unknown.text(), /unknown maturity "imaginary"/);
  const invalidRole = capture();
  assert.equal(commandRegistry.run(["--role=engineer"], { log: invalidRole.log }).code, 1);
  assert.match(invalidRole.text(), /unknown role "engineer"/);
});

test("adoption governance helper commands have registry-level dispatch", () => {
  assert.deepEqual(
    commandRegistry.ADOPTION_GOVERNANCE_COMMAND_NAMES,
    ["guided-closeout", "governance-tier", "publishability-check"]
  );
  assert.equal(typeof commandRegistry.runAdoptionGovernanceCommand, "function");
});

test("adoption governance dispatch keeps its invalid-command and parser guards", () => {
  assert.throws(
    () => commandRegistry.runAdoptionGovernanceCommand("not-registered", [], () => ({})),
    /Unknown adoption governance command "not-registered"\./
  );
  assert.throws(
    () => commandRegistry.runAdoptionGovernanceCommand("guided-closeout", []),
    /runAdoptionGovernanceCommand requires parseFlags\./
  );
});

test("adoption governance dispatch preserves governance-tier and publishability routes", () => {
  const originalLog = console.log;
  const output = [];
  console.log = (...parts) => output.push(parts.join(" "));
  try {
    const tierArgs = [];
    const tier = commandRegistry.runAdoptionGovernanceCommand(
      "governance-tier",
      ["--json"],
      (args) => {
        tierArgs.push(...args);
        return { json: true, tier: "lite" };
      }
    );
    assert.deepEqual(tierArgs, ["--json"]);
    assert.equal(tier.active_tier, "lite");

    const publishabilityArgs = [];
    const publishability = commandRegistry.runAdoptionGovernanceCommand(
      "publishability-check",
      ["BCTX-545", "--json"],
      (args) => {
        publishabilityArgs.push(...args);
        return { json: true, files: ["release/artifact.zip"] };
      }
    );
    assert.deepEqual(publishabilityArgs, ["--json"]);
    assert.equal(publishability.ticket_id, "BCTX-545");
    assert.equal(publishability.needs_publishability, true);
    assert.equal(JSON.parse(output[0]).active_tier, "lite");
    assert.equal(JSON.parse(output[1]).needs_publishability, true);
  } finally {
    console.log = originalLog;
  }
});

test("command reference and commands CLI retain default, help, and invalid-argument behavior", () => {
  const reference = commandRegistry.renderCommandReference();
  const referencePath = path.join(__dirname, "../../engine/docs/COMMAND_REFERENCE.md");
  assert.equal(fs.readFileSync(referencePath, "utf8"), `${reference}\n`);
  const generated = capture();
  assert.equal(commandRegistry.run(["--all"], { log: generated.log }).code, 0);
  assert.equal(generated.text(), reference);
  assert.match(reference, /# Concord Command Reference/);
  assert.match(reference, /bash coord\/scripts\/coord commands --all --json/);
  assert.match(reference, /Entry point: coord\/scripts\/gov/);
  assert.doesNotMatch(reference, /Maturity: planned_surface|requirements:requirements/);
  assert.throws(
    () => commandRegistry.productSummary("missing-command"),
    /Missing product command metadata for missing-command/
  );

  const originalLog = console.log;
  const output = [];
  console.log = (line) => output.push(String(line));
  try {
    const defaultRun = commandRegistry.run();
    assert.equal(defaultRun.code, 0);
    assert.match(output[0], /# Concord Command Reference/);
  } finally {
    console.log = originalLog;
  }

  const help = capture();
  assert.equal(commandRegistry.run(["--help"], { log: help.log }).code, 0);
  assert.match(help.text(), /Usage: coord commands/);
  const invalid = capture();
  assert.equal(commandRegistry.run(["--unexpected"], { log: invalid.log }).code, 1);
  assert.match(invalid.text(), /unexpected argument --unexpected/);
});

test("guided-closeout registry dispatch uses the production review collector", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "command-registry-guided-closeout-"));
  const ticketId = "BCTX-545";
  const row = {
    ID: ticketId,
    Status: "doing",
    Repo: "X",
    Type: "feature",
    Description: "Change invoice approval workflow.",
  };
  fs.mkdirSync(path.join(root, "coord", "board"), { recursive: true });
  fs.writeFileSync(path.join(root, "coord", "board", "tasks.json"), JSON.stringify({
    sections: [{ rows: [row] }],
    pr_index: {},
  }, null, 2));

  try {
    withGovernedSurfaceSandbox(({ boardPath }) => {
      fs.writeFileSync(boardPath, JSON.stringify({
        sections: [{ rows: [row] }],
        pr_index: {},
      }, null, 2));
      const planRecord = {
      schema_version: 1,
      ticket_id: ticketId,
      markdown_heading: `## ${ticketId} — 2026-06-27T00:00:00.000Z`,
      startup_checklist: ["completed"],
      traceability_gate: ["closing-gap"],
      review_round: 1,
      baseline_reproduction: ["Command: not-required", "Outcome: feature ticket"],
      prior_findings: [],
      intended_files: ["backend/src/invoices/post.ts"],
      change_summary: ["Change invoice approval workflow behavior."],
      verification_commands: ["node --test coord/scripts/command-registry.test.js"],
      critical_invariants: ["Approval behavior must preserve confirmed business intent."],
      requirement_closure: [
        "Ticket ask: change invoice workflow",
        "Implemented: changed workflow",
        "Not implemented: none",
        "Deferred to: none",
        "Closeout verdict: complete",
      ],
      feature_proof: ["path:coord/engine/scripts/command-registry.js"],
      repo_gates: ["node --test coord/scripts/command-registry.test.js"],
      self_review_cycles: [1, 2, 3].map((cycle) => ({
        cycle,
        total: 3,
        lens: `review ${cycle}`,
        diff: "governance readiness adapter",
        risks: ["stale context", "false readiness"],
        findings: "none",
        verification: "node --test coord/scripts/command-registry.test.js",
        verdict: "pass",
        raw: `lens=review ${cycle}; diff=governance readiness adapter; risks=stale context, false readiness; findings=none; verification=node --test coord/scripts/command-registry.test.js; verdict=pass`,
      })),
      rollback_strategy: ["revert"],
      security_surface: "no",
      synced_from_markdown_at: "2026-06-27T00:00:00.000Z",
      };
      const recordPath = path.join(governanceState.PLAN_RECORDS_DIR, `${ticketId}.json`);
      fs.writeFileSync(recordPath, JSON.stringify(planRecord, null, 2));

      const expectedIssues = lifecycle.collectReviewPlanReadinessIssues(ticketId, row);
      assert.ok(expectedIssues.some((issue) => issue.code === "context_pack_ack"));

      const originalLog = console.log;
      const output = [];
      console.log = (...parts) => output.push(parts.join(" "));
      try {
        const parsedArgs = [];
        const report = commandRegistry.runAdoptionGovernanceCommand(
          "guided-closeout",
          [ticketId, "--json"],
          (args) => {
            parsedArgs.push(...args);
            return { root, json: true };
          },
          { collectReviewPlanReadinessIssues: lifecycle.collectReviewPlanReadinessIssues }
        );
        assert.deepEqual(parsedArgs, ["--json"]);
        const review = report.checks.find((check) => check.id === "review_plan");
        assert.equal(review.assessed, true);
        assert.deepEqual(review.issues, expectedIssues.map((issue) => ({
          code: issue.code,
          message: issue.message,
          next_steps: issue.next_steps || [],
        })));
        assert.equal(report.ready, false);
        assert.equal(JSON.parse(output.join("\n")).ready, false);
      } finally {
        console.log = originalLog;
      }
    }, { isolateBoardValidation: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("coord commands is routed through the product CLI", () => {
  const cap = capture();
  const result = dispatch(["commands", "--product-only", "--json"], { log: cap.log });
  assert.equal(result.code, 0);
  const report = JSON.parse(cap.text());
  assert.ok(report.commands.every((command) => command.namespace === "product"));
});
