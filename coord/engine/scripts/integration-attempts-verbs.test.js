"use strict";

// COORD-1041 (d): verb-level two-domain tests for `gov integration attempts` and
// `gov integration select`. Each domain is a separate scoped runtime with its own git repo
// (withCanonicalAuthorityContext); all three share one local bare remote as origin. Domains that
// publish attempts run first, then the integrating domain claims, lists, selects and is refused.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { gitFixture } = require("./test-git-fixture.js");
const { ORCH, WORKER, withCanonicalAuthorityContext } = require("./__fixtures__/integration-authority-context.js");
const attemptCoordination = require("./attempt-coordination.js");
const { parseArgs } = require("./integration-commands.js");
const authority = require("./integration-authority.js");

const TICKET = "COORD-1041";
const DOMAIN_B_HANDLE = WORKER;
const DOMAIN_C_HANDLE = "codexa03";

function bareRemote(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-1041-verbs-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, "remote.git");
  gitFixture(dir, ["init", "-q", "--bare", remote]);
  return remote;
}

// One publishing domain: its own runtime and repo, one attempt published to the shared remote.
function publishFrom(remote, handle, journalTxId, ticket = TICKET, {
  state = "active", now = "2026-11-16T10:00:00.000Z",
} = {}) {
  let published = null;
  withCanonicalAuthorityContext(({ root, git, runtime }) => {
    git("remote", "add", "origin", remote);
    const { domain_id: domainId } = attemptCoordination.mintDomainId(runtime, { label: handle });
    const result = attemptCoordination.publishAttempt(root, {
      remote: "origin", ticket, domainId, domainLabel: handle, journalTxId,
      agent: { handle }, baseSha: git("rev-parse", "HEAD"), branch: `agent/${handle}-${ticket}`,
      observedCanonical: { generation: 0 }, now,
    });
    if (state !== "active") {
      // A different publisher can record a submitted or withdrawn attempt on this ref.
      git("fetch", "origin", result.ref);
      git("checkout", "--detach", "FETCH_HEAD");
      fs.writeFileSync(path.join(root, attemptCoordination.RECORD_FILE), JSON.stringify({ ...result.record, state }));
      git("commit", "-am", `${ticket}: ${state} attempt`);
      git("push", "origin", `HEAD:${result.ref}`);
    }
    published = { status: result.status, attempt_id: result.attempt_id, domainId };
  });
  return published;
}

function eventsOf(eventLogPath, command) {
  return fs.readFileSync(eventLogPath, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line)).filter((event) => event.command === command);
}

