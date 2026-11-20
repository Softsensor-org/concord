"use strict";

// COORD-839: a governed landing (finalize, land, finish, mark-done) whose
// in-process workspace integration changes a file under docs/decisions used to
// record the new bytes as the governance baseline in its own event snapshot,
// with no approval check. COORD-722 made a packet-bound human-admin reconcile
// the only way to adopt ADR drift; this binds the landing path to the same
// approved packet.
//
// The workspace merge is irreversible, so the check runs on a PREVIEW of the
// planned integration tree (unreferenced Git objects only; no ref, index or
// working-tree change), before the first merge. Every decision path the
// preview changes must be listed in the packet passed as --expect-paths-file
// with its post-merge sha256, or "absent" for a deletion. Any added, missing or
// changed path refuses. Packet shapes: reconcile-packet.js.

const crypto = require("crypto");
const { parseReconcilePacket } = require("./reconcile-packet.js");
const { classifyDecisionChange } = require("./landing-decision-classifier.js");

const PACKET_OPTION = "--expect-paths-file";
const PREVIEW_IDENTITY = {
  GIT_AUTHOR_NAME: "Concord validation", GIT_AUTHOR_EMAIL: "validation@example.invalid",
  GIT_COMMITTER_NAME: "Concord validation", GIT_COMMITTER_EMAIL: "validation@example.invalid",
};

// The tree the planned workspace merges would produce, merging each tip in
// order onto the previous preview. Shared with prodloc-closeout.js so both
// pre-merge checks judge the same integration.
function previewIntegrationTree(git, headSha, tipShas, { message, onInvalidTree }) {
  let preview = headSha;
  let tree = headSha;
  tipShas.forEach((tip, index) => {
    tree = git(["merge-tree", "--write-tree", "--no-messages", preview, tip]).trim().split("\n")[0];
    if (!/^[a-f0-9]{40,64}$/.test(tree)) onInvalidTree(tree);
    if (index + 1 < tipShas.length) {
      preview = git(["commit-tree", tree, "-p", preview, "-p", tip, "-m", message], {
        env: { ...process.env, ...PREVIEW_IDENTITY },
      }).trim();
    }
  });
  return tree;
}

function decisionsScope(layout) {
  const prefix = layout.coordPathPrefix || "";
  return { prefix, repoPath: prefix ? `${prefix}/docs/decisions` : "docs/decisions" };
}

// Each decision path the integration changes, coord-relative, with the sha256
// of its bytes after the merge ("absent" when the merge deletes it) and the
// COORD-1025 classification of the edit ("metadata" or "body").
function planDecisionChanges({ git, layout, headSha, tipShas, refuse }) {
  if (tipShas.length === 0) return [];
  const tree = previewIntegrationTree(git, headSha, tipShas, {
    message: "Unreferenced decision-packet validation preview",
    // guard:reconcile-approved-packet
    onInvalidTree: () => refuse("the integration preview produced an invalid tree."),
  });
  const scope = decisionsScope(layout);
  const changed = git(["diff-tree", "-r", "-z", "--no-renames", "--name-only", headSha, tree, "--", scope.repoPath])
    .split("\0").filter(Boolean).sort();
  // Text of a regular file at a revision: null when absent, undefined when the
  // entry is not a regular file (the classifier then treats it as body).
  const textAt = (rev, repoPath) => {
    const entry = git(["ls-tree", "-z", "--full-tree", rev, "--", repoPath]).split("\0").filter(Boolean)[0];
    if (!entry) return { entry: null, text: null };
    const match = /^(\d{6}) (\w+) ([a-f0-9]+)\t/.exec(entry);
    if (!match || match[1] !== "100644" && match[1] !== "100755" || match[2] !== "blob") return { entry, text: undefined };
    const bytes = git(["cat-file", "blob", match[3]], { encoding: "buffer" });
    return { entry, text: bytes.toString("utf8"), bytes };
  };
  return changed.map((repoPath) => {
    const after = textAt(tree, repoPath);
    if (after.entry && after.text === undefined) {
      refuse(`${repoPath} in the integration preview is not a regular file (expected mode 100644 or 100755).`);
    }
    const hash = after.entry ? crypto.createHash("sha256").update(after.bytes).digest("hex") : "absent";
    const before = textAt(headSha, repoPath);
    const verdict = classifyDecisionChange({ path: repoPath, oldText: before.text, newText: after.text ?? null });
    return {
      path: scope.prefix ? repoPath.slice(scope.prefix.length + 1) : repoPath,
      sha256: hash,
      kind: verdict.kind,
      reason: verdict.reason,
    };
  });
}

