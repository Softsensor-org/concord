"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { decide } = require("./runtime-authority-decision.js");

// COORD-930: the barrier's canonical coord dir is its own install location. A
// fixture therefore installs a copy of the entry hook under its coord/engine/scripts;
// every other engine module is a symlink to the real file, so there is one source.
function installAuthorityHook(coordDir) {
  const scripts = path.join(coordDir, "engine", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  for (const entry of fs.readdirSync(__dirname)) {
    if (entry !== "runtime-authority-hook.js") fs.symlinkSync(path.join(__dirname, entry), path.join(scripts, entry));
  }
  fs.copyFileSync(path.join(__dirname, "runtime-authority-hook.js"), path.join(scripts, "runtime-authority-hook.js"));
  fs.symlinkSync(path.join(__dirname, "..", "..", "paths.js"), path.join(coordDir, "paths.js"));
  return path.join(scripts, "runtime-authority-hook.js");
}

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "concord-cwd-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "canonical repo"), outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "coord", "board"), { recursive: true });
  fs.mkdirSync(outside);
  const worktree = path.join(root, "coord", ".worktrees", "owner", "TEST-1");
  fs.mkdirSync(worktree, { recursive: true });
  const lock = { ticket: "TEST-1", owner: "owner", worktree, status: "doing" };
  const run = (cwd, command, overrides = {}) => decide({
    cwd, workspaceRoot: root, locks: { active: [lock], unreadable: [] },
    actor: { resolved: false, owner: null }, realpath: fs.realpathSync,
    payload: { tool_name: "Bash", tool_input: { command } }, ...overrides,
  });
  return { root, outside, worktree, run };
}

test("COORD-688: actual guard denies cd-prefixed canonical relative writes", t => {
  const { root, outside, run } = fixture(t);
  for (const command of [
    `cd '${root}' && printf x >> coord/board/tasks.json`,
    `cd -- '${root}' && printf x > './coord/board/tasks.json'`,
    `pushd '${root}' && printf x | tee coord/board/tasks.json`,
    `builtin cd '${root}' && sed -i s/x/y/ coord/board/tasks.json`,
    `command cd '${root}' && printf x >> coord/board/tasks.json`,
    `c\\\nd '${root}' && printf x >> coord/board/tasks.json`,
    `"c\\\nd" '${root}' && printf x >> coord/board/tasks.json`,
    `time cd '${root}' && printf x >> coord/board/tasks.json`,
    `> '${outside}/log' cd '${root}' && printf x >> coord/board/tasks.json`,
    `2> '${outside}/log' builtin cd '${root}' && printf x >> coord/board/tasks.json`,
    `cd '${root}' && cd ./coord && printf x >> board/tasks.json`,
    `cd '${root}' ; printf x >> coord/board/tasks.json`,
    `(cd '${root}' && printf x >> coord/board/tasks.json)`,
  ]) assert.equal(run(outside, command).decision, "deny", command);
  assert.equal(run(root, "printf x >> coord/board/tasks.json").decision, "deny");
  assert.equal(run(outside, `printf x >> '${root}/coord/board/tasks.json'`).decision, "deny");
});

test("COORD-688: successful literal directory chains classify actual outside and worktree targets", t => {
  const { root, outside, worktree, run } = fixture(t);
  assert.equal(run(root, `cd '${outside}' && printf x >> coord/board/tasks.json`).decision, "allow");
  assert.equal(run(root, `cd '${worktree}' && printf x >> coord/board/tasks.json`).decision, "allow");
  assert.equal(run(root, `cd '${worktree}' && printf x >> coord/board/tasks.json`, {
    actor: { resolved: true, owner: "other" },
  }).code, "shell_foreign_worktree_write");
  assert.equal(run(outside, `cd '${root}' && cd '${outside}' && printf x >> coord/board/tasks.json`).decision, "allow");
  // Redirection attached to cd occurs BEFORE the directory change.
  assert.equal(run(root, `cd '${outside}' > coord/board/tasks.json`).decision, "deny");
});