test("COORD-1041 (d): two publishing domains, then attempts lists both and select records the fence transition", (t) => {
  const remote = bareRemote(t);
  const now = Date.now();
  const b = publishFrom(remote, DOMAIN_B_HANDLE, "tx-verb-b", TICKET, { now: new Date(now).toISOString() });
  const c = publishFrom(remote, DOMAIN_C_HANDLE, "tx-verb-c", TICKET, {
    now: new Date(now - 2 * attemptCoordination.ATTEMPT_STALE_MS).toISOString(),
  });
  assert.equal(b.status, "published");
  assert.equal(c.status, "published");
  assert.notEqual(b.domainId, c.domainId, "the two domains mint distinct domain ids");

  withCanonicalAuthorityContext(({ root, git, commands, setThread, eventLogPath }) => {
    git("remote", "add", "origin", remote);
    setThread("thread-old");
    commands.integrationCommand(["claim"]);
    assert.equal(commands.integrationCommand(["status", "--json"]).holder.handle, ORCH);

    const before = commands.integrationCommand(["attempts", TICKET, "--json"]);
    assert.equal(before.attempts.length, 2, "attempts is never refused: both domains are listed");
    assert.equal(before.canonical, null, "no canonical record exists before the first select");
    assert.ok(before.attempts.every((a) => Array.isArray(a.classes) && a.age_ms >= 0), "every attempt carries its report-only classes");
    assert.ok(before.attempts.every((a) => a.classes.length === 0 || a.classes.every((k) => ["attempt-stale", "attempt-orphaned", "retention-eligible"].includes(k))));
    const attemptB = before.attempts.find((a) => a.attempt_id === b.attempt_id);
    const attemptC = before.attempts.find((a) => a.attempt_id === c.attempt_id);
    assert.ok(attemptB && attemptC, "both domain attempts are listed by attempt id");
    assert.deepEqual(attemptB.classes, []);
    assert.ok(attemptC.classes.includes("attempt-stale"));

    fs.writeFileSync(path.join(root, "board", "tasks.json"), JSON.stringify({ sections: [{ rows: [{ ID: TICKET, Owner: DOMAIN_C_HANDLE }] }] }));
    const originalBootstrap = attemptCoordination.bootstrapCanonical;
    let bootstrapOwner = null;
    attemptCoordination.bootstrapCanonical = (repoRoot, options) => {
      if (options.ticket === TICKET) bootstrapOwner = options.owner;
      return originalBootstrap(repoRoot, options);
    };
    let selected;
    try {
      selected = commands.integrationCommand(["select", TICKET, "--attempt", b.attempt_id, "--reject", c.attempt_id, "--reason", "domain B is the chosen approach", "--json"]);
    } finally {
      attemptCoordination.bootstrapCanonical = originalBootstrap;
    }
    assert.equal(bootstrapOwner, DOMAIN_C_HANDLE, "the first canonical record uses the board ticket owner before the selected attempt takes ownership");
    assert.equal(selected.generation, 1, "the first select bootstraps generation 0 and advances to 1");
    assert.equal(selected.selected, b.attempt_id);
    assert.deepEqual(selected.rejected, [c.attempt_id], "the printed selection names the rejected attempt");
    assert.match(selected.token, new RegExp(`^${TICKET}@1:[0-9a-f]{40}$`));

    const after = commands.integrationCommand(["attempts", TICKET, "--json"]);
    assert.equal(after.canonical.record.generation, 1);
    assert.equal(after.canonical.record.owner, DOMAIN_B_HANDLE, "selection moves ownership to the selected attempt's agent");
    assert.equal(after.canonical.record.status, "doing");
    assert.equal(after.canonical.record.authority_epoch, 1, "the canonical record carries the authority epoch it was decided under");
    assert.deepEqual(after.canonical.record.rejected_attempts, [{ attempt_id: c.attempt_id, reason: "domain B is the chosen approach" }],
      "the rejection and its reason are recorded on the canonical record");
    assert.ok(after.attempts.find((a) => a.attempt_id === c.attempt_id).classes.includes("attempt-orphaned"), "a rejected attempt is reported orphaned once another attempt is selected");

    const lsRemote = git("ls-remote", "origin", "refs/heads/coord-state/canonical/*");
    assert.match(lsRemote, /refs\/heads\/coord-state\/canonical\/COORD-1041/, "the canonical ref is on the shared remote");
    const intents = eventsOf(eventLogPath, "integration-canonical-transition-intent");
    const selections = eventsOf(eventLogPath, "integration-attempt-selection");
    assert.equal(intents.length, 1, "the transition intent is journaled once");
    assert.equal(selections.length, 1, "the selection is journaled once");
    assert.equal(selections[0].details.intent_txn, intents[0].details.txn, "the selection names the intent it applied");
    assert.equal(selections[0].details.generation_after, 1);
    assert.equal(selections[0].details.authority_epoch, 1);

    const later = publishFrom(remote, ORCH, "tx-verb-later");
    const replacement = commands.integrationCommand(["select", TICKET, "--attempt", later.attempt_id, "--json"]);
    assert.equal(replacement.generation, 2);
    const current = attemptCoordination.readCanonical(root, { remote: "origin", ticket: TICKET });
    assert.equal(current.record.selected_attempt, later.attempt_id);
    assert.deepEqual(current.record.rejected_attempts, after.canonical.record.rejected_attempts);
    const [, secondSelection] = eventsOf(eventLogPath, "integration-attempt-selection");
    assert.equal(secondSelection.details.bootstrapped, false);
    assert.equal(secondSelection.details.token_before, selected.token);
    assert.equal(secondSelection.details.token_after, replacement.token);
  });
});

