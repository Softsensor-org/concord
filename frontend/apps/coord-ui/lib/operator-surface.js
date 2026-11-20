const STABLE_MATURITY = 'stable';
const PLANNED_MATURITY = 'planned_surface';

/**
 * Return a small, serializable view of command metadata for the client cockpit.
 * This module deliberately does not execute or construct commands.
 */
export function buildCommandPalette(commands, options = {}) {
  const includeAdvanced = options.includeAdvanced === true;
  return (Array.isArray(commands) ? commands : [])
    .filter((command) => command && command.ui_palette === true)
    .filter((command) => includeAdvanced || command.maturity === STABLE_MATURITY)
    .map((command) => ({
      name: String(command.name || ''),
      namespace: String(command.namespace || ''),
      maturity: String(command.maturity || 'unknown'),
      safety: String(command.safety || 'unknown'),
      role: typeof command.role === 'string' ? command.role : '',
      summary: String(command.summary || ''),
      docs: String(command.docs || ''),
      advanced: command.advanced === true || command.maturity !== STABLE_MATURITY,
      planned: command.maturity === PLANNED_MATURITY,
    }))
    .sort((left, right) => `${left.namespace}:${left.name}`.localeCompare(`${right.namespace}:${right.name}`));
}

/** Keep route visibility explicit and independently testable. */
export function visibleNavigation(items, includeAdvanced = false) {
  return (Array.isArray(items) ? items : []).filter((item) =>
    includeAdvanced || item.maturity === STABLE_MATURITY
  );
}
