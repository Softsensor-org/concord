"use strict";

// COORD-691 round 1 review, finding 2 — reading back a push this ticket already
// performed.
//
// THE CASE THIS EXISTS FOR. A governed pre-closeout push succeeds, and closeout
// then fails downstream (cleanup, mark-done). The board rolls back; the REMOTE
// does not. On retry, the ancestry test passes, so no push is needed and none
// happens — and if the landing record simply carried no receipt, the surviving
// evidence would say the remote always had the commit. That is a false record
// of an irreversible act, which is the failure mode the receipt exists to
// prevent in the first place.
//
// So the retry reads back the effect the previous attempt journaled. The
// journal is the right source: `recordGovernanceExternalSideEffect` attaches
// the effect to the mutation record even when the mutation FAILS, and
// coord/.runtime/governance-events.ndjson is force-tracked in git while the
// rest of that directory is ignored. The board could not be the source — it is
// exactly what got rolled back.
//
// Read-only and best-effort by design: a landing must not be refused because
// history could not be re-read. A missing history yields null, and the caller
// then records what it can actually observe.

const fs = require("fs");
const path = require("path");
const { COORD_DIR } = require("./governance-context.js");

const PUSH_EFFECT_TYPE = "control_plane_push";

function journalPath(options = {}) {
  return options.journalPath || path.join(COORD_DIR, ".runtime", "governance-events.ndjson");
}

// Newest first: the most recent recorded push for this ticket and commit is the
// one that delivered it.
function findRecordedControlPlanePush(ticketId, commitSha, options = {}) {
  if (!ticketId || !commitSha) return null;
  const file = journalPath(options);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let event;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      continue; // a torn tail is the journal repair path's problem, not this one's
    }
    const effects = event?.details?.external_side_effects;
    if (!Array.isArray(effects)) continue;
    for (const effect of effects) {
      if (
        effect &&
        effect.type === PUSH_EFFECT_TYPE &&
        effect.ticket === ticketId &&
        effect.commit_sha === commitSha
      ) {
        // ROUND 3 REVIEW, finding 2. This used to return "delivered by an
        // earlier governed pre-closeout push" for ANY recorded effect with a
        // matching ticket and commit — including one that explicitly recorded
        // delivered:false / status:"failed". Round 2 widened the recorder to
        // journal every ATTEMPT, which is right, and that made "an effect
        // exists" stop meaning "a push delivered". Attributing delivery to a
        // confirmed failed attempt is a false record of an irreversible act,
        // which is the opposite of what the receipt exists for.
        //
        // Legacy effects (written before round 2) carry no `delivered` field.
        // They were only ever recorded on success, so their status is the
        // authority for them, and absence of the field is not read as failure.
        const recordedDelivery = effect.delivered === undefined
          ? effect.status === undefined || effect.status === "pushed"
          : effect.delivered === true;
        return {
          // Named distinctly from a fresh push: this closeout did NOT push. It
          // is citing what the journal recorded, and conflating the two would
          // misreport which run advanced the remote.
          status: "already_present",
          pushed: false,
          forced: false,
          ref: effect.ref || null,
          remote: effect.remote || null,
          remote_ref: effect.remote_ref || null,
          commit_sha: effect.commit_sha,
          remote_sha_before: effect.remote_sha_before || null,
          remote_sha_after: effect.remote_sha_after || null,
          observed_at: effect.recorded_at || event.ts || null,
          // The recorded outcome is preserved verbatim rather than collapsed
          // into the citation, so a reader can tell "our push delivered this"
          // from "our push failed and the commit got there some other way".
          earlier_attempt: {
            status: effect.status || (recordedDelivery ? "pushed" : "unknown"),
            delivered: recordedDelivery,
            acknowledged: effect.acknowledged !== false,
            ...(effect.ack_lost ? { ack_lost: true } : {}),
            ...(effect.remote_moved === undefined ? {} : { remote_moved: Boolean(effect.remote_moved) }),
          },
          detail: recordedDelivery
            ? (effect.ack_lost
              ? "delivered by an earlier governed pre-closeout push whose acknowledgement was lost " +
                "(recorded in the governance journal); this closeout performed no push"
              : "delivered by an earlier governed pre-closeout push recorded in the governance journal; " +
                "this closeout performed no push")
            : `an earlier governed pre-closeout push for this commit was recorded as ${effect.status || "not delivered"} ` +
              "and did NOT deliver it; the commit is on the remote by some other route, and this closeout " +
              "performed no push",
        };
      }
    }
  }
  return null;
}

module.exports = { PUSH_EFFECT_TYPE, findRecordedControlPlanePush };
