"use strict";
const path = require("node:path");

const SEPARATORS = new Set(["&&", "||", ";", "&", "|", "\n", "\r", "$(", "`"]);
const DIRECTORY_COMMANDS = new Set(["cd", "pushd", "popd"]);

function directoryCommand(tokens) {
  const words = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    // Redirections can precede or interrupt the command word/arguments.
    if (token.type === "op" && [">", ">>", "<", "<<<"].includes(token.value)) { i += 1; continue; }
    if (token.type !== "word") continue;
    if (/^\d+$/.test(token.value) && tokens[i + 1]?.type === "op" &&
        [">", ">>", "<"].includes(tokens[i + 1].value)) continue;
    words.push(token);
  }
  let i = 0;
  while (i < words.length) {
    const name = words[i].value.replace(/^[({]+/, "");
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name) ||
        ["", "builtin", "command", "time", "--", "-p", "then", "do", "else", "if", "while", "until", "!"].includes(name)) { i += 1; continue; }
    return DIRECTORY_COMMANDS.has(name) ? { name, args: words.slice(i + 1).map(t => t.value) } : null;
  }
  return null;
}

// This is a bounded shell model, not an interpreter. Only a simple && chain
// proves that a preceding directory change succeeded. Other control flow and
// unknown directory operands conservatively make relative writes unresolvable.
// The existing lexer keeps quoted descriptions as words and removes heredoc data.
function resolveCwdWriteTargets(tokens, cwd, collectTargets, resolveTarget, realDirectory) {
  const segments = [[]];
  let complex = false;
  for (const token of tokens) {
    if (token.type === "op" && SEPARATORS.has(token.value)) {
      if (token.value !== "&&") complex = true;
      segments.push([]);
    } else {
      if (token.type === "word" && !token.quoted &&
          (/[(){}]/.test(token.value) || token.value === "!")) complex = true;
      segments[segments.length - 1].push(token);
    }
  }
  const commands = segments.map(directoryCommand);
  // Compound syntax is not interpreted. Even a quoted builtin name may be
  // executable there, so a directory-command token prevents an unsafe guess.
  const compoundDirectoryToken = complex && tokens.some(token => token.type === "word" &&
    DIRECTORY_COMMANDS.has(token.value.replace(/^[({]+/, "")));
  if (!commands.some(Boolean) && !compoundDirectoryToken) return collectTargets(tokens).map(resolveTarget);
  let effectiveCwd = complex ? null : cwd;
  const targets = [];
  for (let i = 0; i < segments.length; i += 1) {
    // Shell opens redirects on cd itself in the OLD directory.
    for (const raw of collectTargets(segments[i])) {
      const target = resolveTarget(raw);
      const relative = target.candidates.some(candidate => !path.isAbsolute(candidate)) ||
        (!target.candidates.length && !path.isAbsolute(raw));
      targets.push({ ...target, unresolvedCwd: !effectiveCwd && relative,
        // cd tracks a logical path, but relative write traversal is performed
        // from the physical cwd. Keep both so an alias followed by .. cannot
        // discard the actual canonical target before its real-path check.
        candidates: target.candidates.flatMap(candidate => effectiveCwd && !path.isAbsolute(candidate)
          ? [path.resolve(effectiveCwd, candidate), path.resolve(realDirectory(effectiveCwd), candidate)]
          : [candidate]) });
    }
    const command = commands[i];
    if (!command || complex) continue;
    const args = command.args[0] === "--" ? command.args.slice(1) : command.args;
    const destination = args[0];
    // Bare relative names depend on CDPATH; home, stack, variables, globbing,
    // substitutions and option modes are deliberately not guessed.
    const literal = args.length === 1 && destination && !/[\$`~*?\[\]]/.test(destination) &&
      (path.isAbsolute(destination) || /^(?:\.{1,2})(?:\/|$)/.test(destination));
    effectiveCwd = command.name !== "popd" && literal && effectiveCwd
      ? path.resolve(effectiveCwd, destination) : null;
  }
  return targets;
}

module.exports = { resolveCwdWriteTargets };
