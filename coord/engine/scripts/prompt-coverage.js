const { loadProjectConfig, resolveEngineModule } = require("../../paths.js");
const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..", "..");
const fs = require("fs");
const path = require("path");
const { STATUS } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/governance-constants.js"));
const { resolvePromptPath } = require("./prompt-paths.js");
const { createSafeTextInput } = require(resolveEngineModule(
  path.resolve(__dirname, "..", ".."),
  "scripts/safe-text-input.js"
));

// COORD-813: prompt coverage is a content contract, not file presence. These
// module-level helpers are pure (fs reads only) so the start gate, the
// read-only start-readiness preflight, and the prompt generators
// (register-prompt --create here, file-ticket --with-prompt / open-followup in
// ticket-commands.js) share one definition. Scaffold acceptance lines that no
// longer count as criteria, normalized by normalizePromptContentLine:
const GENERIC_PROMPT_ACCEPTANCE_LINES = new Set([
  "ticket scope is implemented",
  "focused verification is recorded in the governed plan",
]);

function normalizePromptContentLine(line) {
  return String(line)
    .trim()
    .replace(/^(?:[-*+]|\d+\.)\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!;:\s]+$/, "")
    .trim()
    .toLowerCase();
}

// Human-admin ruling 2026-10-15 (COORD-837): a placeholder starts with one of a
// fixed set of tokens or is wholly "n/a" or "none". Bracket slot lines such as
// "<fill in>" are deliberately not placeholders.
function isPromptPlaceholderLine(line) {
  const normalized = normalizePromptContentLine(line);
  return /^(?:todo|tbd|tba|fixme|xxx)\b/.test(normalized) || /^(?:n\/a|none)$/.test(normalized);
}

// Required sections: `## Acceptance...` (ticket-specific, no placeholder) and,
// when present, `## Verification` (no placeholder). `## Likely Files` and
// `## Preconditions` stay optional (GOVERNANCE.md "Prompt Preconditions"); their
// TODO stubs never block a start. Whether a prompt with NO acceptance heading
// passes depends on what kind of prompt it is (classifyPromptMapping below):
// a ticket-specific prompt must carry one; a deliberately shared role prompt
// is exempt (human-admin ruling, 2026-10-14).
function parsePromptContentSections(promptText) {
  const sections = [];
  let current = null;
  let inFence = false;
  for (const line of String(promptText).split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
    }
    const headingMatch = inFence ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!headingMatch) {
      if (current && line.trim()) {
        current.lines.push(line.trim());
      }
      continue;
    }
    const level = headingMatch[1].length;
    if (current && level > current.level) {
      continue;
    }
    const heading = headingMatch[2].trim();
    const kind = ["acceptance", "verification"].find((name) => new RegExp(`^${name}\\b`, "i").test(heading));
    current = kind ? { kind, heading, level, lines: [] } : null;
    if (current) {
      sections.push(current);
    }
  }
  return sections;
}

// A line with no letter or digit left after normalisation ("-", "- ...", a
// bare code fence) says nothing, so it is not a criterion.
function isSpecificCriterionLine(line) {
  const normalized = normalizePromptContentLine(line);
  return /[\p{L}\p{N}]/u.test(normalized)
    && !isPromptPlaceholderLine(line)
    && !GENERIC_PROMPT_ACCEPTANCE_LINES.has(normalized);
}

const MISSING_ACCEPTANCE_HEADING_ISSUE =
  "no \"## Acceptance\" heading: a ticket-specific prompt must state this ticket's acceptance criteria " +
  "(only an allowlisted shared role prompt is exempt: an engine-shipped coord/prompts role prompt or a " +
  "coord/project.config.js promptCoverage.rolePrompts entry)";

