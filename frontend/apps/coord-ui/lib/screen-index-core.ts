// Pure, runtime-agnostic screen/requirement-index derivation.
// No `server-only`, no Next imports: importable by both the Next server
// component (lib/screens.ts) and the standalone generator script.
// Reads source + URS only; never writes (caller owns persistence).
import fs from 'node:fs';
import path from 'node:path';

export type Framework = 'next-app-router' | 'expo-rn' | 'other';
export type Confidence = 'explicit' | 'inferred';

export interface RequirementRef {
  doc: string;
  anchor: string;
  text: string;
  confidence: Confidence;
}

export interface Screen {
  id: string;
  route: string | null;
  title: string;
  source: string;
  persona_hints: string[];
  requirement_refs: RequirementRef[];
}

export interface AppEntry {
  app: string;
  framework: Framework;
  root: string;
  screens: Screen[];
}

export interface UrsAnchor {
  anchor: string;
  text: string;
  level: number;
}

export interface ScreenIndex {
  version: 1;
  generated_at: string;
  source_commit: string | null;
  apps: AppEntry[];
  requirements: {
    source: string | null;
    headings: UrsAnchor[];
    coverage: {
      linked_anchors: number;
      total_anchors: number;
      unlinked_anchors: string[];
    };
  };
}

// Apps the index never scans (the dashboard itself).
const SKIP_APPS = new Set(['coord-ui']);

