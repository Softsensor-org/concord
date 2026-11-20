// Self-contained markdown block parser for the /urs requirements view
// (COORD-567). It covers the structures a requirements document is made of:
// headings, paragraphs, bullet and numbered lists (nested, with wrapped
// continuation lines), pipe tables, thematic breaks, fenced code, and inline
// code / strong / emphasis.
//
// The output is a plain data tree. Nothing here produces HTML: the page maps
// each node to a React element, so document text is always escaped. Raw HTML
// and links in the source are deliberately left as literal text.

const HEADING = /^(#{1,4})\s+(.*)$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
// A backtick fence may not carry a backtick after the opener, so a prose line
// such as "```x``` is inline code" is not mistaken for the start of a block.
const FENCE = /^ {0,3}(`{3,}(?!.*`)|~{3,})\s*(\S*).*$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const WORD = /[A-Za-z0-9]/;
const MAX_INLINE_DEPTH = 6;

/** @param {string} raw */
export function parseUrsMarkdown(raw) {
  const lines = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const blocks = [];
  let para = [];

  const flush = () => {
    if (para.length === 0) return;
    blocks.push({ type: 'paragraph', inline: parseUrsInline(para.join(' ')) });
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      flush();
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const code = parseFence(lines, i, fence);
      blocks.push(code.block);
      i = code.next;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        line: i + 1,
        inline: parseUrsInline(heading[2].trim()),
      });
      i += 1;
      continue;
    }

    if (THEMATIC_BREAK.test(line)) {
      flush();
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    if (isTableStart(lines, i)) {
      flush();
      const table = parseTable(lines, i);
      blocks.push(table.block);
      i = table.next;
      continue;
    }

    // Inside a paragraph only a bullet or a list starting at 1 opens a list, so
    // a wrapped sentence that happens to begin "2026. ..." stays prose.
    const item = LIST_ITEM.exec(line);
    if (item && (para.length === 0 || !isOrdered(item[2]) || Number.parseInt(item[2], 10) === 1)) {
      flush();
      const list = parseList(lines, i, item[1].length);
      blocks.push(list.block);
      i = list.next;
      continue;
    }

    para.push(line.trim());
    i += 1;
  }
  flush();
  return blocks;
}

function isFenceClose(line, open) {
  const trimmed = line.trim();
  return trimmed.length >= open.length && trimmed === open[0].repeat(trimmed.length);
}

function parseFence(lines, start, fence) {
  const body = [];
  let i = start + 1;
  while (i < lines.length && !isFenceClose(lines[i], fence[1])) {
    body.push(lines[i]);
    i += 1;
  }
  // `i` is the closing fence, or the end of an unterminated block.
  return { block: { type: 'code', lang: fence[2] || null, text: body.join('\n') }, next: i + 1 };
}

function isTableStart(lines, i) {
  const next = lines[i + 1];
  return (
    lines[i].includes('|') &&
    next !== undefined &&
    next.includes('|') &&
    TABLE_DELIMITER.test(next)
  );
}

function startsOtherBlock(lines, i) {
  const line = lines[i];
  return HEADING.test(line) || THEMATIC_BREAK.test(line) || FENCE.test(line) || isTableStart(lines, i);
}

function isOrdered(marker) {
  return /\d/.test(marker);
}

// Parses one list whose items sit at `baseIndent`. Deeper items become a nested
// list on the preceding item; a shallower item or a different marker kind ends
// the list and is left for the caller.
function parseList(lines, start, baseIndent) {
  const first = LIST_ITEM.exec(lines[start]);
  const ordered = isOrdered(first[2]);
  const block = {
    type: 'list',
    ordered,
    start: ordered ? Number.parseInt(first[2], 10) : null,
    items: [],
  };
  let text = [];
  let current = null;

  const closeItem = () => {
    if (!current) return;
    current.inline = parseUrsInline(text.join(' '));
    text = [];
  };

  let i = start;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      const resume = listResumesAfterBlank(lines, i, baseIndent, ordered);
      if (resume === -1) break;
      i = resume;
      continue;
    }

    if (THEMATIC_BREAK.test(line)) break;

    const item = LIST_ITEM.exec(line);
    if (item) {
      const indent = item[1].length;
      if (indent < baseIndent) break;
      if (indent >= baseIndent + 2 && current) {
        const nested = parseList(lines, i, indent);
        current.children.push(nested.block);
        i = nested.next;
        continue;
      }
      if (isOrdered(item[2]) !== ordered) break;
      closeItem();
      current = { inline: [], children: [] };
      block.items.push(current);
      text.push(item[3].trim());
      i += 1;
      continue;
    }

    if (startsOtherBlock(lines, i)) break;

    // Wrapped continuation of the current item.
    text.push(line.trim());
    i += 1;
  }
  closeItem();
  return { block, next: i };
}

// A blank line keeps a list open only when the list visibly continues: another
// item of the same kind, a nested item, or an indented continuation line.
// Returns the index to resume at, or -1 when the list ends at the blank line.
function listResumesAfterBlank(lines, blank, baseIndent, ordered) {
  let j = blank + 1;
  while (j < lines.length && lines[j].trim() === '') j += 1;
  if (j >= lines.length || startsOtherBlock(lines, j)) return -1;
  const indent = lines[j].length - lines[j].trimStart().length;
  if (indent >= baseIndent + 2) return j;
  const item = LIST_ITEM.exec(lines[j]);
  return item && indent >= baseIndent && isOrdered(item[2]) === ordered ? j : -1;
}

