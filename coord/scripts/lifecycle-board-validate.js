"use strict";

module.exports = function createLifecycleBoardValidate({
  BoardValidationError,
  fail,
  state,
  validateBoardState,
}) {
  function runBoardValidate(options = {}) {
    try {
      validateBoardState({
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

  return {
    runBoardValidate,
  };
};
