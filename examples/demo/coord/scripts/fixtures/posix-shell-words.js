"use strict";

// COORD-856 test fixture: a POSIX shell-word splitter for the commands engine
// messages print for an operator to copy. It reads a printed command the way
// sh would tokenize it (single quotes, double quotes, backslash escapes) and
// returns the argv of each `&&`-joined simple command. Any character a shell
// would act on outside quotes ($, backtick, parentheses, ;, |, <, >, a lone &,
// a glob, a leading ~ or #) throws, because a copied command holding one does
// not run the argv the message intends. Production code never parses commands;
// this only lets tests assert what a paste would run.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// A directory-name segment holding a space, parentheses, a dollar sign and a
// single quote: an unquoted copy of a command naming it splits into several
// words, opens a subshell, expands $HOME or leaves a quote unterminated.
const HOSTILE_PATH_SEGMENT = "coord856 (q) $HOME 'x' ";
function hostileTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${HOSTILE_PATH_SEGMENT}${label}-`));
}

const UNQUOTED_META = new Set(["$", "`", "(", ")", ";", "|", "<", ">", "&", "*", "?", "["]);
const DOUBLE_QUOTE_ESCAPABLE = new Set(["$", "`", "\"", "\\"]);

// Each reader consumes one quoted or escaped chunk starting at `start` and
// returns the literal text it stands for plus the index after it.
function readSingleQuoted(source, start) {
  const close = source.indexOf("'", start + 1);
  if (close < 0) throw new Error(`unterminated single quote in: ${source}`);
  return { text: source.slice(start + 1, close), next: close + 1 };
}

function readDoubleQuoted(source, start) {
  let text = "";
  for (let j = start + 1; j < source.length; j += 1) {
    const ch = source[j];
    if (ch === "\"") return { text, next: j + 1 };
    if (ch === "$" || ch === "`") throw new Error(`expansion inside double quotes in: ${source}`);
    const escaped = ch === "\\" ? source[j + 1] : undefined;
    if (escaped === "\n") j += 1;
    else if (DOUBLE_QUOTE_ESCAPABLE.has(escaped)) { text += escaped; j += 1; }
    else text += ch;
  }
  throw new Error(`unterminated double quote in: ${source}`);
}

function readBackslash(source, start) {
  if (start + 1 >= source.length) throw new Error(`trailing backslash in: ${source}`);
  return { text: source[start + 1] === "\n" ? "" : source[start + 1], next: start + 2 };
}

const QUOTE_READERS = { "'": readSingleQuoted, "\"": readDoubleQuoted, "\\": readBackslash };

function assertLiteral(source, ch, wordStart) {
  if (UNQUOTED_META.has(ch)) throw new Error(`unquoted shell metacharacter ${JSON.stringify(ch)} in: ${source}`);
  if (wordStart && (ch === "~" || ch === "#")) throw new Error(`unquoted word-leading ${JSON.stringify(ch)} in: ${source}`);
}

function splitPosixCommands(text) {
  const source = String(text);
  const commands = [[]];
  let word = null;
  const endWord = () => {
    if (word !== null) commands[commands.length - 1].push(word);
    word = null;
  };
  const endCommand = (what) => {
    endWord();
    if (commands[commands.length - 1].length === 0) throw new Error(`empty command ${what} in: ${source}`);
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const reader = QUOTE_READERS[ch];
    if (reader) {
      const chunk = reader(source, i);
      word = (word || "") + chunk.text;
      i = chunk.next;
    } else if (/\s/.test(ch)) {
      endWord();
      i += 1;
    } else if (source.startsWith("&&", i)) {
      endCommand("before &&");
      commands.push([]);
      i += 2;
    } else {
      assertLiteral(source, ch, word === null);
      word = (word || "") + ch;
      i += 1;
    }
  }
  endCommand("at the end");
  return commands;
}

// One simple command's argv; refuses a compound command.
function splitPosixShellWords(text) {
  const commands = splitPosixCommands(text);
  if (commands.length !== 1) throw new Error(`expected one simple command, found ${commands.length} in: ${text}`);
  return commands[0];
}

// The same command tokenized by the real /bin/sh, without running it: `set --`
// makes the words the positional parameters, which are printed NUL-separated.
// A word the splitter above accepts must come out of sh identically.
function shellArgv(text) {
  const result = spawnSync("/bin/sh", ["-c", `set -- ${text}\nprintf '%s\\0' "$@"`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`/bin/sh could not tokenize: ${text}\n${result.stderr}`);
  return result.stdout.split("\0").slice(0, -1);
}

module.exports = { HOSTILE_PATH_SEGMENT, hostileTempDir, splitPosixCommands, splitPosixShellWords, shellArgv };
