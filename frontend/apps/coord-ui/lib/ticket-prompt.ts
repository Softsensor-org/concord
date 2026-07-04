import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, isPathWithinWorkspace } from './coord-paths';

// READ-ONLY: surface the registered ticket prompt (the spec) in the workbench.
// The ticket explain model gives the prompt PATH (lifecycle.promptPath); this
// reads that file, but only within the workspace boundary, and caps the size so
// a huge prompt can't blow up the page.

const MAX = 12000;

export function loadTicketPrompt(promptPath?: string | null): string | null {
  if (!promptPath) return null;
  const abs = path.resolve(PROJECT_ROOT, promptPath);
  if (!isPathWithinWorkspace(abs)) return null;
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    const text = fs.readFileSync(abs, 'utf8');
    return text.length > MAX ? `${text.slice(0, MAX)}\n… (truncated)` : text;
  } catch {
    return null;
  }
}