test("COORD-688: unresolved directory changes and conditional failure paths fail closed", t => {
  const { root, outside, run } = fixture(t);
  for (const command of [
    'cd "$destination" && printf x >> arbitrary.txt',
    "cd && printf x >> arbitrary.txt",
    "cd - && printf x >> arbitrary.txt",
    "cd relative-name && printf x >> arbitrary.txt",
    "popd && printf x >> arbitrary.txt",
    `cd '${outside}' || printf x >> coord/board/tasks.json`,
    `cd '${outside}' ; printf x >> coord/board/tasks.json`,
    `! cd '${outside}/missing' && printf x >> coord/board/tasks.json`,
    `if true; then cd '${root}'; fi; printf x >> coord/board/tasks.json`,
    `if cd '${root}'; then printf x >> coord/board/tasks.json; fi`,
    `case x in x) cd '${root}';; esac; printf x >> coord/board/tasks.json`,
    `case x in x) 'cd' '${root}';; esac; printf x >> coord/board/tasks.json`,
  ]) assert.equal(run(root, command).decision, "deny", command);
  assert.equal(run(outside, 'cd "$destination" && printf x >> arbitrary.txt').decision, "deny");
  assert.equal(run(outside, `case x in x) 'cd' '${root}';; esac; printf x >> coord/board/tasks.json`).decision, "deny");
  assert.equal(run(outside, `cd "$destination" && printf x >> '${outside}/safe.txt'`).decision, "allow");
  assert.equal(run(outside, `cd '${root}' && printf x >> coord/board/tasks.json`, {
    locks: { active: [], unreadable: [] },
  }).decision, "allow");
});

test("COORD-688: directory aliases still use the canonical real-path classification", t => {
  const { root, outside, run } = fixture(t);
  const link = path.join(outside, "alias");
  fs.symlinkSync(root, link, "dir");
  assert.equal(run(outside, `cd '${link}' && printf x >> coord/board/tasks.json`).decision, "deny");
  const coordLink = path.join(outside, "coord-alias");
  fs.symlinkSync(path.join(root, "coord"), coordLink, "dir");
  assert.equal(run(outside, `cd '${coordLink}' && printf x >> ../coord/board/tasks.json`).decision, "deny",
    "write traversal starts from the physical directory, not its logical alias");
});

test("COORD-688: installed hook refuses the cd bypass from an outside cwd", t => {
  const { root, outside, worktree } = fixture(t);
  const lockDir = path.join(root, "coord", ".runtime", "locks");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "TEST-1.lock"), JSON.stringify({
    ticket: "TEST-1", owner: "owner", status: "doing", worktree,
  }));
  // COORD-930: the canonical coord dir is the hook's installed location, so the
  // fixture runs its own installed copy and no env var or cwd can redirect it.
  const hook = installAuthorityHook(path.join(root, "coord"));
  const invoke = command => spawnSync(process.execPath, [hook], {
    cwd: outside, encoding: "utf8", input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    env: { ...process.env, TOOL_INPUT: "",
      COORD_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "", CLAUDE_SESSION_ID: "",
      COORD_PROVIDER: "", COORD_INSTANCE_ID: "" },
  });
  const denied = invoke(`cd '${root}' && printf x >> coord/board/tasks.json`);
  assert.equal(denied.status, 2, denied.stderr);
  assert.match(denied.stderr, /CONCORD DENY.*shell_canonical_write/s);
  const allowed = invoke(`cd '${outside}' && printf x >> safe.txt`);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(fs.existsSync(path.join(root, "coord", "board", "tasks.json")), false,
    "hook classifies the command and never executes the write");
});

test("COORD-688: quoted prose and heredoc content do not change the effective directory", t => {
  const { root, outside, run } = fixture(t);
  assert.equal(run(outside, `printf '%s' 'cd ${root} && printf x > coord/board/tasks.json' > notes.txt`).decision, "allow");
  assert.equal(run(outside, `cat <<'EOF' > notes.txt\ncd '${root}' && printf x > coord/board/tasks.json\nEOF\n`).decision, "allow");
});
