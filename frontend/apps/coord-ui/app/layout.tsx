import type { ReactNode } from 'react';
import Link from 'next/link';
import path from 'node:path';
import './globals.css';
import OperatorNavigation from '../components/operator-navigation';
import { COORD_DIR } from '../lib/coord-paths';
import { requireExternal } from '../lib/external-require';
import { buildCommandPalette, type RegistryCommandMetadata } from '../lib/operator-surface.js';

export const metadata = {
  title: 'coord — command center',
  description: 'read-only governance command center'
};

type CommandRegistry = {
  listCommandMetadata: (options?: { includeAdvanced?: boolean }) => RegistryCommandMetadata[];
};

function commandPaletteMetadata() {
  try {
    const registry = requireExternal<CommandRegistry>(
      path.join(COORD_DIR, 'engine', 'scripts', 'command-registry.js')
    );
    return buildCommandPalette(registry.listCommandMetadata({ includeAdvanced: true }), {
      includeAdvanced: true
    });
  } catch {
    // Do not render hand-authored command claims when the canonical registry is
    // unavailable; the client component shows an explicit unavailable state.
    return null;
  }
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
          <OperatorNavigation commands={commandPaletteMetadata()} />
        </header>
        <main className="coord-main">{children}</main>
      </body>
    </html>
  );
}
