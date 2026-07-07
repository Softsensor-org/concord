import Link from 'next/link';
import { loadRequirements } from '../../lib/requirements';

export const dynamic = 'force-dynamic';

export default function RequirementsPage() {
  const model = loadRequirements();
  const { views, summary } = model;

  return (
    <>
      <div className="board-meta">
        <span>
          assurance views: <strong>{summary.views}</strong>
        </span>
        <span>
          available: <strong>{summary.available_views}</strong> / {summary.views}
        </span>
        <span>
          missing all sources: <strong>{summary.missing_all_sources}</strong>
        </span>
        <span>read-only — commands are copyable text</span>
      </div>

      {!model.found || views.length === 0 ? (
        <section className="action-center">
          <article className="ac-card ac-card--wide">
            <h2 className="ac-card__title">Requirements assurance not initialized</h2>
            <div className="ac-ok">
              No requirements cockpit model available. See <code>coord/product/REQUIREMENTS.md</code> and the
              REQUIREMENTS_ASSURANCE_PROTOCOL.
            </div>
          </article>
        </section>
      ) : (
        <section className="action-center">
          {views.map((view) => (
            <article key={view.id} className="ac-card">
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                <Link href={view.route} style={{ fontSize: '0.9rem', fontWeight: 700 }}>
                  {view.title}
                </Link>
                <span className={view.available ? 'pill pill--p2' : 'pill pill--p1'}>
                  {view.available ? 'available' : 'no data'}
                </span>
              </div>
              <div className="ac-stat ac-muted">{view.route}</div>
              {view.missing_sources.length > 0 ? (
                <div className="ac-stat ac-muted">
                  missing: {view.missing_sources.length} source{view.missing_sources.length === 1 ? '' : 's'}
                </div>
              ) : null}
              <div className="ac-stat">
                <code>{view.copy_command}</code>
              </div>
            </article>
          ))}
        </section>
      )}
    </>
  );
}
