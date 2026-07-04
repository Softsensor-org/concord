"use strict";

module.exports = function createLifecycleGateCodeCommands({
  gatePlan,
  fail,
  getTicketRef,
  readBoard,
  readPlanRecord,
  readPlanState,
  toArray,
  updatePlanBlock,
}) {
  function gatePlanCommand(ticketId, options = {}) {
    if (!ticketId) {
      fail("gate-plan requires <ticket-id>.");
    }
    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }
    const planState = readPlanRecord(ticketId, { allowMissing: true }) || readPlanState(ticketId) || {};
    const receipt = gatePlan.buildGatePlanReceipt({
      ticketId,
      row: ref.row,
      planState,
      files: options.files,
      mapPath: options.mapPath,
      full: options.full === true,
      riskClass: options.riskClass || toArray(options.risk)[0],
      trackOverride: options.trackOverride,
    });
    if (options.write) {
      updatePlanBlock(ticketId, {
        gatePlan: JSON.stringify(receipt),
      });
    }
    if (options.md) {
      console.log(gatePlan.renderMarkdown(receipt).trimEnd());
    } else {
      console.log(JSON.stringify(receipt, null, 2));
    }
    return receipt;
  }

  function codeIndexCommand(options = {}) {
    return require("./code-context.js").codeIndexCommand(options);
  }

  function codeSearchCommand(query, options = {}) {
    return require("./code-context.js").codeSearchCommand(query, options);
  }

  function codeContextCommand(filePaths, options = {}) {
    return require("./code-context.js").codeContextCommand(filePaths, options);
  }

  function codeDiffCommand(baseRef, options = {}) {
    return require("./code-context.js").codeDiffCommand(baseRef, options);
  }

  return {
    codeContextCommand,
    codeDiffCommand,
    codeIndexCommand,
    codeSearchCommand,
    gatePlanCommand,
  };
};