function splitTableRow(line) {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells = [];
  let cell = '';
  for (let k = 0; k < body.length; k += 1) {
    const ch = body[k];
    if (ch === '\\' && body[k + 1] === '|') {
      cell += '|';
      k += 1;
    } else if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function parseTable(lines, start) {
  const header = splitTableRow(lines[start]);
  const width = header.length;
  const delimiters = splitTableRow(lines[start + 1]);
  const align = [];
  for (let c = 0; c < width; c += 1) {
    const d = delimiters[c] ?? '';
    const left = d.startsWith(':');
    const right = d.endsWith(':');
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  const rows = [];
  let i = start + 2;
  while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
    const cells = splitTableRow(lines[i]);
    const row = [];
    for (let c = 0; c < width; c += 1) row.push(parseUrsInline(cells[c] ?? ''));
    rows.push(row);
    i += 1;
  }
  return {
    block: { type: 'table', header: header.map((h) => parseUrsInline(h)), align, rows },
    next: i,
  };
}

/** @param {string} text */
export function parseUrsInline(text) {
  return parseInline(String(text ?? ''), 0);
}

function parseInline(text, depth) {
  const out = [];
  let buf = '';
  // Delimiters already searched for without success. A failed search covers the
  // rest of the string, so repeating it from a later position cannot succeed;
  // remembering that keeps unbalanced input linear instead of quadratic.
  const unmatched = new Set();

  const flushText = () => {
    if (buf === '') return;
    out.push({ type: 'text', text: buf });
    buf = '';
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === '\\' && i + 1 < text.length && ESCAPABLE.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`' || ch === '*' || ch === '_') {
      const span =
        ch === '`' ? readCodeSpan(text, i, unmatched) : readEmphasis(text, i, depth, unmatched);
      buf += span.literal;
      if (span.token) {
        flushText();
        out.push(span.token);
      }
      i = span.next;
      continue;
    }

    buf += ch;
    i += 1;
  }
  flushText();
  return out;
}

// Both readers return `{ literal, token, next }`: `literal` is delimiter text
// that stays prose, `token` is the parsed span (or null when nothing closed it).

function readCodeSpan(text, i, unmatched) {
  const run = runLength(text, i, '`');
  const key = `code${run}`;
  const close = unmatched.has(key) ? -1 : findCodeClose(text, i + run, run);
  if (close === -1) {
    unmatched.add(key);
    return { literal: text.slice(i, i + run), token: null, next: i + run };
  }
  let code = text.slice(i + run, close);
  if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') {
    code = code.slice(1, -1);
  }
  return { literal: '', token: { type: 'code', text: code }, next: close + run };
}

function canOpenEmphasis(text, i, run, depth) {
  const ch = text[i];
  const before = i > 0 ? text[i - 1] : '';
  const after = text[i + run] ?? '';
  if (after === '' || /\s/.test(after) || depth >= MAX_INLINE_DEPTH) return false;
  return ch === '*' || !WORD.test(before);
}

function readEmphasis(text, i, depth, unmatched) {
  const ch = text[i];
  const run = runLength(text, i, ch);
  // Runs longer than `***` are not emphasis here; consuming the whole run at
  // once also keeps a long row of asterisks linear.
  if (run <= 3 && canOpenEmphasis(text, i, run, depth)) {
    // Prefer the widest delimiter (`***`, then `**`, then `*`) that closes.
    for (let size = run; size >= 1; size -= 1) {
      const key = ch.repeat(size);
      if (unmatched.has(key)) continue;
      const open = i + (run - size);
      const close = findEmphasisClose(text, open + size, ch, size);
      if (close === -1) {
        unmatched.add(key);
        continue;
      }
      const children = parseInline(text.slice(open + size, close), depth + 1);
      return { literal: text.slice(i, open), token: wrapEmphasis(size, children), next: close + size };
    }
  }
  return { literal: text.slice(i, i + run), token: null, next: i + run };
}

function wrapEmphasis(size, children) {
  if (size === 1) return { type: 'em', children };
  if (size === 2) return { type: 'strong', children };
  return { type: 'strong', children: [{ type: 'em', children }] };
}

function runLength(text, i, ch) {
  let n = 0;
  while (text[i + n] === ch) n += 1;
  return n;
}

function findCodeClose(text, from, run) {
  let i = from;
  while (i < text.length) {
    if (text[i] !== '`') {
      i += 1;
      continue;
    }
    const n = runLength(text, i, '`');
    if (n === run) return i;
    i += n;
  }
  return -1;
}

// Finds the closing run of exactly `size` delimiter characters: it must follow
// a non-space character, enclose at least one character, and (for `_`) not sit
// inside a word. Code spans and escaped characters are skipped.
function findEmphasisClose(text, from, ch, size) {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') {
      const run = runLength(text, i, '`');
      const close = findCodeClose(text, i + run, run);
      i = close === -1 ? i + run : close + run;
      continue;
    }
    if (c === ch) {
      const n = runLength(text, i, ch);
      const after = text[i + n] ?? '';
      if (
        n === size &&
        i > from &&
        !/\s/.test(text[i - 1]) &&
        (ch === '*' || !WORD.test(after))
      ) {
        return i;
      }
      i += n;
      continue;
    }
    i += 1;
  }
  return -1;
}
