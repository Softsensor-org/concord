const fs = require("fs");
const path = require("path");

function createPromptCoverage(deps) {
  const {
    ROOT_DIR,
    COORD_DIR,
    BOARD_RAW_SYMBOL,
    attachTrackedRaw,
    fail,
    getRepoRoot,
    getTicketRef,
    gitCommitishExists,
    gitPathExistsAtRef,
    gitRefContainsLiteral,
    inferTicketStatus,
    isRepoBackedCode,
    planRecordHasImplicitIntendedFilesScaffoldPlaceholder,
    planRecordPath,
    readBoard,
    readPlanRecord,
    readTicketWaiver,
    repoDisplayNameForCode,
    resolveTicketBaseRef,
    runBoardSync,
    uniqueStrings,
    withCoordStateLock,
    withGovernanceMutation,
    writeBoard,
    writeCanonicalJsonFile,
    writePlanCompatibilityBlockFromRecord,
    writePlanRecordScaffoldPlaceholders,
  } = deps;

  function buildPromptWaiverCommand(ticketId) {
    return `coord/scripts/gov set-waiver ${ticketId} --reason "<why prompt coverage waiver is accepted>"`;
  }

  function hasPromptWaiver(board, ticketId) {
    return Boolean(readTicketWaiver(board, ticketId, "prompt_coverage"));
  }

  function defaultTicketPromptRelPath(ticketId) {
    const abs = path.join(COORD_DIR, "prompts", "tickets", `${ticketId}.md`);
    return path.relative(ROOT_DIR, abs).replace(/\\/g, "/");
  }

  function ticketPromptRelPathExists(relPath) {
    const abs = path.isAbsolute(relPath) ? relPath : path.join(ROOT_DIR, relPath);
    try {
      return fs.statSync(abs).isFile();
    } catch {
      return false;
    }
  }

  function ensurePromptCoverageOrDiscover(board, ticketId) {
    if (board.prompt_index?.[ticketId]) {
      return true;
    }
    if (hasPromptWaiver(board, ticketId)) {
      return true;
    }
    const relPath = defaultTicketPromptRelPath(ticketId);
    if (!ticketPromptRelPathExists(relPath)) {
      return false;
    }
    if (!board.prompt_index || typeof board.prompt_index !== "object") {
      board.prompt_index = {};
    }
    board.prompt_index[ticketId] = relPath;
    withCoordStateLock(() => {
      writeBoard(board);
      runBoardSync({ ignoreActiveTicketLockErrors: true });
    });
    console.log(`[gov] auto-registered on-disk prompt for ${ticketId}: ${relPath}`);
    return true;
  }

  function registerPrompt(ticketId, options = {}) {
    const mutation = {
      command: "register-prompt",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("register-prompt requires <ticket-id>.");
      }
      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }

      let relPath;
      if (options.path) {
        const raw = String(options.path).trim();
        const abs = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
        relPath = path.relative(ROOT_DIR, abs).replace(/\\/g, "/");
      } else {
        relPath = defaultTicketPromptRelPath(ticketId);
      }

      if (!ticketPromptRelPathExists(relPath)) {
        fail(
          `register-prompt: prompt file not found for ${ticketId} at ${relPath}. ` +
          "Create the prompt on disk first, or pass an existing path."
        );
      }

      if (!board.prompt_index || typeof board.prompt_index !== "object") {
        board.prompt_index = {};
      }
      const existing = board.prompt_index[ticketId];
      if (existing) {
        if (existing === relPath) {
          console.log(`register-prompt: ${ticketId} already registered to ${relPath} (idempotent).`);
          return;
        }
        if (!options.force) {
          fail(
            `register-prompt: ${ticketId} is already registered to ${existing}. ` +
            `Pass --force to overwrite with ${relPath}.`
          );
        }
      }

      board.prompt_index[ticketId] = relPath;
      withCoordStateLock(() => {
        writeBoard(board);
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      });
      console.log(`Registered prompt for ${ticketId}: ${relPath}.`);
    });
  }

  function parsePromptPreconditions(promptText) {
    if (typeof promptText !== "string" || !promptText) {
      return [];
    }
    const lines = promptText.split(/\r?\n/);
    let inSection = false;
    const artifacts = [];
    for (const line of lines) {
      const headingMatch = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
      if (headingMatch) {
        const heading = headingMatch[2].trim().toLowerCase();
        if (inSection) {
          inSection = false;
        }
        if (heading === "preconditions" || heading === "existing artifacts") {
          inSection = true;
        }
        continue;
      }
      if (!inSection) {
        continue;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const bulletMatch = /^(?:[-*+]|\d+\.)\s+(.*)$/.exec(trimmed);
      let value = bulletMatch ? bulletMatch[1].trim() : trimmed;
      value = value.replace(/^`+|`+$/g, "").trim();
      value = value.replace(/\s+(?:—|–|--)\s+.*$/, "").trim();
      if (!value) {
        continue;
      }
      if (/^todo\b/i.test(value) || /^\(none\)$/i.test(value) || /^none$/i.test(value)) {
        continue;
      }
      artifacts.push(value);
    }
    return artifacts;
  }

  function parsePromptLikelyFiles(promptText) {
    if (typeof promptText !== "string" || !promptText) {
      return [];
    }
    const lines = promptText.split(/\r?\n/);
    let inSection = false;
    const files = [];
    for (const line of lines) {
      const headingMatch = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
      if (headingMatch) {
        const heading = headingMatch[2].trim().toLowerCase();
        if (inSection) {
          inSection = false;
        }
        if (heading === "likely files") {
          inSection = true;
        }
        continue;
      }
      if (!inSection) {
        continue;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const bulletMatch = /^(?:[-*+]|\d+\.)\s+(.*)$/.exec(trimmed);
      let value = bulletMatch ? bulletMatch[1].trim() : trimmed;
      value = value.replace(/^`+|`+$/g, "").trim();
      value = value.replace(/\s+(?:—|–|--)\s+.*$/, "").trim();
      value = value.replace(/^`+|`+$/g, "").trim();
      if (!value) {
        continue;
      }
      if (/^todo\b/i.test(value) || /^\(none\)$/i.test(value) || /^none$/i.test(value)) {
        continue;
      }
      files.push(value);
    }
    return uniqueStrings(files);
  }

  function readTicketPromptText(ticketId, board) {
    const promptRelPath = board?.prompt_index?.[ticketId];
    if (!promptRelPath) {
      return "";
    }
    const promptAbsPath = path.isAbsolute(promptRelPath)
      ? promptRelPath
      : path.join(ROOT_DIR, promptRelPath);
    try {
      return fs.readFileSync(promptAbsPath, "utf8");
    } catch {
      return "";
    }
  }

  function seedStartIntendedFilesFromPrompt(ticketId, board) {
    const promptText = readTicketPromptText(ticketId, board);
    if (!promptText) {
      return;
    }
    const likelyFiles = parsePromptLikelyFiles(promptText);
    if (likelyFiles.length === 0) {
      return;
    }
    const record = readPlanRecord(ticketId, { allowMissing: true, skipRepairWrite: true });
    if (!record) {
      return;
    }
    if (!planRecordHasImplicitIntendedFilesScaffoldPlaceholder(record)) {
      return;
    }
    const worktreePlaceholders = (record.intended_files || [])
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
    const seededIntendedFiles = uniqueStrings([...worktreePlaceholders, ...likelyFiles]);
    const nextRecord = JSON.parse(JSON.stringify(record));
    nextRecord.intended_files = seededIntendedFiles;
    writePlanRecordScaffoldPlaceholders(nextRecord, "intended_files", seededIntendedFiles);
    const expectedRaw = record[BOARD_RAW_SYMBOL] ?? "";
    writeCanonicalJsonFile(planRecordPath(ticketId), nextRecord, { expectedRaw });
    attachTrackedRaw(nextRecord, BOARD_RAW_SYMBOL, `${JSON.stringify(nextRecord, null, 2)}\n`);
    writePlanCompatibilityBlockFromRecord(ticketId, nextRecord);
  }

  function classifyPreconditionArtifact(raw) {
    const value = String(raw || "").trim();
    if (!value) {
      return { raw, kind: "invalid", reason: "empty precondition" };
    }
    const prefixMatch = /^(path|symbol|route|text):(.*)$/i.exec(value);
    if (prefixMatch) {
      const kind = prefixMatch[1].toLowerCase();
      const remainder = prefixMatch[2].trim();
      if (!remainder) {
        return { raw, kind: "invalid", reason: `missing value after "${kind}:"` };
      }
      if (kind === "path") {
        return { raw, kind: "path", path: remainder };
      }
      if (kind === "route" || kind === "text") {
        return { raw, kind: "literal", text: remainder };
      }
      const hashIndex = remainder.indexOf("#");
      if (hashIndex <= 0 || hashIndex === remainder.length - 1) {
        return { raw, kind: "invalid", reason: 'use "symbol:<repo-relative-path>#<symbol>"' };
      }
      return {
        raw,
        kind: "symbol",
        path: remainder.slice(0, hashIndex).trim(),
        symbol: remainder.slice(hashIndex + 1).trim(),
      };
    }
    if (/^\/\S+$/.test(value) && !value.includes(" ")) {
      return { raw, kind: "literal", text: value };
    }
    if (!value.includes(" ") && /[\\/]/.test(value) && !value.startsWith("/")) {
      return { raw, kind: "path", path: value.replace(/\\/g, "/") };
    }
    return { raw, kind: "literal", text: value };
  }

  function verifyPromptPreconditions(repoRoot, integrationRef, preconditions, options = {}) {
    const checkRefExists = options.gitCommitishExists || gitCommitishExists;
    const pathExists = options.gitPathExistsAtRef || gitPathExistsAtRef;
    const literalExists = options.gitRefContainsLiteral || gitRefContainsLiteral;
    const artifacts = Array.isArray(preconditions) ? preconditions : [];
    const verified = [];
    const unresolved = [];

    if (artifacts.length === 0) {
      return { ok: true, ref: integrationRef, verified, unresolved };
    }

    let resolvedRef = null;
    const candidateRefs = [`origin/${integrationRef}`, integrationRef];
    for (const candidate of candidateRefs) {
      if (checkRefExists(repoRoot, candidate)) {
        resolvedRef = candidate;
        break;
      }
    }
    if (!resolvedRef) {
      for (const artifact of artifacts) {
        unresolved.push({
          raw: artifact,
          reason: `integration ref "${integrationRef}" does not resolve in the target repo`,
        });
      }
      return { ok: false, ref: integrationRef, verified, unresolved };
    }

    for (const artifact of artifacts) {
      const classified = classifyPreconditionArtifact(artifact);
      if (classified.kind === "invalid") {
        unresolved.push({ raw: artifact, reason: classified.reason });
        continue;
      }
      let resolved = false;
      if (classified.kind === "path") {
        resolved = pathExists(repoRoot, resolvedRef, classified.path);
      } else if (classified.kind === "symbol") {
        resolved =
          pathExists(repoRoot, resolvedRef, classified.path) &&
          literalExists(repoRoot, resolvedRef, classified.symbol);
      } else {
        resolved = literalExists(repoRoot, resolvedRef, classified.text);
      }
      if (resolved) {
        verified.push({ raw: artifact, kind: classified.kind });
      } else {
        unresolved.push({
          raw: artifact,
          reason: `not found on ${resolvedRef}`,
        });
      }
    }

    return { ok: unresolved.length === 0, ref: resolvedRef, verified, unresolved };
  }

  function assertPromptPreconditionsResolve(ticketId, row, board, options = {}) {
    const promptRelPath = board?.prompt_index?.[ticketId];
    if (!promptRelPath) {
      return;
    }
    const promptAbsPath = path.isAbsolute(promptRelPath)
      ? promptRelPath
      : path.join(ROOT_DIR, promptRelPath);
    let promptText = "";
    try {
      promptText = fs.readFileSync(promptAbsPath, "utf8");
    } catch {
      return;
    }
    const preconditions = parsePromptPreconditions(promptText);
    if (preconditions.length === 0) {
      return;
    }

    const repoCode = row?.Repo;
    let repoRoot;
    let integrationRef;
    if (isRepoBackedCode(repoCode)) {
      repoRoot = getRepoRoot(repoCode);
      integrationRef = resolveTicketBaseRef(ticketId, row, options);
    } else {
      repoRoot = ROOT_DIR;
      integrationRef = resolveTicketBaseRef(ticketId, row, options);
    }

    const report = verifyPromptPreconditions(repoRoot, integrationRef, preconditions);
    if (!report.ok) {
      const repoLabel = isRepoBackedCode(repoCode) ? repoDisplayNameForCode(repoCode) : "coord";
      const unresolvedList = report.unresolved
        .map((entry) => `  - ${entry.raw} (${entry.reason})`)
        .join("\n");
      fail(
        `Ticket ${ticketId} cannot start: its prompt declares precondition artifacts that do not ` +
        `resolve on ${repoLabel}/${integrationRef}. The prompt is stale — it was likely authored ` +
        `ahead of a dependency that has not landed.\n` +
        `Unresolved preconditions:\n${unresolvedList}\n` +
        `Next: confirm the founding dependency has landed on ${integrationRef}, then update the ` +
        `\`## Preconditions\` section of ${promptRelPath} to match repo reality before retrying ` +
        `\`coord/scripts/gov start ${ticketId}\`.`
      );
    }
  }

  return {
    assertPromptPreconditionsResolve,
    buildPromptWaiverCommand,
    classifyPreconditionArtifact,
    defaultTicketPromptRelPath,
    ensurePromptCoverageOrDiscover,
    hasPromptWaiver,
    parsePromptLikelyFiles,
    parsePromptPreconditions,
    registerPrompt,
    seedStartIntendedFilesFromPrompt,
    ticketPromptRelPathExists,
    verifyPromptPreconditions,
  };
}

module.exports = createPromptCoverage;