test("COORD-1041 (d): select journals abandoned intent and leaves each externally moved canonical state intact", (t) => {
  const remote = bareRemote(t);
  const scenarios = [
    { ticket: "COORD-1042", race: "epoch" },
    { ticket: "COORD-1043", race: "appeared" },
    { ticket: "COORD-1044", race: "missing" },
    { ticket: "COORD-1045", race: "stale" },
    { ticket: "COORD-1046", race: "publish-refused" },
    { ticket: "COORD-1047", race: "removed-before-fence" },
    { ticket: "COORD-1048", race: "removed-before-publish" },
    { ticket: "COORD-1049", race: "transport-string" },
  ].map((scenario) => ({ ...scenario, attempt: publishFrom(remote, DOMAIN_B_HANDLE, `tx-${scenario.race}`, scenario.ticket) }));

  withCanonicalAuthorityContext(({ root, git, commands, setThread, eventLogPath }) => {
    git("remote", "add", "origin", remote);
    setThread("thread-old");
    commands.integrationCommand(["claim"]);

    const originalRead = attemptCoordination.readCanonical;
    const originalBootstrap = attemptCoordination.bootstrapCanonical;
    const originalPublish = attemptCoordination.publishCanonicalTransition;
    const originalVerify = attemptCoordination.verifyFence;
    const runSelect = (scenario) => commands.integrationCommand(["select", scenario.ticket, "--attempt", scenario.attempt.attempt_id]);
    const assertAbandoned = (scenario) => {
      const intents = eventsOf(eventLogPath, "integration-canonical-transition-intent").filter((event) => event.details?.ticket === scenario.ticket);
      const abandoned = eventsOf(eventLogPath, "integration-canonical-transition-abandoned").filter((event) => event.details?.ticket === scenario.ticket);
      const selections = eventsOf(eventLogPath, "integration-attempt-selection").filter((event) => event.details?.ticket === scenario.ticket);
      assert.equal(intents.length, 1, `${scenario.race} journals one intent before detecting the moved state`);
      assert.equal(abandoned.length, 1, `${scenario.race} journals one abandoned intent`);
      assert.equal(selections.length, 0, `${scenario.race} never journals a selection`);
    };
    const withPatched = (patch, run) => {
      Object.assign(attemptCoordination, patch);
      try { run(); } finally {
        attemptCoordination.readCanonical = originalRead;
        attemptCoordination.bootstrapCanonical = originalBootstrap;
        attemptCoordination.publishCanonicalTransition = originalPublish;
        attemptCoordination.verifyFence = originalVerify;
      }
    };

    const transport = scenarios.find((scenario) => scenario.race === "transport-string");
    let transportReads = 0;
    withPatched({ readCanonical(repoRoot, options) {
      if (options.ticket === transport.ticket && ++transportReads === 2) throw "legacy transport unavailable";
      return originalRead(repoRoot, options);
    } }, () => {
      assert.throws(() => runSelect(transport), (error) => error === "legacy transport unavailable");
      assertAbandoned(transport);
      const abandoned = eventsOf(eventLogPath, "integration-canonical-transition-abandoned")
        .find((event) => event.details.ticket === transport.ticket);
      assert.equal(abandoned.details.reason, "legacy transport unavailable");
    });

    const epoch = scenarios.find((scenario) => scenario.race === "epoch");
    let epochMoved = false;
    withPatched({ readCanonical(repoRoot, options) {
      const current = originalRead(repoRoot, options);
      if (!epochMoved && options.ticket === epoch.ticket) {
        epochMoved = true;
        const record = authority.readRecord();
        authority.writeRecord({ ...record, authority_epoch: record.authority_epoch + 1 }, { event: "test-select-epoch-moved-after-intent" });
      }
      return current;
    } }, () => {
      assert.throws(() => runSelect(epoch), (error) => {
        assert.match(error.message, /authority epoch moved/);
        assertAbandoned(epoch);
        return true;
      });
    });
    assert.equal(epochMoved, true);
    assert.equal(authority.readRecord().authority_epoch, 2, "the newer local authority epoch remains intact after the old intent refuses");
    assert.equal(originalRead(root, { remote: "origin", ticket: epoch.ticket }), null, "the epoch race did not publish a canonical record");

    const appeared = scenarios.find((scenario) => scenario.race === "appeared");
    let canonicalAppeared = false;
    withPatched({ readCanonical(repoRoot, options) {
      const current = originalRead(repoRoot, options);
      if (!canonicalAppeared && options.ticket === appeared.ticket && current === null) {
        canonicalAppeared = true;
        const record = authority.readRecord();
        originalBootstrap(repoRoot, { remote: "origin", ticket: appeared.ticket, owner: DOMAIN_C_HANDLE, authorityEpoch: record.authority_epoch });
      }
      return current;
    } }, () => {
      assert.throws(() => runSelect(appeared), (error) => {
        assert.match(error.message, /canonical COORD-1043 appeared/);
        assertAbandoned(appeared);
        return true;
      });
    });
    assert.equal(canonicalAppeared, true);
    const appearedCanonical = originalRead(root, { remote: "origin", ticket: appeared.ticket });
    assert.equal(appearedCanonical.record.generation, 0, "the concurrently appeared bootstrap remains unchanged");
    assert.equal(appearedCanonical.record.owner, DOMAIN_C_HANDLE, "the bootstrap winner's owner remains intact");

    const missing = scenarios.find((scenario) => scenario.race === "missing");
    const missingCanonical = originalBootstrap(root, { remote: "origin", ticket: missing.ticket, owner: DOMAIN_C_HANDLE, authorityEpoch: authority.readRecord().authority_epoch });
    let canonicalRemoved = false;
    withPatched({ readCanonical(repoRoot, options) {
      const current = originalRead(repoRoot, options);
      if (!canonicalRemoved && options.ticket === missing.ticket && current) {
        canonicalRemoved = true;
        const ref = `refs/heads/coord-state/canonical/${missing.ticket}`;
        const removed = spawnSync("git", ["--git-dir", remote, "update-ref", "-d", ref], { encoding: "utf8" });
        assert.equal(removed.status, 0, removed.stderr);
      }
      return current;
    } }, () => {
      assert.throws(() => runSelect(missing), (error) => {
        assert.match(error.message, /canonical COORD-1044 is absent/);
        assertAbandoned(missing);
        return true;
      });
    });
    assert.ok(missingCanonical.oid);
    assert.equal(canonicalRemoved, true);
    assert.equal(originalRead(root, { remote: "origin", ticket: missing.ticket }), null, "the externally removed canonical ref remains absent");

    const stale = scenarios.find((scenario) => scenario.race === "stale");
    const staleCanonical = originalBootstrap(root, { remote: "origin", ticket: stale.ticket, owner: DOMAIN_C_HANDLE, authorityEpoch: authority.readRecord().authority_epoch });
    let canonicalAdvanced = false;
    withPatched({ readCanonical(repoRoot, options) {
      const current = originalRead(repoRoot, options);
      if (!canonicalAdvanced && options.ticket === stale.ticket && current) {
        canonicalAdvanced = true;
        const published = originalPublish(repoRoot, { remote: "origin", ticket: stale.ticket, expected: current,
          next: { ...current.record, generation: current.record.generation + 1, updated_at: new Date().toISOString() } });
        assert.equal(published.status, "published");
      }
      return current;
    } }, () => {
      assert.throws(() => runSelect(stale), (error) => {
        assert.match(error.message, /canonical COORD-1045 fence refused \(stale\)/);
        assertAbandoned(stale);
        return true;
      });
    });
    assert.ok(staleCanonical.oid);
    assert.equal(canonicalAdvanced, true);
    assert.equal(originalRead(root, { remote: "origin", ticket: stale.ticket }).record.generation, 1,
      "a genuine concurrent canonical generation remains intact after the refused select");

    const publishRefused = scenarios.find((scenario) => scenario.race === "publish-refused");
    let canonicalAdvancedBeforePublish = false;
    withPatched({ verifyFence(repoRoot, options) {
      const verified = originalVerify(repoRoot, options);
      if (!canonicalAdvancedBeforePublish && verified.ok && options.ticket === publishRefused.ticket) {
        canonicalAdvancedBeforePublish = true;
        const current = originalRead(repoRoot, { remote: "origin", ticket: publishRefused.ticket });
        const published = originalPublish(repoRoot, { remote: "origin", ticket: publishRefused.ticket, expected: current,
          next: { ...current.record, generation: current.record.generation + 1, updated_at: new Date().toISOString() } });
        assert.equal(published.status, "published");
      }
      return verified;
    } }, () => {
      assert.throws(() => runSelect(publishRefused), (error) => {
        assert.match(error.message, /moved or refused the lease/);
        assertAbandoned(publishRefused);
        return true;
      });
    });
    assert.equal(canonicalAdvancedBeforePublish, true);
    assert.equal(originalRead(root, { remote: "origin", ticket: publishRefused.ticket }).record.generation, 1,
      "the competing lease winner remains intact after the select refuses to publish");

    for (const [race, refusal] of [
      ["removed-before-fence", /fence refused .*current token absent/],
      ["removed-before-publish", /moved or refused the lease .*current holder absent/],
    ]) {
      const scenario = scenarios.find((item) => item.race === race);
      const initial = originalBootstrap(root, { remote: "origin", ticket: scenario.ticket,
        owner: DOMAIN_C_HANDLE, authorityEpoch: authority.readRecord().authority_epoch });
      const ref = `refs/heads/coord-state/canonical/${scenario.ticket}`;
      const removeCanonical = () => gitFixture(remote, ["update-ref", "-d", ref, initial.oid]);
      withPatched({ verifyFence(repoRoot, options) {
        if (race === "removed-before-fence") removeCanonical();
        const result = originalVerify(repoRoot, options);
        if (race === "removed-before-publish") {
          assert.equal(result.ok, true);
          removeCanonical();
        }
        return result;
      } }, () => assert.throws(() => runSelect(scenario), refusal));
      assertAbandoned(scenario);
      assert.equal(originalRead(root, { remote: "origin", ticket: scenario.ticket }), null,
        "selection must preserve the concurrent removal without creating a replacement");
    }
  });
});

