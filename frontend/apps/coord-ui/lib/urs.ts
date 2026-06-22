import 'server-only';
import fs from 'node:fs';
import { REQUIREMENTS_PATH } from './coord-paths';

export interface UrsHeading {
  level: number;
  text: string;
  slug: string;
  line: number;
}

export interface UrsDoc {
  found: boolean;
  sourcePath?: string;
  title?: string;
  raw?: string;
  headings: UrsHeading[];
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export function loadUrs(): UrsDoc {
  const sourcePath = REQUIREMENTS_PATH;
  if (!fs.existsSync(sourcePath)) return { found: false, sourcePath, headings: [] };
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const lines = raw.split('\n');
  const headings: UrsHeading[] = [];
  let title: string | undefined;
  const seen = new Map<string, number>();
  lines.forEach((line, i) => {
    const m = /^(#{1,4})\s+(.*)$/.exec(line);
    if (!m) return;
    const level = m[1].length;
    const text = m[2].trim();
    if (level === 1 && !title) title = text;
    let slug = slugify(text);
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n}`;
    headings.push({ level, text, slug, line: i + 1 });
  });
  return { found: true, sourcePath, title, raw, headings };
}
