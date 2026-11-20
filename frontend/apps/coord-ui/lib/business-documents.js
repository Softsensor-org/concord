import fs from 'node:fs';
import path from 'node:path';
import React from 'react';

export const BUSINESS_DOCUMENTS = Object.freeze([
  'BUSINESS_CONTEXT.md',
  'BUSINESS_RULES.md',
  'WORKFLOW_INVENTORY.md',
  'DOWNSTREAM_CONTRACTS.md',
  'DECISION_LOG.md',
  'KNOWN_WORKAROUNDS.md',
  'OPEN_BUSINESS_QUESTIONS.md',
  'PRESERVATION_HARNESS_CANDIDATES.md'
]);

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function missingOrUnreadable(error) {
  const code = error?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable';
}

/** Read a fixed set of document names from a directory, rejecting path and symlink escapes. */
export function readFixedDocuments(rootDir, names, boundaryDir = rootDir) {
  let realRoot;
  let realBoundary;
  try {
    realBoundary = fs.realpathSync(boundaryDir);
  } catch (error) {
    const state = missingOrUnreadable(error);
    return names.map((name) => ({ name, state, content: null }));
  }
  try {
    realRoot = fs.realpathSync(rootDir);
  } catch (error) {
    const state = missingOrUnreadable(error);
    return names.map((name) => ({ name, state, content: null }));
  }
  if (!within(realBoundary, realRoot)) {
    return names.map((name) => ({ name, state: 'outside-root', content: null }));
  }

  return names.map((name) => {
    if (path.basename(name) !== name || name === '.' || name === '..') {
      return { name, state: 'outside-root', content: null };
    }
    const candidate = path.resolve(realRoot, name);
    if (!within(realRoot, candidate)) return { name, state: 'outside-root', content: null };

    let realFile;
    try {
      realFile = fs.realpathSync(candidate);
    } catch (error) {
      return { name, state: missingOrUnreadable(error), content: null };
    }
    if (!within(realRoot, realFile)) return { name, state: 'outside-root', content: null };

    try {
      const content = fs.readFileSync(realFile, 'utf8');
      return { name, state: content.trim() ? 'available' : 'empty', content };
    } catch {
      return { name, state: 'unreadable', content: null };
    }
  });
}

/** Build a text-only React node so source Markdown/HTML is always escaped. */
export function documentTextElement(content) {
  return React.createElement(
    'pre',
    { style: { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit' } },
    content
  );
}