test("COORD-1041 (d): a handed-off holder's select is refused by the epoch fence until the canonical record is re-established", (t) => {
  const remote = bareRemote(t);
  const b = publishFrom(remote, DOMAIN_B_HANDLE, "tx-epoch-b");
  const c = publishFrom(remote, DOMAIN_C_HANDLE, "tx-epoch-c");

  withCanonicalAuthorityContext(({ git, commands, setThread, eventLogPath }) => {
    git("remote", "add", "origin", remote);
    setThread("thread-old");
    commands.integrationCommand(["claim"]);
    commands.integrationCommand(["select", TICKET, "--attempt", b.attempt_id, "--json"]);

    commands.integrationCommand(["handoff", "--to", WORKER, "--human-admin-override", "epoch fence regression"]);
    assert.equal(authority.readRecord().authority_epoch, 2, "a handoff moved the authority to epoch 2");

    setThread("thread-new");
    const refusedMessage = /canonical authority epoch 1 differs from the holder's epoch 2/;
    assert.throws(() => commands.integrationCommand(["select", TICKET, "--attempt", c.attempt_id]), refusedMessage,
      "the new holder cannot select on canonical state decided under the previous epoch");
    const intents = eventsOf(eventLogPath, "integration-canonical-transition-intent");
    assert.equal(intents.length, 1, "a refusal before the intent is journaled journals no intent for the refused select");
    const still = commands.integrationCommand(["attempts", TICKET, "--json"]);
    assert.equal(still.canonical.record.generation, 1, "the refused select moved no canonical generation");
  });
});