// `options.requireAcceptanceHeading` is set for ticket-specific prompts only.
function inspectPromptContent(promptText, options = {}) {
  const sections = parsePromptContentSections(promptText);
  const issues = sections.flatMap((section) => section.lines
    .filter(isPromptPlaceholderLine)
    .map((line) => `unresolved placeholder in "## ${section.heading}": ${line}`));
  const acceptance = sections.filter((section) => section.kind === "acceptance");
  if (acceptance.length === 0 && options.requireAcceptanceHeading) {
    issues.push(MISSING_ACCEPTANCE_HEADING_ISSUE);
  }
  if (acceptance.length > 0 && !acceptance.some((section) => section.lines.some(isSpecificCriterionLine))) {
    issues.push(
      `"## ${acceptance[0].heading}" has no ticket-specific criteria ` +
      "(only the generated scaffold text, placeholders, or nothing)"
    );
  }
  return issues;
}

function readPromptFileForContract(promptRelPath, rootDir) {
  if (typeof promptRelPath !== "string") {
    return { issues: ["prompt_index mapping is not a path string"] };
  }
  const promptAbsPath = path.isAbsolute(promptRelPath)
    ? promptRelPath
    : path.join(rootDir, promptRelPath);
  let bytes;
  try {
    if (!fs.statSync(promptAbsPath).isFile()) {
      return { issues: ["prompt path is not a regular file"] };
    }
    bytes = fs.readFileSync(promptAbsPath);
  } catch (error) {
    return { issues: [`prompt file is unreadable (${error.code})`] };
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes) || text.includes("\u0000")) {
    return { issues: ["prompt file is malformed: not valid UTF-8 text"] };
  }
  if (!text.trim()) {
    return { issues: ["prompt file is malformed: empty or whitespace-only"] };
  }
  return { issues: [], text };
}

// COORD-813 (human-admin ruling 2026-10-14): a prompt is a SHARED ROLE PROMPT,
// exempt from the acceptance-heading requirement, only when its resolved path
// is on an explicit, reviewable allowlist:
//   - the role prompts the engine ships (ENGINE_ROLE_PROMPT_FILES) in the
//     role-prompt directory: the canonical coord/prompts/ and the parent of the
//     caller's ticket prompts directory (from defaultTicketPromptRelPath); and
//   - the paths the project lists in coord/project.config.js
//     `promptCoverage.rolePrompts` (workspace-root relative; an entry with a
//     `..` segment, or one resolving outside the workspace root, is ignored).
// Directory placement and how many tickets map a file confer nothing. A
// ticket's own default prompt and anything under a ticket prompts directory
// are NEVER shared, even if listed. Everything else is TICKET-SPECIFIC. The
// allowlist derives only from the shared context's rootDir, so start and the
// read-only preflight classify identically without extra bindings.
const ENGINE_ROLE_PROMPT_FILES = Object.freeze(["implementer.md", "planner.md", "reviewer.md"]);

function readProjectRolePrompts(rootDir) {
  let config = null;
  try {
    // forceDefault: the allowlist binds to THIS workspace's own config, like
    // the prompt files it names, never to a COORD_PROJECT_CONFIG matrix file.
    config = loadProjectConfig(path.join(rootDir, "coord"), { forceDefault: true });
  } catch {
    return [];
  }
  const listed = config?.promptCoverage?.rolePrompts;
  return Array.isArray(listed) ? listed.filter((entry) => typeof entry === "string" && entry.trim()) : [];
}

// COORD-837: the native realpath returns the on-disk spelling (including the
// case the filesystem stores) of a path that exists; a missing path stays
// lexical.
function realPathOrResolved(absPath) {
  try {
    return fs.realpathSync.native(absPath);
  } catch {
    return absPath;
  }
}

function swapLetterCase(text) {
  return [...text].map((char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase())).join("");
}