// Framework is detected from the app, not hardcoded, so the contract stays
// framework-agnostic and new apps are picked up automatically.
function detectFramework(appRoot: string): Framework {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  } catch {
    /* no package.json */
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const hasNextConfig = ['js', 'mjs', 'cjs', 'ts'].some((e) =>
    fs.existsSync(path.join(appRoot, `next.config.${e}`))
  );
  if (hasNextConfig || deps.next) return 'next-app-router';
  if (deps.expo || fs.existsSync(path.join(appRoot, 'app', '_layout.tsx'))) return 'expo-rn';
  return 'other';
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function humanize(seg: string): string {
  const s = seg.replace(/^\[(\.\.\.)?/, '').replace(/\]$/, '');
  if (!s) return 'Home';
  return s
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function walk(dir: string, acc: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

function isTestFile(f: string): boolean {
  return /\.(test|spec)\.[tj]sx?$/.test(f);
}

// next-app-router: route = directory of a page.* relative to app/, route
// groups "(x)" stripped, dynamic "[x]" -> ":x". expo-rn: route = file path
// relative to app/ minus extension; "index" -> "/"; "_layout"/"+*" skipped.
function deriveNextRoute(rel: string): string {
  const dir = path.dirname(rel);
  if (dir === '.') return '/';
  const parts = dir
    .split(path.sep)
    .filter((p) => !(p.startsWith('(') && p.endsWith(')')))
    .map((p) => (p.startsWith('[') ? ':' + p.replace(/^\[(\.\.\.)?/, '').replace(/\]$/, '') : p));
  return '/' + parts.join('/');
}

function deriveExpoRoute(rel: string): string {
  const noExt = rel.replace(/\.[tj]sx?$/, '');
  const parts = noExt
    .split(path.sep)
    .map((p) => (p.startsWith('[') ? ':' + p.replace(/^\[(\.\.\.)?/, '').replace(/\]$/, '') : p));
  if (parts[parts.length - 1] === 'index') parts.pop();
  const r = '/' + parts.join('/');
  return r === '/' ? '/' : r.replace(/\/$/, '');
}

export function parseUrs(ursPath: string): { source: string | null; headings: UrsAnchor[]; raw: string } {
  if (!fs.existsSync(ursPath)) return { source: null, headings: [], raw: '' };
  const raw = fs.readFileSync(ursPath, 'utf8');
  const headings: UrsAnchor[] = [];
  const seen = new Map<string, number>();
  raw.split('\n').forEach((line) => {
    const m = /^(#{1,4})\s+(.*)$/.exec(line);
    if (!m) return;
    const level = m[1].length;
    const text = m[2].trim();
    let slug = slugify(text);
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n}`;
    headings.push({ anchor: slug, text, level });
  });
  return { source: ursPath, headings, raw };
}

const STOP = new Set(['the', 'and', 'for', 'page', 'view', 'screen', 'home', 'list', 'a', 'of', 'to']);

function tokens(s: string): Set<string> {
  return new Set(
    slugify(s)
      .split('-')
      .filter((t) => t.length > 2 && !STOP.has(t))
  );
}

// explicit: source contains an `@urs <slug>` / `URS: <slug>` marker that
// matches a heading anchor. inferred: meaningful token overlap between the
// screen (route+title) and a heading. Inferred links are always labeled.
function linkRequirements(
  source: string,
  screenLabel: string,
  ursDoc: string,
  headings: UrsAnchor[]
): RequirementRef[] {
  const refs: RequirementRef[] = [];
  const used = new Set<string>();
  let src = '';
  try {
    src = fs.readFileSync(source, 'utf8');
  } catch {
    /* unreadable source -> inference only */
  }
  const markers = [...src.matchAll(/(?:@urs|URS:)\s*([a-z0-9-]+)/gi)].map((m) => m[1].toLowerCase());
  for (const mk of markers) {
    const h = headings.find((x) => x.anchor === mk);
    if (h && !used.has(h.anchor)) {
      used.add(h.anchor);
      refs.push({ doc: ursDoc, anchor: h.anchor, text: h.text, confidence: 'explicit' });
    }
  }
  const st = tokens(screenLabel);
  if (st.size) {
    for (const h of headings) {
      if (used.has(h.anchor) || h.level > 3) continue;
      const ht = tokens(h.text);
      let overlap = 0;
      for (const t of st) if (ht.has(t)) overlap++;
      if (overlap >= 1 && (overlap / st.size >= 0.5 || overlap >= 2)) {
        used.add(h.anchor);
        refs.push({ doc: ursDoc, anchor: h.anchor, text: h.text, confidence: 'inferred' });
      }
    }
  }
  return refs;
}

export interface BuildOptions {
  appsDir: string;
  ursPath: string;
  ursDocLabel?: string;
  sourceCommit?: string | null;
  repoRelativeTo?: string; // make `source`/`root` paths repo-relative
}

export function buildScreenIndex(opts: BuildOptions): ScreenIndex {
  const { appsDir, ursPath } = opts;
  const ursDocLabel = opts.ursDocLabel ?? ursPath;
  const rel = (p: string) =>
    opts.repoRelativeTo ? path.relative(opts.repoRelativeTo, p).split(path.sep).join('/') : p;

  const urs = parseUrs(ursPath);
  const apps: AppEntry[] = [];

  let appDirs: string[] = [];
  try {
    appDirs = fs
      .readdirSync(appsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP_APPS.has(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    appDirs = [];
  }

  for (const appName of appDirs) {
    const appRoot = path.join(appsDir, appName);
    const appDir = path.join(appRoot, 'app');
    if (!fs.existsSync(appDir)) continue;
    const framework: Framework = detectFramework(appRoot);
    const files = walk(appDir).filter((f) => !isTestFile(f));
    const screens: Screen[] = [];

    for (const file of files) {
      const relToApp = path.relative(appDir, file).split(path.sep).join('/');
      const base = path.basename(file);
      let route: string | null = null;

      if (framework === 'next-app-router') {
        if (!/^page\.[tj]sx?$/.test(base)) continue;
        route = deriveNextRoute(relToApp);
      } else if (framework === 'expo-rn') {
        // expo-router screens are JSX route components; co-located .ts
        // helper modules are not screens.
        if (!/\.[tj]sx$/.test(base)) continue;
        if (base === '_layout.tsx' || base.startsWith('+')) continue;
        route = deriveExpoRoute(relToApp);
      } else {
        if (!/(Screen|Page)\.[tj]sx?$/.test(base)) continue;
        route = null;
      }

      const segs = (route ?? '/').split('/').filter(Boolean);
      const lastSeg = segs.length ? segs[segs.length - 1] : '';
      const title = humanize(lastSeg || base.replace(/\.[tj]sx?$/, ''));
      const slug = slugify(segs.join('-') || appName + '-home');
      const persona_hints =
        framework === 'expo-rn'
          ? ['driver']
          : segs.length
            ? [segs[0].replace(/^:/, '')]
            : [];

      screens.push({
        id: `${appName}:${slug}`,
        route,
        title,
        source: rel(file),
        persona_hints,
        requirement_refs: linkRequirements(
          file,
          `${route ?? ''} ${title}`,
          ursDocLabel,
          urs.headings
        )
      });
    }

    screens.sort((a, b) => a.id.localeCompare(b.id));
    apps.push({ app: appName, framework, root: rel(appRoot), screens });
  }

  const linked = new Set<string>();
  for (const a of apps)
    for (const s of a.screens) for (const r of s.requirement_refs) linked.add(r.anchor);
  const linkable = urs.headings.filter((h) => h.level <= 3);
  const unlinked = linkable.filter((h) => !linked.has(h.anchor)).map((h) => h.anchor);

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    source_commit: opts.sourceCommit ?? null,
    apps,
    requirements: {
      source: urs.source ? (opts.repoRelativeTo ? rel(urs.source) : urs.source) : null,
      headings: urs.headings,
      coverage: {
        linked_anchors: linkable.length - unlinked.length,
        total_anchors: linkable.length,
        unlinked_anchors: unlinked
      }
    }
  };
}