test("COORD-1041 (d): select refuses competing authority and invalid, inactive or unpublished attempts", (t) => {
  const remote = bareRemote(t);
  const b = publishFrom(remote, DOMAIN_B_HANDLE, "tx-refuse-b");
  const withdrawn = publishFrom(remote, DOMAIN_C_HANDLE, "tx-refuse-withdrawn", TICKET, { state: "withdrawn" });

  withCanonicalAuthorityContext(({ root, git, commands, setThread, eventLogPath }) => {
    git("remote", "add", "origin", remote);
    setThread("thread-new");
    assert.throws(() => commands.integrationCommand(["select", TICKET, "--attempt", b.attempt_id]), /does not hold integration authority/,
      "a session that holds no integration authority cannot select");
    setThread("thread-old");
    commands.integrationCommand(["claim"]);
    assert.throws(() => commands.integrationCommand(["select", TICKET, "--attempt", "f".repeat(32)]), /is not published for COORD-1041/,
      "an attempt that is not on the remote cannot be selected");
    setThread("thread-new");
    assert.throws(() => commands.integrationCommand(["select", TICKET, "--attempt", b.attempt_id]),
      new RegExp(`does not hold integration authority.*${ORCH}`));
    setThread("thread-old");
    assert.throws(() => commands.integrationCommand(["select", TICKET, "--attempt", withdrawn.attempt_id]), /is withdrawn, not active/);
    assert.throws(() => commands.integrationCommand(["select", TICKET, "--attempt", b.attempt_id, "--reject", "e".repeat(32)]), /needs a --reason/,
      "a rejection without a reason is refused before any journal event");
    assert.throws(() => commands.integrationCommand(["select", TICKET, "--attempt", b.attempt_id,
      "--reject", "e".repeat(32), "--reason", "not observed on the remote"]), /rejected attempt .* is not published/);
    commands.integrationCommand(["begin", TICKET]);
    assert.throws(() => commands.integrationCommand(["select", TICKET, "--attempt", b.attempt_id]), /operation .* is open/);
    assert.equal(attemptCoordination.readCanonical(root, { remote: "origin", ticket: TICKET }), null);
    assert.deepEqual(eventsOf(eventLogPath, "integration-canonical-transition-intent"), []);
  });
});


