'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { visibleNavigation, type NavigationItem, type PaletteCommand } from '../lib/operator-surface.js';

// One route inventory backs both navigation modes and the README contract test.
// Stable is reserved for the common board/dispatch/proof/setup operator loop;
// specialized evidence, fleet, risk, and knowledge views remain reachable in
// explicit advanced mode and by direct URL.
const NAV = [
  { href: '/', label: 'board', group: 'Work', maturity: 'stable' },
  { href: '/dispatch', label: 'dispatch', group: 'Work', maturity: 'stable' },
  { href: '/pipeline', label: 'pipeline', group: 'Work', maturity: 'stable' },
  { href: '/gates', label: 'gates', group: 'Proof', maturity: 'stable' },
  { href: '/tests', label: 'tests', group: 'Proof', maturity: 'stable' },
  { href: '/evidence', label: 'evidence', group: 'Proof', maturity: 'stable' },
  { href: '/onboarding', label: 'onboarding', group: 'Setup', maturity: 'stable' },
  { href: '/readiness', label: 'readiness', group: 'Setup', maturity: 'stable' },
  { href: '/health', label: 'health', group: 'Setup', maturity: 'stable' },
  { href: '/workflow-packs', label: 'workflow-packs', group: 'Work', maturity: 'advanced' },
  { href: '/timeline', label: 'timeline', group: 'Work', maturity: 'advanced' },
  { href: '/triage', label: 'triage', group: 'Work', maturity: 'advanced' },
  { href: '/tracks', label: 'tracks', group: 'Proof', maturity: 'advanced' },
  { href: '/traceability', label: 'traceability', group: 'Proof', maturity: 'advanced' },
  { href: '/quality', label: 'quality', group: 'Proof', maturity: 'advanced' },
  { href: '/urs', label: 'urs', group: 'Knowledge', maturity: 'advanced' },
  { href: '/screens', label: 'screens', group: 'Knowledge', maturity: 'advanced' },
  { href: '/requirements', label: 'requirements', group: 'Knowledge', maturity: 'advanced' },
  { href: '/adrs', label: 'adrs', group: 'Knowledge', maturity: 'advanced' },
  { href: '/continuity', label: 'continuity', group: 'Knowledge', maturity: 'advanced' },
  { href: '/discovery', label: 'discovery', group: 'Knowledge', maturity: 'advanced' },
  { href: '/knowledge', label: 'knowledge', group: 'Knowledge', maturity: 'advanced' },
  { href: '/insights', label: 'insights', group: 'Knowledge', maturity: 'advanced' },
  { href: '/human-agent', label: 'human-agent', group: 'Knowledge', maturity: 'advanced' },
  { href: '/agents', label: 'agents', group: 'Fleet', maturity: 'advanced' },
  { href: '/runtime', label: 'runtime', group: 'Fleet', maturity: 'advanced' },
  { href: '/git', label: 'git', group: 'Fleet', maturity: 'advanced' },
  { href: '/cost', label: 'cost', group: 'Fleet', maturity: 'advanced' },
  { href: '/live-mcp', label: 'live-mcp', group: 'Risk', maturity: 'advanced' },
  { href: '/bootstrap-risk', label: 'bootstrap-risk', group: 'Risk', maturity: 'advanced' },
  { href: '/issues', label: 'issues', group: 'Risk', maturity: 'advanced' },
  { href: '/waivers', label: 'waivers', group: 'Risk', maturity: 'advanced' },
  { href: '/configuration', label: 'config', group: 'Setup', maturity: 'advanced' },
  { href: '/testing-policy', label: 'testing policy', group: 'Setup', maturity: 'advanced' },
] satisfies NavigationItem[];

const NAV_GROUP_ORDER = ['Work', 'Proof', 'Knowledge', 'Fleet', 'Risk', 'Setup'];

function groupedNav(items: NavigationItem[]) {
  return NAV_GROUP_ORDER.map((label) => ({
    label,
    items: items.filter((item) => item.group === label),
  })).filter((group) => group.items.length > 0);
}

export default function OperatorNavigation({ commands }: { commands: PaletteCommand[] | null }) {
  const [includeAdvanced, setIncludeAdvanced] = useState(false);
  const [query, setQuery] = useState('');
  const routes = useMemo(() => groupedNav(visibleNavigation(NAV, includeAdvanced)), [includeAdvanced]);
  const visibleCommands = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (commands || [])
      .filter((command) => includeAdvanced || !command.advanced)
      .filter((command) => !needle || [command.name, command.namespace, command.role, command.summary]
        .some((value) => value.toLowerCase().includes(needle)));
  }, [commands, includeAdvanced, query]);

  return (
    <>
      <nav className="coord-nav" aria-label="governance views">
        {routes.map((group) => (
          <div key={group.label} className="coord-nav__group">
            <span className="coord-nav__group-label">{group.label}</span>
            <div className="coord-nav__group-links">
              {group.items.map((item) => (
                <Link key={item.href} href={item.href} className="coord-nav__link">
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <section aria-label="Operator discovery" style={{ padding: '0 1.5rem 0.75rem' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.78rem' }}>
          <input
            type="checkbox"
            checked={includeAdvanced}
            onChange={(event) => setIncludeAdvanced(event.currentTarget.checked)}
          />
          Show specialized views and command details
        </label>
        <p style={{ margin: '0.3rem 0', fontSize: '0.72rem', color: 'var(--muted)' }}>Start with common workspace views. Show specialized views as you add workflow, cost, and integration data; they may be empty during setup.</p>
        <details style={{ marginTop: '0.45rem' }}>
          <summary style={{ cursor: 'pointer', fontSize: '0.78rem' }}>Command palette (metadata reference only)</summary>
          <p style={{ margin: '0.4rem 0', fontSize: '0.72rem' }}>
            Registry metadata only. The web UI does not execute or authorize commands.
            Planned entries are labels for future surfaces, not runnable commands.
          </p>
          <label style={{ display: 'block', fontSize: '0.72rem' }}>
            Filter command metadata
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Name, namespace, role, or summary"
              style={{ display: 'block', maxWidth: '28rem', width: '100%', marginTop: '0.2rem' }}
            />
          </label>
          {commands === null ? (
            <p style={{ fontSize: '0.75rem' }}>Canonical command registry metadata is unavailable.</p>
          ) : visibleCommands.length === 0 ? (
            <p style={{ fontSize: '0.75rem' }}>No matching command metadata.</p>
          ) : (
            <ul style={{ margin: '0.5rem 0', paddingLeft: '1.2rem' }}>
              {visibleCommands.map((command) => (
                <li key={`${command.namespace}:${command.name}`} style={{ margin: '0.4rem 0' }}>
                  <strong>{command.namespace}:{command.name}</strong>{' '}
                  <span>({command.planned ? 'planned — not runnable' : command.advanced ? 'advanced metadata' : 'stable'})</span>
                  <div style={{ fontSize: '0.75rem' }}>{command.summary}</div>
                  <div style={{ fontSize: '0.7rem' }}>
                    safety: {command.safety}{command.role ? ` · role: ${command.role}` : ''} · docs: {command.docs}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </details>
      </section>
    </>
  );
}
