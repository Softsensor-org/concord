import { loadDiscovery } from '../../lib/discovery';

export const dynamic = 'force-dynamic';

function chips(rec: Record<string, number>) {
  const entries = Object.entries(rec).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return <span className="ac-muted">—</span>;
  return (
    <>
      {entries.map(([k, v]) => (
        <span key={k} className="ac-chip ac-chip--warn" style={{ marginRight: '0.3rem' }}>
          {k}: {v}
        </span>
      ))}
    </>
  );
}

export default function DiscoveryPage() {
  const d = loadDiscovery();
  const s = d.summary;

  return (
    <>
      <div className="board-meta">
        <span>
          project: <strong>{d.project.name}</strong>
          {d.project.scope ? ` (${d.project.scope})` : ''}
        </span>
        <span>
          sources: <strong>{s.sources}</strong>
        </span>
        <span>
          facts: <strong>{s.facts}</strong>
        </span>
        <span>
          open questions: <strong>{s.open_questions}</strong>
        </span>
        <span>
          context graph: <strong>{s.graph_nodes}</strong> nodes / {s.graph_edges} edges
        </span>
        <span>advisory — derived knowledge, never authority</span>
      </div>

      {!d.found ? (
        <section className="action-center">
          <article className="ac-card ac-card--wide">
            <h2 className="ac-card__title">No discovery run found</h2>
            <div className="ac-ok">
              Run business discovery to extract knowledge from the repo:{' '}
              <code>coord/scripts/coord business-discovery</code> then synthesize.
            </div>
          </article>
        </section>
      ) : (
        <>
          <section className="action-center">
            <article className="ac-card">
              <h2 className="ac-card__title">What coord learned</h2>
              <div className="ac-stat">
                <strong>{s.facts}</strong> facts from <strong>{s.sources}</strong> sources
              </div>
              <div className="ac-stat">repos: {d.project.repos.join(', ') || '—'}</div>
              {d.generatedAt ? <div className="ac-stat ac-muted">extracted {d.generatedAt.slice(0, 10)}</div> : null}
            </article>
            <article className="ac-card">
              <h2 className="ac-card__title">Confidence</h2>
              <div className="ac-stat">{chips(d.byConfidence)}</div>
              <div className="ac-stat ac-muted" style={{ marginTop: '0.3rem' }}>
                status: {chips(d.byStatus)}
              </div>
            </article>
            <article className="ac-card">
              <h2 className="ac-card__title">Evidence by authority</h2>
              <div className="ac-stat">{chips(d.byAuthority)}</div>
            </article>
            <article className="ac-card">
              <h2 className="ac-card__title">Surfaced for review</h2>
              <div className="ac-stat">
                <strong>{s.decisions}</strong> decisions · <strong>{s.workarounds}</strong> workarounds
              </div>
              <div className="ac-stat">
                <strong>{s.preservation_candidates}</strong> preservation candidates ·{' '}
                <strong>{s.contradictions}</strong> contradictions
              </div>
            </article>
          </section>

          {d.openQuestions.length > 0 ? (
            <section className="action-center">
              <article className="ac-card ac-card--wide">
                <h2 className="ac-card__title">Open questions (need human acceptance)</h2>
                <ul className="ac-rows">
                  {d.openQuestions.map((q) => (
                    <li key={q.id} className="ac-stat">
                      <span className="ac-row__id">{q.id}</span> {q.statement}
                    </li>
                  ))}
                </ul>
              </article>
            </section>
          ) : null}

          <section className="action-center">
            <article className="ac-card ac-card--wide">
              <h2 className="ac-card__title">Discovered facts {s.facts > d.facts.length ? `(top ${d.facts.length} of ${s.facts})` : ''}</h2>
              <ul className="ac-rows">
                {d.facts.map((f) => (
                  <li key={f.id} className="ac-stat">
                    <span className={`pill ${f.confidence === 'confirmed' ? 'pill--p2' : 'pill--p1'}`}>
                      {f.confidence ?? 'observed'}
                    </span>{' '}
                    <span className="ac-muted">{f.kind}</span> — {f.statement}
                    {f.classification ? <span className="ac-muted"> [{f.classification}]</span> : null}
                  </li>
                ))}
              </ul>
            </article>
          </section>
        </>
      )}
    </>
  );
}