test("COORD-1052: integration parser and select preflight reject malformed controls without journaling", () => {
  assert.throws(() => parseArgs(["--reject"]), /--reject requires an attempt id/);
  assert.throws(() => parseArgs(["--reason"]), /--reason requires a value/);
  assert.throws(() => parseArgs(["--reason", "unattached"]), /--reason must follow/);
  assert.throws(() => parseArgs(["--reject", "a".repeat(32), "--reason", "first", "--reason", "second"]), /--reason must follow/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown flag/);

  withCanonicalAuthorityContext(({ commands, eventLogPath }) => {
    assert.throws(() => commands.integrationCommand(["attempts"]), /attempts requires <ticket-id>/);
    assert.throws(() => commands.integrationCommand(["select"]), /select requires <ticket-id>/);
    assert.throws(() => commands.integrationCommand(["select", TICKET]), /select requires --attempt/);
    const sameAttempt = "a".repeat(32);
    assert.throws(() => commands.integrationCommand(["select", TICKET, "--attempt", sameAttempt,
      "--reject", sameAttempt, "--reason", "not a separate rejection"]), /cannot be both selected and rejected/);
    assert.equal(fs.existsSync(eventLogPath), false, "syntax/preflight refusals happen before any authority journal write");
  });
});

test("COORD-1052: first canonical selection records an unassigned fallback when the board is unreadable", (t) => {
  const remote = bareRemote(t);
  const published = publishFrom(remote, DOMAIN_B_HANDLE, "tx-unreadable-board-fallback");
  withCanonicalAuthorityContext(({ root, git, commands, setThread, boardPath }) => {
    git("remote", "add", "origin", remote);
    setThread("thread-old");
    commands.integrationCommand(["claim"]);
    const malformedBoard = "{malformed board bytes\n";
    fs.writeFileSync(boardPath, malformedBoard);
    const originalBootstrap = attemptCoordination.bootstrapCanonical;
    let bootstrapOwner = null;
    attemptCoordination.bootstrapCanonical = (repoRoot, options) => {
      if (options.ticket === TICKET) bootstrapOwner = options.owner;
      return originalBootstrap(repoRoot, options);
    };
    let selected;
    try {
      selected = commands.integrationCommand(["select", TICKET, "--attempt", published.attempt_id, "--json"]);
    } finally {
      attemptCoordination.bootstrapCanonical = originalBootstrap;
    }
    assert.equal(bootstrapOwner, "unassigned", "unreadable ticket ownership has a fail-safe canonical bootstrap owner");
    assert.equal(selected.selected, published.attempt_id);
    assert.equal(attemptCoordination.readCanonical(root, { remote: "origin", ticket: TICKET }).record.owner, DOMAIN_B_HANDLE);
    assert.equal(fs.readFileSync(boardPath, "utf8"), malformedBoard, "selection never repairs or rewrites the unreadable board");
  });
});

