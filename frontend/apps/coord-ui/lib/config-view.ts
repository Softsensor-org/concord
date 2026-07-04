import 'server-only';
import path from 'node:path';
import fs from 'node:fs';
import { COORD_DIR, PROJECT_ROOT, sanitizeProjectConfig } from './coord-paths';
import { requireExternal, uncacheExternal } from './external-require';

/**
 * COORD-150 — READ-ONLY "Configuration" cockpit data layer.
 *
 * Surfaces the CURRENT config-as-code (parsed from coord/project.config.js) and,
 * for each setting, the GOVERNED COMMAND/file an operator edits to change it.
 * This is the same "render-the-command" pattern coord-ui uses for tickets via
 * buildTicketNextCommands (lib/ticket-guidance.ts): the UI tells you what to run,
 * it never runs it.
 *
 * STRICTLY READ-ONLY / fail-closed (SEC-001/SEC-002):
 *   - This module performs NO writes, NO process spawning, NO mutation. It only
 *     READS coord/project.config.js (the same fixed, in-workspace require path
 *     project-config.ts uses) and returns plain data.
 *   - There is NO write/POST/toggle path. Changing config is config-as-code on
 *     the governed lane: you EDIT the file and COMMIT it. The view renders the
 *     command for that; it cannot apply it.
 *   - A missing/malformed config degrades to `found: false` rather than throwing
 *     (fail-closed: surface nothing rather than a half-read mutable surface).
 *
 * The absence of any mutation path is asserted by
 * coord/scripts/coord-ui-config-view.test.js.
 */

const CONFIG_PATH = path.join(COORD_DIR, 'project.config.js');
const CONFIG_REL = path.relative(PROJECT_ROOT, CONFIG_PATH).split(path.sep).join('/');

/** A single surfaced config setting + the governed command/file to change it. */
export interface ConfigSetting {
  /** Dotted key path, e.g. "repos.B.integrationBranch". */
  key: string;
  /** Current value as a display string. */
  value: string;
  /** Human description of what the setting does. */
  description: string;
  /** The config-as-code file the operator edits. */
  file: string;
  /** The governed command/instruction to change it. Display-only. */
  changeCommand: string;
}

export interface ConfigRepoView {
  code: string;
  path: string;
  integrationBranch: string;
}

export interface ConfigView {
  found: boolean;
  /** Repo-relative-to-project path of the config-as-code file. */
  sourcePath: string;
  /** Whether the data layer is read-only (always true; surfaced for the UI). */
  readOnly: true;
  coordTicketPrefix?: string;
  repos: ConfigRepoView[];
  settings: ConfigSetting[];
  /** The single governed-change posture shown at the top of the view. */
  governedChangeNote: string;
}

interface RawRepoConfig {
  path?: string;
  integrationBranch?: string;
}
interface RawProjectConfig {
  coordTicketPrefix?: string;
  repos?: Record<string, RawRepoConfig>;
}

// The governed-change command for editing the config seam: edit the file, then
// commit it through the governed lane. Mirrors the docs/MEMORY_ARCHITECTURE.md
// sec 12 stance — changes go through config-as-code on the governed lifecycle.
function editAndCommit(): string {
  return `edit ${CONFIG_REL}, then commit via the governed lane ` +
    `(git add ${CONFIG_REL} + coord/scripts/gov commit <ticket> --message "…")`;
}

function loadRawConfig(): RawProjectConfig | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    // FIXED in-workspace require path — never built from request input (SEC-002).
    uncacheExternal(CONFIG_PATH);
    const raw = requireExternal<unknown>(CONFIG_PATH) as RawProjectConfig;
    // Validate the repo block to the consumed shape via the shared core.
    const sanitized = sanitizeProjectConfig(raw);
    return {
      coordTicketPrefix:
        typeof raw?.coordTicketPrefix === 'string' ? raw.coordTicketPrefix : undefined,
      repos: sanitized.repos
    };
  } catch {
    return null;
  }
}

/**
 * Build the read-only Configuration view: current config-as-code + the governed
 * command to change each setting. NO writes, NO spawn, NO mutation.
 */
export function loadConfigView(): ConfigView {
  const raw = loadRawConfig();
  const governedChangeNote =
    'Configuration is config-as-code on the governed lifecycle. This view is ' +
    'read-only: it surfaces the current config and the command to change it. To ' +
    `change a setting, edit ${CONFIG_REL} and commit through the governed lane — ` +
    'not from here.';

  if (!raw) {
    return {
      found: false,
      sourcePath: CONFIG_REL,
      readOnly: true,
      repos: [],
      settings: [],
      governedChangeNote
    };
  }

  const repos: ConfigRepoView[] = Object.entries(raw.repos ?? {})
    .filter(([code]) => code.toUpperCase() !== 'X')
    .map(([code, cfg]) => ({
      code,
      path: typeof cfg?.path === 'string' ? cfg.path : code,
      integrationBranch:
        typeof cfg?.integrationBranch === 'string' ? cfg.integrationBranch : 'main'
    }));

  const settings: ConfigSetting[] = [];

  settings.push({
    key: 'coordTicketPrefix',
    value: raw.coordTicketPrefix ?? 'COORD',
    description: 'Ticket-id prefix for coord/cross-repo ("X") work.',
    file: CONFIG_REL,
    changeCommand: editAndCommit()
  });

  for (const repo of repos) {
    settings.push({
      key: `repos.${repo.code}.path`,
      value: repo.path,
      description: `Filesystem path (relative to project root) for repo ${repo.code}.`,
      file: CONFIG_REL,
      changeCommand: editAndCommit()
    });
    settings.push({
      key: `repos.${repo.code}.integrationBranch`,
      value: repo.integrationBranch,
      description: `Integration base branch for repo ${repo.code}.`,
      file: CONFIG_REL,
      changeCommand: editAndCommit()
    });
  }

  return {
    found: true,
    sourcePath: CONFIG_REL,
    readOnly: true,
    coordTicketPrefix: raw.coordTicketPrefix ?? 'COORD',
    repos,
    settings,
    governedChangeNote
  };
}
