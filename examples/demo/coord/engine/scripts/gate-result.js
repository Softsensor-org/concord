"use strict";

// COORD-279 (item 6): shared gate-result shaping. The analytics/content/infra
// track gates each independently built the SAME final report object — count the
// failed checks, derive a pass/fail verdict, and format a `<label> gate
// pass/fail: ...` summary. That duplication meant a tweak to the report shape had
// to be made in three places and could silently diverge. This helper is the ONE
// canonical shaper; each gate supplies only what differs (gateProc, track, its
// subject field, and the human label). Behaviour is byte-identical to the prior
// inlined blocks — pure de-duplication, no semantic change.
//
// shapeGateResult({ gateProc, track, label, subject, checks, artifactPaths })
//   gateProc      — gate-proc identifier (e.g. "content", "infra", "evidence")
//   track         — track name (e.g. "marketing", "devops", "product-engineering")
//   label         — human label used in the summary string; defaults to gateProc
//   subject       — gate-specific identity fields spread in after track
//                   (e.g. { site }, { target }, { ticket }); preserves key order
//   checks        — the array of { name, result, detail } check records
//   artifactPaths — emitted artifact paths
function shapeGateResult({
  gateProc,
  track,
  label = gateProc,
  subject = {},
  checks = [],
  artifactPaths = [],
}) {
  const failed = checks.filter((c) => c && c.result === "fail");
  return {
    gateProc,
    track,
    ...subject,
    result: failed.length === 0 ? "pass" : "fail",
    checks,
    artifact_paths: artifactPaths,
    summary:
      failed.length === 0
        ? `${label} gate pass: ${checks.length} check(s) ok`
        : `${label} gate fail: ${failed.length}/${checks.length} check(s) failed`,
  };
}

module.exports = { shapeGateResult };