// COORD-837: case sensitivity is a property of the filesystem, not the
// platform (macOS volumes, Windows directories and WSL mounts each vary), so it
// is probed: the nearest existing ancestor of dirAbs whose name has a letter is
// looked up again with its letter case swapped. The same file answering both
// spellings means the filesystem folds case. No existing lettered ancestor, or
// no file at the swapped spelling, reads as case-sensitive.
function isCaseInsensitiveFs(dirAbs) {
  let candidate = path.resolve(dirAbs);
  for (;;) {
    const base = path.basename(candidate);
    const swapped = swapLetterCase(base);
    let original = null;
    if (swapped !== base) {
      try {
        original = fs.statSync(candidate);
      } catch {
        original = null;
      }
    }
    if (original) {
      try {
        const other = fs.statSync(path.join(path.dirname(candidate), swapped));
        return other.dev === original.dev && other.ino === original.ino;
      } catch {
        return false;
      }
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return false;
    }
    candidate = parent;
  }
}

function comparablePath(absPath, foldCase) {
  return foldCase ? absPath.toLowerCase() : absPath;
}

function isWithinDir(absPath, dirAbs, foldCase = false) {
  const relative = path.relative(comparablePath(dirAbs, foldCase), comparablePath(absPath, foldCase));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// COORD-837: an entry counts only when BOTH its lexical path and its realpath
// are inside the workspace root (the realpath against the root's realpath), so
// a symlink inside the workspace cannot allowlist a file outside it. Entries
// under a tickets directory never reach this set's consumer: classifyPromptMapping
// classifies those as ticket-owned first, on the lexical and the real path.
function buildSharedRolePromptAllowlist(rootDir, ownAbs, foldCase) {
  const root = path.resolve(rootDir);
  const rootReal = realPathOrResolved(root);
  const roleDirs = new Set([path.dirname(path.dirname(ownAbs)), path.join(root, "coord", "prompts")]);
  const listed = [...roleDirs].flatMap((dir) => ENGINE_ROLE_PROMPT_FILES.map((name) => path.join(dir, name)));
  for (const entry of readProjectRolePrompts(root)) {
    const trimmed = entry.trim();
    if (!trimmed.split(/[\\/]+/).includes("..")) {
      listed.push(path.resolve(root, trimmed));
    }
  }
  const allowed = [];
  for (const abs of listed) {
    const real = realPathOrResolved(abs);
    if (isWithinDir(abs, root, foldCase) && isWithinDir(real, rootReal, foldCase)) {
      allowed.push(abs, real);
    }
  }
  return new Set(allowed.map((abs) => comparablePath(abs, foldCase)));
}

// `context.caseInsensitiveFs` (boolean) overrides the probe; it exists so the
// case-folding path is testable on a case-sensitive filesystem.
function classifyPromptMapping(ticketId, promptRelPath, _board, context) {
  const root = path.resolve(context.rootDir);
  const foldCase = typeof context.caseInsensitiveFs === "boolean"
    ? context.caseInsensitiveFs
    : isCaseInsensitiveFs(root);
  const promptAbs = path.resolve(root, String(promptRelPath));
  const ownAbs = path.resolve(root, String(context.defaultTicketPromptRelPath(ticketId)));
  const candidates = [promptAbs, realPathOrResolved(promptAbs)];
  const ownKeys = [ownAbs, realPathOrResolved(ownAbs)].map((abs) => comparablePath(abs, foldCase));
  const ticketDirs = [path.dirname(ownAbs), path.join(root, "coord", "prompts", "tickets")]
    .flatMap((dir) => [dir, realPathOrResolved(dir)]);
  if (candidates.some((candidate) => (
    ownKeys.includes(comparablePath(candidate, foldCase))
    || ticketDirs.some((dir) => isWithinDir(candidate, dir, foldCase))
  ))) {
    return "ticket";
  }
  const allowlist = buildSharedRolePromptAllowlist(root, ownAbs, foldCase);
  return candidates.every((candidate) => allowlist.has(comparablePath(candidate, foldCase))) ? "shared" : "ticket";
}

// Returns { prompt, issues }. A recorded waiver is the only bypass. An unmapped
// ticket is judged on the on-disk default prompt that start would
// auto-register (COORD-023); with neither, the existing coverage gate owns the
// refusal and this reports nothing. `context` carries the caller's bound
// rootDir / hasPromptWaiver / defaultTicketPromptRelPath /
// ticketPromptRelPathExists so start and preflight resolve identically.
function evaluatePromptContent(ticketId, board, context) {
  if (context.hasPromptWaiver(board, ticketId)) {
    return { prompt: null, issues: [] };
  }
  let promptRelPath = board.prompt_index?.[ticketId];
  if (!promptRelPath) {
    const defaultRelPath = context.defaultTicketPromptRelPath(ticketId);
    if (!context.ticketPromptRelPathExists(defaultRelPath)) {
      return { prompt: null, issues: [] };
    }
    promptRelPath = defaultRelPath;
  }
  const read = readPromptFileForContract(promptRelPath, context.rootDir);
  const issues = read.issues.length > 0 ? read.issues : inspectPromptContent(read.text, {
    requireAcceptanceHeading: classifyPromptMapping(ticketId, promptRelPath, board, context) === "ticket",
  });
  return { prompt: String(promptRelPath), issues };
}

// guard:prompt-record
function formatPromptContentRefusal(ticketId, report, waiverCommand) {
  return `Ticket ${ticketId} cannot start: its prompt ${report.prompt} does not satisfy the prompt content contract.\n` +
    `${report.issues.map((issue) => `  - ${issue}`).join("\n")}\n` +
    "Next: author ticket-specific acceptance (and verification) with " +
    `\`coord/scripts/gov register-prompt ${ticketId} --body-file <file>\`, or record the explicit bypass: ` +
    `\`${waiverCommand}\`.`;
}

// COORD-813: the generators lift the ticket's own acceptance (and verification)
// text from the board Description, so a freshly generated prompt is
// start-ready when the Description carries it. Recognised forms: a
// `Acceptance:` / `**Acceptance:**` / `Acceptance criteria:` label (the text
// runs to the next blank line or `**Label:**`) or an `Acceptance` markdown
// heading (the text runs to the next heading). The label counts only at the
// start of a line or of a sentence (after `.`, `!` or `?`), so the documented
// one-liner "Fix X. Acceptance: ..." lifts while prose such as "The
// Acceptance: section ..." or "User Acceptance: ..." does not. Matching is
// case-sensitive on the leading capital. COORD-837: the final period of the
// mid-sentence abbreviations e.g., i.e., vs. and cf. (standing as a word) does
// not end a sentence, so "Do it e.g. Acceptance: x" lifts nothing.
const NON_TERMINAL_ABBREVIATION_PERIOD = "(?<!(?:^|[^A-Za-z0-9.])(?:[Ee]\\.[Gg]|[Ii]\\.[Ee]|[Vv]s|[Cc]f))\\.";
function collectDescriptionSectionLines(lines, index, patterns) {
  if (patterns.heading.test(lines[index])) {
    const end = lines.findIndex((line, at) => at > index && /^#{1,6}\s/.test(line));
    return lines.slice(index + 1, end < 0 ? lines.length : end);
  }
  const match = patterns.label.exec(lines[index]);
  if (!match) {
    return [];
  }
  const end = lines.findIndex((line, at) => (
    at > index && (!line.trim() || /^\s*\*\*[^*]+:\*\*/.test(line) || /^#{1,6}\s/.test(line))
  ));
  return [match[1], ...lines.slice(index + 1, end < 0 ? lines.length : end)];
}

function extractDescriptionSection(description, label) {
  const lines = String(description || "").split(/\r?\n/);
  const patterns = {
    label: new RegExp(`(?:^\\s*|(?:[!?]|${NON_TERMINAL_ABBREVIATION_PERIOD})\\s+)\\*{0,2}${label}(?:\\s+[Cc]riteria)?\\s*\\*{0,2}\\s*:\\s*\\*{0,2}\\s*(.*)$`),
    heading: new RegExp(`^#{1,6}\\s+${label}\\b`),
  };
  for (let index = 0; index < lines.length; index += 1) {
    const items = collectDescriptionSectionLines(lines, index, patterns)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => (/^(?:[-*+]|\d+\.)\s+/.test(line) ? line : `- ${line}`));
    if (items.some(isSpecificCriterionLine)) {
      return items;
    }
  }
  return [];
}

// The generated `## Acceptance Criteria` and `## Verification` bodies. With no
// recognisable acceptance text the body is a TODO that names exactly what to
// add, so inspectPromptContent (and therefore `gov start`) refuses it with that
// instruction instead of a generic line passing as criteria.
function buildGeneratedPromptCriteria(ticketId, description) {
  const acceptance = extractDescriptionSection(description, "Acceptance");
  const verification = extractDescriptionSection(description, "Verification");
  return {
    acceptance: acceptance.length > 0 ? acceptance : [
      "- TODO: write this ticket's acceptance criteria here; the board Description has no " +
        "`Acceptance:` text to lift. Author them with " +
        `\`coord/scripts/gov register-prompt ${ticketId} --body-file <file>\`, ` +
        "or file the ticket with `Acceptance: <criteria>` in --description.",
    ],
    verification: verification.length > 0 ? verification : [
      "- Record the focused verification commands and their results in the governed plan (`coord/scripts/gov update-plan`).",
    ],
  };
}

function createPromptCoverage(deps) {
  const {
    ROOT_DIR,
    COORD_DIR,
    BOARD_RAW_SYMBOL,
    attachTrackedRaw,
    assertTicketMutationOwnership,
    fail,
    findLockForTicket,
    getRepoRoot,
    getTicketRef,
    gitCommitishExists,
    gitPathExistsAtRef,
    gitRefContainsLiteral,
    inferTicketStatus,
    ensureCurrentAgentIdentity,
    isDoingStatus,
    isRepoBackedCode,
    normalizeOwnerValue,
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
    writeFileAtomicSync,
    writeBoard,
    writeCanonicalJsonFile,
    writePlanCompatibilityBlockFromRecord,
    writePlanRecordScaffoldPlaceholders,
    getPromptsDir = () => path.join(COORD_DIR, "prompts"),
  } = deps;
  const { readUtf8TextFile } = createSafeTextInput({ fs, fail });

  function buildPromptWaiverCommand(ticketId) {
    return `coord/scripts/gov set-waiver ${ticketId} --reason "<why prompt coverage waiver is accepted>"`;
  }

  function hasPromptWaiver(board, ticketId) {
    return Boolean(readTicketWaiver(board, ticketId, "prompt_coverage"));
  }

  function defaultTicketPromptRelPath(ticketId) {
    const abs = path.join(getPromptsDir(), "tickets", `${ticketId}.md`);
    const canonicalAbs = path.join(COORD_DIR, "prompts", "tickets", `${ticketId}.md`);
    if (abs !== canonicalAbs && !fs.existsSync(abs) && fs.existsSync(canonicalAbs)) {
      return path.relative(ROOT_DIR, canonicalAbs).replace(/\\/g, "/");
    }
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

  function normalizePromptRelPath(ticketId, options = {}) {
    const rawPath = options.path || options.prompt || null;
    if (!rawPath) {
      return defaultTicketPromptRelPath(ticketId);
    }
    return resolvePromptPath(rawPath, { workspaceRoot: ROOT_DIR, coordDir: COORD_DIR, fail }).relPath;
  }

  function normalizeTemplateName(templateName) {
    const value = String(templateName || "ticket").trim().toLowerCase();
    if (!value || value === "default") {
      return "ticket";
    }
    if (value !== "ticket") {
      fail(`Unsupported prompt template "${templateName}". Supported templates: ticket.`);
    }
    return value;
  }

  function buildTicketPromptTemplate(ticketId, row = {}, options = {}) {
    normalizeTemplateName(options.template || options.promptTemplate);
    const title = String(row.Description || `${ticketId} implementation prompt`).trim();
    const repo = String(row.Repo || "X").trim();
    const type = String(row.Type || "task").trim();
    const pri = String(row.Pri || "P2").trim();
    const criteria = buildGeneratedPromptCriteria(ticketId, row.Description);
    return [
      `# ${ticketId}: ${title}`,
      "",
      "## Assignment",
      "",
      title,
      "",
      "## Context",
      "",
      `- Repo: ${repo}`,
      `- Type: ${type}`,
      `- Priority: ${pri}`,
      "",
      "## Scope",
      "",
      "- Follow the ticket description and repo governance.",
      "- Keep edits limited to the files required for this ticket.",
      "",
      "## Non-goals",
      "",
      "- Do not broaden the ticket beyond the filed scope.",
      "",
      "## Acceptance Criteria",
      "",
      ...criteria.acceptance,
      "",
      "## Likely Files",
      "",
      "- TODO: add likely files before start when known.",
      "",
      "## Verification",
      "",
      ...criteria.verification,
      "",
    ].join("\n");
  }

  // COORD-956 (ADR 0021): one prompt-record check. It replaces the retired
  // prompt-content-contract, prompt-coverage and prompt-preconditions guards and
  // keeps their order at start: content contract (COORD-813) before any
  // discovery write, then coverage or auto-discovery (COORD-023), then the
  // declared preconditions (COORD-008). The read-only preflight below reports the
  // coverage and content refusals with the same message and blocker code.
  // COORD-813: the content read is the same evaluator for start and preflight, so
  // `gov start` and `gov explain` can never disagree about a prompt.
  // guard:prompt-record
  function collectPromptRecordIssues(ticketId, board) {
    return evaluatePromptContent(ticketId, board, {
      rootDir: ROOT_DIR,
      hasPromptWaiver,
      defaultTicketPromptRelPath,
      ticketPromptRelPathExists,
    });
  }

  // guard:prompt-record
  function collectPromptRecordBlockers(ticketId, board) {
    if (
      !board.prompt_index?.[ticketId] &&
      !hasPromptWaiver(board, ticketId) &&
      !ticketPromptRelPathExists(defaultTicketPromptRelPath(ticketId))
    ) {
      return [{
        code: "prompt_coverage",
        message: `Ticket ${ticketId} cannot start without prompt coverage or a recorded waiver.`,
        next_steps: [
          `coord/scripts/gov register-prompt ${ticketId}  # if you create coord/prompts/tickets/${ticketId}.md`,
          buildPromptWaiverCommand(ticketId),
        ],
      }];
    }
    const content = collectPromptRecordIssues(ticketId, board);
    if (content.issues.length === 0) {
      return [];
    }
    return [{
      code: "prompt_coverage",
      message: formatPromptContentRefusal(ticketId, content, buildPromptWaiverCommand(ticketId)),
      next_steps: [
        `coord/scripts/gov register-prompt ${ticketId} --body-file <file>`,
        buildPromptWaiverCommand(ticketId),
      ],
    }];
  }

  // guard:prompt-record
  function assertPromptRecord(ticketId, row, board, options = {}) {
    const report = collectPromptRecordIssues(ticketId, board);
    if (report.issues.length > 0) {
      fail(formatPromptContentRefusal(ticketId, report, buildPromptWaiverCommand(ticketId)));
    }
    if (!board.prompt_index?.[ticketId] && !hasPromptWaiver(board, ticketId)) {
      const relPath = defaultTicketPromptRelPath(ticketId);
      if (!ticketPromptRelPathExists(relPath)) {
        fail(`Ticket ${ticketId} cannot start without prompt coverage or a recorded waiver.`);
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
    }
    // The integration ref is resolved once coverage holds and before any
    // precondition is verified, so a refused prompt triggers no fetch.
    const preconditionRef = typeof options.resolvePreconditionRef === "function"
      ? options.resolvePreconditionRef()
      : options.preconditionRef;
    verifyDeclaredPreconditions(ticketId, row, board, { ...options, preconditionRef });
  }

  function createPromptCoverageForTicket(board, ticketId, row, options = {}) {
    const relPath = normalizePromptRelPath(ticketId, options);
    const absPath = path.isAbsolute(relPath) ? relPath : path.join(ROOT_DIR, relPath);
    if (!board.prompt_index || typeof board.prompt_index !== "object") {
      board.prompt_index = {};
    }

    const existing = board.prompt_index[ticketId];
    if (existing && existing !== relPath && !options.force) {
      fail(
        `prompt creation/register: ${ticketId} is already registered to ${existing}. ` +
        `Pass --force to overwrite with ${relPath}.`
      );
    }

    const fileExists = ticketPromptRelPathExists(relPath);
    const replace = Boolean(options.replace);
    if (fileExists && replace && !options.force) {
      fail(`prompt creation/register: ${relPath} already exists. Pass --force with --replace to overwrite it.`);
    }

    let created = false;
    let overwritten = false;
    if (!fileExists || replace) {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, buildTicketPromptTemplate(ticketId, row, options), "utf8");
      created = !fileExists;
      overwritten = fileExists && replace;
    }

    board.prompt_index[ticketId] = relPath;
    return {
      ticket: ticketId,
      prompt: relPath,
      created,
      overwritten,
      registered: existing !== relPath,
    };
  }

  function registerPrompt(ticketId, options = {}) {
    const hasBodyFile = options.bodyFile !== undefined;
    const authoringBody = hasBodyFile
      ? readUtf8TextFile(options.bodyFile, "--body-file")
      : null;
    const mutation = {
      command: "register-prompt",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
      details: hasBodyFile ? { body_authored: true } : null,
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

      if (hasBodyFile) {
        if (
          options.path || options.prompt || options.create || options.template
          || options.promptTemplate || options.force || options.replace
        ) {
          fail("register-prompt --body-file only updates an existing mapping; do not combine it with mapping or template options.");
        }
        const existing = board.prompt_index?.[ticketId];
        if (!existing) {
          fail(`register-prompt --body-file requires an existing prompt_index mapping for ${ticketId}.`);
        }
        const status = String(ref.row.Status || "").toLowerCase();
        if (status === STATUS.DONE || status === STATUS.SUPERSEDED) {
          fail(`register-prompt --body-file refuses a closed ticket (${ticketId}: ${status}).`);
        }
        const owner = normalizeOwnerValue(ref.row.Owner);
        if (owner === "unassigned") {
          if (![STATUS.PROPOSED, STATUS.TODO, STATUS.DEFERRED].includes(status)) {
            fail(`register-prompt --body-file requires an unassigned backlog/pre-start ticket; ${ticketId} is ${status || "missing status"}.`);
          }
          mutation.identity = ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
        } else {
          const lock = findLockForTicket(ticketId);
          if (isDoingStatus(ref.row.Status) && !lock) {
            fail(`register-prompt --body-file requires the governed doing lock for ${ticketId}.`);
          }
          mutation.identity = assertTicketMutationOwnership(ticketId, ref.row, lock);
        }
        const { absPath, relPath } = resolvePromptPath(existing, {
          workspaceRoot: ROOT_DIR,
          coordDir: COORD_DIR,
          fail,
        });
        let promptRoot;
        let promptTarget;
        let targetStat;
        try {
          promptRoot = fs.realpathSync(getPromptsDir());
          promptTarget = fs.realpathSync(absPath);
          targetStat = fs.lstatSync(absPath);
        } catch {
          fail(`register-prompt --body-file target is not an existing regular prompt file for ${ticketId}: ${relPath}.`);
        }
        const targetRelative = path.relative(promptRoot, promptTarget);
        if (targetStat.nlink !== 1) {
          fail(`register-prompt --body-file refuses a prompt target with multiple hard links: ${relPath}.`);
        }
        if (
          !targetStat.isFile()
          || targetStat.isSymbolicLink()
          || promptTarget !== path.resolve(absPath)
          || targetRelative === ".."
          || targetRelative.startsWith(`..${path.sep}`)
          || path.isAbsolute(targetRelative)
        ) {
          fail(`register-prompt --body-file target must be a regular file inside the governed prompts directory: ${relPath}.`);
        }
        const sharedWith = Object.entries(board.prompt_index || {})
          .filter(([otherTicket]) => otherTicket !== ticketId)
          .filter(([, otherPath]) => {
            if (!otherPath) return false;
            try {
              const other = resolvePromptPath(otherPath, {
                workspaceRoot: ROOT_DIR,
                coordDir: COORD_DIR,
                fail,
              });
              return path.resolve(other.absPath) === path.resolve(absPath);
            } catch {
              return String(otherPath) === String(existing);
            }
          })
          .map(([otherTicket]) => otherTicket)
          .sort();
        if (sharedWith.length > 0) {
          fail(`register-prompt --body-file refuses a prompt target shared by other tickets: ${sharedWith.join(", ")}.`);
        }
        withCoordStateLock(() => {
          writeFileAtomicSync(absPath, authoringBody);
          fs.chmodSync(absPath, targetStat.mode & 0o777);
          runBoardSync({ ignoreActiveTicketLockErrors: true });
        });
        mutation.details = { body_authored: true, prompt: relPath };
        console.log(`Updated prompt body for ${ticketId}: ${relPath}.`);
        return { ticket: ticketId, prompt: relPath, bodyAuthored: true };
      }

      const existing = board.prompt_index?.[ticketId];
      const hasExplicitPath = Boolean(options.path || options.prompt);
      const relPath = !hasExplicitPath && existing
        ? existing
        : normalizePromptRelPath(ticketId, options);

      if (options.create || options.promptTemplate || options.replace) {
        const result = createPromptCoverageForTicket(board, ticketId, ref.row, {
          ...options,
          create: true,
          template: options.template || options.promptTemplate,
        });
        withCoordStateLock(() => {
          writeBoard(board);
          runBoardSync({ ignoreActiveTicketLockErrors: true });
        });
        mutation.details = result;
        console.log(
          `${result.created ? "Created and registered" : "Registered"} prompt for ${ticketId}: ${result.prompt}.`
        );
        return result;
      }

      if (!ticketPromptRelPathExists(relPath)) {
        fail(
          `register-prompt: prompt file not found for ${ticketId} at ${relPath}. ` +
          "Create the prompt on disk first, pass an existing path, or use --create."
        );
      }

      if (!board.prompt_index || typeof board.prompt_index !== "object") {
        board.prompt_index = {};
      }
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
      mutation.details = { ticket: ticketId, prompt: relPath, created: false, overwritten: false };
      console.log(`Registered prompt for ${ticketId}: ${relPath}.`);
      return { ticket: ticketId, prompt: relPath, created: false, overwritten: false };
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

  // guard:prompt-record
  function verifyDeclaredPreconditions(ticketId, row, board, options = {}) {
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
      if (!hasPromptWaiver(board, ticketId)) fail(`Ticket ${ticketId} cannot start: unable to read prompt ${promptRelPath} for precondition verification.`);
      return;
    }
    const preconditions = parsePromptPreconditions(promptText);
    if (preconditions.length === 0) {
      return;
    }

    const repoCode = row?.Repo;
    const repoRoot = isRepoBackedCode(repoCode) ? getRepoRoot(repoCode) : ROOT_DIR;
    const integrationRef = options.preconditionRef || resolveTicketBaseRef(ticketId, row, options);

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
    assertPromptRecord,
    buildPromptWaiverCommand,
    collectPromptRecordBlockers,
    collectPromptRecordIssues,
    buildTicketPromptTemplate,
    classifyPreconditionArtifact,
    createPromptCoverageForTicket,
    defaultTicketPromptRelPath,
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
// COORD-813: pure helpers shared with ticket-commands.js (the file-ticket /
// open-followup generator) and gates/readiness.js (the start preflight).
Object.assign(module.exports, {
  buildGeneratedPromptCriteria,
  classifyPromptMapping,
  evaluatePromptContent,
  formatPromptContentRefusal,
  inspectPromptContent,
  isCaseInsensitiveFs,
});
