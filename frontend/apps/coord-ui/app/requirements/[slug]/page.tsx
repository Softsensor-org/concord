import Link from 'next/link';
import { notFound } from 'next/navigation';
import { loadRequirementView, loadRequirements, slugForRequirementRoute } from '../../../lib/requirements';

export const dynamic = 'force-dynamic';

export function generateStaticParams() {
  return loadRequirements().views.map((view) => ({ slug: slugForRequirementRoute(view.route) }));
}

export default async function RequirementDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const view = loadRequirementView(slug);
  if (!view) notFound();

  const sources = view.source_status ?? [];

  return (
    <>
      <div className="ticket-header">
        <Link href="/requirements" className="back">
          ← requirements
        </Link>
        <h1>{view.title}</h1>
        <span className={view.available ? 'rl rl--ready' : 'rl rl--blocked'}>
          {view.available ? 'available' : 'no data'}
        </span>
      </div>

      <div className="board-meta">
        <span>
          route: <strong>{view.route}</strong>
        </span>
        <span>
          sources: <strong>{sources.filter((s) => s.exists).length}</strong> / {sources.length}
        </span>
        <span>
          missing: <strong>{view.missing_sources.length}</strong>
        </span>
        <span>read-only — copy command, do not execute in web tier</span>
      </div>

      <section className="action-center">
        <article className="ac-card ac-card--wide">
          <h2 className="ac-card__title">Regenerate evidence</h2>
          <div className="ac-stat">
            <code>{view.copy_command}</code>
          </div>
          <div className="ac-stat ac-muted">
            Commands are rendered for operators; coord-ui never runs requirements generators.
          </div>
        </article>
      </section>

      <section className="action-center">
        <article className="ac-card ac-card--wide">
          <h2 className="ac-card__title">Source artifacts</h2>
          {sources.length === 0 ? (
            <div className="ac-ok">No sources declared by the requirements cockpit model.</div>
          ) : (
            <ul className="ac-rows">
              {sources.map((source) => (
                <li key={source.path} className="ac-stat">
                  <span className={source.exists ? 'pill pill--p2' : 'pill pill--p1'}>
                    {source.exists ? 'present' : 'missing'}
                  </span>{' '}
                  <code>{source.path}</code>
                  <span className="ac-muted"> · {source.kind}</span>
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>

      {view.missing_sources.length > 0 ? (
        <section className="action-center">
          <article className="ac-card ac-card--wide">
            <h2 className="ac-card__title">Missing inputs</h2>
            <ul className="ac-rows">
              {view.missing_sources.map((source) => (
                <li key={source} className="ac-stat">
                  <code>{source}</code>
                </li>
              ))}
            </ul>
          </article>
        </section>
      ) : null}
    </>
  );
}