test("COORD-1052: sparse ownership and older canonical records preserve selection provenance", (t) => {
  const remote = bareRemote(t);
  const sparseTickets = ["COORD-1061", "COORD-1062"];
  const oldTicket = "COORD-1063";
  const [withoutSections, withoutOwner, legacy] = [...sparseTickets, oldTicket].map((ticket) =>
    publishFrom(remote, DOMAIN_B_HANDLE, `tx-${ticket}`, ticket));

  withCanonicalAuthorityContext(({ root, git, commands, setThread, boardPath, eventLogPath }) => {
    git("remote", "add", "origin", remote);
    setThread("thread-old");
    commands.integrationCommand(["claim"]);
    const select = (ticket, attempt) => commands.integrationCommand(["select", ticket, "--attempt", attempt.attempt_id, "--json"]);
    for (const [ticket, attempt, board] of [
      [sparseTickets[0], withoutSections, {}],
      [sparseTickets[1], withoutOwner, { sections: [{}, { rows: [{ ID: sparseTickets[1] }] }] }],
    ]) {
      const bytes = JSON.stringify(board);
      fs.writeFileSync(boardPath, bytes);
      assert.equal(select(ticket, attempt).generation, 1);
      assert.equal(fs.readFileSync(boardPath, "utf8"), bytes);
      const canonical = attemptCoordination.readCanonical(root, { remote: "origin", ticket });
      const parent = gitFixture(remote, ["show", `${canonical.oid}^:${attemptCoordination.RECORD_FILE}`]);
      assert.equal(JSON.parse(parent).owner, "unassigned");
    }

    const initial = attemptCoordination.bootstrapCanonical(root, { remote: "origin", ticket: oldTicket,
      owner: DOMAIN_C_HANDLE, authorityEpoch: authority.readRecord().authority_epoch });
    const { rejected_attempts, ...legacyRecord } = initial.record;
    assert.deepEqual(rejected_attempts, []);
    const advanced = attemptCoordination.publishCanonicalTransition(root, { remote: "origin", ticket: oldTicket,
      expected: initial, next: { ...legacyRecord, generation: 1 } });
    assert.equal(advanced.status, "published");
    assert.equal(attemptCoordination.readCanonical(root, { remote: "origin", ticket: oldTicket }).record.rejected_attempts, undefined);
    assert.equal(select(oldTicket, legacy).generation, 2);
    const result = attemptCoordination.readCanonical(root, { remote: "origin", ticket: oldTicket });
    assert.equal(result.record.selected_attempt, legacy.attempt_id);
    assert.deepEqual(result.record.rejected_attempts, []);
    const selection = eventsOf(eventLogPath, "integration-attempt-selection").at(-1);
    assert.equal(selection.details.bootstrapped, false);
    assert.match(selection.details.token_before, /^COORD-1063@1:/);
  });
});
