import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';

export const metadata = {
  title: 'coord — command center',
  description: 'read-only governance command center'
};

// Grouped information architecture (COORD-UI adoption cockpit). The 23-item nav is
// regrouped into role/track clusters so a newcomer can answer "what is my team
// doing / what must I prove / what do I know / who is running / what is risky /
// am I set up" without already understanding coord. Read-only — all links are
// inspection views.
//
// `NAV` stays a single flat array on purpose: it is the source of truth AND the
// contract surface pinned to the README route list by
// coord-ui-nav-readme-sync.test.js (COORD-110). The `group` field drives the
// grouped rendering, derived below — do not split NAV into per-group arrays.
// New Knowledge routes (/requirements, /adrs, /continuity) join via a `group`.
type NavItem = { href: string; label: string; group: string };

// NOTE: keep the declaration below as a bare array literal with no type
// annotation between the name and the equals sign — the COORD-110 nav<->README
// contract locates it by regex and a type annotation breaks the match.
const NAV = [
  { href: '/', label: 'board', group: 'Work' },
  { href: '/dispatch', label: 'dispatch', group: 'Work' },
  { href: '/pipeline', label: 'pipeline', group: 'Work' },
  { href: '/timeline', label: 'timeline', group: 'Work' },
  { href: '/triage', label: 'triage', group: 'Work' },
  { href: '/gates', label: 'gates', group: 'Proof' },
  { href: '/tracks', label: 'tracks', group: 'Proof' },
  { href: '/tests', label: 'tests', group: 'Proof' },
  { href: '/evidence', label: 'evidence', group: 'Proof' },
  { href: '/traceability', label: 'traceability', group: 'Proof' },
  { href: '/quality', label: 'quality', group: 'Proof' },
  { href: '/urs', label: 'urs', group: 'Knowledge' },
  { href: '/screens', label: 'screens', group: 'Knowledge' },
  { href: '/requirements', label: 'requirements', group: 'Knowledge' },
  { href: '/adrs', label: 'adrs', group: 'Knowledge' },
  { href: '/continuity', label: 'continuity', group: 'Knowledge' },
  { href: '/discovery', label: 'discovery', group: 'Knowledge' },
  { href: '/knowledge', label: 'knowledge', group: 'Knowledge' },
  { href: '/insights', label: 'insights', group: 'Knowledge' },
  { href: '/human-agent', label: 'human-agent', group: 'Knowledge' },
  { href: '/agents', label: 'agents', group: 'Fleet' },
  { href: '/runtime', label: 'runtime', group: 'Fleet' },
  { href: '/git', label: 'git', group: 'Fleet' },
  { href: '/cost', label: 'cost', group: 'Fleet' },
  { href: '/live-mcp', label: 'live-mcp', group: 'Risk' },
  { href: '/bootstrap-risk', label: 'bootstrap-risk', group: 'Risk' },
  { href: '/issues', label: 'issues', group: 'Risk' },
  { href: '/waivers', label: 'waivers', group: 'Risk' },
  { href: '/onboarding', label: 'onboarding', group: 'Setup' },
  { href: '/readiness', label: 'readiness', group: 'Setup' },
  { href: '/configuration', label: 'config', group: 'Setup' },
  { href: '/health', label: 'health', group: 'Setup' }
];

const NAV_GROUP_ORDER = ['Work', 'Proof', 'Knowledge', 'Fleet', 'Risk', 'Setup'];

function groupedNav(): { label: string; items: NavItem[] }[] {
  return NAV_GROUP_ORDER.map((label) => ({
    label,
    items: NAV.filter((item) => item.group === label)
  })).filter((group) => group.items.length > 0);
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@500;600;700;800&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <div className="deck-bg" aria-hidden="true" />
        <header className="coord-header">
          <Link href="/" className="coord-brand">
            <span className="coord-brand__glyph" aria-hidden="true" />
            <span className="coord-brand__mark">COORD</span>
            <span className="coord-brand__hint">
              <span className="coord-brand__line">governance command center</span>
              <span className="coord-brand__ro">read&#8209;only mirror</span>
            </span>
          </Link>
          <nav className="coord-nav" aria-label="governance views">
            {groupedNav().map((group) => (
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
        </header>
        <main className="coord-main">{children}</main>
      </body>
    </html>
  );
}