// guard:reconcile-approved-packet
function assertDecisionPacket({ changes, packetText, coordDir, refuse }) {
  if (packetText == null) {
    if (changes.length === 0) return { checked: 0 };
    // COORD-1025: a landing whose every decision change is an ADR metadata-line
    // edit (Status, Date, Supersedes, links, Approval State, README status
    // cells) is admitted without a packet. The classifier verdict is returned
    // as the recorded check. Any body line keeps the packet requirement.
    if (changes.every((change) => change.kind === "metadata")) {
      return { checked: changes.length, metadataOnly: changes.map((change) => ({ path: change.path, sha256: change.sha256 })) };
    }
    const changedPaths = changes.map((change) => change.path);
    const packetLines = changes.map((change) => `${change.sha256} ${change.path}`);
    refuse(
      `the workspace integration changes ${changes.length} decision record(s) under docs/decisions ` +
      `(${changedPaths.join(", ")}), and a landing records those bytes as the governance baseline. ` +
      `An ADR change is adopted only through an approved packet (COORD-722): re-run with ${PACKET_OPTION} <approved packet> ` +
      `listing exactly these paths with their post-merge sha256: ${packetLines.join(", ")}.`
    );
  }
  const packet = parseReconcilePacket(packetText, { coordDir, fail: refuse });
  const planned = new Map(changes.map((change) => [change.path, change.sha256]));
  const unapproved = [...planned.keys()].filter((entry) => !packet.has(entry));
  const unchanged = [...packet.keys()].filter((entry) => !planned.has(entry));
  const differing = [...planned.keys()].filter((entry) => packet.has(entry) && packet.get(entry) !== planned.get(entry))
    .map((entry) => `${entry} (approved ${packet.get(entry)}, after merge ${planned.get(entry)})`);
  const problems = [
    unapproved.length ? `would change decision paths not in the packet: ${unapproved.join(", ")}` : "",
    unchanged.length ? `packet paths the integration does not change: ${unchanged.join(", ")}` : "",
    differing.length ? `bytes differ from the packet: ${differing.join(", ")}` : "",
  ].filter(Boolean);
  if (problems.length) {
    refuse(`the workspace integration's decision changes do not match the approved ${PACKET_OPTION} packet: ${problems.join("; ")}.`);
  }
  return { checked: changes.length };
}

// gitTry(root, args, options) -> spawnSync-shaped result. headSha and tipShas
// are the exact commits the merge will use (the validated tips when planned).
function checkWorkspaceDecisionPacket({ ticketId, layout, gitTry, headSha, tipShas, packetText }) {
  const refuse = (detail) => {
    // guard:reconcile-approved-packet
    throw new Error(`Ticket ${ticketId} landing refused before the workspace merge: ${detail} Nothing was merged or written.`);
  };
  const git = (args, options = {}) => {
    const result = gitTry(layout.coordRepoRoot, args, { maxBuffer: 32 * 1024 * 1024, ...options });
    if (result.status !== 0) {
      const stderr = String(result.stderr || "").trim();
      refuse(`Git ${args[0]} could not preview the decision records the integration changes.${stderr ? ` ${stderr}` : ""}`);
    }
    return options.encoding === "buffer" ? result.stdout : String(result.stdout || "");
  };
  const changes = planDecisionChanges({ git, layout, headSha, tipShas, refuse });
  return assertDecisionPacket({ changes, packetText, coordDir: layout.coordDir, refuse });
}

module.exports = { PACKET_OPTION, previewIntegrationTree, checkWorkspaceDecisionPacket };
