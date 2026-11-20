"use strict";
const createQuestionResolution = require("./question-resolution.js");

// Wire the mutation command after the journal. The question readers and raw
// append writer are also journal dependencies, so keeping them separate avoids
// a circular initialization dependency in the composition root.
module.exports = function createQuestionCommands(deps) {
  const { withGovernanceMutation, appendQuestionRow, fail } = deps;
  const { resolveQuestion } = createQuestionResolution(deps);
  function logQuestion(options) {
    if (!options.from || !options.to || !options.question || !options.resolved) {
      fail("log-question requires --from, --to, --question, and --resolved.");
    }
    if (!["yes", "no", "n/a"].includes(options.resolved)) {
      fail("log-question --resolved must be yes, no, or n/a.");
    }
    if (options.resolved !== "no" && !String(options.answer ?? "").trim()) {
      fail("log-question --answer is required for --resolved yes or n/a.");
    }

    return withGovernanceMutation({ command: "log-question" }, () => {
      appendQuestionRow({ ...options, answer: options.answer ?? "" });
      console.log(`Appended QUESTIONS.md row.`);
    });
  }

  return { logQuestion, resolveQuestion };
};
