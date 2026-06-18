import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';

export const metadata = {
  title: 'coord — command center',
  description: 'read-only governance command center'
};

const NAV = [
  { href: '/', label: 'board' },
  { href: '/agents', label: 'agents' },
  { href: '/timeline', label: 'timeline' },
  { href: '/gates', label: 'gates' },
  { href: '/quality', label: 'quality' },
  { href: '/dispatch', label: 'dispatch' },
  { href: '/tests', label: 'tests' },
  { href: '/health', label: 'health' },
  { href: '/runtime', label: 'runtime' },
  { href: '/pipeline', label: 'pipeline' },
  { href: '/urs', label: 'urs' },
  { href: '/screens', label: 'screens' },
  { href: '/traceability', label: 'traceability' },
  { href: '/evidence', label: 'evidence' },
  { href: '/cost', label: 'cost' },
  { href: '/issues', label: 'issues' },
  { href: '/waivers', label: 'waivers' },
  { href: '/git', label: 'git' }
];

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
          <nav className="coord-nav">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className="coord-nav__link">
                {item.label}
              </Link>
            ))}
          </nav>
        </header>
        <main className="coord-main">{children}</main>
      </body>
    </html>
  );
}
