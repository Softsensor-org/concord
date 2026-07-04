function createGovernanceBoardState(deps) {
  const {
    BOARD_RAW_SYMBOL,
    BoardValidationError,
    LEGAL_STATUSES,
    WAIVER_CODES,
    attachTrackedRaw,
    fail,
    normalizeBoardIdentityReferences,
    readCanonicalTextFile,
    state,
    syncBoardArtifacts,
    writeCanonicalTextFile,
  } = deps;

  function readBoard() {
    try {
      const raw = readCanonicalTextFile(state.BOARD_PATH);
      const board = normalizeBoardIdentityReferences(JSON.parse(raw));
      attachTrackedRaw(board, BOARD_RAW_SYMBOL, raw);
      return board;
    } catch (error) {
      fail(`Failed to read ${state.BOARD_PATH}: ${error.message}`);
    }
  }

  function writeBoard(board) {
    const normalized = normalizeBoardIdentityReferences(board);
    const nextRaw = `${JSON.stringify(normalized, null, 2)}\n`;
    const expectedRaw = normalized?.[BOARD_RAW_SYMBOL] ?? board?.[BOARD_RAW_SYMBOL];
    writeCanonicalTextFile(state.BOARD_PATH, nextRaw, { expectedRaw });
    attachTrackedRaw(normalized, BOARD_RAW_SYMBOL, nextRaw);
    if (board && board !== normalized) {
      attachTrackedRaw(board, BOARD_RAW_SYMBOL, nextRaw);
    }
  }

  function getRows(board) {
    return (board.sections || []).flatMap((section) => section.rows || []);
  }

  // COORD-072: shared ID->row index. Single-sources the
  // `new Map(getRows(board).map((row) => [row.ID, row]))` idiom that recurred
  // across validation/transition/worktree readiness checks.
  function rowsById(board) {
    return new Map(getRows(board).map((row) => [row.ID, row]));
  }

  function getTicketRef(board, ticketId) {
    for (const section of board.sections || []) {
      if (!Array.isArray(section.rows)) {
        continue;
      }
      const rowIndex = section.rows.findIndex((candidate) => candidate.ID === ticketId);
      if (rowIndex >= 0) {
        return {
          row: section.rows[rowIndex],
          rowIndex,
          section,
        };
      }
    }
    return null;
  }

  function ensureWaiverIndex(board) {
    if (!board || typeof board !== "object") {
      return {};
    }
    if (!board.waiver_index || typeof board.waiver_index !== "object" || Array.isArray(board.waiver_index)) {
      board.waiver_index = {};
    }
    return board.waiver_index;
  }

  function readTicketWaiver(board, ticketId, code = null) {
    const waiver = ensureWaiverIndex(board)?.[ticketId] || null;
    if (!waiver || typeof waiver !== "object" || Array.isArray(waiver)) {
      return null;
    }
    if (!WAIVER_CODES.has(waiver.code)) {
      return null;
    }
    if (code && waiver.code !== code) {
      return null;
    }
    return waiver;
  }

  function runBoardSync(options = {}) {
    try {
      syncBoardArtifacts({
        ...options,
        ticketScopedValidation:
          options.ticketScopedValidation ??
          Boolean(state.activeGovernanceMutationContext?.metadata?.ticket),
        currentTicketId: options.currentTicketId || state.activeGovernanceMutationContext?.metadata?.ticket || null,
      });
    } catch (error) {
      if (error instanceof BoardValidationError) {
        fail(error.message);
      }
      throw error;
    }
  }

  function isLegalStatus(status) {
    return LEGAL_STATUSES.has(status) || /^doing \(blocked: .+\)$/.test(status);
  }

  function applyTicketStatus(ref, status) {
    ref.row.Status = status;
    return ref.row;
  }

  function assignTicketOwner(ref, owner) {
    ref.row.Owner = owner;
    return ref.row;
  }

  function clearTicketOwner(ref) {
    ref.row.Owner = "unassigned";
    return ref.row;
  }

  function setTicketPrRefs(board, ticketId, refs) {
    if (!board.pr_index || typeof board.pr_index !== "object") {
      board.pr_index = {};
    }
    board.pr_index[ticketId] = refs;
    return board.pr_index[ticketId];
  }

  function ensureLandingIndex(board) {
    if (!board.landing_index || typeof board.landing_index !== "object") {
      board.landing_index = {};
    }
    return board.landing_index;
  }

  function ensureReviewFindings(board, ticketId) {
    if (!board.review_findings || typeof board.review_findings !== "object") {
      board.review_findings = {};
    }
    if (!Array.isArray(board.review_findings[ticketId])) {
      board.review_findings[ticketId] = [];
    }
    return board.review_findings[ticketId];
  }

  function ensurePromptIndex(board) {
    if (!board.prompt_index || typeof board.prompt_index !== "object") {
      board.prompt_index = {};
    }
    return board.prompt_index;
  }

  return {
    applyTicketStatus,
    assignTicketOwner,
    clearTicketOwner,
    ensureLandingIndex,
    ensurePromptIndex,
    ensureReviewFindings,
    ensureWaiverIndex,
    getRows,
    rowsById,
    getTicketRef,
    isLegalStatus,
    readBoard,
    readTicketWaiver,
    runBoardSync,
    setTicketPrRefs,
    writeBoard,
  };
}

module.exports = createGovernanceBoardState;
