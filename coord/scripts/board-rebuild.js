"use strict";

// COORD-091 (Wave 4 residual): the board-rebuild-from-journal surface extracted
// from lifecycle.js to bring the composition root back under the arch size
// budget. This module owns ONE cohesive capability: replaying the governance
// event journal to repair board/tasks.json rows whose Status/Owner drifted away
// from the journal's terminal (succeeded, after_status-bearing) event.
//
// BOUNDARY: this module never appends to the journal and never decides mutation
// policy — it READS the journal (readGovernanceEventLog) and the board
// (readBoard / getTicketRef), and writes the board (writeBoard) only inside the
// withGovernanceMutation envelope injected from the journal factory. All of
// those collaborators are INJECTED via the createBoardRebuild factory so the
// module stays free of lifecycle wiring order: lifecycle.js wires this factory
// AFTER createJournal (which produces readGovernanceEventLog /
// withGovernanceMutation) and createGovernanceBoardState (readBoard / writeBoard
// / getTicketRef).
//
// terminalJournalStatusForTicket and collectTicketsWithJournalDrift default
// their journal/board args via the injected readers so direct callers (and the
// existing __testing facade contract) can invoke them with no arguments exactly
// as before the move.

module.exports = function createBoardRebuild(deps = {}) {
  const {
    fail,
    withGovernanceMutation,
    readGovernanceEventLog,
    readBoard,
    getTicketRef,
    writeBoard,
  } = deps;

  function terminalJournalStatusForTicket(ticketId, journal = readGovernanceEventLog()) {
    // Scan the journal newest-first for a succeeded event that asserts an after_status.
    // Returns { status, owner, ts, command } or null.
    for (let i = journal.length - 1; i >= 0; i -= 1) {
      const event = journal[i];
      if (!event || event.ticket !== ticketId) continue;
      if (event.result && event.result !== "succeeded") continue;
      if (!event.after_status) continue;
      return {
        status: event.after_status,
        owner: event.identity?.owner || null,
        ts: event.ts,
        command: event.command,
      };
    }
    return null;
  }

  function collectTicketsWithJournalDrift(journal = readGovernanceEventLog(), board = readBoard()) {
    const seen = new Set();
    const drifted = [];
    for (let i = journal.length - 1; i >= 0; i -= 1) {
      const event = journal[i];
      if (!event || !event.ticket || seen.has(event.ticket)) continue;
      if (event.result && event.result !== "succeeded") continue;
      if (!event.after_status) continue;
      seen.add(event.ticket);
      const ref = getTicketRef(board, event.ticket);
      if (!ref) {
        // Row missing entirely — qualifies as drift (even though rebuild-board v1 cannot
        // reconstruct the row metadata, reporting it is useful).
        drifted.push(event.ticket);
        continue;
      }
      if (ref.row.Status !== event.after_status) {
        drifted.push(event.ticket);
      }
    }
    return drifted;
  }

  function rebuildBoardFromJournal(ticketArg, options = {}) {
    const ticketId = ticketArg && !String(ticketArg).startsWith("--") ? String(ticketArg).trim() : null;
    const mode = options.all === true ? "all" : "single";
    if (mode === "single" && !ticketId) {
      fail("rebuild-board requires <ticket-id> or --all.");
    }

    const mutation = { command: "rebuild-board", ticket: ticketId, allowRecoverableProvenanceDrift: true };
    return withGovernanceMutation(mutation, () => {
      const journal = readGovernanceEventLog();
      const board = readBoard();

      const ticketIdsToReplay = mode === "all"
        ? collectTicketsWithJournalDrift(journal, board)
        : [ticketId];

      if (ticketIdsToReplay.length === 0) {
        console.log(JSON.stringify({ ticket: ticketId, mode, repaired: [], unchanged: [], failed: [], note: "No drift detected." }, null, 2));
        return;
      }

      const repaired = [];
      const unchanged = [];
      const failed = [];

      for (const id of ticketIdsToReplay) {
        const terminal = terminalJournalStatusForTicket(id, journal);
        if (!terminal) {
          failed.push({ ticket: id, reason: "no succeeded status events in journal" });
          continue;
        }

        const ref = getTicketRef(board, id);
        if (!ref) {
          failed.push({
            ticket: id,
            reason:
              "row is missing from board/tasks.json; the journal alone does not carry the original repo/type/pri/description metadata. " +
              "Recover by re-running gov open-followup, or by reading the row from git history of board/tasks.json and manually reinserting.",
          });
          continue;
        }

        const row = ref.row;
        if (row.Status === terminal.status && (!terminal.owner || row.Owner === terminal.owner)) {
          unchanged.push({ ticket: id, status: row.Status });
          continue;
        }

        const before = { Status: row.Status, Owner: row.Owner };
        row.Status = terminal.status;
        if (terminal.owner) {
          row.Owner = terminal.owner;
        }
        repaired.push({
          ticket: id,
          before,
          after: { Status: row.Status, Owner: row.Owner },
          journal_event_ts: terminal.ts,
          journal_event_command: terminal.command,
        });
      }

      if (repaired.length > 0) {
        writeBoard(board);
      }

      mutation.details = { repaired: repaired.length, unchanged: unchanged.length, failed: failed.length };
      console.log(JSON.stringify({ ticket: ticketId, mode, repaired, unchanged, failed }, null, 2));

      if (failed.length > 0 && mode === "single") {
        // Surface a non-zero exit when the caller asked for a single-ticket repair but it
        // could not be applied (usually missing-row case). --all is best-effort and swallows
        // individual failures so batch repair continues.
        fail(failed[0].reason);
      }
    });
  }

  return {
    rebuildBoardFromJournal,
    terminalJournalStatusForTicket,
    collectTicketsWithJournalDrift,
  };
};
